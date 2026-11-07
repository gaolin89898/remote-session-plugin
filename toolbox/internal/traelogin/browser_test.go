package traelogin

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/chromedp/chromedp"
)

// Opt-in integration test: real installed Edge/Chrome, synthetic local login.
// The regular suite never opens a user's browser or contacts Trae.
func TestBrowserCredentialCapture(t *testing.T) {
	if os.Getenv("TRAE_BROWSER_TEST") != "1" {
		t.Skip("set TRAE_BROWSER_TEST=1 to test an installed browser")
	}
	executable := BrowserPath()
	if executable == "" {
		t.Fatal("no desktop browser found")
	}
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "X-Cloudide-Session", Value: "private-fixture-session", Path: "/", HttpOnly: true})
		http.SetCookie(w, &http.Cookie{Name: "unrelated", Value: "do-not-collect", Path: "/"})
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte(`<script>localStorage.setItem('Cloud-IDE-Token','fixture.payload.signature')</script>`))
	}))
	defer fixture.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	result, err := runBrowser(ctx, executable, fixture.URL, chromedp.Headless)
	if err != nil {
		t.Fatal(err)
	}
	if result.Token != "fixture.payload.signature" || result.Session != "private-fixture-session" {
		t.Fatal("did not capture token and HttpOnly session")
	}
}

func TestBrowserCancellation(t *testing.T) {
	if os.Getenv("TRAE_BROWSER_TEST") != "1" {
		t.Skip("set TRAE_BROWSER_TEST=1 to test an installed browser")
	}
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`<p>Waiting for login</p>`)) }))
	defer fixture.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	start := time.Now()
	credentials, err := runBrowser(ctx, BrowserPath(), fixture.URL, chromedp.Headless)
	if err == nil || credentials.Token != "" {
		t.Fatal("cancelled browser returned credentials")
	}
	if time.Since(start) > 15*time.Second {
		t.Fatal("browser cleanup did not finish promptly")
	}
}

func TestBrowserWaitsForSessionAfterToken(t *testing.T) {
	if os.Getenv("TRAE_BROWSER_TEST") != "1" {
		t.Skip("set TRAE_BROWSER_TEST=1 to test an installed browser")
	}
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/session" {
			http.SetCookie(w, &http.Cookie{Name: "X-Cloudide-Session", Value: "delayed-private-session", Path: "/", HttpOnly: true})
			return
		}
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte(`<script>localStorage.setItem('Cloud-IDE-Token','fixture.payload.signature');setTimeout(()=>fetch('/session'),2200)</script>`))
	}))
	defer fixture.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	credentials, err := runBrowser(ctx, BrowserPath(), fixture.URL, chromedp.Headless)
	if err != nil {
		t.Fatal(err)
	}
	if credentials.Session != "delayed-private-session" {
		t.Fatal("login window closed before session cookie arrived")
	}
}
