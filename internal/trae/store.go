package trae

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Account is the private on-disk record; API responses must use Status.
type Account struct {
	ID               string         `json:"id"`
	AccountUID       string         `json:"account_uid"`
	Nickname         string         `json:"nickname"`
	Token            string         `json:"token"`
	Session          string         `json:"session"`
	DeviceID         string         `json:"device_id"`
	OAuth            *OAuthIdentity `json:"oauth,omitempty"`
	Disabled         bool           `json:"disabled"`
	Credits          float64        `json:"credits"`
	Total            float64        `json:"credits_total"`
	BalanceKnown     bool           `json:"balance_known"`
	LastCheckinDate  string         `json:"last_checkin_date"`
	CheckinSupported *bool          `json:"checkin_supported,omitempty"`
	TokenUpdatedAt   time.Time      `json:"token_updated_at"`
	BalanceUpdatedAt time.Time      `json:"balance_updated_at"`
	LastError        string         `json:"last_error,omitempty"`
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
	CheckinDone      bool      `json:"checkin_done"`
	CheckinSupported *bool     `json:"checkin_supported,omitempty"`
	TokenExpiresAt   time.Time `json:"token_expires_at"`
	HasSession       bool      `json:"has_session"`
	HasOAuth         bool      `json:"has_oauth"`
	BalanceUpdatedAt time.Time `json:"balance_updated_at"`
	LastError        string    `json:"last_error,omitempty"`
}

type Store struct {
	mu              sync.RWMutex
	op              sync.Mutex
	path            string
	accounts        []Account
	client          *Client
	localDevices    func() []clientDevice
	refreshDisabled atomic.Bool
}

var china = time.FixedZone("Asia/Shanghai", 8*60*60)

func chinaDay(t time.Time) string { return t.In(china).Format("2006-01-02") }

func Open(path string, client *Client) (*Store, error) {
	if client == nil {
		client = NewClient()
	}
	s := &Store{path: path, client: client, accounts: []Account{}}
	s.localDevices = func() []clientDevice { return readClientDevices(clientStoragePaths()) }
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return s, nil
	}
	if err != nil {
		return nil, fmt.Errorf("读取 Trae 账号文件失败")
	}
	if json.Unmarshal(raw, &s.accounts) != nil {
		return nil, fmt.Errorf("Trae 账号文件格式无效")
	}
	return s, nil
}

func (s *Store) SetRefreshEnabled(enabled bool) { s.refreshDisabled.Store(!enabled) }

func status(a Account) Status {
	_, expiry := tokenInfo(a.Token)
	return Status{UID: a.ID, AccountUID: a.AccountUID, Nickname: a.Nickname, Provider: "trae", Realm: "cn", Disabled: a.Disabled,
		Credits: a.Credits, Total: a.Total, BalanceKnown: a.BalanceKnown, CheckinDone: a.LastCheckinDate == chinaDay(time.Now()),
		CheckinSupported: a.CheckinSupported, TokenExpiresAt: expiry, HasSession: a.Session != "", HasOAuth: a.OAuth != nil, BalanceUpdatedAt: a.BalanceUpdatedAt, LastError: a.LastError}
}

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

// commit publishes state only after an atomic private file replacement succeeds.
// All callers hold op, keeping credential refresh, removal and imports ordered.
func (s *Store) commit(accounts []Account) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0700); err != nil {
		return fmt.Errorf("创建 Trae 数据目录失败")
	}
	raw, err := json.MarshalIndent(accounts, "", "  ")
	if err != nil {
		return fmt.Errorf("保存 Trae 账号数据失败")
	}
	f, err := os.CreateTemp(filepath.Dir(s.path), ".trae-*.tmp")
	if err != nil {
		return fmt.Errorf("创建 Trae 账号存档失败")
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(raw)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil || closeErr != nil {
		return fmt.Errorf("写入 Trae 账号文件失败")
	}
	if os.Rename(name, s.path) != nil {
		return fmt.Errorf("替换 Trae 账号文件失败")
	}
	s.mu.Lock()
	s.accounts = accounts
	s.mu.Unlock()
	return nil
}

