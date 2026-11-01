// Package desktop switches local desktop client sessions. It never exposes
// credentials through its status API and never copies projects or chat history.
package desktop

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/linguo2625469/workbuddy2api-panel/internal/trae"
)

type Client struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Available   bool     `json:"available"`
	Running     bool     `json:"running"`
	CurrentUID  string   `json:"current_uid"`
	CurrentName string   `json:"current_name"`
	SavedUIDs   []string `json:"saved_uids"`
	Reason      string   `json:"reason,omitempty"`
}

type Job struct {
	ID      string    `json:"id"`
	Client  string    `json:"client"`
	UID     string    `json:"uid"`
	Phase   string    `json:"phase"`
	Done    bool      `json:"done"`
	Error   string    `json:"error,omitempty"`
	Started time.Time `json:"started_at"`
}

type profile struct{ id, name, exe, root, auth, snapshot string }
type fileEntry struct {
	Path    string `json:"path"`
	Present bool   `json:"present"`
	Body    []byte `json:"body,omitempty"`
}
type snapshot struct {
	Version int         `json:"version"`
	Client  string      `json:"client"`
	UID     string      `json:"uid"`
	Name    string      `json:"name"`
	Files   []fileEntry `json:"files"`
}

type Manager struct {
	mu            sync.Mutex
	profiles      map[string]profile
	dir           string
	job           *Job
	closed        bool
	wg            sync.WaitGroup
	cancel        context.CancelFunc
	stop          func(context.Context, profile) error
	launch        func(profile) error
	running       func(profile) bool
	verifyTimeout time.Duration
}

func New(dir string) *Manager {
	return &Manager{dir: dir, profiles: discover(), stop: stopClient, launch: launchClient, running: clientRunning, verifyTimeout: 45 * time.Second}
}

func (m *Manager) Close() {
	m.mu.Lock()
	m.closed = true
	if m.cancel != nil {
		m.cancel()
	}
	m.mu.Unlock()
	m.wg.Wait()
}

func (m *Manager) Status() ([]Client, *Job) {
	m.mu.Lock()
	defer m.mu.Unlock()
	clients := make([]Client, 0, 4)
	for _, id := range []string{"workbuddy", "workbuddy-global", "trae", "qoder"} {
		p := m.profiles[id]
		c := Client{ID: id, Name: p.name, SavedUIDs: []string{}}
		c.Available = regular(p.exe)
		if !c.Available {
			c.Reason = "未找到本机客户端（暂支持 Windows 默认安装位置）"
		}
		if c.Available {
			c.CurrentUID, c.CurrentName = identity(p)
			c.Running = m.running(p)
		}
		entries, _ := filepath.Glob(filepath.Join(m.dir, id, "*.json"))
		for _, path := range entries {
			var s snapshot
			if readJSON(path, &s) == nil && s.Version == 1 && s.Client == id && s.UID != "" {
				c.SavedUIDs = append(c.SavedUIDs, s.UID)
			}
		}
		clients = append(clients, c)
	}
	var job *Job
	if m.job != nil {
		v := *m.job
		job = &v
	}
	return clients, job
}

func (m *Manager) SaveCurrent(id string) (string, string, []byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || m.job != nil && !m.job.Done {
		return "", "", nil, fmt.Errorf("客户端切换仍在执行，请稍后再保存")
	}
	p, ok := m.profiles[id]
	if !ok || !regular(p.exe) {
		return "", "", nil, fmt.Errorf("未找到本机客户端")
	}
	s, err := capture(p)
	if err != nil {
		return "", "", nil, err
	}
	if id == "trae" {
		// A saved file alone is not evidence of the currently running user.
		if live := liveTraeUID(p.root, "", time.Time{}); live != s.UID {
			return "", "", nil, fmt.Errorf("Trae 当前会话与保存的账号不一致，请等待客户端登录完成后重试")
		}
	}
	if err := writeJSON(m.slot(id, s.UID), s); err != nil {
		return "", "", nil, fmt.Errorf("保存客户端登录态失败")
	}
	var raw []byte
	for _, f := range s.Files {
		if f.Path == authStorage {
			raw = f.Body
		}
	}
	return s.UID, s.Name, raw, nil
}

