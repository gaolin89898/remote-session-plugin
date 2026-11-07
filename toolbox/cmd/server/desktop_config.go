package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type desktopPreferences struct {
	ConfigPath string `json:"config_path"`
}

func desktopHasAccounts(configPath string) bool {
	raw, err := os.ReadFile(configPath)
	if err != nil {
		return false
	}
	paths := struct {
		AuthDir   string `json:"auth_dir"`
		StateFile string `json:"state_file"`
	}{AuthDir: "auths", StateFile: "data/state.json"}
	if json.Unmarshal(raw, &paths) != nil {
		return false
	}
	resolve := func(path string) string {
		if filepath.IsAbs(path) {
			return path
		}
		return filepath.Join(filepath.Dir(configPath), path)
	}
	files, _ := filepath.Glob(filepath.Join(resolve(paths.AuthDir), "workbuddy*.json"))
	for _, file := range files {
		if st, err := os.Stat(file); err == nil && st.Mode().IsRegular() && st.Size() > 0 {
			return true
		}
	}
	for _, name := range []string{"trae-accounts.json", "qoder-accounts.json"} {
		raw, err := os.ReadFile(filepath.Join(filepath.Dir(resolve(paths.StateFile)), name))
		var accounts []struct {
			ID string `json:"id"`
		}
		if err == nil && json.Unmarshal(raw, &accounts) == nil {
			for _, account := range accounts {
				if account.ID != "" {
					return true
				}
			}
		}
	}
	return false
}

func desktopConfigPath(executableDir, preferencesPath string) string {
	local := filepath.Join(executableDir, "config.json")
	if desktopHasAccounts(local) {
		return local
	}
	var preferences desktopPreferences
	if raw, err := os.ReadFile(preferencesPath); err == nil {
		_ = json.Unmarshal(raw, &preferences)
	}
	if filepath.IsAbs(preferences.ConfigPath) && desktopHasAccounts(preferences.ConfigPath) {
		return preferences.ConfigPath
	}
	// Builds stored under data/releases should keep using their installation data.
	dir := executableDir
	for i := 0; i < 3; i++ {
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
		candidate := filepath.Join(dir, "config.json")
		if desktopHasAccounts(candidate) {
			return candidate
		}
	}
	if filepath.IsAbs(preferences.ConfigPath) {
		if st, err := os.Stat(preferences.ConfigPath); err == nil && st.Mode().IsRegular() {
			return preferences.ConfigPath
		}
	}
	return local
}

func rememberDesktopConfig(preferencesPath, configPath string) error {
	if err := os.MkdirAll(filepath.Dir(preferencesPath), 0700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(desktopPreferences{ConfigPath: configPath}, "", "  ")
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(preferencesPath), ".desktop-settings-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(raw)
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(file.Name(), preferencesPath)
}
