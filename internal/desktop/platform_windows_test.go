//go:build windows

package desktop

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestDesktopProcessHelper(t *testing.T) {
	if os.Getenv("WB_DESKTOP_PROCESS_HELPER") != "1" {
		return
	}
	_, _ = io.Copy(io.Discard, os.Stdin)
	os.Exit(259)
}

func TestProcessImagePathDuringExit(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(executable, "-test.run=^TestDesktopProcessHelper$")
	cmd.Env = append(os.Environ(), "WB_DESKTOP_PROCESS_HELPER=1")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, uint32(cmd.Process.Pid))
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(process)
	image, err := processImagePath(process)
	if err != nil || !strings.EqualFold(filepath.Clean(image), filepath.Clean(executable)) {
		t.Fatalf("running process image = %q, error = %v", image, err)
	}
	if processExited(process) {
		t.Fatal("live process reported as exited")
	}
	_ = stdin.Close()
	state, err := windows.WaitForSingleObject(process, 10000)
	if err != nil || state != windows.WAIT_OBJECT_0 {
		t.Fatalf("child did not exit: state %d, error %v", state, err)
	}
	// Exit code 259 is also STILL_ACTIVE, so use the signaled handle instead.
	image, err = processImagePath(process)
	if err != nil || image != "" {
		t.Fatalf("exited process should be ignored: image %q, error %v", image, err)
	}
}

func TestProcessImagePathInvalidHandle(t *testing.T) {
	if _, err := processImagePath(0); err == nil {
		t.Fatal("unverifiable process must remain an error")
	}
}

func TestQoderUpdatedProcessStaysWithinInstalledVersionDirectory(t *testing.T) {
	root := filepath.Join(t.TempDir(), "Qoder CN")
	p := profile{id: "qoder", exe: filepath.Join(root, "Qoder CN.exe")}
	for _, tc := range []struct {
		name, image string
		match       bool
	}{
		{"launcher", p.exe, true},
		{"updated client", filepath.Join(root, ".qoder-versions", "0.5.2", "Qoder CN.exe"), true},
		{"case insensitive", filepath.Join(root, ".QODER-VERSIONS", "0.5.2", "qoder cn.EXE"), true},
		{"other installation", filepath.Join(t.TempDir(), ".qoder-versions", "0.5.2", "Qoder CN.exe"), false},
		{"uninstaller", filepath.Join(root, ".qoder-versions", "0.5.2", "Uninstall Qoder CN.exe"), false},
		{"nested unrelated program", filepath.Join(root, ".qoder-versions", "0.5.2", "tools", "Qoder CN.exe"), false},
		{"unrecognized directory", filepath.Join(root, "other", "0.5.2", "Qoder CN.exe"), false},
		{"unrecognized version", filepath.Join(root, ".qoder-versions", "download", "Qoder CN.exe"), false},
		{"empty", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := sameClientImage(p, tc.image); got != tc.match {
				t.Fatalf("matched %q = %v, want %v", tc.image, got, tc.match)
			}
		})
	}
	p.id = "trae"
	if sameClientImage(p, filepath.Join(root, ".qoder-versions", "0.5.2", "Qoder CN.exe")) {
		t.Fatal("Qoder update matching must not apply to other clients")
	}
}

func TestQoderUpdatedProcessIsDetectedBesideLauncher(t *testing.T) {
	root := t.TempDir()
	p := profile{id: "qoder", exe: filepath.Join(root, "Qoder CN.exe")}
	versionExe := filepath.Join(root, ".qoder-versions", "0.5.2", "Qoder CN.exe")
	if err := os.MkdirAll(filepath.Dir(versionExe), 0700); err != nil {
		t.Fatal(err)
	}
	testExe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(testExe)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(versionExe, body, 0700); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(versionExe, "-test.run=^TestDesktopProcessHelper$")
	cmd.Env = append(os.Environ(), "WB_DESKTOP_PROCESS_HELPER=1")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = cmd.Start(); err != nil {
		stdin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { stdin.Close(); _ = cmd.Process.Kill(); _ = cmd.Wait() })
	ids, err := appPIDs(p)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 1 || ids[0] != uint32(cmd.Process.Pid) {
		t.Fatalf("updated client process not found: %v", ids)
	}
	if !clientRunning(p) {
		t.Fatal("updated client was reported as stopped")
	}
}
