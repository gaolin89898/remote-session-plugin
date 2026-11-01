package panel

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/linguo2625469/workbuddy2api-panel/internal/qoder"
)

type qoderTransport func(*http.Request) (*http.Response, error)

func (f qoderTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestQoderLoginCancellationDoesNotWaitForNetwork(t *testing.T) {
	s, err := qoder.Open(filepath.Join(t.TempDir(), "accounts.json"), nil)
	if err != nil {
		t.Fatal(err)
	}
	p := New(Config{AccountsOnly: true, APIKey: "test-key", Qoder: s})
	defer p.Close()
	call := func(method, path, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://127.0.0.1:7863/panel/api/qoder/"+path, strings.NewReader(body))
		r.RemoteAddr = "127.0.0.1:50000"
		r.Header.Set("Authorization", "Bearer test-key")
		w := httptest.NewRecorder()
		p.ServeHTTP(w, r)
		return w
	}
	start := call("POST", "login/start", `{}`)
	var response struct {
		State string `json:"state"`
	}
	if start.Code != 200 || json.Unmarshal(start.Body.Bytes(), &response) != nil || response.State == "" {
		t.Fatalf("start: %s", start.Body)
	}
	entered := make(chan struct{})
	p.qoderLogin.client.HTTP.Transport = qoderTransport(func(r *http.Request) (*http.Response, error) {
		close(entered)
		<-r.Context().Done()
		return nil, r.Context().Err()
	})
	finished := make(chan struct{})
	go func() { call("GET", "login/poll?state="+response.State, ""); close(finished) }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("poll not started")
	}
	if w := call("POST", "login/cancel?state="+response.State, ""); w.Code != 200 {
		t.Fatal(w.Code)
	}
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("cancel blocked by network")
	}
	if w := call("GET", "login/poll?state="+response.State, ""); w.Code != 410 {
		t.Fatal(w.Code)
	}
	if len(s.List()) != 0 {
		t.Fatal("cancelled authorization saved an account")
	}
	if w := call("POST", "login/start", `{} {}`); w.Code != 400 {
		t.Fatal("accepted trailing JSON")
	}
	for _, mode := range []string{"remote", "cross-site", "unauthorized"} {
		r := httptest.NewRequest("POST", "http://127.0.0.1:7863/panel/api/qoder/login/start", strings.NewReader(`{}`))
		r.RemoteAddr = "127.0.0.1:50000"
		r.Header.Set("Authorization", "Bearer test-key")
		want := 403
		if mode == "remote" {
			r.RemoteAddr = "192.168.1.1:50000"
		}
		if mode == "cross-site" {
			r.Header.Set("Sec-Fetch-Site", "cross-site")
		}
		if mode == "unauthorized" {
			r.Header.Del("Authorization")
			want = 401
		}
		w := httptest.NewRecorder()
		p.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("%s: %d", mode, w.Code)
		}
	}
}
