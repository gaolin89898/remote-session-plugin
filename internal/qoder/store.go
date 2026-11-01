package qoder

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Account struct {
	ID               string    `json:"id"`
	AccountUID       string    `json:"account_uid"`
	Nickname         string    `json:"nickname"`
	Token            string    `json:"token"`
	RefreshToken     string    `json:"refresh_token"`
	PAT              string    `json:"pat,omitempty"`
	MachineID        string    `json:"machine_id"`
	ExpiresAt        time.Time `json:"expires_at"`
	RefreshExpiresAt time.Time `json:"refresh_expires_at"`
	Disabled         bool      `json:"disabled"`
	Credits          float64   `json:"credits"`
	Total            float64   `json:"credits_total"`
	BalanceKnown     bool      `json:"balance_known"`
	BalanceUpdatedAt time.Time `json:"balance_updated_at"`
	LastPeriod       string    `json:"last_period"`
	ClaimedUntil     time.Time `json:"claimed_until"`
	LastError        string    `json:"last_error,omitempty"`
}
type Status struct {
	UID              string    `json:"uid"`
	AccountUID       string    `json:"account_uid"`
	Nickname         string    `json:"nickname"`
	Provider         string    `json:"provider"`
	Realm            string    `json:"realm"`
	Disabled         bool      `json:"disabled"`
	Credits          float64   `json:"credits"`
	Total            float64   `json:"credits_total"`
	BalanceKnown     bool      `json:"balance_known"`
	BalanceUpdatedAt time.Time `json:"balance_updated_at"`
	CheckinDone      bool      `json:"checkin_done"`
	TokenExpiresAt   time.Time `json:"token_expires_at"`
	HasRefresh       bool      `json:"has_refresh"`
	DesktopSupported bool      `json:"desktop_supported"`
	LastError        string    `json:"last_error,omitempty"`
}

func status(a Account) Status {
	return Status{UID: a.ID, AccountUID: a.AccountUID, Nickname: a.Nickname, Provider: "qoder", Realm: "cn", Disabled: a.Disabled, Credits: a.Credits, Total: a.Total, BalanceKnown: a.BalanceKnown, BalanceUpdatedAt: a.BalanceUpdatedAt, CheckinDone: a.LastPeriod == RewardPeriod(time.Now()) && a.ClaimedUntil.After(time.Now()), TokenExpiresAt: a.ExpiresAt, HasRefresh: a.RefreshToken != "" || a.PAT != "", DesktopSupported: strings.HasPrefix(a.Token, "dt-") && strings.HasPrefix(a.RefreshToken, "drt-"), LastError: a.LastError}
}

type Store struct {
	mu             sync.RWMutex
	op             sync.Mutex
	path           string
	accounts       []Account
	client         *Client
	desktopSource  func() *Account
	refreshEnabled atomic.Bool
}

