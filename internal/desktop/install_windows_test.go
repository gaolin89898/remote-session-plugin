//go:build windows

package desktop

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows/registry"
)

func testInstallRegistry(t *testing.T) registry.Key {
	t.Helper()
	path := fmt.Sprintf(`Software\WorkBuddyAccountsTests-%d-%d`, os.Getpid(), time.Now().UnixNano())
	key, _, err := registry.CreateKey(registry.CURRENT_USER, path, registry.ALL_ACCESS)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		var removeChildren func(registry.Key)
		removeChildren = func(parent registry.Key) {
			names, err := parent.ReadSubKeyNames(-1)
			if err != nil {
				t.Error(err)
				return
			}
			for _, name := range names {
				child, err := registry.OpenKey(parent, name, registry.ALL_ACCESS)
				if err != nil {
					t.Error(err)
					continue
				}
				removeChildren(child)
				child.Close()
				if err := registry.DeleteKey(parent, name); err != nil {
					t.Error(err)
				}
			}
		}
		removeChildren(key)
		key.Close()
		if err := registry.DeleteKey(registry.CURRENT_USER, path); err != nil {
			t.Error(err)
		}
	})
	return key
}

func TestCustomClientInstallDiscovery(t *testing.T) {
	const version = `Microsoft\Windows\CurrentVersion\`
	for _, tc := range []struct {
		name, key, display, location, icon, appPath string
		clientID, clientName, exeName               string
		found                                       bool
	}{
		{name: "custom install icon", key: "Uninstall\\custom", display: "WorkBuddy 5.9.3", icon: "%EXE%,0", found: true},
		{name: "quoted icon and comma in path", key: "Uninstall\\custom", display: "WorkBuddy 5.9.3", icon: `"%EXE%",0`, found: true},
		{name: "install directory", key: "Uninstall\\custom", display: "WorkBuddy", location: "%DIR%", found: true},
		{name: "app paths", key: "App Paths\\WorkBuddy.exe", appPath: `"%EXE%"`, found: true},
		{name: "other realm", key: "Uninstall\\custom", display: "WorkBuddy AI 5.9.3", icon: "%EXE%,0"},
		{name: "missing executable", key: "Uninstall\\custom", display: "WorkBuddy", icon: "%DIR%\\missing\\WorkBuddy.exe,0"},
		{name: "uninstall command is not an executable path", key: "App Paths\\WorkBuddy.exe", appPath: `"%EXE%" --argument`},
		{name: "relative executable", key: "Uninstall\\custom", display: "WorkBuddy", icon: "WorkBuddy.exe,0"},
		{name: "Trae user installation", key: "Uninstall\\custom", display: "TRAE CN (User)", icon: "%EXE%", clientID: "trae", clientName: "Trae 国内版", exeName: "Trae CN.exe", found: true},
		{name: "Trae system installation", key: "Uninstall\\custom", display: "TRAE CN (System)", location: "%DIR%", clientID: "trae", clientName: "Trae 国内版", exeName: "Trae CN.exe", found: true},
		{name: "Qoder standalone icon", key: "Uninstall\\custom", display: "Qoder CN 0.5.2", icon: "%DIR%\\uninstallerIcon.ico", clientID: "qoder", clientName: "Qoder 国内版", exeName: "Qoder CN.exe", found: true},
		{name: "Trae SOLO is a separate profile", key: "Uninstall\\custom", display: "TRAE SOLO CN (User)", icon: "%EXE%", clientID: "trae", clientName: "Trae 国内版", exeName: "Trae CN.exe"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := testInstallRegistry(t)
			dir := filepath.Join(t.TempDir(), "自定义,install")
			if err := os.MkdirAll(dir, 0700); err != nil {
				t.Fatal(err)
			}
			exeName := tc.exeName
			if exeName == "" {
				exeName = "WorkBuddy.exe"
			}
			exe := filepath.Join(dir, exeName)
			if err := os.WriteFile(exe, []byte("fixture, never executed"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, "uninstallerIcon.ico"), []byte("fixture icon"), 0600); err != nil {
				t.Fatal(err)
			}
			replace := func(value string) string {
				return strings.NewReplacer("%EXE%", exe, "%DIR%", dir).Replace(value)
			}
			entry, _, err := registry.CreateKey(root, version+tc.key, registry.ALL_ACCESS)
			if err != nil {
				t.Fatal(err)
			}
			defer entry.Close()
			for name, value := range map[string]string{"DisplayName": tc.display, "InstallLocation": tc.location, "DisplayIcon": tc.icon, "": tc.appPath} {
				if err := entry.SetStringValue(name, replace(value)); err != nil {
					t.Fatal(err)
				}
			}
			p := profile{id: "workbuddy", name: "WorkBuddy", exe: filepath.Join(t.TempDir(), exeName)}
			if tc.clientID != "" {
				p.id, p.name = tc.clientID, tc.clientName
			}
			got := clientExecutableInRegistry(p, root, 0)
			if tc.found && got != exe || !tc.found && got != "" {
				t.Fatalf("discovered %q, expected found=%v at %q", got, tc.found, exe)
			}
		})
	}
}