// WorkBuddyAuth is an internal credential payload, never a JSON response.
type WorkBuddyAuth struct {
	UID, Name, Access, Refresh, Domain, Enterprise string
	Expires                                        int64
}

func (m *Manager) Start(id, uid string, credentials *WorkBuddyAuth) (Job, error) {
	return m.start(id, uid, credentials, nil)
}

func (m *Manager) StartQoder(uid string, credentials *QoderAuth) (Job, error) {
	return m.start("qoder", uid, nil, credentials)
}

func (m *Manager) start(id, uid string, credentials *WorkBuddyAuth, qoder *QoderAuth) (Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Job{}, fmt.Errorf("服务正在关闭")
	}
	if m.job != nil && !m.job.Done {
		return Job{}, fmt.Errorf("已有客户端切换任务，请等待完成")
	}
	p, ok := m.profiles[id]
	if !ok || !regular(p.exe) || uid == "" {
		return Job{}, fmt.Errorf("未找到目标客户端或账号")
	}
	var target snapshot
	if id == "qoder" {
		if qoder == nil || qoder.UID != uid {
			return Job{}, fmt.Errorf("Qoder 目标账号不一致")
		}
		var err error
		target, err = qoderTarget(p, qoder)
		if err != nil {
			return Job{}, err
		}
	} else if id == "trae" {
		if readJSON(m.slot(id, uid), &target) != nil || validate(p, target) != nil || target.UID != uid {
			return Job{}, fmt.Errorf("该 Trae 账号尚未保存客户端登录态，请先在 Trae 登录此账号，再点「保存当前登录态」")
		}
	} else {
		if credentials == nil || credentials.UID != uid || credentials.Access == "" || credentials.Refresh == "" {
			return Job{}, fmt.Errorf("WorkBuddy 凭证不完整，请重新添加账号")
		}
		if credentials.Enterprise != "" {
			return Job{}, fmt.Errorf("企业账号暂不支持客户端切换")
		}
		body, err := workbuddyBody(*credentials)
		if err != nil {
			return Job{}, err
		}
		target = snapshot{Version: 1, Client: id, UID: uid, Name: credentials.Name, Files: []fileEntry{{Path: "auth", Present: true, Body: body}, {Path: "logout", Present: false}}}
	}
	job := Job{ID: fmt.Sprintf("%d", time.Now().UnixNano()), Client: id, UID: uid, Phase: "正在关闭客户端", Started: time.Now()}
	m.job = &job
	ctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel
	m.wg.Add(1)
	go func() { defer m.wg.Done(); defer cancel(); m.run(ctx, p, target) }()
	return job, nil
}

func (m *Manager) phase(value string) { m.mu.Lock(); m.job.Phase = value; m.mu.Unlock() }
func (m *Manager) finish(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.job.Done = true
	if err != nil {
		m.job.Error = err.Error()
		m.job.Phase = "切换未完成"
	} else {
		m.job.Phase = "客户端已确认切换成功"
	}
}

func (m *Manager) run(ctx context.Context, p profile, target snapshot) {
	// Refuse to write if closing the explicitly confirmed client fails.
	if err := m.stop(ctx, p); err != nil {
		m.finish(err)
		return
	}
	m.phase("正在备份原登录态")
	before, err := captureFiles(p)
	if err != nil {
		_ = m.launch(p)
		m.finish(fmt.Errorf("备份原登录态失败，未修改客户端"))
		return
	}
	backup := filepath.Join(m.dir, "backups", m.jobID()+".json")
	if err = writeJSON(backup, before); err != nil {
		_ = m.launch(p)
		m.finish(fmt.Errorf("备份写入失败，未修改客户端"))
		return
	}
	if before.UID != "" {
		if err = writeJSON(m.slot(p.id, before.UID), before); err != nil {
			_ = m.launch(p)
			m.finish(fmt.Errorf("保存原账号登录态失败，未修改客户端"))
			return
		}
	}
	baseline := newestSession(p.root)
	if p.id == "qoder" {
		baseline = newestQoderSession(p.root)
	}
	anchor := time.Now()
	m.phase("正在恢复目标账号")
	if err = apply(p, target); err == nil {
		m.phase("正在启动客户端并核对账号")
		err = m.launch(p)
		if err == nil {
			err = m.verify(ctx, p, target.UID, baseline, anchor)
		}
	}
	if err == nil {
		m.finish(nil)
		return
	}
	m.phase("切换未确认，正在恢复原登录态")
	// Rollback must finish even if shutdown cancelled verification.
	recovery, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if stopErr := m.stop(recovery, p); stopErr != nil {
		m.finish(fmt.Errorf("切换未确认；客户端未退出，无法自动恢复。原登录态备份已保留，请关闭客户端后重试"))
		return
	}
	if restoreErr := apply(p, before); restoreErr != nil {
		m.finish(fmt.Errorf("切换未确认；恢复原登录态失败，备份已保留"))
		return
	}
	if launchErr := m.launch(p); launchErr != nil {
		m.finish(fmt.Errorf("已恢复原登录态，请手动启动客户端"))
		return
	}
	m.finish(fmt.Errorf("%s；已恢复原登录态并重新启动客户端", err.Error()))
}

