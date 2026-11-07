package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"
	_ "time/tzdata"

	"github.com/linguo2625469/workbuddy2api-panel/internal/auth"
	"github.com/linguo2625469/workbuddy2api-panel/internal/credithist"
	"github.com/linguo2625469/workbuddy2api-panel/internal/panel"
	"github.com/linguo2625469/workbuddy2api-panel/internal/pool"
	"github.com/linguo2625469/workbuddy2api-panel/internal/qoder"
	"github.com/linguo2625469/workbuddy2api-panel/internal/scheduler"
	"github.com/linguo2625469/workbuddy2api-panel/internal/trae"
	"github.com/linguo2625469/workbuddy2api-panel/internal/upstream"
)

type accountSchedule struct {
	Enabled             bool  `json:"checkin_enabled"`
	Hours               []int `json:"checkin_hours"`
	RefreshAfterCheckin bool  `json:"refresh_after_checkin"`
	CatchupOnStart      bool  `json:"catchup_on_start"`
}

func (s accountSchedule) validate() error {
	if len(s.Hours) == 0 || len(s.Hours) > 24 {
		return fmt.Errorf("请设置 1 至 24 个签到时刻")
	}
	seen := make(map[int]bool)
	for _, h := range s.Hours {
		if h < 0 || h > 23 || seen[h] {
			return fmt.Errorf("签到小时须为 0 至 23 的整数，且不能重复")
		}
		seen[h] = true
	}
	return nil
}

type accountSettings struct {
	mu       sync.Mutex
	path     string
	schedule accountSchedule
}

func loadAccountSettings(path string, cfg *Config) (*accountSettings, error) {
	s := &accountSettings{path: path, schedule: accountSchedule{
		Enabled: cfg.Schedule.CheckinEnabled, Hours: cfg.Schedule.CheckinHours,
		RefreshAfterCheckin: true, CatchupOnStart: true,
	}}
	raw, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	if err == nil {
		if err := json.Unmarshal(raw, &s.schedule); err != nil {
			return nil, fmt.Errorf("读取签到设置: %w", err)
		}
	}
	return s, s.schedule.validate()
}

func (s *accountSettings) load() (any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return map[string]any{
		"checkin_enabled":       s.schedule.Enabled,
		"checkin_hours":         append([]int(nil), s.schedule.Hours...),
		"refresh_after_checkin": s.schedule.RefreshAfterCheckin,
		"catchup_on_start":      s.schedule.CatchupOnStart,
		"timezone":              time.Local.String(),
	}, nil
}

func (s *accountSettings) save(raw []byte, sch *scheduler.Scheduler) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.schedule
	next.Hours = append([]int(nil), s.schedule.Hours...)
	if trimmed := bytes.TrimSpace(raw); len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, fmt.Errorf("设置必须是单个 JSON 对象")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&next); err != nil {
		return nil, err
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return nil, fmt.Errorf("设置必须是单个 JSON 对象")
	}
	if err := next.validate(); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return nil, err
	}
	out, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(s.path+".tmp", out, 0o600); err != nil {
		return nil, err
	}
	if err := os.Rename(s.path+".tmp", s.path); err != nil {
		return nil, err
	}
	s.schedule = next
	configureAccountSchedule(sch, next)
	return nil, nil
}

func configureAccountSchedule(sch *scheduler.Scheduler, s accountSchedule) {
	sch.SetCheckinRefreshEnabled(s.RefreshAfterCheckin)
	sch.Reconfigure(s.Hours, nil, nil, nil, nil, nil, !s.Enabled, true, true, true, true, true)
}