func normalizeCredential(raw string, session bool) (string, error) {
	value := strings.Trim(strings.TrimSpace(raw), "\"'")
	if session {
		if i := strings.Index(strings.ToLower(value), "x-cloudide-session="); i >= 0 {
			value = value[i+len("x-cloudide-session="):]
			value = strings.SplitN(value, ";", 2)[0]
		}
	} else {
		value = strings.TrimSpace(strings.TrimPrefix(value, "Authorization:"))
		value = strings.TrimSpace(strings.TrimPrefix(value, "Cloud-IDE-JWT"))
	}
	if len(value) > 32768 || strings.ContainsAny(value, "\r\n\t ;\"'\\") {
		return "", fmt.Errorf("Trae 凭证格式无效，请只填写凭证值")
	}
	return value, nil
}

func prepare(a *Account) error {
	var err error
	if a.Session, err = normalizeCredential(a.Session, true); err != nil {
		return err
	}
	if a.Token, err = normalizeCredential(a.Token, false); err != nil {
		return err
	}
	if a.Token == "" && a.Session == "" {
		return fmt.Errorf("请填写 Trae Session 或 Token")
	}
	if a.DeviceID == "" {
		n, err := rand.Int(rand.Reader, big.NewInt(9000000000000000))
		if err != nil {
			return fmt.Errorf("无法创建账号设备号")
		}
		a.DeviceID = fmt.Sprint(n.Int64() + 1000000000000000)
	}
	if !validDeviceID(a.DeviceID) {
		return fmt.Errorf("Trae 设备号须为 12 至 20 位数字")
	}
	if a.OAuth != nil {
		if _, err := identityKey(a.OAuth); err != nil {
			return err
		}
		if a.DeviceID != a.OAuth.DeviceID || a.OAuth.RefreshToken == "" {
			return oauthError("Trae OAuth 设备绑定不完整，请重新授权登录")
		}
		if _, err := normalizeCredential(a.OAuth.RefreshToken, false); err != nil {
			return oauthError("Trae OAuth 刷新凭证格式无效")
		}
	}
	if len(a.Nickname) > 240 {
		return fmt.Errorf("账号名称过长")
	}
	return nil
}

func accountID(uid string) string {
	sum := sha256.Sum256([]byte(uid))
	return "trae-" + hex.EncodeToString(sum[:12])
}

func (s *Store) Add(ctx context.Context, a Account) (Status, []string, error) {
	return s.add(ctx, a, "")
}

// Reauthorize verifies the selected row before replacing credentials or identity.
func (s *Store) Reauthorize(ctx context.Context, a Account, expectedID string) (Status, []string, error) {
	return s.add(ctx, a, expectedID)
}

