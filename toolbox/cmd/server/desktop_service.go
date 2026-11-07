package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

func desktopAddress(listen string) (string, error) {
	_, port, err := net.SplitHostPort(listen)
	if err != nil {
		return "", fmt.Errorf("无法读取本地服务端口：%w", err)
	}
	return net.JoinHostPort("127.0.0.1", port), nil
}

func desktopServiceReady(ctx context.Context, origin, key string) bool {
	client := &http.Client{Timeout: time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	request, err := http.NewRequestWithContext(ctx, "GET", origin+"/healthz", nil)
	if err != nil {
		return false
	}
	response, err := client.Do(request)
	if err != nil {
		return false
	}
	var health struct {
		OK      bool   `json:"ok"`
		Service string `json:"service"`
	}
	err = json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&health)
	response.Body.Close()
	if err != nil || response.StatusCode != http.StatusOK || !health.OK || health.Service != "workbuddy-accounts" {
		return false
	}
	request, _ = http.NewRequestWithContext(ctx, "GET", origin+"/panel/api/overview", nil)
	request.Header.Set("Authorization", "Bearer "+key)
	response, err = client.Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	return response.StatusCode == http.StatusOK
}

func startDesktopService(configPath string, cfg *Config) (string, func(), error) {
	address, err := desktopAddress(cfg.Listen)
	if err != nil {
		return "", nil, err
	}
	origin := "http://" + address
	// Windows can allow a specific IPv4 bind beside an existing wildcard listener.
	if desktopServiceReady(context.Background(), origin, cfg.APIKey) {
		return origin, func() {}, nil
	}
	listenAddress := address
	if connection, dialErr := net.DialTimeout("tcp", address, 200*time.Millisecond); dialErr == nil {
		connection.Close()
		listenAddress = "127.0.0.1:0"
	}
	listener, err := net.Listen("tcp", listenAddress)
	if err != nil {
		listener, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return "", nil, fmt.Errorf("启动本地服务失败：%w", err)
		}
	}
	localConfig := *cfg
	localConfig.Listen = listener.Addr().String()
	origin = "http://" + localConfig.Listen
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runAccountsWithListener(ctx, configPath, &localConfig, listener) }()
	stop := sync.OnceFunc(func() { cancel(); <-done })
	deadline := time.NewTimer(20 * time.Second)
	defer deadline.Stop()
	for {
		if desktopServiceReady(ctx, origin, cfg.APIKey) {
			return origin, stop, nil
		}
		select {
		case err := <-done:
			cancel()
			return "", nil, fmt.Errorf("本地服务启动失败：%v", err)
		case <-deadline.C:
			stop()
			return "", nil, fmt.Errorf("等待本地服务启动超时")
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func validDesktopExternalURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && u.Hostname() != "" && u.User == nil && !strings.ContainsAny(raw, "\x00\r\n")
}
