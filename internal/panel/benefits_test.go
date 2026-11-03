package panel

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/linguo2625469/workbuddy2api-panel/internal/auth"
	"github.com/linguo2625469/workbuddy2api-panel/internal/pool"
	"github.com/linguo2625469/workbuddy2api-panel/internal/upstream"
)

func benefitTestPanel(t *testing.T, handler http.HandlerFunc) *Panel {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	up := upstream.New()
	up.ChatBaseCN, up.BillingBaseCN, up.WebBaseCN = srv.URL, srv.URL, srv.URL
	accounts := pool.New("")
	t.Cleanup(accounts.Close)
	accounts.Add(&auth.Auth{UID: "personal", AccessToken: "test-token"})
	accounts.Add(&auth.Auth{UID: "global", Domain: "www.workbuddy.ai"})
	accounts.Add(&auth.Auth{UID: "enterprise", EnterpriseID: "company"})
	accounts.Add(&auth.Auth{UID: "enterprise-session", AccessToken: "header." + base64.RawURLEncoding.EncodeToString([]byte(`{"token_source":"enterprise_switch"}`)) + ".signature"})
	accounts.Add(&auth.Auth{UID: "disabled"})
	accounts.Disable("disabled", "test")
	p := New(Config{AccountsOnly: true, APIKey: "benefits-test", Pool: accounts, Upstream: up})
	t.Cleanup(p.Close)
	return p
}

func benefitRequest(p *Panel, method, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "/panel/api/"+path, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer benefits-test")
	w := httptest.NewRecorder()
	p.ServeHTTP(w, r)
	return w
}

func TestBenefitRoutesScopeAndAuthentication(t *testing.T) {
	p := benefitTestPanel(t, func(w http.ResponseWriter, r *http.Request) { t.Error("unexpected upstream request") })
	for _, route := range []struct{ method, path string }{
		{"GET", "accounts/personal/tasks"}, {"POST", "accounts/personal/tasks/accept"},
		{"POST", "accounts/personal/tasks/claim"}, {"POST", "accounts/personal/tasks/auto"},
		{"GET", "benefits/accounts/personal/rewards"}, {"POST", "benefits/accounts/personal/rewards"},
		{"POST", "tasks/scan_all"}, {"POST", "tasks/run_queue"}, {"GET", "tasks/queue"},
		{"GET", "packages"}, {"GET", "credit_history"},
	} {
		w := httptest.NewRecorder()
		p.ServeHTTP(w, httptest.NewRequest(route.method, "/panel/api/"+route.path, nil))
		if w.Code != 401 {
			t.Errorf("unauthenticated %s: %d", route.path, w.Code)
		}
	}
	for _, uid := range []string{"global", "enterprise", "missing"} {
		want := 400
		if uid == "missing" {
			want = 404
		}
		for _, path := range []string{"accounts/" + uid + "/tasks", "benefits/accounts/" + uid + "/rewards"} {
			if w := benefitRequest(p, "GET", path, ""); w.Code != want {
				t.Errorf("%s: %d", path, w.Code)
			}
		}
	}
	for _, path := range []string{"accounts/disabled/tasks/accept", "accounts/disabled/tasks/claim", "accounts/disabled/tasks/auto", "benefits/accounts/disabled/rewards"} {
		if w := benefitRequest(p, "POST", path, `{}`); w.Code != 409 {
			t.Errorf("disabled %s: %d", path, w.Code)
		}
	}
	for _, path := range []string{"models", "usage", "travel_all", "activity_all"} {
		if w := benefitRequest(p, "GET", path, ""); w.Code != 404 {
			t.Errorf("unrelated route exposed %s: %d", path, w.Code)
		}
	}
}

