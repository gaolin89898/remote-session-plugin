package trae

import (
	"context"
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type oauthTransport func(*http.Request) (*http.Response, error)

func (f oauthTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func oauthResponse(r *http.Request, code int, body string) *http.Response {
	return &http.Response{StatusCode: code, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}
}
func testLogin(t *testing.T) *OAuthLogin {
	t.Helper()
	l, err := NewOAuthLogin()
	if err != nil {
		t.Fatal(err)
	}
	return l
}
func testCallback(l *OAuthLogin, uid string) string {
	info, _ := json.Marshal(map[string]string{"AuthCode": "private-auth-code"})
	user, _ := json.Marshal(map[string]string{"UserID": uid})
	return OAuthRedirectURI + "?" + url.Values{"loginTraceID": {l.state}, "authCodeInfo": {string(info)}, "userInfo": {string(user)}, "host": {"https://api.trae.com.cn"}}.Encode()
}
func testOAuthAccount(t *testing.T, uid string) Account {
	l := testLogin(t)
	identity := l.identity
	identity.RefreshToken = "private-refresh"
	return Account{Token: testToken(uid, time.Now().Add(time.Hour)), AccountUID: uid, DeviceID: identity.DeviceID, OAuth: &identity}
}

func TestOAuthLoginURLAndCallbackValidation(t *testing.T) {
	l, other := testLogin(t), testLogin(t)
	if l.identity.DeviceID == other.identity.DeviceID || l.identity.PrivateKeyPEM == other.identity.PrivateKeyPEM || l.state == other.state {
		t.Fatal("login identities reused")
	}
	u, _ := url.Parse(l.URL())
	q := u.Query()
	challenge := sha256.Sum256([]byte(l.verifier))
	if u.Host != "www.trae.cn" || q.Get("login_channel") != "native_ide" || q.Get("device_id") != l.identity.DeviceID || q.Get("x_device_id") != l.identity.DeviceID || q.Get("machine_id") != l.identity.MachineID || q.Get("code_challenge") != base64.RawURLEncoding.EncodeToString(challenge[:]) {
		t.Fatal("OAuth login identity or PKCE does not match")
	}
	if len(l.identity.DeviceID) != 15 || !validDeviceID(l.identity.DeviceID) {
		t.Fatal("invalid device")
	}
	cb, err := l.ParseCallback(testCallback(l, "90071992547409931234"))
	if err != nil || cb.uid != "90071992547409931234" {
		t.Fatal("valid callback rejected")
	}
	for _, change := range []func(*url.URL){
		func(u *url.URL) { v := u.Query(); v.Del("loginTraceID"); u.RawQuery = v.Encode() },
		func(u *url.URL) { v := u.Query(); v.Set("loginTraceID", other.state); u.RawQuery = v.Encode() },
		func(u *url.URL) { v := u.Query(); v.Add("loginTraceID", l.state); u.RawQuery = v.Encode() },
		func(u *url.URL) {
			v := u.Query()
			v.Set("host", "https://api.trae.cn@evil.example")
			u.RawQuery = v.Encode()
		},
		func(u *url.URL) { v := u.Query(); v.Set("host", "https://api.trae.cn/path"); u.RawQuery = v.Encode() },
		func(u *url.URL) { v := u.Query(); v.Set("host", "http://api.trae.cn"); u.RawQuery = v.Encode() },
		func(u *url.URL) { v := u.Query(); v.Set("host", "https://api.trae.com"); u.RawQuery = v.Encode() },
		func(u *url.URL) { v := u.Query(); v.Set("userRegion", "global"); u.RawQuery = v.Encode() },
		func(u *url.URL) { u.Host = "evil.example" },
		func(u *url.URL) { u.User = url.User("attacker") },
		func(u *url.URL) { u.Path = "/other" },
	} {
		u, _ := url.Parse(testCallback(l, "user"))
		change(u)
		if _, err := l.ParseCallback(u.String()); err == nil {
			t.Fatal("unsafe callback accepted")
		}
	}
	l.created = time.Now().Add(-16 * time.Minute)
	if _, err := l.ParseCallback(testCallback(l, "user")); err == nil {
		t.Fatal("expired callback accepted")
	}
}

func TestOAuthExchangeRegistersPublicKeyAndCannotReplay(t *testing.T) {
	l := testLogin(t)
	calls := 0
	c := NewClient()
	c.HTTP.Transport = oauthTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.String() != "https://api.trae.com.cn"+oauthExchangePath || r.Header.Get("x-device-id") != l.identity.DeviceID {
			t.Fatal("exchange host or device mismatch")
		}
		if values, ok := r.Header["X-Cloudide-Token"]; !ok || len(values) != 1 || values[0] != "" {
			t.Fatal("missing empty client token header")
		}
		var payload struct {
			ClientID, AuthCode, CodeVerifier string
			DeviceInfo                       struct{ DeviceID, MachineID, DevicePublicKey string }
		}
		if json.NewDecoder(r.Body).Decode(&payload) != nil || payload.ClientID != oauthClientID || payload.AuthCode != "private-auth-code" || payload.CodeVerifier != l.verifier || payload.DeviceInfo.DeviceID != l.identity.DeviceID || payload.DeviceInfo.MachineID != l.identity.MachineID {
			t.Fatal("exchange lost session binding")
		}
		block, _ := pem.Decode([]byte(payload.DeviceInfo.DevicePublicKey))
		if block == nil {
			t.Fatal("missing public key")
		}
		public, err := x509.ParsePKIXPublicKey(block.Bytes)
		key, _ := identityKey(&l.identity)
		if err != nil || !key.PublicKey.Equal(public) {
			t.Fatal("registered public key does not belong to device")
		}
		body, _ := json.Marshal(map[string]any{"Result": map[string]string{"Token": testToken("oauth-user", time.Now().Add(time.Hour)), "RefreshToken": "private-refresh"}})
		return oauthResponse(r, 200, string(body)), nil
	})
	cb, err := l.ParseCallback(testCallback(l, "oauth-user"))
	if err != nil {
		t.Fatal(err)
	}
	a, err := c.CompleteOAuth(context.Background(), l, cb)
	if err != nil {
		t.Fatal(err)
	}
	if a.OAuth == nil || a.DeviceID != l.identity.DeviceID || a.OAuth.RefreshToken != "private-refresh" || a.Session != "" {
		t.Fatal("account did not retain the OAuth identity")
	}
	if _, err := c.CompleteOAuth(context.Background(), l, cb); err == nil || calls != 1 {
		t.Fatal("authorization code replayed")
	}
	if _, err := l.ParseCallback(testCallback(l, "oauth-user")); err == nil {
		t.Fatal("consumed callback accepted")
	}
}

