package traelogin

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/chromedp/chromedp"
	"github.com/linguo2625469/workbuddy2api-panel/internal/trae"
)

func callbackFixture(t *testing.T) (*trae.OAuthLogin, string) {
	t.Helper()
	l, err := trae.NewOAuthLogin()
	if err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(l.URL())
	return l, trae.OAuthRedirectURI + "?" + url.Values{"loginTraceID": {u.Query().Get("login_trace_id")}, "authCodeInfo": {`{"AuthCode":"private-code"}`}, "host": {"https://api.trae.com.cn"}, "userInfo": {`{"UserID":"browser-oauth"}`}}.Encode()
}

func TestOAuthCallbackHandlerRejectsUnrelatedAndDuplicateRequests(t *testing.T) {
	l, target := callbackFixture(t)
	callbacks := make(chan trae.OAuthCallback, 1)
	h := callbackHandler(l, callbacks)
	for _, bad := range []string{"http://evil.example/authorize?code=secret", trae.OAuthRedirectURI + "?code=secret", trae.OAuthRedirectURI + "?loginTraceID=other&code=secret"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", bad, nil))
		if w.Code != 400 || len(callbacks) != 0 || strings.Contains(w.Body.String(), "secret") {
			t.Fatal("invalid callback accepted or echoed")
		}
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", target, nil))
	if w.Code != 200 || len(callbacks) != 1 || strings.Contains(w.Body.String(), "private-code") || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("callback was not delivered privately")
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", target, nil))
	if w.Code != 409 {
		t.Fatal("duplicate callback accepted")
	}
}

func TestOAuthCallbackPortConflictDoesNotOpenBrowser(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:17388")
	if err != nil {
		t.Skip("callback port already occupied")
	}
	defer listener.Close()
	_, err = runOAuthBrowser(context.Background(), "invalid-browser-must-not-start")
	if !errors.Is(err, ErrCallbackPort) {
		t.Fatal("callback conflict not reported")
	}
}

type browserOAuthTransport func(*http.Request) (*http.Response, error)

func (f browserOAuthTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// This integration uses a real headless browser and a local fake authorization
// page. It exercises callback receipt, exchange and cleanup without contacting Trae.
func TestOAuthBrowserCallbackExchangeAndCleanup(t *testing.T) {
	if os.Getenv("TRAE_BROWSER_TEST") != "1" {
		t.Skip("set TRAE_BROWSER_TEST=1 to exercise installed browser")
	}
	l, target := callbackFixture(t)
	encoded, _ := json.Marshal(target)
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		io.WriteString(w, `<script>location.href=`+string(encoded)+`</script>`)
	}))
	defer fixture.Close()
	client := trae.NewClient()
	exchanges := 0
	client.HTTP.Transport = browserOAuthTransport(func(r *http.Request) (*http.Response, error) {
		exchanges++
		if r.URL.Host != "api.trae.com.cn" || r.URL.Path != "/trae/api/v3/oauth/ExchangeToken" {
			t.Fatal("unexpected request")
		}
		payload, _ := json.Marshal(map[string]any{"data": map[string]string{"id": "browser-oauth"}, "exp": time.Now().Add(time.Hour).Unix()})
		token := "header." + base64.RawURLEncoding.EncodeToString(payload) + ".signature"
		body, _ := json.Marshal(map[string]any{"Result": map[string]string{"Token": token, "RefreshToken": "private-refresh"}})
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(body))), Request: r}, nil
	})
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	credentials, err := runOAuthSession(ctx, BrowserPath(), l, fixture.URL, client, chromedp.Headless)
	if err != nil || credentials.OAuth == nil || credentials.DeviceID != credentials.OAuth.DeviceID || credentials.Session != "" || exchanges != 1 {
		t.Fatalf("OAuth browser exchange failed: %v", err)
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:17388")
	if err != nil {
		t.Fatal("callback listener was not released")
	}
	listener.Close()
}
