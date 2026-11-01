package traelogin

import (
	"context"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/chromedp/chromedp"
	"github.com/linguo2625469/workbuddy2api-panel/internal/trae"
)

var ErrCallbackPort = errors.New("Trae 授权回调端口 17388 被占用，请关闭其他正在登录的 Trae 工具后重试")

func callbackHandler(login *trae.OAuthLogin, callbacks chan<- trae.OAuthCallback) http.Handler {
	var received atomic.Bool
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		if r.Method != http.MethodGet || r.Host != "127.0.0.1:17388" || r.URL.Path != "/authorize" || len(r.URL.RawQuery) > 64<<10 {
			http.Error(w, "无效的授权回调", http.StatusBadRequest)
			return
		}
		cb, err := login.ParseCallback(trae.OAuthRedirectURI + "?" + r.URL.RawQuery)
		if err != nil {
			http.Error(w, "授权回调与本次登录不匹配，请返回登录窗口重试", http.StatusBadRequest)
			return
		}
		if !received.CompareAndSwap(false, true) {
			http.Error(w, "授权回调已接收", http.StatusConflict)
			return
		}
		select {
		case callbacks <- cb:
		default:
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		io.WriteString(w, "<!doctype html><html lang=zh-CN><meta charset=utf-8><title>Trae 授权</title><p>已收到授权，正在保存账号。请返回账号面板查看结果。</p></html>")
	})
}

func runOAuthBrowser(ctx context.Context, executable string) (Credentials, error) {
	login, err := trae.NewOAuthLogin()
	if err != nil {
		return Credentials{}, err
	}
	return runOAuthSession(ctx, executable, login, login.URL(), trae.NewClient())
}

// Only in-package browser tests may replace the authorization URL/API transport.
func runOAuthSession(ctx context.Context, executable string, login *trae.OAuthLogin, targetURL string, client *trae.Client, extra ...chromedp.ExecAllocatorOption) (Credentials, error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:17388")
	if err != nil {
		return Credentials{}, ErrCallbackPort
	}
	callbacks := make(chan trae.OAuthCallback, 1)
	server := &http.Server{Handler: callbackHandler(login, callbacks), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, MaxHeaderBytes: 128 << 10, ErrorLog: log.New(io.Discard, "", 0)}
	serverDone := make(chan struct{})
	go func() { defer close(serverDone); _ = server.Serve(listener) }()
	defer func() { _ = server.Close(); <-serverDone }()
	browser, stopBrowser := browserContext(ctx, executable, extra...)
	defer stopBrowser()
	if err := chromedp.Run(browser, chromedp.Navigate(targetURL)); err != nil {
		if ctx.Err() != nil {
			return Credentials{}, ctx.Err()
		}
		return Credentials{}, ErrLaunch
	}
	var cb trae.OAuthCallback
	select {
	case <-ctx.Done():
		return Credentials{}, ctx.Err()
	case <-browser.Done():
		select {
		case cb = <-callbacks:
		default:
			return Credentials{}, ErrWindowClosed
		}
	case cb = <-callbacks:
	}
	// Token exchange runs under the original context; closing/cancelling a login
	// must not leave an unbounded request or a callback listener behind.
	account, err := client.CompleteOAuth(ctx, login, cb)
	if err != nil {
		return Credentials{}, err
	}
	if err := ctx.Err(); err != nil {
		return Credentials{}, err
	}
	if strings.TrimSpace(account.Token) == "" {
		return Credentials{}, errors.New("Trae 授权未返回登录凭证")
	}
	return Credentials{Token: account.Token, DeviceID: account.DeviceID, OAuth: account.OAuth}, nil
}
