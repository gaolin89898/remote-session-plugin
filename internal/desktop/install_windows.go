//go:build windows

package desktop

import (
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/sys/windows/registry"
)

func registeredClientExecutable(p profile) string {
	for _, root := range []registry.Key{registry.CURRENT_USER, registry.LOCAL_MACHINE} {
		for _, view := range []uint32{registry.WOW64_64KEY, registry.WOW64_32KEY} {
			software, err := registry.OpenKey(root, `Software`, registry.READ|view)
			if err != nil {
				continue
			}
			path := clientExecutableInRegistry(p, software, view)
			software.Close()
			if path != "" {
				return path
			}
		}
	}
	return ""
}

// software may be an isolated registry root in tests. Only read installation
// metadata; registry commands are never executed, and the exact EXE is checked.
func clientExecutableInRegistry(p profile, software registry.Key, view uint32) string {
	const version = `Microsoft\Windows\CurrentVersion\`
	exeName := filepath.Base(p.exe)
	valid := func(path string) bool {
		return filepath.IsAbs(path) && strings.EqualFold(filepath.Base(path), exeName) && regular(path)
	}
	app, err := registry.OpenKey(software, version+`App Paths\`+exeName, registry.QUERY_VALUE|view)
	if err == nil {
		value, _, _ := app.GetStringValue("")
		app.Close()
		if path := registryIconPath(value); valid(path) {
			return path
		}
	}
	uninstall, err := registry.OpenKey(software, version+`Uninstall`, registry.READ|view)
	if err != nil {
		return ""
	}
	defer uninstall.Close()
	entries, err := uninstall.ReadSubKeyNames(-1)
	if err != nil {
		return ""
	}
	for _, entry := range entries {
		key, err := registry.OpenKey(uninstall, entry, registry.QUERY_VALUE|view)
		if err != nil {
			continue
		}
		name, _, _ := key.GetStringValue("DisplayName")
		location, _, _ := key.GetStringValue("InstallLocation")
		icon, _, _ := key.GetStringValue("DisplayIcon")
		key.Close()
		if !clientInstallName(p, name) {
			continue
		}
		if location = strings.Trim(strings.TrimSpace(location), `"`); filepath.IsAbs(location) {
			if path := filepath.Join(location, exeName); valid(path) {
				return path
			}
		}
		if path := registryIconPath(icon); valid(path) {
			return path
		}
		// Electron installers such as Qoder record an .ico instead of an EXE.
		if path := registryIconPath(icon); filepath.IsAbs(path) && strings.EqualFold(filepath.Ext(path), ".ico") && regular(path) {
			if candidate := filepath.Join(filepath.Dir(path), exeName); valid(candidate) {
				return candidate
			}
		}
	}
	return ""
}

func clientInstallName(p profile, name string) bool {
	name = strings.ToLower(strings.TrimSpace(name))
	for _, suffix := range []string{" (user)", " (system)"} {
		name = strings.TrimSpace(strings.TrimSuffix(name, suffix))
	}
	for _, alias := range []string{p.name, strings.TrimSuffix(filepath.Base(p.exe), filepath.Ext(p.exe))} {
		alias = strings.ToLower(alias)
		if name == alias {
			return true
		}
		if strings.HasPrefix(name, alias+" ") {
			suffix := strings.TrimSpace(name[len(alias):])
			if len(suffix) > 0 && suffix[0] >= '0' && suffix[0] <= '9' {
				return true
			}
		}
	}
	return false
}

func registryIconPath(value string) string {
	value = strings.TrimSpace(value)
	if i := strings.LastIndexByte(value, ','); i >= 0 {
		if _, err := strconv.Atoi(strings.TrimSpace(value[i+1:])); err == nil {
			value = value[:i]
		}
	}
	return strings.Trim(strings.TrimSpace(value), `"`)
}
