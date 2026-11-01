//go:build !windows

package desktop

import (
	"context"
	"fmt"
)

func discover() map[string]profile {
	return map[string]profile{"qoder": {id: "qoder", name: "Qoder 国内版"}, "trae": {id: "trae", name: "Trae 国内版"}, "workbuddy": {id: "workbuddy", name: "WorkBuddy"}, "workbuddy-global": {id: "workbuddy-global", name: "WorkBuddy AI"}}
}
func stopClient(context.Context, profile) error {
	return fmt.Errorf("客户端切换暂仅支持 Windows")
}
func launchClient(profile) error { return fmt.Errorf("客户端切换暂仅支持 Windows") }
func clientRunning(profile) bool { return false }