func TestOAuthRefreshVerifiesProofRotatesTokenAndKeepsIdentity(t *testing.T) {
	a := testOAuthAccount(t, "refresh-user")
	a.Token = testToken("refresh-user", time.Now().Add(-time.Hour))
	original := *a.OAuth
	c := NewClient()
	refreshes, statuses := 0, 0
	forceUnauthorized := false
	c.HTTP.Transport = oauthTransport(func(r *http.Request) (*http.Response, error) {
		if r.Header.Get("x-device-id") != original.DeviceID {
			t.Fatal("request used a different device")
		}
		if r.URL.Path == oauthExchangePath {
			refreshes++
			var body struct {
				DeviceID, RefreshToken string
				DeviceProof            struct {
					Signature string
					Timestamp int64
					Nonce     string
				}
			}
			if json.NewDecoder(r.Body).Decode(&body) != nil || body.DeviceID != original.DeviceID {
				t.Fatal("invalid refresh body")
			}
			expectedRefresh := "private-refresh"
			if refreshes > 1 {
				expectedRefresh = "rotated-refresh-1"
			}
			if body.RefreshToken != expectedRefresh {
				t.Fatal("rotated refresh token was not used")
			}
			if body.DeviceProof.Timestamp < time.Now().Add(-time.Minute).Unix() || len(body.DeviceProof.Nonce) != 32 {
				t.Fatal("stale proof")
			}
			msg := fmt.Sprintf("POST\n%s\n%s\n%s\n%d\n%s", oauthExchangePath, oauthClientID, body.RefreshToken, body.DeviceProof.Timestamp, body.DeviceProof.Nonce)
			hash := sha256.Sum256([]byte(msg))
			sig, err := base64.StdEncoding.DecodeString(body.DeviceProof.Signature)
			key, _ := identityKey(&original)
			if err != nil || len(sig) != 64 || !ecdsa.Verify(&key.PublicKey, hash[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
				t.Fatal("invalid DeviceProof signature")
			}
			result, _ := json.Marshal(map[string]any{"Result": map[string]string{"Token": testToken("refresh-user", time.Now().Add(time.Hour)), "RefreshToken": fmt.Sprintf("rotated-refresh-%d", refreshes)}})
			return oauthResponse(r, 200, string(result)), nil
		}
		statuses++
		if forceUnauthorized {
			forceUnauthorized = false
			return oauthResponse(r, 401, `{}`), nil
		}
		return oauthResponse(r, 200, `{"code":0,"enable":true,"checked_in":false}`), nil
	})
	if _, _, err := c.status(context.Background(), &a); err != nil {
		t.Fatal(err)
	}
	if refreshes != 1 || statuses != 1 || a.OAuth.RefreshToken != "rotated-refresh-1" || original.RefreshToken != "private-refresh" || a.OAuth.PrivateKeyPEM != original.PrivateKeyPEM {
		t.Fatal("refresh rotated identity or mutated snapshot")
	}
	forceUnauthorized = true
	if _, _, err := c.status(context.Background(), &a); err != nil {
		t.Fatal(err)
	}
	if refreshes != 2 || statuses != 3 {
		t.Fatal("unauthorized request was not renewed exactly once")
	}
}

func TestOAuthRefreshRejectsOtherAccountAndRedactsFailures(t *testing.T) {
	for _, response := range []string{
		`{"ResponseMetadata":{"Error":{"Code":"20405","Message":"secret-authorization-code"}}}`,
		`{"ResponseMetadata":{"Error":{"Code":"secret-authorization-code","Message":"secret-refresh"}}}`,
		`{"Result":{"Token":"bad-private-token","RefreshToken":"secret-refresh"}}`,
	} {
		a := testOAuthAccount(t, "user")
		original := a.Token
		c := NewClient()
		c.HTTP.Transport = oauthTransport(func(r *http.Request) (*http.Response, error) { return oauthResponse(r, 200, response), nil })
		err := c.refreshOAuth(context.Background(), &a)
		if err == nil || strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "bad-private") || a.Token != original {
			t.Fatal("failed refresh leaked credentials or changed state")
		}
	}
	a := testOAuthAccount(t, "user")
	original := a.Token
	c := NewClient()
	c.HTTP.Transport = oauthTransport(func(r *http.Request) (*http.Response, error) {
		body, _ := json.Marshal(map[string]any{"Result": map[string]string{"Token": testToken("other-user", time.Now().Add(time.Hour)), "RefreshToken": "other-refresh"}})
		return oauthResponse(r, 200, string(body)), nil
	})
	if err := c.refreshOAuth(context.Background(), &a); err == nil || a.Token != original || a.OAuth.RefreshToken != "private-refresh" {
		t.Fatal("cross-account refresh was accepted")
	}
}

