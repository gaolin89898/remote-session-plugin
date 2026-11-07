package panel

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDesktopRoutesRejectRemoteForwardedAndCrossSiteRequests(t *testing.T) {
	p := New(Config{AccountsOnly: true, APIKey: "test-secret"})
	defer p.Close()
	for _, path := range []string{"status", "switch", "capture"} {
		method := "POST"
		if path == "status" {
			method = "GET"
		}
		for _, mode := range []string{"remote", "forwarded", "cross-site", "wrong-origin", "unauthorized"} {
			t.Run(path+"/"+mode, func(t *testing.T) {
				r := httptest.NewRequest(method, "http://127.0.0.1:7863/panel/api/desktop/"+path, strings.NewReader(`{"provider":"trae","uid":"missing","confirmed":true}`))
				r.RemoteAddr = "127.0.0.1:40000"
				r.Header.Set("Authorization", "Bearer test-secret")
				want := 403
				switch mode {
				case "remote":
					r.RemoteAddr = "192.168.1.20:40000"
				case "forwarded":
					r.Header.Set("X-Forwarded-For", "127.0.0.1")
				case "cross-site":
					r.Header.Set("Sec-Fetch-Site", "cross-site")
				case "wrong-origin":
					r.Header.Set("Origin", "https://untrusted.example")
				case "unauthorized":
					r.Header.Del("Authorization")
					want = 401
				}
				w := httptest.NewRecorder()
				p.ServeHTTP(w, r)
				if w.Code != want {
					t.Fatalf("HTTP %d, want %d", w.Code, want)
				}
			})
		}
	}
}

func TestDesktopSwitchRequiresExplicitRestartConfirmationAndKnownAccount(t *testing.T) {
	p := New(Config{AccountsOnly: true})
	defer p.Close()
	for _, tc := range []struct {
		body string
		want int
	}{
		{`{"provider":"trae","uid":"missing"}`, 400},
		{`{"provider":"trae","uid":"missing","confirmed":true}`, 404},
		{`{"provider":"trae","uid":"missing","confirmed":true,"path":"C:/other.exe"}`, 400},
		{`{"provider":"trae","uid":"missing","confirmed":true} {}`, 400},
		{`{"provider":"trae","realm":"global","confirmed":true}`, 400},
		{`{"provider":"qoder","realm":"global","confirmed":true}`, 400},
		{`{"provider":"qoder","uid":"missing"}`, 400},
	} {
		r := httptest.NewRequest("POST", "http://127.0.0.1:7863/panel/api/desktop/switch", strings.NewReader(tc.body))
		r.RemoteAddr = "127.0.0.1:50000"
		w := httptest.NewRecorder()
		p.ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Fatalf("%s: HTTP %d, want %d", tc.body, w.Code, tc.want)
		}
	}
}