func (s *Store) add(ctx context.Context, a Account, expectedID string) (Status, []string, error) {
	// An interactive login can be cancelled while a scheduled batch owns op.
	// Do not keep its browser session alive waiting for that batch to finish.
	for !s.op.TryLock() {
		select {
		case <-ctx.Done():
			return Status{}, nil, ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
	defer s.op.Unlock()
	if err := ctx.Err(); err != nil {
		return Status{}, nil, err
	}
	deviceSupplied := a.DeviceID != ""
	if err := prepare(&a); err != nil {
		return Status{}, nil, err
	}
	name := a.Nickname
	if expectedID != "" && a.OAuth != nil {
		uid, _ := tokenInfo(a.Token)
		found := false
		for _, existing := range s.snapshot() {
			if existing.ID == expectedID {
				found = true
				if existing.AccountUID != uid {
					return Status{}, nil, oauthError("登录账号与所选账号不一致，已取消更新，请使用原账号重新授权")
				}
			}
		}
		if !found {
			return Status{}, nil, oauthError("所选 Trae 账号已移除，请重新添加")
		}
	}
	if err := s.client.identify(ctx, &a); err != nil {
		return Status{}, nil, err
	}
	if name != "" {
		a.Nickname = name
	}
	a.ID = accountID(a.AccountUID)
	accounts := s.snapshot()
	if expectedID != "" {
		found := false
		for _, existing := range accounts {
			if existing.ID == expectedID {
				found = true
				if existing.AccountUID != a.AccountUID {
					return Status{}, nil, oauthError("登录账号与所选账号不一致，已取消更新，请使用原账号重新授权")
				}
			}
		}
		if !found {
			return Status{}, nil, oauthError("所选 Trae 账号已移除，请重新添加")
		}
	}
	index := -1
	for i, existing := range accounts {
		if existing.AccountUID == a.AccountUID || a.Session != "" && existing.Session == a.Session || a.Token != "" && existing.Token == a.Token {
			index = i
			a.ID = existing.ID
			if !deviceSupplied {
				a.DeviceID = existing.DeviceID
			}
			if a.Session == "" && a.OAuth == nil {
				a.Session = existing.Session
			}
			if existing.LastCheckinDate != "" {
				a.LastCheckinDate = existing.LastCheckinDate
			}
			a.Disabled = existing.Disabled
			if a.OAuth != nil && name == "" && existing.Nickname != "" {
				a.Nickname = existing.Nickname
			}
			a.Credits, a.Total, a.BalanceKnown = existing.Credits, existing.Total, existing.BalanceKnown
			a.BalanceUpdatedAt = existing.BalanceUpdatedAt
		}
	}
	for i, existing := range accounts {
		if i != index && existing.DeviceID == a.DeviceID {
			return Status{}, nil, fmt.Errorf("设备号已被其他 Trae 账号使用，请填写此账号自己的设备号")
		}
	}
	warnings := []string{}
	if _, _, err := s.client.status(ctx, &a); err != nil {
		warnings = append(warnings, err.Error())
	}
	if err := s.client.balance(ctx, &a); err != nil {
		warnings = append(warnings, err.Error())
	}
	if len(warnings) > 0 {
		a.LastError = strings.Join(warnings, "；")
	}
	if err := ctx.Err(); err != nil {
		return Status{}, nil, err
	}
	if index < 0 {
		accounts = append(accounts, a)
	} else {
		accounts[index] = a
	}
	if err := s.commit(accounts); err != nil {
		return Status{}, nil, err
	}
	log.Printf("trae: 已添加或更新账号 %s", a.ID)
	return status(a), warnings, nil
}

func (s *Store) Action(ctx context.Context, id, action string) (Status, string, error) {
	s.op.Lock()
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
			out := status(*a)
			err = s.commit(append(accounts[:i], accounts[i+1:]...))
			return out, "", err
		case "disable":
			a.Disabled = true
		case "revive":
			a.Disabled = false
		case "balance":
			if strings.HasPrefix(a.AccountUID, "pending-") {
				if err = s.client.identify(ctx, a); err != nil {
					break
				}
			}
			err = s.client.balance(ctx, a)
			if err == nil {
				_, _, statusErr := s.client.status(ctx, a)
				if statusErr != nil {
					warning = statusErr.Error()
				}
			}
		case "checkin":
			if a.Disabled {
				return status(*a), "", fmt.Errorf("该 Trae 账号已停用")
			}
			if strings.HasPrefix(a.AccountUID, "pending-") {
				if err = s.client.identify(ctx, a); err != nil {
					break
				}
			}
			// Match the account actually signed in to a local CN client.
			// Never borrow another account's device or generate a replacement
			// after a refusal. A device's daily allowance is platform-owned.
			s.useClientDevice(a)
			err = s.client.checkin(ctx, a)
			if err == nil && !s.refreshDisabled.Load() {
				if balanceErr := s.client.balance(ctx, a); balanceErr != nil {
					warning = balanceErr.Error()
				}
			}
		default:
			return Status{}, "", fmt.Errorf("不支持的 Trae 账号操作")
		}
		if action == "checkin" || action == "balance" {
			a.LastError = warning
			if err != nil {
				a.LastError = err.Error()
			}
		}
		if saveErr := s.commit(accounts); saveErr != nil {
			return Status{}, "", saveErr
		}
		if err != nil {
			log.Printf("trae: %s %s 失败: %v", action, id, err)
		} else if action == "checkin" {
			log.Printf("trae: checkin %s 签到成功", id)
		} else {
			log.Printf("trae: %s %s 完成", action, id)
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
		_, warning, err := s.Action(ctx, a.UID, action)
		if err != nil {
			errors = append(errors, a.UID+": "+err.Error())
		} else if warning != "" {
			errors = append(errors, a.UID+": "+warning)
		}
	}
	return errors
}
