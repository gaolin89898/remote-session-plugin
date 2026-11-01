package qoder

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	c := NewClient()
	c.base = srv.URL
	return c
}
func reply(w http.ResponseWriter, v any) { _ = json.NewEncoder(w).Encode(v) }
func daily(id, state string) map[string]any {
	now := time.Now()
	return map[string]any{"campaignId": id, "claimStatus": state, "actionType": "CLAIM_BENEFIT", "startAt": now.Add(-time.Hour).Unix(), "endAt": now.Add(23 * time.Hour).Unix(), "benefit": map[string]any{"kind": "CREDITS", "amount": 100}}
}

func TestLoginPKCEAndPollIdentity(t *testing.T) {
	l, err := NewLogin()
	if err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(l.URL)
	callback, _ := url.Parse(u.Query().Get("oauth_callback"))
	digest := sha256.Sum256([]byte(l.verifier))
	if u.Host != "qoder.cn" || u.Path != "/sso/login/aliyun" || callback.Query().Get("challenge") != base64.RawURLEncoding.EncodeToString(digest[:]) || strings.Contains(l.URL, l.verifier) {
		t.Fatal("invalid PKCE authorization URL")
	}
	mode := "pending"
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("verifier") != l.verifier || r.Header.Get("Authorization") != "" {
			t.Error("invalid polling request")
		}
		if mode == "pending" {
			w.WriteHeader(404)
			return
		}
		nonce := l.nonce
		if mode == "wrong" {
			nonce = "another-flow"
		}
		reply(w, map[string]any{"nonce": nonce, "user_id": "user-a", "token": "dt-secret", "refresh_token": "drt-secret", "expires_in": 2591999999})
	})
	if a, err := c.Poll(context.Background(), l); err != nil || a != nil {
		t.Fatalf("pending: %v", err)
	}
	mode = "wrong"
	if _, err := c.Poll(context.Background(), l); err == nil {
		t.Fatal("accepted wrong nonce")
	}
	mode = "success"
	a, err := c.Poll(context.Background(), l)
	if err != nil || a.AccountUID != "user-a" || time.Until(a.ExpiresAt) < 29*24*time.Hour {
		t.Fatalf("poll: %v", err)
	}
}

func TestBalanceRejectsUnknownAndAddsQuotas(t *testing.T) {
	for _, tc := range []struct {
		body  string
		want  float64
		valid bool
	}{
		{`{"data":{"qoderUsage":{"userId":"a","userQuota":{"remaining":"180","total":300},"addOnQuota":{"total":100,"used":40}}}}`, 240, true},
		{`{"qoderUsage":{"userQuota":{"remaining":null}}}`, 0, false},
		{`{"qoderUsage":{"userQuota":{"total":100}}}`, 0, false},
		{`{"qoderUsage":{"userId":"other","userQuota":{"remaining":100}}}`, 0, false},
		{`{"qoderUsage":{"userQuota":{"remaining":0,"total":100}}}`, 0, true},
	} {
		c := testClient(t, func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(tc.body)) })
		a := Account{AccountUID: "a"}
		err := c.balance(context.Background(), &a)
		if (err == nil) != tc.valid || tc.valid && (!a.BalanceKnown || a.Credits != tc.want) {
			t.Fatalf("%s: %+v, %v", tc.body, a, err)
		}
	}
}

func TestDailyClaimConfirmsAfterLostResponseWithoutRetry(t *testing.T) {
	posts := 0
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			posts++
			if r.ContentLength != 0 || r.URL.Path != "/sash/api/v1/me/campaigns/daily/claim" {
				t.Error("invalid claim request")
			}
			w.WriteHeader(503)
			return
		}
		state := "CLAIMABLE"
		if posts > 0 {
			state = "CLAIMED"
		}
		reply(w, map[string]any{"campaigns": []any{daily("daily", state)}})
	})
	a := Account{}
	if err := c.checkin(context.Background(), &a, true); err != nil {
		t.Fatal(err)
	}
	if posts != 1 || !status(a).CheckinDone {
		t.Fatalf("posts=%d, done=%v", posts, status(a).CheckinDone)
	}
}