func (m *Manager) jobID() string { m.mu.Lock(); defer m.mu.Unlock(); return m.job.ID }
func (m *Manager) slot(id, uid string) string {
	sum := sha256.Sum256([]byte(uid))
	return filepath.Join(m.dir, id, hex.EncodeToString(sum[:16])+".json")
}

func (m *Manager) verify(ctx context.Context, p profile, uid, baseline string, anchor time.Time) error {
	ctx, cancel := context.WithTimeout(ctx, m.verifyTimeout)
	defer cancel()
	for {
		var actual string
		if p.id == "trae" {
			actual = liveTraeUID(p.root, baseline, anchor)
		} else if p.id == "qoder" {
			actual = liveQoderUID(p.root, baseline, anchor)
		} else {
			path := filepath.Join(p.root, "storage", "skeleton", "account-snapshot.json")
			if st, err := os.Stat(path); err == nil && !st.ModTime().Before(anchor) {
				actual, _ = snapshotIdentity(path)
			}
		}
		if actual != "" {
			if actual == uid && m.running(p) {
				return nil
			}
			if actual != uid {
				return fmt.Errorf("客户端登录为其他账号，已拒绝确认")
			}
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("客户端未在规定时间内确认目标账号，请检查登录状态或网络")
		case <-time.After(500 * time.Millisecond):
		}
	}
}

const authStorage = "User/globalStorage/storage.json"

var traeFiles = []string{authStorage, "aha/Remote_State", "aha/TinyStorage", "machineid"}

func capture(p profile) (snapshot, error) {
	s, err := captureFiles(p)
	if err != nil {
		return s, err
	}
	if s.UID == "" {
		return s, fmt.Errorf("客户端尚未登录，或登录态已失效")
	}
	if p.id == "trae" {
		for _, f := range s.Files {
			if f.Path == authStorage {
				if _, err = trae.DesktopAccount(f.Body); err != nil {
					return s, err
				}
			}
		}
	}
	return s, nil
}

func captureFiles(p profile) (snapshot, error) {
	s := snapshot{Version: 1, Client: p.id}
	s.UID, s.Name = identity(p)
	paths := []string{"auth", "logout"}
	if p.id == "trae" {
		paths = traeFiles
	} else if p.id == "qoder" {
		paths = qoderFiles
	}
	for _, rel := range paths {
		path := entryPath(p, rel)
		body, err := readPrivate(path)
		if err != nil && !os.IsNotExist(err) {
			return s, err
		}
		f := fileEntry{Path: rel, Present: err == nil, Body: body}
		if p.id == "qoder" && rel == "auth.v1.dat" && f.Present {
			auth, e := decodeQoderAuth(p.root, f.Body)
			if e != nil {
				return s, e
			}
			s.UID, s.Name = qoderIdentity(auth)
		}
		if rel == authStorage && f.Present {
			// Store only native login keys. Restoring merges them into the
			// current settings instead of reverting layout/projects/history.
			var doc map[string]json.RawMessage
			if json.Unmarshal(body, &doc) != nil {
				return s, fmt.Errorf("Trae 登录文件损坏")
			}
			for key := range doc {
				if !strings.HasPrefix(key, "iCubeAuthInfo://") {
					delete(doc, key)
				}
			}
			f.Body, _ = json.Marshal(doc)
			// Identify from this exact copy, not an earlier read.
			if a, err := trae.DesktopAccount(f.Body); err == nil {
				s.UID, s.Name = a.AccountUID, a.Nickname
			} else {
				s.UID = ""
			}
		}
		s.Files = append(s.Files, f)
	}
	// Reject a torn snapshot if a running client updated a login file mid-read.
	for _, f := range s.Files {
		body, err := readPrivate(entryPath(p, f.Path))
		if f.Path == authStorage && err == nil {
			var doc map[string]json.RawMessage
			if json.Unmarshal(body, &doc) != nil {
				return s, fmt.Errorf("Trae 登录态正在更新，请稍后重试")
			}
			for key := range doc {
				if !strings.HasPrefix(key, "iCubeAuthInfo://") {
					delete(doc, key)
				}
			}
			body, _ = json.Marshal(doc)
		}
		if f.Present != (err == nil) || err != nil && !os.IsNotExist(err) || !bytes.Equal(body, f.Body) {
			return s, fmt.Errorf("客户端登录态正在更新，请稍后重试")
		}
	}
	return s, nil
}

