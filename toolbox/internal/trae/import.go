package trae

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"strings"
)

type ImportResult struct {
	Imported int      `json:"imported"`
	Updated  int      `json:"updated"`
	Skipped  int      `json:"skipped"`
	Errors   []string `json:"errors"`
}

// PBKDF2-HMAC-SHA256, one 32-byte output block, matching TraeTools backups.
func deriveKey(password string, salt []byte, iterations int) []byte {
	mac := hmac.New(sha256.New, []byte(password))
	mac.Write(salt)
	var block [4]byte
	binary.BigEndian.PutUint32(block[:], 1)
	mac.Write(block[:])
	u := mac.Sum(nil)
	key := append([]byte(nil), u...)
	for n := 1; n < iterations; n++ {
		mac.Reset()
		mac.Write(u)
		u = mac.Sum(u[:0])
		for i := range key {
			key[i] ^= u[i]
		}
	}
	return key
}

func backupPayload(raw []byte, password string) ([]byte, error) {
	var env struct {
		App, Type, Kdf, Cipher, Salt, Nonce, Tag, Payload string
		Version, Iterations                               int
	}
	if json.Unmarshal(raw, &env) != nil {
		return nil, fmt.Errorf("Trae JSON 文件格式无效")
	}
	if env.App == "" && env.Type == "" {
		return raw, nil
	}
	if env.App != "TraeTools" || env.Type != "account-backup" || env.Version != 1 || env.Kdf != "PBKDF2-SHA256" || env.Cipher != "AES-256-GCM" {
		return nil, fmt.Errorf("不支持的 TraeTools 备份版本或加密格式")
	}
	if password == "" {
		return nil, fmt.Errorf("请输入 TraeTools 备份口令")
	}
	if env.Iterations <= 0 {
		env.Iterations = 200000
	}
	if env.Iterations < 1000 || env.Iterations > 1000000 {
		return nil, fmt.Errorf("备份密钥参数超出支持范围")
	}
	salt, e1 := base64.StdEncoding.DecodeString(env.Salt)
	nonce, e2 := base64.StdEncoding.DecodeString(env.Nonce)
	tag, e3 := base64.StdEncoding.DecodeString(env.Tag)
	payload, e4 := base64.StdEncoding.DecodeString(env.Payload)
	if e1 != nil || e2 != nil || e3 != nil || e4 != nil || len(salt) != 16 || len(nonce) != 12 || len(tag) != 16 {
		return nil, fmt.Errorf("TraeTools 备份数据无效")
	}
	key := deriveKey(password, salt, env.Iterations)
	block, _ := aes.NewCipher(key)
	gcm, _ := cipher.NewGCM(block)
	plain, err := gcm.Open(nil, nonce, append(payload, tag...), nil)
	for i := range key {
		key[i] = 0
	}
	if err != nil {
		return nil, fmt.Errorf("备份口令错误或文件已损坏")
	}
	return plain, nil
}

func importAccounts(raw []byte, password string) ([]Account, error) {
	if len(raw) == 0 || len(raw) > 8<<20 {
		return nil, fmt.Errorf("Trae 备份文件大小须在 8 MB 以内")
	}
	var entries []json.RawMessage
	if json.Unmarshal(raw, &entries) != nil {
		plain, err := backupPayload(raw, password)
		if err != nil {
			return nil, err
		}
		var root struct{ Accounts []json.RawMessage }
		if json.Unmarshal(plain, &root) != nil {
			return nil, fmt.Errorf("Trae 账号列表格式无效")
		}
		entries = root.Accounts
	}
	if len(entries) == 0 || len(entries) > 200 {
		return nil, fmt.Errorf("Trae 备份须包含 1 至 200 个账号")
	}
	out := make([]Account, 0, len(entries))
	for _, entry := range entries {
		var fields map[string]json.RawMessage
		if json.Unmarshal(entry, &fields) != nil || fields == nil {
			return nil, fmt.Errorf("Trae 账号记录格式无效")
		}
		keys := map[string]json.RawMessage{}
		for k, v := range fields {
			keys[strings.ReplaceAll(strings.ToLower(k), "_", "")] = v
		}
		a := Account{Nickname: str(keys["name"]), Token: str(keys["token"]), Session: str(keys["session"]), DeviceID: str(keys["deviceid"]), AccountUID: str(keys["accountuid"])}
		if a.Nickname == "" {
			a.Nickname = str(keys["screenname"])
		}
		if a.Nickname == "" {
			a.Nickname = str(keys["nickname"])
		}
		if enabled, ok := keys["enabled"]; ok {
			var value bool
			if json.Unmarshal(enabled, &value) != nil {
				return nil, fmt.Errorf("Trae 账号启用状态无效")
			}
			a.Disabled = !value
		}
		if disabled, ok := keys["disabled"]; ok {
			_ = json.Unmarshal(disabled, &a.Disabled)
		}
		out = append(out, a)
	}
	return out, nil
}

func (s *Store) Import(raw []byte, password string) (ImportResult, error) {
	incoming, err := importAccounts(raw, password)
	result := ImportResult{Errors: []string{}}
	if err != nil {
		return result, err
	}
	s.op.Lock()
	defer s.op.Unlock()
	accounts := s.snapshot()
	for i, a := range incoming {
		if err := prepare(&a); err != nil {
			result.Skipped++
			result.Errors = append(result.Errors, fmt.Sprintf("第 %d 个账号：%s", i+1, err))
			continue
		}
		if uid, _ := tokenInfo(a.Token); uid != "" {
			a.AccountUID = uid
		}
		if a.AccountUID == "" {
			if a.Session == "" {
				result.Skipped++
				result.Errors = append(result.Errors, fmt.Sprintf("第 %d 个账号：Token 中缺少账号标识", i+1))
				continue
			}
			a.AccountUID = "pending-" + accountID(a.Session)
		}
		index := -1
		for j, existing := range accounts {
			if existing.AccountUID == a.AccountUID || a.Session != "" && existing.Session == a.Session || a.Token != "" && existing.Token == a.Token {
				index = j
				break
			}
		}
		duplicateDevice := false
		for j, existing := range accounts {
			if j != index && existing.DeviceID == a.DeviceID {
				duplicateDevice = true
			}
		}
		if duplicateDevice {
			result.Skipped++
			result.Errors = append(result.Errors, fmt.Sprintf("第 %d 个账号：设备号已被其他账号使用", i+1))
			continue
		}
		if index >= 0 {
			existing := accounts[index]
			// Imported web credentials do not belong to the old OAuth device.
			existing.OAuth = nil
			if a.Token != "" {
				existing.Token = a.Token
			}
			if a.Session != "" {
				existing.Session = a.Session
			}
			existing.DeviceID = a.DeviceID
			if a.Nickname != "" {
				existing.Nickname = a.Nickname
			}
			existing.LastError = ""
			accounts[index] = existing
			result.Updated++
		} else {
			a.ID = accountID(a.AccountUID)
			if a.Nickname == "" {
				a.Nickname = "Trae 账号"
			}
			accounts = append(accounts, a)
			result.Imported++
		}
	}
	if result.Imported+result.Updated == 0 {
		return result, fmt.Errorf("没有可导入的 Trae 账号，请检查凭证和设备号")
	}
	if err := s.commit(accounts); err != nil {
		return ImportResult{}, err
	}
	return result, nil
}