func TestDailyCampaignEligibilityAndUnconfirmedResult(t *testing.T) {
	for _, mode := range []string{"empty", "expired", "month-promo", "view", "unconfirmed", "already", "partial"} {
		t.Run(mode, func(t *testing.T) {
			posts := 0
			c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "POST" {
					posts++
					reply(w, map[string]any{"ok": true})
					return
				}
				d := daily("daily", "CLAIMABLE")
				list := []any{d}
				switch mode {
				case "empty":
					list = []any{}
				case "expired":
					d["startAt"], d["endAt"] = time.Now().Add(-48*time.Hour).Unix(), time.Now().Add(-24*time.Hour).Unix()
				case "month-promo":
					d["endAt"] = time.Now().Add(30 * 24 * time.Hour).Unix()
				case "view":
					d["actionType"] = "VIEW_DETAILS"
				case "already":
					d["claimStatus"] = "CLAIMED"
				case "partial":
					d["claimStatus"] = "CLAIMED"
					list = append(list, daily("locked", "LOCKED"))
				}
				reply(w, map[string]any{"campaigns": list})
			})
			a := Account{LastPeriod: RewardPeriod(time.Now()), ClaimedUntil: time.Now().Add(time.Hour)}
			err := c.checkin(context.Background(), &a, true)
			if (err == nil) != (mode == "already") || status(a).CheckinDone != (mode == "already") {
				t.Fatalf("err=%v, done=%v", err, status(a).CheckinDone)
			}
			wantPosts := 0
			if mode == "unconfirmed" {
				wantPosts = 1
			}
			if posts != wantPosts {
				t.Fatalf("posts=%d, want=%d", posts, wantPosts)
			}
		})
	}
}

func TestRewardPeriodBoundary(t *testing.T) {
	for _, tc := range []struct{ instant, period string }{
		{"2026-11-01T01:59:59Z", "2026-10-31"},
		{"2026-11-01T02:00:00Z", "2026-11-01"},
		{"2026-11-01T23:00:00Z", "2026-11-01"},
	} {
		now, _ := time.Parse(time.RFC3339, tc.instant)
		if RewardPeriod(now) != tc.period {
			t.Fatalf("%s: %s", tc.instant, RewardPeriod(now))
		}
	}
}

func TestIdentifyUsesAuthenticatedUsageWhenUserinfoRemoved(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/userinfo" {
			w.WriteHeader(404)
			return
		}
		reply(w, map[string]any{"qoderUsage": map[string]any{"userId": "account-a"}})
	})
	a := Account{AccountUID: "account-a", Token: "dt-secret"}
	if err := c.identify(context.Background(), &a); err != nil {
		t.Fatal(err)
	}
	a.AccountUID = "account-b"
	if err := c.identify(context.Background(), &a); err == nil {
		t.Fatal("accepted mismatched usage identity")
	}
}

func TestDesktopCredentialRefreshesAndChecksIdentity(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/userinfo":
			if r.Method != "GET" {
				t.Error("userinfo must use GET")
			}
			reply(w, map[string]any{"id": "user-a", "name": "Real name"})
		case "/api/v1/deviceToken/refresh":
			reply(w, map[string]any{"token": "dt-renewed", "refresh_token": "drt-renewed", "expires_in": 2591999999, "refresh_token_expires_in": 31103999999})
		default:
			w.WriteHeader(404)
		}
	})
	s, _ := Open(filepath.Join(t.TempDir(), "accounts.json"), c)
	_ = s.commit([]Account{{ID: "qoder-a", AccountUID: "user-a", Token: "dt-old", RefreshToken: "drt-old", ExpiresAt: time.Now().Add(time.Hour)}})
	a, err := s.DesktopCredential(context.Background(), "qoder-a")
	if err != nil || a.UID != "user-a" || a.Token != "dt-renewed" || a.Name != "Real name" || time.Until(a.RefreshExpiresAt) < 300*24*time.Hour {
		t.Fatalf("credential not prepared: %v", err)
	}
	if s.snapshot()[0].RefreshToken != "drt-renewed" {
		t.Fatal("rotated native refresh token not persisted")
	}
}

