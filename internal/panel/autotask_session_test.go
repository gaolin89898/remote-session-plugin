package panel

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Switched personal sessions must be scanned and run through the same action,
// progress verification and reward claim flow as other personal accounts.
func TestSwitchedPersonalSessionAutomaticTasks(t *testing.T) {
	oldGap := reportGap
	reportGap = 0
	t.Cleanup(func() { reportGap = oldGap })
	for _, entry := range []string{"single", "all", "queue"} {
		t.Run(entry, func(t *testing.T) {
			var reports, claims atomic.Int32
			p := benefitTestPanel(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer header.eyJ0b2tlbl9zb3VyY2UiOiJlbnRlcnByaXNlX3N3aXRjaCJ9.signature" {
					t.Errorf("unexpected account reached upstream: %s", r.URL.Path)
				}
				w.Header().Set("Content-Type", "application/json")
				switch {
				case r.URL.Path == "/v2/activity/growth/tasks":
					w.Write([]byte(sweepTasksBody([]map[string]any{
						sweepTask("chat_5", 5, 4+int64(reports.Load()), "accepted", nil),
					})))
				case r.URL.Path == "/v2/report":
					reports.Add(1)
					w.Write([]byte(`{"code":0,"data":{}}`))
				case strings.HasSuffix(r.URL.Path, "/chat_5/claim"):
					if reports.Load() != 1 {
						t.Error("claimed before verified progress")
					}
					claims.Add(1)
					w.Write([]byte(`{"code":0,"data":{"credit":100,"energy":5}}`))
				default:
					t.Errorf("unexpected upstream request: %s", r.URL.Path)
					http.Error(w, "unexpected", 500)
				}
			})
			p.cfg.Pool.Disable("personal", "only test the switched session")
			scan := benefitRequest(p, "POST", "tasks/scan_all", "")
			var scanned struct {
				Pending  int               `json:"pending_count"`
				Accounts []scanAccountItem `json:"accounts"`
			}
			if scan.Code != 200 || json.Unmarshal(scan.Body.Bytes(), &scanned) != nil || scanned.Pending != 1 {
				t.Fatalf("session missing from scan: %d %s", scan.Code, scan.Body)
			}
			found := false
			for _, a := range scanned.Accounts {
				if a.UID == "enterprise-session" && len(a.Growth) == 1 {
					found = true
				}
			}
			if !found {
				t.Fatal("pending task was not assigned to switched personal account")
			}
			switch entry {
			case "single":
				w := benefitRequest(p, "POST", "accounts/enterprise-session/tasks/auto", `{"task_code":"chat_5"}`)
				if w.Code != 200 || !strings.Contains(w.Body.String(), `"claimed":true`) {
					t.Fatalf("single task: %d %s", w.Code, w.Body)
				}
			case "all":
				r := httptest.NewRequest("POST", "/", nil)
				r.SetPathValue("uid", "enterprise-session")
				w := httptest.NewRecorder()
				p.accountTaskAutoAll(w, r)
				if w.Code != 200 || !strings.Contains(w.Body.String(), `"claimed":true`) {
					t.Fatalf("all tasks: %d %s", w.Code, w.Body)
				}
			case "queue":
				w := benefitRequest(p, "POST", "tasks/run_queue", `{"growth":true,"concurrency":1}`)
				if w.Code != 200 {
					t.Fatalf("queue: %d %s", w.Code, w.Body)
				}
				deadline := time.Now().Add(3 * time.Second)
				for {
					q := p.queue()
					q.mu.Lock()
					running := q.running
					items := append([]queueItem(nil), q.items...)
					q.mu.Unlock()
					if !running {
						if len(items) != 1 || items[0].UID != "enterprise-session" || items[0].Status != "done" {
							t.Fatalf("queue failed to execute personal session: %+v", items)
						}
						break
					}
					if time.Now().After(deadline) {
						t.Fatal("queue did not finish")
					}
					time.Sleep(10 * time.Millisecond)
				}
			}
			if reports.Load() != 1 || claims.Load() != 1 {
				t.Fatalf("reports=%d claims=%d, want one of each", reports.Load(), claims.Load())
			}
		})
	}
}

func TestAutomaticTasksStillRejectEnterpriseAccounts(t *testing.T) {
	p := benefitTestPanel(t, func(w http.ResponseWriter, r *http.Request) { t.Error("enterprise account reached upstream") })
	for _, handler := range []http.HandlerFunc{p.accountTaskAuto, p.accountTaskAutoAll} {
		r := httptest.NewRequest("POST", "/", strings.NewReader(`{"task_code":"chat_5"}`))
		r.SetPathValue("uid", "enterprise")
		w := httptest.NewRecorder()
		handler(w, r)
		if w.Code != http.StatusUnprocessableEntity {
			t.Fatalf("enterprise task status: %d", w.Code)
		}
	}
}
