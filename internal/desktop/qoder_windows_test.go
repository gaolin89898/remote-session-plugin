//go:build windows

package desktop

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func qoderFixture(t *testing.T) (*Manager, profile, *QoderAuth) {
	t.Helper()
	m, _, _ := fixture(t)
	p := profile{id: "qoder", name: "Qoder 国内版", root: filepath.Join(t.TempDir(), "client"), exe: filepath.Join(t.TempDir(), "Qoder CN.exe")}
	_ = atomicWrite(p.exe, []byte("test fixture, never executed"))
	key := make([]byte, 32)
	_, _ = rand.Read(key)
	input := windows.DataBlob{Size: uint32(len(key)), Data: &key[0]}
	var out windows.DataBlob
	if err := windows.CryptProtectData(&input, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		t.Fatal(err)
	}
	wrapped := append([]byte("DPAPI"), unsafe.Slice(out.Data, out.Size)...)
	windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	_ = writeJSON(filepath.Join(p.root, "Local State"), map[string]any{"os_crypt": map[string]string{"encrypted_key": base64.StdEncoding.EncodeToString(wrapped)}})
	old, err := encodeQoderAuth(p.root, map[string]any{"schemaVersion": 1, "authenticationContext": "cn", "token": "dt-old-private", "refreshToken": "drt-old-private", "user": map[string]string{"id": "old", "name": "Old", "email": "old@example.test"}, "profileOverlay": map[string]string{"private": "old-profile"}})
	if err != nil {
		t.Fatal(err)
	}
	_ = atomicWrite(filepath.Join(p.root, "auth.v1.dat"), old)
	_ = atomicWrite(filepath.Join(p.root, "auth-profile-overlays.v1.dat"), []byte("old-private-overlay"))
	_ = atomicWrite(filepath.Join(p.root, "auth.machine-id"), []byte("keep-machine"))
	_ = atomicWrite(filepath.Join(p.root, "main.sqlite"), []byte("keep-chats"))
	m.profiles["qoder"] = p
	return m, p, &QoderAuth{UID: "new", Name: "New", Token: "dt-new-private", Refresh: "drt-new-private", ExpiresAt: time.Now().Add(time.Hour), RefreshExpiresAt: time.Now().Add(24 * time.Hour)}
}

func TestQoderDirectSwitchUsesNativeEncryptionAndFreshClientEvidence(t *testing.T) {
	m, p, c := qoderFixture(t)
	m.launch = func(profile) error {
		path := filepath.Join(p.root, "logs", "20261101-200000.123-1234-abcdef01", "main.log")
		return atomicWrite(path, []byte(`[Auth] Account plan request completed {"operation":"account.getUserPlan","region":"cn","status":200}`))
	}
	if _, err := m.StartQoder(c.UID, c); err != nil {
		t.Fatal(err)
	}
	if j := awaitJob(t, m); j.Error != "" {
		t.Fatal(j.Error)
	}
	auth, err := readQoderAuth(p.root)
	if err != nil {
		t.Fatal(err)
	}
	uid, _ := qoderIdentity(auth)
	if uid != "new" || string(auth["authenticationContext"]) != `"cn"` || auth["profileOverlay"] != nil {
		t.Fatal("native auth identity or binding incorrect")
	}
	raw, _ := json.Marshal(auth)
	if strings.Contains(string(raw), "old@example.test") {
		t.Fatal("copied another account's profile")
	}
	enc, _ := os.ReadFile(filepath.Join(p.root, "auth.v1.dat"))
	if !bytes.HasPrefix(enc, []byte("v10")) || bytes.Contains(enc, []byte(c.Token)) {
		t.Fatal("native credential was not encrypted")
	}
	for _, f := range []string{"main.sqlite", "auth.machine-id"} {
		b, _ := os.ReadFile(filepath.Join(p.root, f))
		if !bytes.HasPrefix(b, []byte("keep-")) {
			t.Fatalf("changed %s", f)
		}
	}
	clients, j := m.Status()
	public, _ := json.Marshal(map[string]any{"clients": clients, "job": j})
	if strings.Contains(string(public), "private") {
		t.Fatal("status leaked credentials")
	}
}

func TestQoderStaleEvidenceRollsBackAndRejectsOtherIdentity(t *testing.T) {
	m, p, c := qoderFixture(t)
	old, _ := os.ReadFile(filepath.Join(p.root, "auth.v1.dat"))
	_ = atomicWrite(filepath.Join(p.root, "logs", "20261101-190000.123-1234-abcdef01", "main.log"), []byte(`[Auth] Account plan request completed {"operation":"account.getUserPlan","region":"cn","status":200}`))
	if _, err := m.StartQoder(c.UID, c); err != nil {
		t.Fatal(err)
	}
	if j := awaitJob(t, m); !strings.Contains(j.Error, "已恢复原登录态") {
		t.Fatalf("stale evidence confirmed switch: %+v", j)
	}
	now, _ := os.ReadFile(filepath.Join(p.root, "auth.v1.dat"))
	if !bytes.Equal(old, now) {
		t.Fatal("original auth not restored")
	}
	overlay, _ := os.ReadFile(filepath.Join(p.root, "auth-profile-overlays.v1.dat"))
	if string(overlay) != "old-private-overlay" {
		t.Fatal("original overlay not restored")
	}
	target, err := qoderTarget(p, c)
	if err != nil {
		t.Fatal(err)
	}
	target.UID = "someone-else"
	if err = apply(p, target); err == nil {
		t.Fatal("accepted mismatched encrypted snapshot")
	}
	now, _ = os.ReadFile(filepath.Join(p.root, "auth.v1.dat"))
	if !bytes.Equal(old, now) {
		t.Fatal("invalid snapshot partially applied")
	}
}