func accountHandler(pn *panel.Panel) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/panel/", pn)
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/panel/", http.StatusSeeOther)
	})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"service":"workbuddy-accounts","ok":true}`)
	})
	return mux
}

func runAccounts(configPath string, cfg *Config) error {
	return runAccountsWithListener(context.Background(), configPath, cfg, nil)
}

func runAccountsWithListener(parent context.Context, configPath string, cfg *Config, listener net.Listener) error {
	if listener == nil {
		var err error
		listener, err = net.Listen("tcp", cfg.Listen)
		if err != nil {
			return err
		}
	}
	defer listener.Close()
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		return err
	}
	time.Local = loc
	auth.SetGlobalEnabled(true)
	auths, err := auth.LoadDir(cfg.AuthDir)
	if err != nil {
		return err
	}
	p := pool.New(cfg.StateFile)
	defer p.Close()
	p.SyncToDir(auths)
	up := upstream.New()
	up.HTTP.Timeout = time.Duration(cfg.Upstream.TimeoutSeconds) * time.Second
	up.GlobalEnabled = true
	up.ChatBaseGlobal = cfg.Global.ChatBase
	up.BillingBaseGlobal = cfg.Global.BillingBase
	up.UserAgent = cfg.Upstream.UserAgent
	up.ClientVersion = cfg.Upstream.ClientVersion
	up.CliVersion = cfg.Upstream.CliVersion
	up.ClientName = cfg.Upstream.ClientName
	up.DeviceToken = cfg.Upstream.DeviceToken
	up.DeviceTokenFile = cfg.Upstream.DeviceTokenFile
	applyCNChatBase(up, cfg)
	creditHistory := credithist.New(stateSibling(cfg.StateFile, "credit-history.json"), 2000)
	up.SetCreditObserver(creditHistory.Observe)
	if len(cfg.DNSServers) > 0 {
		up.SetDNSDialer(upstream.NewDNSDialer(cfg.DNSServers))
	}
	settings, err := loadAccountSettings(stateSibling(cfg.StateFile, "account-settings.json"), cfg)
	if err != nil {
		return err
	}
	traeAccounts, err := trae.Open(stateSibling(cfg.StateFile, "trae-accounts.json"), nil)
	if err != nil {
		return err
	}
	traeAccounts.SetRefreshEnabled(settings.schedule.RefreshAfterCheckin)
	qoderAccounts, err := qoder.Open(stateSibling(cfg.StateFile, "qoder-accounts.json"), nil)
	if err != nil {
		return err
	}
	qoderAccounts.SetRefreshEnabled(settings.schedule.RefreshAfterCheckin)
	runTraeCheckin := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		traeAccounts.RunAll(ctx, "checkin")
	}
	sch := scheduler.New(scheduler.Config{
		Pool: p, Upstream: up, CheckinOnly: true,
		CheckinHook:  runTraeCheckin,
		CheckinHours: settings.schedule.Hours, CheckinDisabled: !settings.schedule.Enabled,
		TravelDisabled: true, ActivityDisabled: true, KeepaliveDisabled: true,
		BlackcatDisabled: true, GrowthDisabled: true,
	})
	sch.SetCheckinRefreshEnabled(settings.schedule.RefreshAfterCheckin)
	pn := panel.New(panel.Config{
		AccountsOnly: true, Pool: p, Upstream: up, Scheduler: sch,
		Trae:          traeAccounts,
		Qoder:         qoderAccounts,
		CreditHistory: creditHistory,
		AuthDir:       cfg.AuthDir, APIKey: cfg.APIKey, Version: appVersion + "-accounts",
		ConfigPath: settings.path, LoadConfig: settings.load,
		DesktopDir: stateSibling(cfg.StateFile, "desktop"),
		SaveConfig: func(raw []byte) ([]string, error) {
			changes, err := settings.save(raw, sch)
			if err == nil {
				settings.mu.Lock()
				traeAccounts.SetRefreshEnabled(settings.schedule.RefreshAfterCheckin)
				qoderAccounts.SetRefreshEnabled(settings.schedule.RefreshAfterCheckin)
				settings.mu.Unlock()
			}
			return changes, err
		},
	})
	previousLog := log.Writer()
	defer pn.Close()
	log.SetOutput(io.MultiWriter(previousLog, pn.Logs()))
	defer log.SetOutput(previousLog)
	ctx, stop := signal.NotifyContext(parent, os.Interrupt, syscall.SIGTERM)
	defer stop()
	go sch.Run(ctx)
	go runQoderSchedule(ctx, settings, qoderAccounts)
	if settings.schedule.Enabled && settings.schedule.CatchupOnStart {
		go sch.RunCheckinNow()
		go runTraeCheckin()
		go qoderAccounts.RunAll(ctx, "checkin")
	}
	srv := &http.Server{
		Addr: cfg.Listen, Handler: accountHandler(pn),
		ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 60 * time.Second,
		IdleTimeout: 120 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()
	log.Printf("账号管理已启动：http://127.0.0.1%s/panel/（%d 个账号；每日签到时区 Asia/Shanghai；管理密钥见 %s）", panelListenPath(cfg.Listen), len(auths), configPath)
	err = srv.Serve(listener)
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}