func entryPath(p profile, rel string) string {
	if rel == "auth" {
		return p.auth
	}
	if rel == "logout" {
		return p.auth + ".logged-out"
	}
	return filepath.Join(p.root, filepath.FromSlash(rel))
}

func validate(p profile, s snapshot) error {
	if s.Version != 1 || s.Client != p.id {
		return fmt.Errorf("登录态快照无效")
	}
	allowed := map[string]bool{}
	if p.id == "trae" {
		for _, rel := range traeFiles {
			allowed[rel] = true
		}
	} else if p.id == "qoder" {
		for _, rel := range qoderFiles {
			allowed[rel] = true
		}
	} else {
		allowed["auth"] = true
		allowed["logout"] = true
	}
	seen := map[string]bool{}
	for _, f := range s.Files {
		if !allowed[f.Path] || seen[f.Path] {
			return fmt.Errorf("登录态快照路径无效")
		}
		seen[f.Path] = true
		if p.id == "qoder" && f.Path == "auth.v1.dat" {
			if !f.Present && s.UID != "" {
				return fmt.Errorf("Qoder 快照缺少登录凭证")
			}
			if f.Present {
				auth, err := decodeQoderAuth(p.root, f.Body)
				uid, _ := qoderIdentity(auth)
				if err != nil || uid == "" || uid != s.UID {
					return fmt.Errorf("Qoder 快照身份无效")
				}
			}
		}
		if p.id == "trae" && f.Path == authStorage && f.Present {
			var doc map[string]json.RawMessage
			if json.Unmarshal(f.Body, &doc) != nil {
				return fmt.Errorf("Trae 快照损坏")
			}
			for key := range doc {
				if !strings.HasPrefix(key, "iCubeAuthInfo://") {
					return fmt.Errorf("Trae 快照包含非登录设置")
				}
			}
		}
	}
	if len(seen) != len(allowed) {
		return fmt.Errorf("登录态快照不完整")
	}
	return nil
}

func apply(p profile, s snapshot) error {
	if err := validate(p, s); err != nil {
		return err
	}
	for _, f := range s.Files {
		path := entryPath(p, f.Path)
		if f.Path == authStorage {
			var current, auth map[string]json.RawMessage
			body, err := readPrivate(path)
			if err != nil || json.Unmarshal(body, &current) != nil || current == nil {
				return fmt.Errorf("无法读取 Trae 当前设置，已中止恢复")
			}
			if f.Present {
				if json.Unmarshal(f.Body, &auth) != nil {
					return fmt.Errorf("Trae 登录态快照无效")
				}
			}
			for key := range current {
				if strings.HasPrefix(key, "iCubeAuthInfo://") {
					delete(current, key)
				}
			}
			for key, value := range auth {
				current[key] = value
			}
			if err = writeJSON(path, current); err != nil {
				return fmt.Errorf("写入 Trae 登录态失败")
			}
			continue
		}
		if !f.Present {
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				return fmt.Errorf("清理旧登录标记失败")
			}
			continue
		}
		if err := atomicWrite(path, f.Body); err != nil {
			return fmt.Errorf("写入客户端登录态失败")
		}
	}
	return nil
}

