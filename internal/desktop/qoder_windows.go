//go:build windows

package desktop

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

func qoderKey(root string) ([]byte, error) {
	var state struct {
		Crypt struct {
			Key string `json:"encrypted_key"`
		} `json:"os_crypt"`
	}
	if readJSON(entryPath(profile{root: root}, "Local State"), &state) != nil {
		return nil, fmt.Errorf("无法读取 Qoder 本机加密密钥")
	}
	wrapped, err := base64.StdEncoding.DecodeString(state.Crypt.Key)
	if err != nil || len(wrapped) <= 5 || !bytes.Equal(wrapped[:5], []byte("DPAPI")) {
		return nil, fmt.Errorf("Qoder 本机密钥格式不支持")
	}
	input := windows.DataBlob{Size: uint32(len(wrapped) - 5), Data: &wrapped[5]}
	var output windows.DataBlob
	if windows.CryptUnprotectData(&input, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &output) != nil {
		return nil, fmt.Errorf("无法解密 Qoder 登录态，请使用安装客户端的 Windows 用户运行面板")
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(output.Data)))
	key := append([]byte(nil), unsafe.Slice(output.Data, output.Size)...)
	if len(key) != 32 {
		return nil, fmt.Errorf("Qoder 加密密钥长度不支持")
	}
	return key, nil
}

func qoderCipher(root string) (cipher.AEAD, error) {
	key, err := qoderKey(root)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("Qoder 加密初始化失败")
	}
	return cipher.NewGCM(block)
}

func readQoderAuth(root string) (map[string]json.RawMessage, error) {
	enc, err := readPrivate(entryPath(profile{root: root}, "auth.v1.dat"))
	if err != nil {
		return nil, fmt.Errorf("Qoder 尚未保存客户端登录态，请先启动并登录一次")
	}
	return decodeQoderAuth(root, enc)
}

func decodeQoderAuth(root string, enc []byte) (map[string]json.RawMessage, error) {
	gcm, err := qoderCipher(root)
	if err != nil {
		return nil, err
	}
	if len(enc) < 3+gcm.NonceSize()+gcm.Overhead() || !bytes.Equal(enc[:3], []byte("v10")) {
		return nil, fmt.Errorf("Qoder 登录文件格式不支持")
	}
	plain, err := gcm.Open(nil, enc[3:3+gcm.NonceSize()], enc[3+gcm.NonceSize():], nil)
	if err != nil {
		return nil, fmt.Errorf("无法解密 Qoder 登录文件")
	}
	var auth map[string]json.RawMessage
	if json.Unmarshal(plain, &auth) != nil || auth == nil {
		return nil, fmt.Errorf("Qoder 登录文件内容无效")
	}
	return auth, nil
}

func encodeQoderAuth(root string, auth any) ([]byte, error) {
	gcm, err := qoderCipher(root)
	if err != nil {
		return nil, err
	}
	plain, err := json.Marshal(auth)
	if err != nil {
		return nil, fmt.Errorf("Qoder 登录数据无效")
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("无法生成 Qoder 加密随机数")
	}
	out := append([]byte("v10"), nonce...)
	return gcm.Seal(out, nonce, plain, nil), nil
}