func TestDesktopRenewalsAreRetainedBeforeLeavingCurrentAccount(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		reply(w, map[string]any{"id": "user-a", "name": "Native name"})
	})
	s, _ := Open(filepath.Join(t.TempDir(), "accounts.json"), c)
	_ = s.commit([]Account{{ID: "a", AccountUID: "user-a", Token: "dt-old", RefreshToken: "drt-old", ExpiresAt: time.Now().Add(time.Hour)}})
	s.SetDesktopSource(func() *Account {
		return &Account{AccountUID: "user-a", Token: "dt-native-renewed", RefreshToken: "drt-native-renewed", ExpiresAt: time.Now().Add(24 * time.Hour), RefreshExpiresAt: time.Now().Add(30 * 24 * time.Hour)}
	})
	accounts := s.snapshot()
	if err := s.syncDesktop(context.Background(), accounts); err != nil {
		t.Fatal(err)
	}
	if got := s.snapshot()[0]; got.Token != "dt-native-renewed" || got.Nickname != "Native name" {
		t.Fatal("native renewal not retained")
	}
	// A future credential claiming another UID must not replace this account.
	s.SetDesktopSource(func() *Account {
		return &Account{AccountUID: "user-a", Token: "dt-mismatched", RefreshToken: "drt-other", ExpiresAt: time.Now().Add(48 * time.Hour)}
	})
	c.HTTP.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"id":"someone-else"}`)), Header: make(http.Header)}, nil
	})
	if err := s.syncDesktop(context.Background(), s.snapshot()); err == nil {
		t.Fatal("accepted another identity from native storage")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestStoreIdentityGuardRefreshRotationAndPublicStatus(t *testing.T) {
	uid := "a"
	failBalance := false
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/userinfo":
			reply(w, map[string]any{"uid": uid, "nickname": "Alice"})
		case "/sash/api/v2/me/usage":
			if failBalance {
				w.WriteHeader(503)
				_, _ = w.Write([]byte("private-upstream-secret"))
				return
			}
			reply(w, map[string]any{"qoderUsage": map[string]any{"userQuota": map[string]any{"remaining": 200, "total": 300}}})
		case "/sash/api/v1/me/campaigns":
			reply(w, map[string]any{"campaigns": []any{daily("daily", "CLAIMED")}})
		case "/api/v1/deviceToken/refresh":
			reply(w, map[string]any{"device_token": "dt-rotated-secret", "refresh_token": "drt-rotated-secret", "expires_in": 3600})
		default:
			t.Errorf("unexpected %s", r.URL.Path)
			w.WriteHeader(404)
		}
	})
	path := filepath.Join(t.TempDir(), "accounts.json")
	s, _ := Open(path, c)
	a, _, err := s.Add(context.Background(), Account{Token: "dt-secret", RefreshToken: "drt-secret", ExpiresAt: time.Now().Add(-time.Hour)}, "")
	if err != nil {
		t.Fatal(err)
	}
	uid = "b"
	if _, _, err = s.Add(context.Background(), Account{Token: "dt-other"}, a.UID); err == nil || len(s.List()) != 1 {
		t.Fatal("wrong account update accepted")
	}
	failBalance = true
	if _, _, err = s.Action(context.Background(), a.UID, "balance"); err == nil {
		t.Fatal("expected balance failure")
	}
	reopened, err := Open(path, c)
	if err != nil || reopened.snapshot()[0].RefreshToken != "drt-rotated-secret" {
		t.Fatalf("rotation lost: %v", err)
	}
	public, _ := json.Marshal(reopened.List())
	if strings.Contains(string(public), "secret") || strings.Contains(string(public), "token\"") || !strings.Contains(string(public), "HTTP 503") {
		t.Fatalf("unsafe public status: %s", public)
	}
	_, _, _ = s.Action(context.Background(), a.UID, "disable")
	if _, _, err = s.Action(context.Background(), a.UID, "checkin"); err == nil {
		t.Fatal("disabled account claimed")
	}
	_, _, _ = s.Action(context.Background(), a.UID, "remove")
	reopened, _ = Open(path, c)
	if len(reopened.List()) != 0 {
		t.Fatal("remove did not persist")
	}
}