func workbuddyBody(c WorkBuddyAuth) ([]byte, error) {
	if c.Expires < time.Now().Unix() {
		return nil, fmt.Errorf("WorkBuddy 凭证已过期，请先刷新账号凭证")
	}
	account := map[string]any{"uid": c.UID, "nickname": c.Name, "type": "personal"}
	auth := map[string]any{"accessToken": c.Access, "refreshToken": c.Refresh, "domain": c.Domain, "tokenType": "Bearer", "scope": "openid profile offline_access email", "expiresAt": c.Expires * 1000, "expiresIn": c.Expires - time.Now().Unix(), "lastRefreshTime": time.Now().UnixMilli()}
	return json.Marshal(map[string]any{"account": account, "auth": auth, "accounts": []any{account}, "allAccounts": []any{account}})
}

func identity(p profile) (string, string) {
	if p.id == "qoder" {
		auth, err := readQoderAuth(p.root)
		if err != nil {
			return "", ""
		}
		return qoderIdentity(auth)
	}
	if p.id == "trae" {
		var doc map[string]json.RawMessage
		if readJSON(entryPath(p, authStorage), &doc) != nil {
			return "", ""
		}
		raw, _ := json.Marshal(doc)
		if a, err := trae.DesktopAccount(raw); err == nil {
			return a.AccountUID, a.Nickname
		}
		return "", ""
	}
	if regular(p.auth + ".logged-out") {
		return "", ""
	}
	if uid, name := snapshotIdentity(filepath.Join(p.root, "storage", "skeleton", "account-snapshot.json")); uid != "" {
		return uid, name
	}
	return snapshotIdentity(p.auth)
}

func snapshotIdentity(path string) (string, string) {
	var doc map[string]json.RawMessage
	if readJSON(path, &doc) != nil {
		return "", ""
	}
	for _, key := range []string{"primary", "account"} {
		if raw := doc[key]; raw != nil {
			var nested map[string]json.RawMessage
			if json.Unmarshal(raw, &nested) == nil {
				doc = nested
			}
			break
		}
	}
	var uid, name string
	_ = json.Unmarshal(doc["uid"], &uid)
	_ = json.Unmarshal(doc["nickname"], &name)
	return uid, name
}

var sessionPattern = regexp.MustCompile(`^[0-9]{8}T[0-9]{6}$`)
var uidPattern = regexp.MustCompile(`(?:[?&]|\b)uid=([0-9]{10,20})(?:[&\s"']|$)`)

func newestSession(root string) string {
	entries, _ := os.ReadDir(filepath.Join(root, "logs"))
	var names []string
	for _, e := range entries {
		if e.IsDir() && sessionPattern.MatchString(e.Name()) {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	if len(names) > 0 {
		return names[len(names)-1]
	}
	return ""
}
func liveTraeUID(root, baseline string, anchor time.Time) string {
	session := newestSession(root)
	if session == "" || session < baseline {
		return ""
	}
	path := filepath.Join(root, "logs", session, "dynamicConfig.log")
	st, err := os.Stat(path)
	if err != nil || !anchor.IsZero() && (session == baseline || st.ModTime().Before(anchor)) {
		return ""
	}
	body, err := readPrivate(path)
	if err != nil {
		return ""
	}
	matches := uidPattern.FindAllSubmatch(body, -1)
	if len(matches) == 0 {
		return ""
	}
	return string(matches[len(matches)-1][1])
}

func regular(path string) bool {
	if path == "" {
		return false
	}
	st, err := os.Stat(path)
	return err == nil && st.Mode().IsRegular()
}
func readPrivate(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() || st.Size() > 8<<20 {
		return nil, fmt.Errorf("客户端文件不是常规文件或超过大小限制")
	}
	body, err := io.ReadAll(io.LimitReader(f, (8<<20)+1))
	if len(body) > 8<<20 {
		return nil, fmt.Errorf("客户端文件超过大小限制")
	}
	return body, err
}
func readJSON(path string, v any) error {
	body, err := readPrivate(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(bytes.TrimPrefix(body, []byte{0xef, 0xbb, 0xbf}), v)
}
func writeJSON(path string, v any) error {
	body, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(path, body)
}
func atomicWrite(path string, body []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".desktop-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(body)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(f.Name(), path)
}
