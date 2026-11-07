package trae

import (
	"encoding/json"
	"fmt"
	"time"
)

// DesktopAccount reads only a native login's identity and access token. Device
// signing keys and refresh tokens remain in the private desktop snapshot, so
// the scheduler and the client cannot race to rotate the same refresh token.
func DesktopAccount(raw []byte) (Account, error) {
	var storage map[string]json.RawMessage
	if json.Unmarshal(raw, &storage) != nil {
		return Account{}, fmt.Errorf("Trae 登录文件格式无效")
	}
	var encoded string
	_ = json.Unmarshal(storage["iCubeAuthInfo://icube.cloudide"], &encoded)
	var info struct {
		Token   string `json:"token"`
		UID     string `json:"userId"`
		Host    string `json:"host"`
		Account struct {
			Username string `json:"username"`
		} `json:"account"`
	}
	if json.Unmarshal(decodeClientAuth(encoded), &info) != nil || info.Host != "https://api.trae.cn" {
		return Account{}, fmt.Errorf("未识别到 Trae 国内版的客户端登录态")
	}
	uid, expiry := tokenInfo(info.Token)
	if uid == "" || uid != info.UID || expiry.IsZero() || expiry.Before(time.Now()) {
		return Account{}, fmt.Errorf("Trae 客户端登录态已过期或账号不一致，请在客户端重新登录")
	}
	device, ok := deviceFromStorage(raw)
	if !ok {
		return Account{}, fmt.Errorf("Trae 设备凭证不完整，请在客户端重新登录")
	}
	return Account{ID: accountID(uid), AccountUID: uid, Nickname: info.Account.Username, Token: info.Token, DeviceID: device.device, TokenUpdatedAt: time.Now()}, nil
}

// RememberDesktop adds a newly captured local account without replacing an
// existing account's separately authorized OAuth identity or check-in state.
func (s *Store) RememberDesktop(a Account) (Status, error) {
	s.op.Lock()
	defer s.op.Unlock()
	uid, _ := tokenInfo(a.Token)
	if uid == "" || uid != a.AccountUID {
		return Status{}, fmt.Errorf("客户端账号身份不一致")
	}
	accounts := s.snapshot()
	for _, existing := range accounts {
		if existing.AccountUID == uid {
			return status(existing), nil
		}
	}
	a.ID = accountID(uid)
	if a.Nickname == "" {
		a.Nickname = "Trae 账号"
	}
	accounts = append(accounts, a)
	if err := s.commit(accounts); err != nil {
		return Status{}, err
	}
	return status(a), nil
}
