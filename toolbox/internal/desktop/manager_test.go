package desktop

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fixture(t *testing.T) (*Manager, profile, *WorkBuddyAuth) {
	t.Helper()
	root := t.TempDir()
	p := profile{id: "workbuddy", name: "WorkBuddy", root: filepath.Join(root, "client"), auth: filepath.Join(root, "auth.info"), exe: filepath.Join(root, "WorkBuddy.exe")}
	if err := atomicWrite(p.exe, []byte("fixture executable, never run")); err != nil {
		t.Fatal(err)
	}
	old := WorkBuddyAuth{UID: "old", Name: "原账号", Access: "private-old-access", Refresh: "private-old-refresh", Expires: time.Now().Add(time.Hour).Unix()}
	body, _ := workbuddyBody(old)
	_ = atomicWrite(p.auth, body)
	_ = writeJSON(filepath.Join(p.root, "storage", "skeleton", "account-snapshot.json"), map[string]any{"primary": map[string]any{"uid": "old", "nickname": "原账号"}})
	m := New(filepath.Join(root, "snapshots"))
	m.profiles = map[string]profile{"workbuddy": p}
	m.verifyTimeout = 80 * time.Millisecond
	m.stop = func(context.Context, profile) error { return nil }
	m.running = func(profile) bool { return true }
	m.launch = func(profile) error { return nil }
	t.Cleanup(m.Close)
	return m, p, &WorkBuddyAuth{UID: "new", Name: "新账号", Access: "private-new-access", Refresh: "private-new-refresh", Domain: "example.com", Expires: time.Now().Add(time.Hour).Unix()}
}