func TestBenefitOverviewEligibility(t *testing.T) {
	p := benefitTestPanel(t, func(w http.ResponseWriter, r *http.Request) { t.Error("unexpected upstream request") })
	w := benefitRequest(p, "GET", "overview", "")
	var out struct {
		Accounts []benefitAccountStatus `json:"accounts"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &out) != nil {
		t.Fatalf("overview: status %d", w.Code)
	}
	if len(out.Accounts) != 5 {
		t.Fatalf("account count: %d", len(out.Accounts))
	}
	for _, a := range out.Accounts {
		if a.BenefitsSupported != (a.UID == "personal" || a.UID == "enterprise-session") {
			t.Errorf("eligibility for %s: %v", a.UID, a.BenefitsSupported)
		}
		if !a.BenefitsSupported && a.BenefitsReason == "" {
			t.Errorf("missing reason for %s", a.UID)
		}
	}
	if strings.Contains(w.Body.String(), "test-token") || strings.Contains(w.Body.String(), ".signature") {
		t.Fatal("overview exposed credentials")
	}
}

func TestBenefitRewardsQueryPreservesPartialErrors(t *testing.T) {
	var queries atomic.Int32
	p := benefitTestPanel(t, func(w http.ResponseWriter, r *http.Request) {
		queries.Add(1)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/streak"):
			w.Write([]byte(`{"code":0,"data":{"streak":{"days":7}}}`))
		case strings.HasSuffix(r.URL.Path, "/summary"):
			http.Error(w, "lottery unavailable", 503)
		case strings.HasSuffix(r.URL.Path, "/compensation-status"):
			w.Write([]byte(`{"code":0,"data":{"active":false}}`))
		case strings.HasSuffix(r.URL.Path, "/vouchers"):
			w.Write([]byte(`{"code":0,"data":{"items":[]}}`))
		default:
			t.Errorf("unexpected action: %s", r.URL.Path)
			http.Error(w, "unexpected", 500)
		}
	})
	w := benefitRequest(p, "GET", "benefits/accounts/enterprise-session/rewards", "")
	var out struct {
		Streak       *upstream.StreakFull         `json:"streak"`
		Chances      *int                         `json:"chances"`
		Compensation *upstream.CompensationStatus `json:"compensation"`
		Errors       map[string]string            `json:"errors"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &out) != nil {
		t.Fatalf("query: %d %s", w.Code, w.Body)
	}
	if out.Streak == nil || out.Streak.Streak.Days != 7 || out.Compensation == nil || out.Chances != nil || len(out.Errors) != 1 || out.Errors["抽奖活动"] == "" {
		t.Fatalf("partial result lost: %s", w.Body)
	}
	if queries.Load() != 4 {
		t.Fatalf("query made %d upstream requests", queries.Load())
	}
}

func TestBenefitMutationsRecheckAvailabilityAndLocks(t *testing.T) {
	var mutations atomic.Int32
	p := benefitTestPanel(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/streak"):
			w.Write([]byte(`{"code":0,"data":{"streak":{"days":7},"redemption_status":{"tier_7d_status":"claimed","tiers":[{"tier":"7d","days":7}]}}}`))
		case strings.HasSuffix(r.URL.Path, "/summary"):
			w.Write([]byte(`{"code":0,"data":{"chances":0}}`))
		case strings.HasSuffix(r.URL.Path, "/compensation-status"):
			w.Write([]byte(`{"code":0,"data":{"active":true,"claimed":true,"credit_num":500}}`))
		default:
			mutations.Add(1)
			http.Error(w, "mutation must not be sent", 500)
		}
	})
	for _, body := range []string{`{"action":"redeem","tier":"7d"}`, `{"action":"draw"}`, `{"action":"compensation"}`} {
		if w := benefitRequest(p, "POST", "benefits/accounts/personal/rewards", body); w.Code != 409 {
			t.Errorf("availability %s: %d %s", body, w.Code, w.Body)
		}
	}
	for _, body := range []string{`{}`, `null`, `{"action":"unknown"}`, `{"action":"draw"} {}`, `{"action":"draw","extra":true}`} {
		if w := benefitRequest(p, "POST", "benefits/accounts/personal/rewards", body); w.Code != 400 {
			t.Errorf("invalid %s: %d", body, w.Code)
		}
	}
	if !p.tryLockAccount("personal") {
		t.Fatal("lock was not released after rejected action")
	}
	defer p.unlockAccount("personal")
	for _, action := range []struct{ path, body string }{
		{"benefits/accounts/personal/rewards", `{"action":"draw"}`},
		{"accounts/personal/tasks/accept", `{"task_codes":["test"]}`},
		{"accounts/personal/tasks/claim", `{"task_code":"test"}`},
	} {
		if w := benefitRequest(p, "POST", action.path, action.body); w.Code != 409 {
			t.Errorf("lock %s: %d", action.path, w.Code)
		}
	}
	if mutations.Load() != 0 {
		t.Fatal("sent an ineligible mutation")
	}
}

// A switched session is still a personal account. Queries and claims must
// reach upstream, and an upstream rejection must not become a local success.
func TestBenefitSwitchedSessionUsesUpstreamEligibility(t *testing.T) {
	var calls atomic.Int32
	p := benefitTestPanel(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		http.Error(w, "reward unavailable", http.StatusForbidden)
	})
	for _, route := range []struct{ method, path, body string }{
		{"GET", "accounts/enterprise-session/tasks", ""},
		{"POST", "accounts/enterprise-session/tasks/accept", `{"task_codes":["chat_5"]}`},
		{"POST", "accounts/enterprise-session/tasks/claim", `{"task_code":"chat_5"}`},
		{"POST", "accounts/enterprise-session/tasks/auto", `{"task_code":"chat_5"}`},
		{"POST", "benefits/accounts/enterprise-session/rewards", `{"action":"compensation"}`},
	} {
		before := calls.Load()
		w := benefitRequest(p, route.method, route.path, route.body)
		if w.Code != http.StatusBadGateway || calls.Load() <= before {
			t.Errorf("%s: status=%d upstream calls=%d", route.path, w.Code, calls.Load()-before)
		}
	}
}
