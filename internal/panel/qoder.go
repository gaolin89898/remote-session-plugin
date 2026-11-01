package panel

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/linguo2625469/workbuddy2api-panel/internal/qoder"
)

type qoderLogin struct {
	flow        *qoder.Login
	created     time.Time
	expected    string
	account     *qoder.Status
	credentials *qoder.Account
	warnings    []string
	busy        bool
	cancel      context.CancelFunc
}
type qoderLoginManager struct {
	mu       sync.Mutex
	sessions map[string]*qoderLogin
	client   *qoder.Client
}

func newQoderLoginManager() *qoderLoginManager {
	return &qoderLoginManager{sessions: map[string]*qoderLogin{}, client: qoder.NewClient()}
}

func (p *Panel) qoderRoutes() {
	p.mux.HandleFunc("POST /panel/api/qoder/login/start", p.withAuth(p.qoderLoginStart))
	p.mux.HandleFunc("GET /panel/api/qoder/login/poll", p.withAuth(p.qoderLoginPoll))
	p.mux.HandleFunc("POST /panel/api/qoder/login/cancel", p.withAuth(p.qoderLoginCancel))
	p.mux.HandleFunc("POST /panel/api/qoder/accounts", p.withAuth(p.qoderAdd))
	p.mux.HandleFunc("POST /panel/api/qoder/accounts/{uid}/{action}", p.withAuth(p.qoderAction))
	p.mux.HandleFunc("POST /panel/api/qoder/checkin_all", p.withAuth(p.qoderCheckinAll))
	p.mux.HandleFunc("POST /panel/api/qoder/balance_all", p.withAuth(p.qoderBalanceAll))
}
func (p *Panel) qoderAccounts() []qoder.Status {
	if p.cfg.Qoder == nil {
		return []qoder.Status{}
	}
	return p.cfg.Qoder.List()
}
func (p *Panel) qoderReady(w http.ResponseWriter) bool {
	if p.cfg.Qoder == nil {
		writeErr(w, 501, "Qoder 账号管理未启用")
		return false
	}
	return true
}
func decodeQoder(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if dec.Decode(v) != nil || dec.Decode(new(any)) != io.EOF {
		writeErr(w, 400, "Qoder 表单格式无效")
		return false
	}
	return true
}
func (p *Panel) qoderAdd(w http.ResponseWriter, r *http.Request) {
	if !p.qoderReady(w) {
		return
	}
	var input struct {
		Token    string `json:"token"`
		Nickname string `json:"nickname"`
		UID      string `json:"uid"`
	}
	if !decodeQoder(w, r, &input) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	a, warnings, err := p.cfg.Qoder.Add(ctx, qoder.Account{Token: input.Token, Nickname: input.Nickname}, input.UID)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	log.Printf("qoder: 账号已添加或更新")
	writeJSON(w, 200, map[string]any{"ok": true, "account": a, "warnings": warnings})
}
func (p *Panel) qoderAction(w http.ResponseWriter, r *http.Request) {
	if !p.qoderReady(w) {
		return
	}
	action := r.PathValue("action")
	if action != "checkin" && action != "balance" && action != "remove" && action != "disable" && action != "revive" {
		http.NotFound(w, r)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 100*time.Second)
	defer cancel()
	a, warning, err := p.cfg.Qoder.Action(ctx, r.PathValue("uid"), action)
	if errors.Is(err, os.ErrNotExist) {
		writeErr(w, 404, "Qoder 账号不存在")
		return
	}
	if err != nil {
		writeErr(w, 502, err.Error())
		return
	}
	log.Printf("qoder: %s 完成", action)
	writeJSON(w, 200, map[string]any{"ok": true, "account": a, "checkin_done": a.CheckinDone, "balance_error": warning})
}
func (p *Panel) qoderCheckinAll(w http.ResponseWriter, r *http.Request) {
	if !p.qoderReady(w) {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		p.cfg.Qoder.RunAll(ctx, "checkin")
	}()
	log.Printf("qoder: 手动领取每日奖励已开始")
	writeJSON(w, 200, map[string]any{"ok": true, "started": true})
}
func (p *Panel) qoderBalanceAll(w http.ResponseWriter, r *http.Request) {
	if !p.qoderReady(w) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	errs := p.cfg.Qoder.RunAll(ctx, "balance")
	writeJSON(w, 200, map[string]any{"ok": true, "accounts": p.qoderAccounts(), "errors": errs})
}
func (p *Panel) qoderLoginStart(w http.ResponseWriter, r *http.Request) {
	if !p.qoderReady(w) || !desktopLocal(w, r) {
		return
	}
	var input struct {
		UID string `json:"uid"`
	}
	if !decodeQoder(w, r, &input) {
		return
	}
	if len(input.UID) > 200 {
		writeErr(w, 400, "Qoder 账号参数无效")
		return
	}
	flow, err := qoder.NewLogin()
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	var id [24]byte
	if _, err = rand.Read(id[:]); err != nil {
		writeErr(w, 500, "无法创建授权会话")
		return
	}
	state := hex.EncodeToString(id[:])
	m := p.qoderLogin
	m.mu.Lock()
	defer m.mu.Unlock()
	for key, s := range m.sessions {
		if time.Since(s.created) > 10*time.Minute {
			if s.cancel != nil {
				s.cancel()
			}
			delete(m.sessions, key)
		}
	}
	if len(m.sessions) >= 16 {
		writeErr(w, 429, "Qoder 授权窗口过多，请稍后重试")
		return
	}
	m.sessions[state] = &qoderLogin{flow: flow, created: time.Now(), expected: input.UID}
	writeJSON(w, 200, map[string]any{"state": state, "url": flow.URL})
}
func (p *Panel) qoderLoginPoll(w http.ResponseWriter, r *http.Request) {
	if !p.qoderReady(w) || !desktopLocal(w, r) {
		return
	}
	m := p.qoderLogin
	m.mu.Lock()
	state := r.URL.Query().Get("state")
	s := m.sessions[state]
	if s == nil || time.Since(s.created) > 10*time.Minute {
		if s != nil && s.cancel != nil {
			s.cancel()
		}
		delete(m.sessions, state)
		m.mu.Unlock()
		writeErr(w, 410, "Qoder 授权已过期或已取消，请重新登录")
		return
	}
	if s.account != nil {
		m.mu.Unlock()
		writeJSON(w, 200, map[string]any{"done": true, "account": s.account, "warnings": s.warnings})
		return
	}
	if s.busy {
		m.mu.Unlock()
		writeJSON(w, 200, map[string]any{"done": false})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	s.busy, s.cancel = true, cancel
	m.mu.Unlock()
	defer cancel()
	defer func() {
		m.mu.Lock()
		s.busy, s.cancel = false, nil
		m.mu.Unlock()
	}()
	a := s.credentials
	var err error
	if a == nil {
		a, err = m.client.Poll(ctx, s.flow)
	}
	if err != nil {
		writeErr(w, 502, err.Error())
		return
	}
	if a == nil {
		writeJSON(w, 200, map[string]any{"done": false})
		return
	}
	m.mu.Lock()
	s.credentials = a
	m.mu.Unlock()
	account, warnings, err := p.cfg.Qoder.Add(ctx, *a, s.expected)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	m.mu.Lock()
	s.account, s.warnings = &account, warnings
	m.mu.Unlock()
	log.Printf("qoder: 浏览器授权完成，账号已保存")
	writeJSON(w, 200, map[string]any{"done": true, "account": account, "warnings": warnings})
}
func (p *Panel) qoderLoginCancel(w http.ResponseWriter, r *http.Request) {
	if !desktopLocal(w, r) {
		return
	}
	m := p.qoderLogin
	m.mu.Lock()
	state := r.URL.Query().Get("state")
	if s := m.sessions[state]; s != nil && s.cancel != nil {
		s.cancel()
	}
	delete(m.sessions, state)
	m.mu.Unlock()
	writeJSON(w, 200, map[string]bool{"ok": true})
}