func awaitJob(t *testing.T, m *Manager) Job {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		_, job := m.Status()
		if job != nil && job.Done {
			return *job
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("job did not finish")
	return Job{}
}

func TestSwitchRequiresFreshClientEvidenceAndKeepsBackup(t *testing.T) {
	m, p, c := fixture(t)
	before, _ := os.ReadFile(p.auth)
	// A stale skeleton already containing the target must not count as a
	// successful login. Only a write made by the restarted client confirms it.
	path := filepath.Join(p.root, "storage", "skeleton", "account-snapshot.json")
	_ = writeJSON(path, map[string]any{"primary": map[string]any{"uid": "new"}})
	old := time.Now().Add(-time.Hour)
	_ = os.Chtimes(path, old, old)
	if _, err := m.Start("workbuddy", "new", c); err != nil {
		t.Fatal(err)
	}
	job := awaitJob(t, m)
	if job.Error == "" || !strings.Contains(job.Error, "已恢复原登录态") {
		t.Fatalf("stale file confirmed a switch: %+v", job)
	}
	after, _ := os.ReadFile(p.auth)
	if !bytes.Equal(before, after) {
		t.Fatal("original credentials not restored")
	}
	backups, _ := filepath.Glob(filepath.Join(m.dir, "backups", "*.json"))
	if len(backups) != 1 {
		t.Fatal("missing private backup")
	}
}

func TestSwitchSuccessOnlyAfterNativeRewriteAndSerializesClients(t *testing.T) {
	m, p, c := fixture(t)
	gate := make(chan struct{})
	entered := make(chan struct{})
	m.stop = func(context.Context, profile) error { close(entered); <-gate; return nil }
	m.launch = func(profile) error {
		path := filepath.Join(p.root, "storage", "skeleton", "account-snapshot.json")
		if err := writeJSON(path, map[string]any{"primary": map[string]any{"uid": "new"}}); err != nil {
			return err
		}
		future := time.Now().Add(time.Second)
		return os.Chtimes(path, future, future)
	}
	_, err := m.Start("workbuddy", "new", c)
	if err != nil {
		t.Fatal(err)
	}
	<-entered
	if _, err = m.Start("workbuddy", "new", c); err == nil {
		t.Fatal("accepted concurrent switch")
	}
	if _, _, _, err = m.SaveCurrent("workbuddy"); err == nil {
		t.Fatal("capture raced with switch")
	}
	close(gate)
	job := awaitJob(t, m)
	if job.Error != "" {
		t.Fatal(job.Error)
	}
	uid, _ := snapshotIdentity(p.auth)
	if uid != "new" {
		t.Fatal("wrong persisted target")
	}
	clients, j := m.Status()
	raw, _ := json.Marshal(map[string]any{"clients": clients, "job": j})
	if strings.Contains(string(raw), "private-") {
		t.Fatal("status leaked credentials")
	}
}

func TestStopFailureNeverWritesCredentials(t *testing.T) {
	m, p, c := fixture(t)
	before, _ := os.ReadFile(p.auth)
	m.stop = func(context.Context, profile) error { return fmt.Errorf("client still running") }
	if _, err := m.Start("workbuddy", "new", c); err != nil {
		t.Fatal(err)
	}
	if awaitJob(t, m).Error == "" {
		t.Fatal("reported success")
	}
	after, _ := os.ReadFile(p.auth)
	if !bytes.Equal(before, after) {
		t.Fatal("wrote while client running")
	}
}

func TestTraeRestoreOnlyLoginKeysAndRejectsPathTraversal(t *testing.T) {
	p := profile{id: "trae", root: t.TempDir()}
	_ = writeJSON(entryPath(p, authStorage), map[string]any{"iCubeAuthInfo://icube.cloudide": "old-private", "window.layout": "preserve", "projects": []string{"keep-project"}})
	s := snapshot{Version: 1, Client: "trae", UID: "target"}
	for _, path := range traeFiles {
		s.Files = append(s.Files, fileEntry{Path: path})
	}
	s.Files[0] = fileEntry{Path: authStorage, Present: true, Body: []byte(`{"iCubeAuthInfo://icube.cloudide":"new-private"}`)}
	if err := apply(p, s); err != nil {
		t.Fatal(err)
	}
	var result map[string]any
	_ = readJSON(entryPath(p, authStorage), &result)
	if result["window.layout"] != "preserve" || result["iCubeAuthInfo://icube.cloudide"] != "new-private" {
		t.Fatal(result)
	}
	s.Files = append(s.Files, fileEntry{Path: "../escape", Present: true, Body: []byte("bad")})
	before, _ := os.ReadFile(entryPath(p, authStorage))
	if err := apply(p, s); err == nil {
		t.Fatal("accepted traversal")
	}
	after, _ := os.ReadFile(entryPath(p, authStorage))
	if !bytes.Equal(before, after) {
		t.Fatal("partially applied invalid snapshot")
	}
}

func TestTraeVerificationIgnoresOlderSessionAndReadsLatestUID(t *testing.T) {
	root := t.TempDir()
	writeLog := func(session, body string) {
		t.Helper()
		if err := atomicWrite(filepath.Join(root, "logs", session, "dynamicConfig.log"), []byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	writeLog("20261101T100000", "url?uid=123456789012345&test=1")
	if liveTraeUID(root, "20261101T100000", time.Now()) != "" {
		t.Fatal("old session accepted")
	}
	writeLog("20261101T100001", "url?uid=123456789012345&test=1\nurl?uid=223456789012345&test=2")
	if got := liveTraeUID(root, "20261101T100000", time.Now().Add(-time.Minute)); got != "223456789012345" {
		t.Fatal(got)
	}
}

func TestTraeCaptureRequiresMatchingJWTAndKeepsSettingsOut(t *testing.T) {
	m, _, _ := fixture(t)
	root := t.TempDir()
	p := profile{id: "trae", name: "Trae", root: root, exe: filepath.Join(root, "Trae CN.exe")}
	_ = atomicWrite(p.exe, []byte("fixture"))
	m.profiles["trae"] = p
	claims, _ := json.Marshal(map[string]any{"data": map[string]string{"id": "123456789012345"}, "exp": time.Now().Add(time.Hour).Unix()})
	token := "header." + base64.RawURLEncoding.EncodeToString(claims) + ".fixture"
	info, _ := json.Marshal(map[string]any{"userId": "123456789012345", "token": token, "host": "https://api.trae.cn", "account": map[string]string{"username": "本地账号"}})
	_ = writeJSON(entryPath(p, authStorage), map[string]any{"iCubeAuthInfo://icube.cloudide": string(info), "iCubeAuthInfo://icube-dc:123456789012345": "secret-key", "projects": "not-a-login-field"})
	_ = atomicWrite(filepath.Join(root, "logs", "20261101T100000", "dynamicConfig.log"), []byte("url?uid=223456789012345&x=1"))
	if _, _, _, err := m.SaveCurrent("trae"); err == nil {
		t.Fatal("captured another running account")
	}
	_ = atomicWrite(filepath.Join(root, "logs", "20261101T100000", "dynamicConfig.log"), []byte("url?uid=123456789012345&x=1"))
	uid, _, _, err := m.SaveCurrent("trae")
	if err != nil {
		t.Fatal(err)
	}
	if uid != "123456789012345" {
		t.Fatal(uid)
	}
	body, _ := os.ReadFile(m.slot("trae", uid))
	if strings.Contains(string(body), "not-a-login-field") {
		t.Fatal("copied unrelated settings")
	}
}