func Open(path string, c *Client) (*Store, error) {
	if c == nil {
		c = NewClient()
	}
	s := &Store{path: path, client: c, accounts: []Account{}}
	s.refreshEnabled.Store(true)
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return s, nil
	}
	if err != nil || json.Unmarshal(raw, &s.accounts) != nil {
		return nil, fmt.Errorf("读取 Qoder 账号存档失败")
	}
	return s, nil
}
func (s *Store) SetRefreshEnabled(v bool) { s.refreshEnabled.Store(v) }
func (s *Store) List() []Status {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Status, 0, len(s.accounts))
	for _, a := range s.accounts {
		out = append(out, status(a))
	}
	return out
}
func (s *Store) snapshot() []Account {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]Account(nil), s.accounts...)
}
func (s *Store) commit(accounts []Account) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0700); err != nil {
		return fmt.Errorf("创建 Qoder 存档目录失败")
	}
	raw, err := json.MarshalIndent(accounts, "", "  ")
	if err != nil {
		return fmt.Errorf("保存 Qoder 账号失败")
	}
	f, err := os.CreateTemp(filepath.Dir(s.path), ".qoder-*.tmp")
	if err != nil {
		return fmt.Errorf("创建 Qoder 存档失败")
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(raw)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil || closeErr != nil {
		return fmt.Errorf("写入 Qoder 存档失败")
	}
	if os.Rename(f.Name(), s.path) != nil {
		return fmt.Errorf("替换 Qoder 存档失败")
	}
	s.mu.Lock()
	s.accounts = append([]Account(nil), accounts...)
	s.mu.Unlock()
	return nil
}
func accountID(uid string) string {
	sum := sha256.Sum256([]byte(uid))
	return "qoder-" + hex.EncodeToString(sum[:12])
}
func (s *Store) lock(ctx context.Context) error {
	for !s.op.TryLock() {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
	if ctx.Err() != nil {
		s.op.Unlock()
		return ctx.Err()
	}
	return nil
}
func (s *Store) Add(ctx context.Context, a Account, expected string) (Status, []string, error) {
	if err := s.lock(ctx); err != nil {
		return Status{}, nil, err
	}
	defer s.op.Unlock()
	if !cleanToken(a.Token) || len(a.Nickname) > 240 {
		return Status{}, nil, fmt.Errorf("Qoder 凭证或昵称格式无效")
	}
	if a.MachineID == "" {
		var err error
		a.MachineID, err = randomID()
		if err != nil {
			return Status{}, nil, fmt.Errorf("无法创建 Qoder 授权身份")
		}
	}
	if len(a.Token) > 3 && a.Token[:3] == "pt-" {
		a.PAT = a.Token
		if err := s.client.refresh(ctx, &a); err != nil {
			return Status{}, nil, err
		}
	}
	name := a.Nickname
	if err := s.client.identify(ctx, &a); err != nil {
		return Status{}, nil, err
	}
	if name != "" {
		a.Nickname = name
	}
	if a.Nickname == "" {
		a.Nickname = "Qoder 账号"
	}
	accounts := s.snapshot()
	index := -1
	if expected != "" {
		found := false
		for _, old := range accounts {
			if old.ID == expected {
				found = true
				if old.AccountUID != a.AccountUID {
					return Status{}, nil, fmt.Errorf("登录账号与所选 Qoder 账号不一致，已保留原账号")
				}
			}
		}
		if !found {
			return Status{}, nil, os.ErrNotExist
		}
	}
	a.ID = accountID(a.AccountUID)
	for i, old := range accounts {
		if old.AccountUID == a.AccountUID {
			index = i
			a.ID = old.ID
			a.Disabled = old.Disabled
			a.Credits, a.Total, a.BalanceKnown = old.Credits, old.Total, old.BalanceKnown
			a.BalanceUpdatedAt = old.BalanceUpdatedAt
			a.LastPeriod, a.ClaimedUntil = old.LastPeriod, old.ClaimedUntil
		}
	}
	warnings := []string{}
	if err := s.client.balance(ctx, &a); err != nil {
		warnings = append(warnings, err.Error())
	}
	if err := s.client.checkin(ctx, &a, false); err != nil {
		warnings = append(warnings, err.Error())
	}
	if index < 0 {
		accounts = append(accounts, a)
	} else {
		accounts[index] = a
	}
	if ctx.Err() != nil {
		return Status{}, nil, ctx.Err()
	}
	if err := s.commit(accounts); err != nil {
		return Status{}, nil, err
	}
	return status(a), warnings, nil
}
func (s *Store) fresh(ctx context.Context, accounts []Account, i int) error {
	if err := s.syncDesktop(ctx, accounts); err != nil {
		return err
	}
	a := &accounts[i]
	if !a.ExpiresAt.IsZero() && a.ExpiresAt.After(time.Now().Add(5*time.Minute)) {
		return nil
	}
	if a.RefreshToken == "" && a.PAT == "" && a.ExpiresAt.IsZero() {
		return nil
	}
	if err := s.client.refresh(ctx, a); err != nil {
		return err
	}
	// Persist rotated refresh credentials before any subsequent operation.
	return s.commit(accounts)
}
func (s *Store) Action(ctx context.Context, id, action string) (Status, string, error) {
	if err := s.lock(ctx); err != nil {
		return Status{}, "", err
	}
	defer s.op.Unlock()
	accounts := s.snapshot()
	for i := range accounts {
		a := &accounts[i]
		if a.ID != id {
			continue
		}
		var err error
		warning := ""
		switch action {
		case "remove":
			return Status{}, "", s.commit(append(accounts[:i], accounts[i+1:]...))
		case "disable":
			a.Disabled = true
		case "revive":
			a.Disabled = false
			a.LastError = ""
		case "checkin", "balance":
			if action == "checkin" && a.Disabled {
				return status(*a), "", fmt.Errorf("该 Qoder 账号已停用")
			}
			err = s.fresh(ctx, accounts, i)
			if err == nil && action == "balance" {
				err = s.client.balance(ctx, a)
				if err == nil {
					if e := s.client.identify(ctx, a); e != nil {
						warning = e.Error()
					}
					if e := s.client.checkin(ctx, a, false); e != nil {
						warning = e.Error()
					}
				}
			}
			if err == nil && action == "checkin" {
				if !status(*a).CheckinDone {
					err = s.client.checkin(ctx, a, true)
				}
				if err == nil && s.refreshEnabled.Load() {
					if e := s.client.balance(ctx, a); e != nil {
						warning = e.Error()
					}
				}
			}
			a.LastError = warning
			if err != nil {
				a.LastError = err.Error()
			}
		default:
			return Status{}, "", fmt.Errorf("不支持的 Qoder 操作")
		}
		if e := s.commit(accounts); e != nil {
			return Status{}, "", e
		}
		return status(*a), warning, err
	}
	return Status{}, "", os.ErrNotExist
}
func (s *Store) RunAll(ctx context.Context, action string) []string {
	errors := []string{}
	for _, a := range s.List() {
		if ctx.Err() != nil {
			break
		}
		if a.Disabled || action == "checkin" && a.CheckinDone {
			continue
		}
		_, _, err := s.Action(ctx, a.UID, action)
		if err != nil {
			errors = append(errors, a.UID+": "+err.Error())
			log.Printf("qoder: %s 失败 %s", action, err)
		} else {
			log.Printf("qoder: %s 完成", action)
		}
	}
	return errors
}
