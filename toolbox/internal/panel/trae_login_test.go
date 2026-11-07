package panel

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/linguo2625469/workbuddy2api-panel/internal/trae"
	"github.com/linguo2625469/workbuddy2api-panel/internal/traelogin"
)

type loginTransport func(*http.Request) (*http.Response, error)

func (f loginTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func loginTestPanel(t *testing.T) *Panel {
	t.Helper()
	client := trae.NewClient()
	client.HTTP.Transport = loginTransport(func(r *http.Request) (*http.Response, error) {
		body := `{"code":0}`
		switch r.URL.Path {
		case "/cloudide/api/v3/trae/GetUserInfo":
			cookie, err := r.Cookie("X-Cloudide-Session")
			_, oauth := r.Header["X-Cloudide-Token"]
			if !oauth && (err != nil || cookie.Value != "private-session") {
				return &http.Response{StatusCode: 401, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"message":"session required"}`)), Request: r}, nil
			}
			body = `{"Result":{"UserID":"browser-user","ScreenName":"直接登录账号"}}`
		case "/trae/api/v2/ug/checkin_credits/status":
			body = `{"code":0,"enable":true,"checked_in":false}`
		case "/trae/api/v2/pay/user_current_entitlement_list":
			body = `{"user_entitlement_pack_list":[{"entitlement_base_info":{"quota":{"credits_limit":100}},"usage":{"credits_amount":25}}]}`
		default:
			t.Errorf("unexpected endpoint %s", r.URL.Path)
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})
	store, err := trae.Open(filepath.Join(t.TempDir(), "trae.json"), client)
	if err != nil {
		t.Fatal(err)
	}
	p := New(Config{AccountsOnly: true, Trae: store, APIKey: "test-admin"})
	p.traeLogin.find = func() string { return "fixture-browser" }
	t.Cleanup(p.Close)
	return p
}

func loginRequest(p *Panel, method, path string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://127.0.0.1:7863/panel/api/trae/login/"+path, nil)
	r.RemoteAddr = "127.0.0.1:45678"
	r.Header.Set("Origin", "http://127.0.0.1:7863")
	r.Header.Set("Authorization", "Bearer test-admin")
	w := httptest.NewRecorder()
	p.ServeHTTP(w, r)
	return w
}

func startTestLogin(t *testing.T, p *Panel) string {
	t.Helper()
	w := loginRequest(p, "POST", "start")
	var result struct{ State string }
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result.State) != 48 {
		t.Fatalf("start failed: %d %s", w.Code, w.Body.String())
	}
	return result.State
}

func waitTestLogin(t *testing.T, p *Panel, state string) *httptest.ResponseRecorder {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		w := loginRequest(p, "GET", "poll?state="+state)
		if strings.Contains(w.Body.String(), `"done":true`) {
			return w
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("login did not finish")
	return nil
}

func TestTraeBrowserLoginPersistsWithoutExposingCredentials(t *testing.T) {
	p := loginTestPanel(t)
	payload, _ := json.Marshal(map[string]any{"data": map[string]any{"id": "browser-user"}, "exp": time.Now().Add(time.Hour).Unix()})
	token := "header." + base64.RawURLEncoding.EncodeToString(payload) + ".signature"
	p.traeLogin.run = func(context.Context, string) (traelogin.Credentials, error) {
		return traelogin.Credentials{Token: token, Session: "private-session"}, nil
	}
	w := waitTestLogin(t, p, startTestLogin(t, p))
	if !strings.Contains(w.Body.String(), `"status":"success"`) || len(p.cfg.Trae.List()) != 1 || p.cfg.Trae.List()[0].Credits != 75 {
		t.Fatalf("login did not save account: %s", w.Body.String())
	}
	if strings.Contains(w.Body.String(), token) || strings.Contains(w.Body.String(), "private-session") {
		t.Fatal("credentials leaked in poll response")
	}
	// Reauthentication must update the existing account, preserving its local ID.
	id := p.cfg.Trae.List()[0].UID
	w = waitTestLogin(t, p, startTestLogin(t, p))
	if len(p.cfg.Trae.List()) != 1 || p.cfg.Trae.List()[0].UID != id {
		t.Fatal("re-login duplicated account")
	}
}

func TestTraeOAuthLoginPersistsIdentityWithoutExposingSecrets(t *testing.T) {
	p := loginTestPanel(t)
	payload, _ := json.Marshal(map[string]any{"data": map[string]string{"id": "browser-user"}, "exp": time.Now().Add(time.Hour).Unix()})
	token := "header." + base64.RawURLEncoding.EncodeToString(payload) + ".signature"
	l, err := trae.NewOAuthLogin()
	if err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(l.URL())
	callback := trae.OAuthRedirectURI + "?" + url.Values{"loginTraceID": {u.Query().Get("login_trace_id")}, "authCodeInfo": {`{"AuthCode":"private-auth-code"}`}}.Encode()
	cb, err := l.ParseCallback(callback)
	if err != nil {
		t.Fatal(err)
	}
	c := trae.NewClient()
	c.HTTP.Transport = loginTransport(func(r *http.Request) (*http.Response, error) {
		body, _ := json.Marshal(map[string]any{"Result": map[string]string{"Token": token, "RefreshToken": "private-oauth-refresh"}})
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(body))), Request: r}, nil
	})
	a, err := c.CompleteOAuth(context.Background(), l, cb)
	if err != nil {
		t.Fatal(err)
	}
	p.traeLogin.run = func(context.Context, string) (traelogin.Credentials, error) {
		return traelogin.Credentials{Token: a.Token, DeviceID: a.DeviceID, OAuth: a.OAuth}, nil
	}
	w := waitTestLogin(t, p, startTestLogin(t, p))
	if !strings.Contains(w.Body.String(), `"status":"success"`) || !strings.Contains(w.Body.String(), `"has_oauth":true`) {
		t.Fatalf("OAuth login failed: %s", w.Body.String())
	}
	for _, secret := range []string{token, a.DeviceID, a.OAuth.RefreshToken, a.OAuth.MachineID, "PRIVATE KEY", "private_key_pem", "private-auth-code"} {
		if strings.Contains(w.Body.String(), secret) {
			t.Fatal("OAuth credentials leaked from poll")
		}
	}
}

func TestTraeBrowserLoginCancellationAndLateResult(t *testing.T) {
	p := loginTestPanel(t)
	release, finished := make(chan struct{}), make(chan struct{})
	p.traeLogin.run = func(ctx context.Context, _ string) (traelogin.Credentials, error) {
		defer close(finished)
		<-release // Simulate a browser result arriving after cancellation.
		return traelogin.Credentials{Token: "late.payload.signature"}, nil
	}
	state := startTestLogin(t, p)
	if loginRequest(p, "POST", "start").Code != 409 {
		t.Fatal("opened overlapping login")
	}
	if loginRequest(p, "POST", "cancel?state="+state).Code != 200 {
		t.Fatal("cancel failed")
	}
	close(release)
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("browser did not finish")
	}
	w := waitTestLogin(t, p, state)
	if !strings.Contains(w.Body.String(), `"status":"cancelled"`) || len(p.cfg.Trae.List()) != 0 {
		t.Fatal("cancelled login saved a late result")
	}
}

func TestTraeBrowserLoginRedactsErrorsAndMissingBrowser(t *testing.T) {
	p := loginTestPanel(t)
	p.traeLogin.run = func(context.Context, string) (traelogin.Credentials, error) {
		return traelogin.Credentials{}, errors.New("private-token-in-browser-diagnostic")
	}
	w := waitTestLogin(t, p, startTestLogin(t, p))
	if strings.Contains(w.Body.String(), "private-token") || !strings.Contains(w.Body.String(), `"status":"error"`) {
		t.Fatal("unsafe browser error")
	}
	p.traeLogin.find = func() string { return "" }
	if loginRequest(p, "POST", "start").Code != 501 {
		t.Fatal("missing browser not reported")
	}
	if !strings.Contains(loginRequest(p, "GET", "available").Body.String(), `"available":false`) {
		t.Fatal("missing browser marked available")
	}
}

func TestTraeBrowserLoginReportsVerificationFailure(t *testing.T) {
	p := loginTestPanel(t)
	p.traeLogin.run = func(context.Context, string) (traelogin.Credentials, error) {
		return traelogin.Credentials{Token: "invalid-private-token"}, nil
	}
	w := waitTestLogin(t, p, startTestLogin(t, p))
	if !strings.Contains(w.Body.String(), "账号验证或保存失败") || !strings.Contains(w.Body.String(), "登录凭证已失效") {
		t.Fatalf("verification error was hidden: %s", w.Body.String())
	}
	if strings.Contains(w.Body.String(), "invalid-private-token") || len(p.cfg.Trae.List()) != 0 {
		t.Fatal("failed verification leaked credentials or saved account")
	}
}

func TestTraeDesktopLoginRejectsRemoteAndCrossSiteRequests(t *testing.T) {
	p := loginTestPanel(t)
	var opened atomic.Int32
	p.traeLogin.run = func(context.Context, string) (traelogin.Credentials, error) {
		opened.Add(1)
		return traelogin.Credentials{}, errors.New("closed")
	}
	for _, tc := range []struct{ host, remote, header, value string }{
		{"127.0.0.1:7863", "192.0.2.1:1234", "", ""},
		{"evil.example:7863", "127.0.0.1:1234", "", ""},
		{"127.0.0.1:7863", "127.0.0.1:1234", "Origin", "https://evil.example"},
		{"127.0.0.1:7863", "127.0.0.1:1234", "Sec-Fetch-Site", "cross-site"},
		{"127.0.0.1:7863", "127.0.0.1:1234", "X-Forwarded-For", "192.0.2.1"},
	} {
		r := httptest.NewRequest("POST", "http://"+tc.host+"/panel/api/trae/login/start", nil)
		r.RemoteAddr = tc.remote
		r.Header.Set("Authorization", "Bearer test-admin")
		if tc.header != "" {
			r.Header.Set(tc.header, tc.value)
		}
		w := httptest.NewRecorder()
		p.ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatalf("accepted non-local request: %+v: %d", tc, w.Code)
		}
	}
	if opened.Load() != 0 {
		t.Fatal("rejected request opened browser")
	}
}
