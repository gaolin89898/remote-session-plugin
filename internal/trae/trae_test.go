package trae

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func testToken(uid string, expiry time.Time) string {
	payload, _ := json.Marshal(map[string]any{"data": map[string]any{"id": uid}, "exp": expiry.Unix()})
	return "eyJhbGciOiJub25lIn0." + base64.RawURLEncoding.EncodeToString(payload) + ".test-signature"
}

func TestProfileUsesSessionAndPreservesNumericUID(t *testing.T) {
	const uid = "90071992547409931234"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie("X-Cloudide-Session")
		if err != nil || cookie.Value != "web-session" || !strings.HasPrefix(r.Header.Get("Authorization"), "Cloud-IDE-JWT ") {
			w.WriteHeader(401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"Result":{"UserID":` + uid + `,"ScreenName":"网页账号"}}`))
	}))
	defer server.Close()
	client := NewClient()
	client.base = server.URL
	a := Account{Token: testToken(uid, time.Now().Add(time.Hour)), Session: "web-session", DeviceID: "1234567890123456"}
	if err := client.identify(context.Background(), &a); err != nil {
		t.Fatal(err)
	}
	if a.AccountUID != uid || a.Nickname != "网页账号" {
		t.Fatal("profile identifier was lost or rounded")
	}
}

func TestBalanceUsesCreditSummaryWithMixedEntitlements(t *testing.T) {
	for _, tc := range []struct {
		name, body       string
		remaining, total float64
		wantError        bool
	}{
		{"mixed privileges and credits", `{"is_credits_billing":true,"is_dollar_usage_billing":false,"usage_summary":{"total_amount":1500,"consumed_amount":0},"user_entitlement_pack_list":[{"entitlement_base_info":{"quota":{"enable_solo_agent":true}},"usage":{}},{"entitlement_base_info":{"quota":{"credits_limit":500}},"usage":{}}]}`, 1500, 1500, false},
		{"decimal strings", `{"is_credits_billing":true,"usage_summary":{"total_amount":"1500.5","consumed_amount":"20.25"}}`, 1480.25, 1500.5, false},
		{"known zero", `{"is_credits_billing":true,"usage_summary":{"total_amount":0,"consumed_amount":0}}`, 0, 0, false},
		{"overdrawn", `{"is_credits_billing":true,"usage_summary":{"total_amount":100,"consumed_amount":120}}`, 0, 100, false},
		{"missing consumed", `{"is_credits_billing":true,"usage_summary":{"total_amount":100}}`, 0, 0, true},
		{"malformed summary", `{"is_credits_billing":true,"usage_summary":{"total_amount":"bad","consumed_amount":0}}`, 0, 0, true},
		{"negative total", `{"is_credits_billing":true,"usage_summary":{"total_amount":-1,"consumed_amount":0}}`, 0, 0, true},
		{"nonfinite", `{"is_credits_billing":true,"usage_summary":{"total_amount":"Infinity","consumed_amount":0}}`, 0, 0, true},
		{"dollar billing", `{"is_credits_billing":false,"is_dollar_usage_billing":true,"usage_summary":{"total_amount":10,"consumed_amount":2}}`, 0, 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(tc.body)) }))
			defer server.Close()
			client := NewClient()
			client.base = server.URL
			a := Account{Token: testToken("balance-user", time.Now().Add(time.Hour)), Credits: 42, Total: 50, BalanceKnown: true}
			err := client.balance(context.Background(), &a)
			if tc.wantError {
				if err == nil || a.Credits != 42 || a.Total != 50 {
					t.Fatal("invalid summary replaced last known balance")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if a.Credits != tc.remaining || a.Total != tc.total || !a.BalanceKnown || a.BalanceUpdatedAt.IsZero() {
				t.Fatalf("incorrect credit summary: %+v", a)
			}
		})
	}
}

func TestRestrictedCheckinReportsStageWithoutRetrying(t *testing.T) {
	for _, stage := range []string{"status", "claim", "confirm"} {
		t.Run(stage, func(t *testing.T) {
			statuses, claims, renewals := 0, 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/trae/api/v2/ug/checkin_credits/status":
					statuses++
					if stage == "status" || stage == "confirm" && statuses == 2 {
						w.Write([]byte(`{"code":9074,"message":"private-session-token"}`))
					} else {
						w.Write([]byte(`{"code":0,"enable":true,"checked_in":false}`))
					}
				case "/trae/api/v2/ug/checkin_credits/claim":
					claims++
					if stage == "claim" {
						w.Write([]byte(`{"code":-9074,"message":"private-session-token"}`))
					} else {
						w.Write([]byte(`{"code":0}`))
					}
				default:
					renewals++
					t.Error("restricted check-in attempted credential renewal")
				}
			}))
			defer server.Close()
			client := NewClient()
			client.base = server.URL
			a := Account{Token: testToken("restricted", time.Now().Add(time.Hour)), Session: "private-session-token"}
			err := client.checkin(context.Background(), &a)
			expected := map[string]string{"status": "查询签到状态失败", "claim": "领取签到奖励失败", "confirm": "确认签到结果失败"}[stage]
			if err == nil || !strings.Contains(err.Error(), expected) || !strings.Contains(err.Error(), "9074") || strings.Contains(err.Error(), "private-session-token") {
				t.Fatalf("incorrect restriction diagnostic: %v", err)
			}
			if claims > 1 || renewals != 0 || stage == "status" && claims != 0 || a.LastCheckinDate != "" {
				t.Fatal("restricted claim retried or marked successful")
			}
		})
	}
}

func TestCancelledAddDoesNotWaitForScheduledOperation(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "trae.json"), nil)
	if err != nil {
		t.Fatal(err)
	}
	s.op.Lock()
	defer s.op.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() { _, _, err := s.Add(ctx, Account{Token: "unused"}); result <- err }()
	cancel()
	select {
	case err := <-result:
		if err != context.Canceled {
			t.Fatalf("cancelled Add returned %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled login waited for another operation")
	}
	if len(s.List()) != 0 {
		t.Fatal("cancelled login changed accounts")
	}
}

type upstreamFixture struct {
	mu                                        sync.Mutex
	checked                                   bool
	claims, refreshes, balances               int
	badBalance, authFailure, claimUnconfirmed bool
	token                                     string
}

func testStore(t *testing.T) (*Store, *upstreamFixture) {
	t.Helper()
	f := &upstreamFixture{token: testToken("user-001", time.Now().Add(time.Hour))}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if r.Method != "POST" {
			t.Error("Trae endpoints must use POST")
		}
		if r.URL.Path == "/cloudide/api/v3/common/GetUserToken" {
			f.refreshes++
			cookie, err := r.Cookie("X-Cloudide-Session")
			if err != nil || cookie.Value != "private-session-for-test" {
				t.Error("missing session cookie")
			}
			if r.Header.Get("Authorization") != "" {
				t.Error("token refresh must use session authentication")
			}
			json.NewEncoder(w).Encode(map[string]any{"Result": map[string]any{"Token": f.token}})
			return
		}
		if f.authFailure {
			w.WriteHeader(401)
			w.Write([]byte(`{"message":"private-session-for-test"}`))
			return
		}
		if r.Header.Get("Authorization") != "Cloud-IDE-JWT "+f.token || r.Header.Get("X-User-Region") != "cn" || len(r.Header.Get("x-device-id")) != 16 {
			t.Error("incorrect Trae authentication headers")
		}
		switch r.URL.Path {
		case "/cloudide/api/v3/trae/GetUserInfo":
			w.Write([]byte(`{"Result":{"UserID":"user-001","ScreenName":"Trae 测试账号"}}`))
		case "/trae/api/v2/ug/checkin_credits/status":
			json.NewEncoder(w).Encode(map[string]any{"code": 0, "enable": true, "checked_in": f.checked})
		case "/trae/api/v2/ug/checkin_credits/claim":
			f.claims++
			if !f.claimUnconfirmed {
				f.checked = true
			}
			w.Write([]byte(`{"code":0}`))
		case "/trae/api/v2/pay/user_current_entitlement_list":
			f.balances++
			if f.badBalance {
				w.Write([]byte(`{"user_entitlement_pack_list":[{"entitlement_base_info":{"quota":{"credits_limit":"bad"}},"usage":{"credits_amount":"1"}}]}`))
				return
			}
			w.Write([]byte(`{"user_entitlement_pack_list":[{"entitlement_base_info":{"quota":{"credits_limit":"150.5"}},"usage":{"credits_amount":"20.25"}},{"entitlement_base_info":{"quota":{"credits_limit":50}},"usage":{"credits_amount":100}}]}`))
		default:
			t.Errorf("unexpected Trae endpoint %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(server.Close)
	client := NewClient()
	client.base = server.URL
	client.HTTP = server.Client()
	s, err := Open(filepath.Join(t.TempDir(), "trae-accounts.json"), client)
	if err != nil {
		t.Fatal(err)
	}
	return s, f
}

func TestAccountLifecycleAndCredentialIsolation(t *testing.T) {
	s, f := testStore(t)
	a, warnings, err := s.Add(context.Background(), Account{Session: "Cookie: X-Cloudide-Session=private-session-for-test; other=test", DeviceID: "1234567890123456"})
	if err != nil || len(warnings) != 0 {
		t.Fatalf("add: %v %v", err, warnings)
	}
	if a.Credits != 130.25 || a.Total != 200.5 || !a.BalanceKnown || a.CheckinDone || f.refreshes != 1 {
		t.Fatalf("incorrect initial account: %+v", a)
	}
	public, _ := json.Marshal(s.List())
	if strings.Contains(string(public), "private-session-for-test") || strings.Contains(string(public), f.token) || strings.Contains(string(public), "1234567890123456") {
		t.Fatal("public account status leaked credentials")
	}
	s.SetRefreshEnabled(false)
	if _, _, err := s.Action(context.Background(), a.UID, "checkin"); err != nil {
		t.Fatal(err)
	}
	if f.claims != 1 || f.balances != 1 || !s.List()[0].CheckinDone {
		t.Fatal("check-in or refresh option did not apply")
	}
	if errs := s.RunAll(context.Background(), "checkin"); len(errs) != 0 || f.claims != 1 {
		t.Fatal("same-day automatic check-in should skip completed accounts")
	}
	reopened, err := Open(s.path, s.client)
	if err != nil || !reopened.List()[0].CheckinDone {
		t.Fatal("check-in date did not survive restart")
	}
	if _, _, err = s.Action(context.Background(), a.UID, "disable"); err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.Action(context.Background(), a.UID, "checkin"); err == nil {
		t.Fatal("disabled account was checked in")
	}
	// Updating credentials keeps stable ID, device, disabled state and signed date.
	updated, _, err := s.Add(context.Background(), Account{Token: f.token})
	if err != nil || updated.UID != a.UID || !updated.Disabled || s.snapshot()[0].DeviceID != "1234567890123456" {
		t.Fatalf("credential update lost account state: %v %+v", err, updated)
	}
	if _, _, err = s.Action(context.Background(), a.UID, "revive"); err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.Action(context.Background(), a.UID, "remove"); err != nil || len(s.List()) != 0 {
		t.Fatal("remove failed")
	}
	reopened, err = Open(s.path, s.client)
	if err != nil || len(reopened.List()) != 0 {
		t.Fatal("removed credentials remained in the store")
	}
}

func TestFailedBalanceAndUnconfirmedClaimPreserveState(t *testing.T) {
	s, f := testStore(t)
	a, _, err := s.Add(context.Background(), Account{Token: f.token, Session: "private-session-for-test"})
	if err != nil {
		t.Fatal(err)
	}
	f.badBalance = true
	if _, _, err = s.Action(context.Background(), a.UID, "balance"); err == nil {
		t.Fatal("malformed credits must fail")
	}
	if s.List()[0].Credits != 130.25 {
		t.Fatal("failed balance refresh overwrote the last good snapshot")
	}
	f.claimUnconfirmed = true
	if _, _, err = s.Action(context.Background(), a.UID, "checkin"); err == nil || s.List()[0].CheckinDone {
		t.Fatal("unconfirmed claim was recorded as a successful check-in")
	}
	f.authFailure = true
	if _, _, err = s.Action(context.Background(), a.UID, "balance"); err == nil {
		t.Fatal("invalid authentication must fail")
	}
	if f.refreshes != 1 {
		t.Fatal("expired token should refresh once before retry")
	}
	if strings.Contains(s.List()[0].LastError, "private-session") {
		t.Fatal("upstream error leaked a credential")
	}
}

func TestTokenExpiryNormalizationAndDayBoundary(t *testing.T) {
	token := testToken("account-007", time.Unix(1800000000, 0))
	uid, expiry := tokenInfo(token)
	if uid != "account-007" || expiry.Unix() != 1800000000 {
		t.Fatal("JWT identity/expiry not parsed")
	}
	if chinaDay(time.Date(2026, 11, 1, 16, 0, 0, 0, time.UTC)) != "2026-11-02" {
		t.Fatal("check-in day must follow Beijing midnight")
	}
	if _, err := normalizeCredential("abc\r\nX-Injected: true", true); err == nil {
		t.Fatal("header injection accepted")
	}
	if _, err := normalizeCredential(strings.Repeat("s", 32769), true); err == nil {
		t.Fatal("oversized credential accepted")
	}
	if value, err := normalizeCredential("Authorization: Cloud-IDE-JWT "+token, false); err != nil || value != token {
		t.Fatal("authorization header normalization failed")
	}
}

func TestTraeToolsEncryptedBackupAndMerge(t *testing.T) {
	// Independent published PBKDF2-SHA256 test vector.
	if got := hex.EncodeToString(deriveKey("password", []byte("salt"), 2)); got != "ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43" {
		t.Fatalf("PBKDF2 mismatch: %s", got)
	}
	s, f := testStore(t)
	plain, _ := json.Marshal(map[string]any{"Accounts": []map[string]any{{"AccountUid": "user-001", "Name": "从备份导入", "Token": f.token, "Session": "private-session-for-test", "DeviceId": "1234567890123456", "Enabled": false}}})
	salt, nonce := []byte("0123456789abcdef"), []byte("0123456789ab")
	key := deriveKey("backup-password", salt, 200000)
	block, _ := aes.NewCipher(key)
	gcm, _ := cipher.NewGCM(block)
	sealed := gcm.Seal(nil, nonce, plain, nil)
	encode := base64.StdEncoding.EncodeToString
	backup, _ := json.Marshal(map[string]any{"App": "TraeTools", "Type": "account-backup", "Version": 1, "Kdf": "PBKDF2-SHA256", "Cipher": "AES-256-GCM", "Iterations": 200000, "Salt": encode(salt), "Nonce": encode(nonce), "Payload": encode(sealed[:len(sealed)-16]), "Tag": encode(sealed[len(sealed)-16:])})
	if _, err := s.Import(backup, "wrong-password"); err == nil || len(s.List()) != 0 {
		t.Fatal("wrong password changed store")
	}
	result, err := s.Import(backup, "backup-password")
	if err != nil || result.Imported != 1 || !s.List()[0].Disabled || s.List()[0].BalanceKnown {
		t.Fatalf("encrypted import: %v %+v", err, result)
	}
	result, err = s.Import(plain, "")
	if err != nil || result.Updated != 1 || len(s.List()) != 1 {
		t.Fatal("reimport should update credentials without duplicating accounts")
	}
	before, _ := os.ReadFile(s.path)
	if _, err = s.Import([]byte(`{"Accounts":[{"Token":""}]}`), ""); err == nil {
		t.Fatal("empty credential accepted")
	}
	after, _ := os.ReadFile(s.path)
	if string(before) != string(after) {
		t.Fatal("invalid import mutated saved credentials")
	}
	if _, err = s.Import([]byte(`{"App":"TraeTools","Type":"account-backup","Version":999}`), "x"); err == nil {
		t.Fatal("unsupported backup version accepted")
	}
}

func TestStoreWriteFailureDoesNotPublishMutation(t *testing.T) {
	s, f := testStore(t)
	a, _, err := s.Add(context.Background(), Account{Token: f.token})
	if err != nil {
		t.Fatal(err)
	}
	badPath := filepath.Join(t.TempDir(), "not-a-directory")
	if err = os.WriteFile(badPath, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	s.path = filepath.Join(badPath, "trae.json")
	if _, _, err = s.Action(context.Background(), a.UID, "remove"); err == nil || len(s.List()) != 1 {
		t.Fatal("failed storage update changed live accounts")
	}
}

func TestSessionOnlyImportMergesWithVerifiedLogin(t *testing.T) {
	s, _ := testStore(t)
	if _, err := s.Import([]byte(`{"Accounts":[{"Session":"private-session-for-test","DeviceId":"1234567890123456"}]}`), ""); err != nil {
		t.Fatal(err)
	}
	original := s.List()[0].UID
	verified, _, err := s.Add(context.Background(), Account{Session: "private-session-for-test"})
	if err != nil || len(s.List()) != 1 || verified.UID != original || verified.AccountUID != "user-001" {
		t.Fatalf("session-only import was duplicated instead of updated: %v %+v", err, verified)
	}
}
