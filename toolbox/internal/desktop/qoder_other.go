//go:build !windows

package desktop

import (
	"encoding/json"
	"fmt"
)

func readQoderAuth(string) (map[string]json.RawMessage, error) {
	return nil, fmt.Errorf("Qoder 客户端切换暂仅支持 Windows")
}
func decodeQoderAuth(string, []byte) (map[string]json.RawMessage, error) {
	return nil, fmt.Errorf("Qoder 客户端切换暂仅支持 Windows")
}
func encodeQoderAuth(string, any) ([]byte, error) {
	return nil, fmt.Errorf("Qoder 客户端切换暂仅支持 Windows")
}
