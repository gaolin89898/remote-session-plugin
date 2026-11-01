package desktop

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

var qoderFiles = []string{"auth.v1.dat", "auth-profile-overlays.v1.dat"}

type QoderAuth struct {
	UID, Name, Token, Refresh   string
	ExpiresAt, RefreshExpiresAt time.Time
}

// CurrentQoderCredential lets the account store retain native token renewals.
func (m *Manager) CurrentQoderCredential() *QoderAuth {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || m.job != nil && !m.job.Done {
		return nil
	}
	p, ok := m.profiles["qoder"]
	if !ok || !regular(p.exe) {
		return nil
	}
	auth, err := readQoderAuth(p.root)
	if err != nil {
		return nil
	}
	uid, name := qoderIdentity(auth)
	var token, refresh, expires, refreshExpires string
	_ = json.Unmarshal(auth["token"], &token)
	_ = json.Unmarshal(auth["refreshToken"], &refresh)
	_ = json.Unmarshal(auth["expiresAt"], &expires)
	_ = json.Unmarshal(auth["refreshTokenExpiresAt"], &refreshExpires)
	exp, _ := time.Parse(time.RFC3339, expires)
	rexp, _ := time.Parse(time.RFC3339, refreshExpires)
	return &QoderAuth{UID: uid, Name: name, Token: token, Refresh: refresh, ExpiresAt: exp, RefreshExpiresAt: rexp}
}

func qoderIdentity(auth map[string]json.RawMessage) (string, string) {
	var user struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	_ = json.Unmarshal(auth["user"], &user)
	return user.ID, user.Name
}

func qoderTarget(p profile, c *QoderAuth) (snapshot, error) {
	if c == nil || c.UID == "" || !strings.HasPrefix(c.Token, "dt-") || !strings.HasPrefix(c.Refresh, "drt-") || !c.ExpiresAt.After(time.Now()) || !c.RefreshExpiresAt.After(time.Now()) {
		return snapshot{}, fmt.Errorf("Qoder 浏览器授权凭证不完整或已过期，请重新授权")
	}
	old, err := readQoderAuth(p.root)
	if err != nil {
		return snapshot{}, err
	}
	var version int
	if json.Unmarshal(old["schemaVersion"], &version) != nil || version != 1 || len(old["authenticationContext"]) == 0 {
		return snapshot{}, fmt.Errorf("Qoder 当前客户端登录格式不支持，请先在客户端登录一次")
	}
	// Keep the local environment binding, but no profile fields from another user.
	auth := map[string]any{"schemaVersion": 1, "authenticationContext": old["authenticationContext"], "token": c.Token, "refreshToken": c.Refresh, "expiresAt": c.ExpiresAt.UTC().Format(time.RFC3339), "refreshTokenExpiresAt": c.RefreshExpiresAt.UTC().Format(time.RFC3339), "user": map[string]string{"id": c.UID, "name": c.Name, "email": "", "phone": "", "avatarUrl": ""}}
	enc, err := encodeQoderAuth(p.root, auth)
	if err != nil {
		return snapshot{}, err
	}
	return snapshot{Version: 1, Client: p.id, UID: c.UID, Name: c.Name, Files: []fileEntry{{Path: qoderFiles[0], Present: true, Body: enc}, {Path: qoderFiles[1]}}}, nil
}

func newestQoderSession(root string) string {
	entries, _ := os.ReadDir(filepath.Join(root, "logs"))
	names := []string{}
	for _, e := range entries {
		if e.IsDir() && len(e.Name()) > 20 && !strings.ContainsAny(e.Name(), "/\\") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	if len(names) > 0 {
		return names[len(names)-1]
	}
	return ""
}

func liveQoderUID(root, baseline string, anchor time.Time) string {
	session := newestQoderSession(root)
	if session == "" || !anchor.IsZero() && session <= baseline {
		return ""
	}
	path := filepath.Join(root, "logs", session, "main.log")
	st, err := os.Stat(path)
	if err != nil || !anchor.IsZero() && st.ModTime().Before(anchor) {
		return ""
	}
	body, err := readPrivate(path)
	if err != nil {
		return ""
	}
	confirmed := false
	for _, line := range strings.Split(string(body), "\n") {
		if !strings.Contains(line, "[Auth] Account plan request completed ") {
			continue
		}
		pos := strings.IndexByte(line, '{')
		if pos < 0 {
			continue
		}
		var event struct {
			Status    int    `json:"status"`
			Region    string `json:"region"`
			Operation string `json:"operation"`
		}
		if json.Unmarshal([]byte(line[pos:]), &event) == nil && event.Operation == "account.getUserPlan" && event.Region == "cn" {
			confirmed = event.Status == 200
		}
	}
	if !confirmed {
		return ""
	}
	auth, err := readQoderAuth(root)
	if err != nil {
		return ""
	}
	uid, _ := qoderIdentity(auth)
	return uid
}