func TestOAuthRejectsDeviceDriftAndDoesNotFollowRedirects(t *testing.T) {
	a := testOAuthAccount(t, "user")
	a.DeviceID = "123456789012345"
	c := NewClient()
	calls := 0
	c.HTTP.Transport = oauthTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		response := oauthResponse(r, 302, "")
		response.Header.Set("Location", "https://evil.example/steal")
		return response, nil
	})
	if _, _, err := c.status(context.Background(), &a); err == nil || calls != 0 {
		t.Fatal("OAuth device drift sent a request")
	}
	a.DeviceID = a.OAuth.DeviceID
	c.HTTP.CheckRedirect = nil
	if err := c.refreshOAuth(context.Background(), &a); err == nil || calls != 1 {
		t.Fatal("OAuth redirect was followed")
	}
}

func TestOAuthStorePreservesBindingAndReauthorizationChecksTarget(t *testing.T) {
	c := NewClient()
	uid := "stored-user"
	checked := false
	profileOnly := false
	device := ""
	c.HTTP.Transport = oauthTransport(func(r *http.Request) (*http.Response, error) {
		if r.Header.Get("x-device-id") != device {
			t.Fatal("stored OAuth device changed")
		}
		switch r.URL.Path {
		case "/cloudide/api/v3/trae/GetUserInfo":
			t.Fatal("native OAuth attempted to use web profile authentication")
			return oauthResponse(r, 401, `{}`), nil
		case "/trae/api/v2/ug/checkin_credits/status":
			if profileOnly {
				t.Fatal("wrong reauthorization queried another account")
			}
			return oauthResponse(r, 200, fmt.Sprintf(`{"code":0,"enable":true,"checked_in":%t}`, checked)), nil
		case "/trae/api/v2/pay/user_current_entitlement_list":
			return oauthResponse(r, 200, `{"is_credits_billing":true,"usage_summary":{"total_amount":500,"consumed_amount":0}}`), nil
		default:
			t.Fatal("unexpected OAuth operation (including claim)")
			return nil, nil
		}
	})
	path := filepath.Join(t.TempDir(), "accounts.json")
	s, err := Open(path, c)
	if err != nil {
		t.Fatal(err)
	}
	a := testOAuthAccount(t, uid)
	device = a.DeviceID
	first, _, err := s.Add(context.Background(), a)
	if err != nil {
		t.Fatal(err)
	}
	s.localDevices = func() []clientDevice { t.Fatal("OAuth account inspected local client device"); return nil }
	checked = true
	if _, _, err := s.Action(context.Background(), first.UID, "checkin"); err != nil {
		t.Fatal(err)
	}
	second := testOAuthAccount(t, uid)
	device = second.DeviceID
	reauthed, _, err := s.Reauthorize(context.Background(), second, first.UID)
	if err != nil || reauthed.UID != first.UID || !reauthed.CheckinDone || reauthed.Credits != 500 || !reauthed.HasOAuth {
		t.Fatal("re-authentication lost account state")
	}
	reopened, err := Open(path, c)
	if err != nil {
		t.Fatal(err)
	}
	saved := reopened.snapshot()[0]
	if saved.OAuth == nil || saved.DeviceID != second.DeviceID || saved.OAuth.PrivateKeyPEM != second.OAuth.PrivateKeyPEM {
		t.Fatal("OAuth identity did not survive reopening")
	}
	public, _ := json.Marshal(reopened.List())
	for _, secret := range []string{saved.Token, saved.DeviceID, saved.OAuth.MachineID, saved.OAuth.RefreshToken, "PRIVATE KEY", "private_key_pem"} {
		if strings.Contains(string(public), secret) {
			t.Fatal("public account response leaked private OAuth identity")
		}
	}
	before, _ := os.ReadFile(path)
	profileOnly = true
	uid = "different-user"
	wrong := testOAuthAccount(t, uid)
	device = wrong.DeviceID
	if _, _, err := s.Reauthorize(context.Background(), wrong, first.UID); err == nil {
		t.Fatal("reauthorization accepted the wrong account")
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatal("rejected reauthorization modified stored credentials")
	}
}
