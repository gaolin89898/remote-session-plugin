//go:build windows

package desktop

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func discover() map[string]profile {
	home, _ := os.UserHomeDir()
	local := os.Getenv("LOCALAPPDATA")
	if local == "" {
		local = filepath.Join(home, "AppData", "Local")
	}
	roaming := os.Getenv("APPDATA")
	if roaming == "" {
		roaming = filepath.Join(home, "AppData", "Roaming")
	}
	programs := filepath.Join(local, "Programs")
	authDir := filepath.Join(local, "CodeBuddyExtension", "Data", "Public", "auth")
	out := map[string]profile{
		"qoder":            {id: "qoder", name: "Qoder 国内版", root: filepath.Join(roaming, "com.qodercn.app.stable"), exe: filepath.Join(programs, "Qoder CN", "Qoder CN.exe")},
		"trae":             {id: "trae", name: "Trae 国内版", root: filepath.Join(roaming, "Trae CN"), exe: filepath.Join(programs, "Trae CN", "Trae CN.exe")},
		"workbuddy":        {id: "workbuddy", name: "WorkBuddy", root: filepath.Join(home, ".workbuddy"), exe: filepath.Join(programs, "WorkBuddy", "WorkBuddy.exe"), auth: filepath.Join(authDir, "workbuddy-desktop.info")},
		"workbuddy-global": {id: "workbuddy-global", name: "WorkBuddy AI", root: filepath.Join(home, ".workbuddy-ai"), exe: filepath.Join(programs, "WorkBuddyAI", "WorkBuddyAI.exe"), auth: filepath.Join(authDir, "workbuddy-desktop-ai.info")},
	}
	for id, p := range out {
		if !regular(p.exe) {
			for _, base := range []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)")} {
				if base != "" {
					candidate := filepath.Join(base, filepath.Base(filepath.Dir(p.exe)), filepath.Base(p.exe))
					if regular(candidate) {
						p.exe = candidate
						break
					}
				}
			}
		}
		if !regular(p.exe) {
			if path := registeredClientExecutable(p); path != "" {
				p.exe = path
			}
		}
		out[id] = p
	}
	return out
}

func appPIDs(p profile) ([]uint32, error) {
	h, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, fmt.Errorf("无法检查客户端进程")
	}
	defer windows.CloseHandle(h)
	var entry windows.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	var ids []uint32
	var scanErr error
	for err = windows.Process32First(h, &entry); err == nil; err = windows.Process32Next(h, &entry) {
		if !strings.EqualFold(windows.UTF16ToString(entry.ExeFile[:]), filepath.Base(p.exe)) {
			continue
		}
		proc, e := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, entry.ProcessID)
		if e != nil {
			if e == windows.ERROR_INVALID_PARAMETER {
				continue
			} // Exited during enumeration.
			scanErr = fmt.Errorf("无法访问客户端进程，请让面板与客户端使用相同权限运行")
			continue
		}
		image, e := processImagePath(proc)
		windows.CloseHandle(proc)
		if e != nil {
			scanErr = fmt.Errorf("无法核对客户端进程路径（PID %d），已停止切换：%w", entry.ProcessID, e)
			continue
		}
		if sameClientImage(p, image) {
			ids = append(ids, entry.ProcessID)
		}
	}
	if err != windows.ERROR_NO_MORE_FILES {
		return ids, fmt.Errorf("读取客户端进程列表失败")
	}
	return ids, scanErr
}

var qoderVersionDirectory = regexp.MustCompile(`^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?$`)

func sameClientImage(p profile, image string) bool {
	if image == "" {
		return false
	}
	if strings.EqualFold(filepath.Clean(image), filepath.Clean(p.exe)) {
		return true
	}
	if p.id != "qoder" {
		return false
	}
	// Qoder's stable launcher hands off to its installed update directory.
	// Keep path verification scoped to that exact installation and layout.
	relative, err := filepath.Rel(filepath.Dir(p.exe), filepath.Clean(image))
	if err != nil {
		return false
	}
	parts := strings.Split(relative, string(filepath.Separator))
	return len(parts) == 3 && strings.EqualFold(parts[0], ".qoder-versions") &&
		qoderVersionDirectory.MatchString(parts[1]) && strings.EqualFold(parts[2], filepath.Base(p.exe))
}

func processExited(process windows.Handle) bool {
	state, err := windows.WaitForSingleObject(process, 0)
	return err == nil && state == windows.WAIT_OBJECT_0
}

func processImagePath(process windows.Handle) (string, error) {
	if processExited(process) {
		return "", nil
	}
	buf := make([]uint16, 32768)
	n := uint32(len(buf))
	if err := windows.QueryFullProcessImageName(process, 0, &buf[0], &n); err != nil {
		// Electron children can exit between the snapshot and the image query.
		state, waitErr := windows.WaitForSingleObject(process, 250)
		if waitErr == nil && state == windows.WAIT_OBJECT_0 {
			return "", nil
		}
		return "", err
	}
	return windows.UTF16ToString(buf[:n]), nil
}

// Verified matching processes are enough for status. Switching still refuses
// any enumeration error before closing a client or touching credentials.
func clientRunning(p profile) bool { ids, _ := appPIDs(p); return len(ids) > 0 }

var user32 = windows.NewLazySystemDLL("user32.dll")
var enumWindows = user32.NewProc("EnumWindows")
var windowPID = user32.NewProc("GetWindowThreadProcessId")
var postMessage = user32.NewProc("PostMessageW")

func stopClient(ctx context.Context, p profile) error {
	ids, err := appPIDs(p)
	if err != nil {
		return err
	}
	if len(ids) == 0 {
		return nil
	}
	set := map[uint32]bool{}
	for _, id := range ids {
		set[id] = true
	}
	callback := syscall.NewCallback(func(hwnd, extra uintptr) uintptr {
		var pid uint32
		windowPID.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
		if set[pid] {
			postMessage.Call(hwnd, 0x0010, 0, 0)
		}
		return 1
	})
	enumWindows.Call(callback, 0)
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		ids, err = appPIDs(p)
		if err != nil {
			return err
		}
		if len(ids) == 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("客户端退出已取消")
		case <-time.After(250 * time.Millisecond):
		}
	}
	// The panel's confirmation explicitly asks the user to save work and
	// authorizes exiting this exact client, including tray/background processes.
	ids, err = appPIDs(p)
	if err != nil {
		return err
	}
	for _, id := range ids {
		h, e := windows.OpenProcess(windows.PROCESS_TERMINATE|windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, id)
		if e != nil {
			if e == windows.ERROR_INVALID_PARAMETER {
				continue
			}
			return fmt.Errorf("无法关闭客户端，请手动退出后重试")
		}
		// Recheck the image after acquiring the handle (PID reuse protection).
		image, e := processImagePath(h)
		if e == nil && sameClientImage(p, image) {
			e = windows.TerminateProcess(h, 0)
		}
		if e != nil && processExited(h) {
			e = nil
		}
		windows.CloseHandle(h)
		if e != nil {
			return fmt.Errorf("关闭客户端失败，请手动退出后重试")
		}
	}
	for i := 0; i < 20; i++ {
		ids, err = appPIDs(p)
		if err != nil {
			return err
		}
		if len(ids) == 0 {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("客户端仍在运行，未修改登录态")
}

func launchClient(p profile) error {
	cmd := exec.Command(p.exe)
	cmd.Dir = filepath.Dir(p.exe)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("启动客户端失败")
	}
	return cmd.Process.Release()
}
