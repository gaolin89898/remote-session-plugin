// Package traelogin opens an isolated local browser for an interactive Trae login.
// Credentials travel directly to the account store, never through the panel UI.
package traelogin

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/chromedp"
	"github.com/linguo2625469/workbuddy2api-panel/internal/trae"
)

const loginURL = "https://www.trae.cn/dashboard"

var (
	ErrLaunch       = errors.New("无法打开 Trae 登录窗口，请检查浏览器或网络后重试")
	ErrWindowClosed = errors.New("登录窗口已关闭，请重新开始登录")
)

type Credentials struct {
	Token    string
	Session  string
	DeviceID string
	OAuth    *trae.OAuthIdentity
}

// BrowserPath searches known installations, without opening existing profiles.
func BrowserPath() string {
	var candidates []string
	switch runtime.GOOS {
	case "windows":
		for _, root := range []string{os.Getenv("ProgramFiles(x86)"), os.Getenv("ProgramFiles"), os.Getenv("LOCALAPPDATA")} {
			if root != "" {
				candidates = append(candidates, filepath.Join(root, "Microsoft", "Edge", "Application", "msedge.exe"), filepath.Join(root, "Google", "Chrome", "Application", "chrome.exe"))
			}
		}
	case "darwin":
		candidates = append(candidates, "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
	case "linux":
		if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
			return ""
		}
	}
	for _, name := range []string{"msedge", "microsoft-edge", "google-chrome", "chromium", "chromium-browser"} {
		if path, err := exec.LookPath(name); err == nil {
			candidates = append(candidates, path)
		}
	}
	for _, path := range candidates {
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			return path
		}
	}
	return ""
}

func Run(ctx context.Context, executable string) (Credentials, error) {
	return runOAuthBrowser(ctx, executable)
}

// targetURL and extra options are internal so browser integration tests can use
// a local fixture; HTTP callers cannot choose a URL, executable or debug port.
func runBrowser(ctx context.Context, executable, targetURL string, extra ...chromedp.ExecAllocatorOption) (Credentials, error) {
	browser, stopBrowser := browserContext(ctx, executable, extra...)
	defer stopBrowser()
	if err := chromedp.Run(browser, chromedp.Navigate(targetURL)); err != nil {
		return Credentials{}, ErrLaunch
	}
	return captureWebCredentials(ctx, browser, targetURL)
}

func browserContext(ctx context.Context, executable string, extra ...chromedp.ExecAllocatorOption) (context.Context, func()) {
	opts := []chromedp.ExecAllocatorOption{
		chromedp.ExecPath(executable), chromedp.NoFirstRun, chromedp.NoDefaultBrowserCheck,
		chromedp.Flag("remote-debugging-address", "127.0.0.1"),
		chromedp.Flag("remote-debugging-port", "0"),
		chromedp.Flag("window-size", "1050,800"),
		// Keep the browser sandbox and default security settings enabled.
		chromedp.Flag("no-sandbox", false),
	}
	opts = append(opts, extra...)
	allocator, stopAllocator := chromedp.NewExecAllocator(ctx, opts...)
	browser, stopBrowser := chromedp.NewContext(allocator, chromedp.WithErrorf(func(string, ...any) {}))
	return browser, func() { stopBrowser(); stopAllocator() }
}

func captureWebCredentials(ctx, browser context.Context, targetURL string) (Credentials, error) {
	u, err := url.Parse(targetURL)
	if err != nil {
		return Credentials{}, errors.New("登录地址无效")
	}
	origin, _ := json.Marshal(u.Scheme + "://" + u.Host)
	script := `(function(){if(location.origin!==` + string(origin) + `)return '';return localStorage.getItem('Cloud-IDE-Token')||'';})()`
	ticker := time.NewTicker(1500 * time.Millisecond)
	defer ticker.Stop()
	var tokenSeenAt time.Time
	var previousToken string
	for {
		select {
		case <-ctx.Done():
			return Credentials{}, ctx.Err()
		case <-browser.Done():
			return Credentials{}, ErrWindowClosed
		case <-ticker.C:
			var token string
			// Redirects to identity providers are allowed, but only the Trae
			// origin's localStorage and cookies are ever inspected.
			err := chromedp.Run(browser, chromedp.Evaluate(script, &token))
			if err != nil || len(token) > 32768 || len(strings.Split(token, ".")) != 3 {
				continue
			}
			if token != previousToken {
				previousToken, tokenSeenAt = token, time.Now()
			}
			credentials := Credentials{Token: token}
			_ = chromedp.Run(browser, chromedp.ActionFunc(func(ctx context.Context) error {
				cookies, err := network.GetCookies().WithUrls([]string{u.Scheme + "://" + u.Host + "/"}).Do(ctx)
				if err == nil {
					for _, cookie := range cookies {
						if cookie.Name == "X-Cloudide-Session" && len(cookie.Value) <= 32768 {
							credentials.Session = cookie.Value
							break
						}
					}
				}
				return err
			}))
			// The website can write its token before its session cookie arrives.
			// Give that cookie time to settle before closing the login window.
			if credentials.Session != "" || time.Since(tokenSeenAt) >= 3*time.Second {
				return credentials, nil
			}
		}
	}
}
