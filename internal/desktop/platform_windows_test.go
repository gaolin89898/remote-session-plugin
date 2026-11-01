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
