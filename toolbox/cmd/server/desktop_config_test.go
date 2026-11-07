package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func writeDesktopFixture(t *testing.T, root string, populated bool) string {
	t.Helper()
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "config.json")
	if err := os.WriteFile(path, []byte(`{"auth_dir":"auths","state_file":"data/state.json"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if populated {
		if err := os.MkdirAll(filepath.Join(root, "auths"), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "auths", "workbuddy-example.json"), []byte(`{"uid":"example"}`), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return path
}

func TestDesktopFindsOriginalAccountsFromRelease(t *testing.T) {
	root := t.TempDir()
	original := writeDesktopFixture(t, root, true)
	release := filepath.Join(root, "data", "releases", "desktop")
	empty := writeDesktopFixture(t, release, false)
	preferences := filepath.Join(t.TempDir(), "desktop-settings.json")
	if got := desktopConfigPath(release, preferences); got != original {
		t.Fatalf("selected %s instead of original installation", got)
	}
	if err := rememberDesktopConfig(preferences, original); err != nil {
		t.Fatal(err)
	}
	moved := t.TempDir()
	if got := desktopConfigPath(moved, preferences); got != original {
		t.Fatalf("moving EXE lost accounts: %s", got)
	}
	if _, err := os.Stat(empty); err != nil {
		t.Fatal("empty installation was modified")
	}
	local := writeDesktopFixture(t, moved, true)
	if got := desktopConfigPath(moved, preferences); got != local {
		t.Fatal("replaced a populated local installation")
	}
}

func TestDesktopConfigFreshAndMissingPreferences(t *testing.T) {
	root := t.TempDir()
	preferences := filepath.Join(t.TempDir(), "desktop-settings.json")
	if err := rememberDesktopConfig(preferences, filepath.Join(t.TempDir(), "missing.json")); err != nil {
		t.Fatal(err)
	}
	if got := desktopConfigPath(root, preferences); got != filepath.Join(root, "config.json") {
		t.Fatalf("fresh installation selected %s", got)
	}
}

func TestDesktopFindsProviderAccountsInCustomStateDirectory(t *testing.T) {
	for _, name := range []string{"trae-accounts.json", "qoder-accounts.json"} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, "config.json")
			stateDir := filepath.Join(root, "custom-state")
			if err := os.MkdirAll(stateDir, 0700); err != nil {
				t.Fatal(err)
			}
			raw, _ := json.Marshal(map[string]string{"state_file": filepath.Join(stateDir, "state.json")})
			if err := os.WriteFile(path, raw, 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(stateDir, name), []byte(`[{"id":"saved-account"}]`), 0600); err != nil {
				t.Fatal(err)
			}
			if !desktopHasAccounts(path) {
				t.Fatal("did not recognize provider accounts")
			}
		})
	}
}
