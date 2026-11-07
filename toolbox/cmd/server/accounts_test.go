package main

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/linguo2625469/workbuddy2api-panel/internal/panel"
	"github.com/linguo2625469/workbuddy2api-panel/internal/pool"
	"github.com/linguo2625469/workbuddy2api-panel/internal/scheduler"
)

func TestAccountHandlerRestrictsRoutes(t *testing.T) {
	p := pool.New("")
	defer p.Close()
	h := accountHandler(panel.New(panel.Config{AccountsOnly: true, Pool: p, APIKey: "secret"}))
	for _, tc := range []struct {
		method, path string
		status       int
	}{
		{"GET", "/", 303},
		{"GET", "/panel/", 200},
		{"GET", "/panel/accounts.js", 200},
		{"GET", "/panel/index.css", 200},
		{"GET", "/panel/src/main.js", 404},
		{"GET", "/healthz", 200},
		{"GET", "/panel/api/overview", 401},
		{"GET", "/panel/api/trae/login/available", 401},
		{"POST", "/panel/api/trae/login/start", 401},
		{"GET", "/panel/api/trae/login/poll", 401},
		{"POST", "/panel/api/trae/login/cancel", 401},
		{"POST", "/panel/api/trae/accounts", 401},
		{"POST", "/panel/api/trae/import", 401},
		{"POST", "/panel/api/trae/checkin_all", 401},
		{"POST", "/panel/api/trae/balance_all", 401},
		{"POST", "/panel/api/trae/accounts/t1/remove", 401},
		{"POST", "/panel/api/checkin_all", 401},
		{"POST", "/panel/api/login/start", 401},
		{"POST", "/panel/api/config", 401},
		{"POST", "/panel/api/accounts/u1/remove", 401},
		{"GET", "/v1/models", 404},
		{"POST", "/v1/chat/completions", 404},
		{"POST", "/v1/search/messages", 404},
		{"GET", "/status", 404},
		{"GET", "/panel/api/models", 404},
		{"GET", "/panel/api/usage", 404},
		{"POST", "/panel/api/accounts/u1/tasks/auto_all", 404},
		{"POST", "/panel/api/travel_all", 404},
		{"POST", "/panel/api/activity_all", 404},
	} {
		t.Run(tc.method+tc.path, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(tc.method, tc.path, nil))
			if rec.Code != tc.status {
				t.Fatalf("status=%d want=%d body=%s", rec.Code, tc.status, rec.Body.String())
			}
		})
	}
	req := httptest.NewRequest("GET", "/panel/api/overview", nil)
	req.Header.Set("Authorization", "Bearer secret")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"accounts"`) {
		t.Fatalf("authenticated overview: %d %s", rec.Code, rec.Body.String())
	}
}

func TestAccountSettingsPersistence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "data", "account-settings.json")
	s, err := loadAccountSettings(path, Default())
	if err != nil {
		t.Fatal(err)
	}
	sch := scheduler.New(scheduler.Config{})
	if _, err := s.save([]byte(`{"checkin_enabled":false,"checkin_hours":[8,20]}`), sch); err != nil {
		t.Fatal(err)
	}
	reloaded, err := loadAccountSettings(path, Default())
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.schedule.Enabled || len(reloaded.schedule.Hours) != 2 || reloaded.schedule.Hours[0] != 8 {
		t.Fatalf("saved settings not restored: %+v", reloaded.schedule)
	}
	if !reloaded.schedule.RefreshAfterCheckin || !reloaded.schedule.CatchupOnStart {
		t.Fatal("missing optional settings must preserve enabled defaults")
	}
	before, _ := os.ReadFile(path)
	for _, raw := range []string{
		`{"checkin_enabled":true,"checkin_hours":[]}`,
		`{"checkin_enabled":true,"checkin_hours":[24]}`,
		`{"checkin_enabled":true,"checkin_hours":[-1]}`,
		`{"checkin_enabled":true,"checkin_hours":[9,9]}`,
		`{"checkin_enabled":true,"checkin_hours":[9.5]}`,
		`{"checkin_enabled":true,"checkin_hours":[9],"api_key":""}`,
		`{"checkin_enabled":true,"checkin_hours":[9]} {}`,
		`null`,
	} {
		if _, err := s.save([]byte(raw), sch); err == nil {
			t.Errorf("accepted invalid settings: %s", raw)
		}
	}
	after, _ := os.ReadFile(path)
	if string(after) != string(before) || s.schedule.Enabled || s.schedule.Hours[0] != 8 {
		t.Fatal("invalid update changed settings")
	}
}

func TestAccountOptionsPersistence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "account-settings.json")
	// Old settings files gain the new options with the previous behavior as defaults.
	if err := os.WriteFile(path, []byte(`{"checkin_enabled":true,"checkin_hours":[9,21]}`), 0600); err != nil {
		t.Fatal(err)
	}
	s, err := loadAccountSettings(path, Default())
	if err != nil {
		t.Fatal(err)
	}
	if !s.schedule.RefreshAfterCheckin || !s.schedule.CatchupOnStart {
		t.Fatal("old settings did not receive defaults")
	}
	sch := scheduler.New(scheduler.Config{CheckinOnly: true})
	if _, err := s.save([]byte(`{"refresh_after_checkin":false,"catchup_on_start":false}`), sch); err != nil {
		t.Fatal(err)
	}
	reloaded, err := loadAccountSettings(path, Default())
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.schedule.RefreshAfterCheckin || reloaded.schedule.CatchupOnStart || sch.CheckinRefreshEnabled() {
		t.Fatal("new options were not persisted and applied")
	}
}
