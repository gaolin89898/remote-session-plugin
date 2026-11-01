package trae

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

type clientDevice struct{ uid, device string }

// Protocol salts for the Trae client's two tc storage envelopes. These are
// format constants, not account keys. The local auth body is discarded after
// reading userId/host; tokens and device signing keys are never imported.
var clientSalts = map[string]string{
	"746305100000": "4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58",
	"123920200203": "490cc21292b05d0cc06ccbe91fb92e21b5a7c538811dc85e27a96e28104e1cf69c7166efab232807390da78a8b91e49c44b49a43feb941a1e46f2656e613e47b",
}

func validDeviceID(value string) bool {
	return len(value) >= 12 && len(value) <= 20 && strings.Trim(value, "0123456789") == ""
}

func clientStoragePaths() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	var roots []string
	switch runtime.GOOS {
	case "windows":
		roots = []string{os.Getenv("APPDATA"), filepath.Join(home, "AppData", "Roaming")}
	case "darwin":
		roots = []string{filepath.Join(home, "Library", "Application Support")}
	case "linux":
		root := os.Getenv("XDG_CONFIG_HOME")
		if root == "" {
			root = filepath.Join(home, ".config")
		}
		roots = []string{root}
	default:
		return nil
	}
	seen := map[string]bool{}
	var paths []string
	for _, root := range roots {
		if root == "" {
			continue
		}
		for _, profile := range []string{"Trae CN", "TRAE SOLO CN", "trae-cn"} {
			path := filepath.Join(root, profile, "User", "globalStorage", "storage.json")
			key := path
			if runtime.GOOS == "windows" {
				key = strings.ToLower(key)
			}
			if !seen[key] {
				seen[key] = true
				paths = append(paths, path)
			}
		}
	}
	return paths
}

// decodeClientAuth accepts only a verified envelope or plain JSON. Unsupported
// formats, corrupted padding and checksum failures simply name no account.
func decodeClientAuth(value string) []byte {
	value = strings.TrimSpace(value)
	if strings.HasPrefix(value, "{") {
		return []byte(value)
	}
	buf, err := base64.StdEncoding.DecodeString(value)
	if err != nil || len(buf) < 118 {
		return nil
	}
	saltHex, ok := clientSalts[hex.EncodeToString(buf[:6])]
	if !ok {
		return nil
	}
	salt, _ := hex.DecodeString(saltHex)
	randomHash := sha512.Sum512(buf[6:38])
	key := sha512.Sum512(append(randomHash[:], salt...))
	block, _ := aes.NewCipher(key[:16])
	encrypted := buf[38:]
	if len(encrypted)%aes.BlockSize != 0 {
		return nil
	}
	plain := make([]byte, len(encrypted))
	cipher.NewCBCDecrypter(block, key[16:32]).CryptBlocks(plain, encrypted)
	pad := int(plain[len(plain)-1])
	if pad < 1 || pad > aes.BlockSize || pad > len(plain) {
		return nil
	}
	for _, b := range plain[len(plain)-pad:] {
		if int(b) != pad {
			return nil
		}
	}
	plain = plain[:len(plain)-pad]
	if len(plain) < 64 {
		return nil
	}
	body := plain[64:]
	sum := sha512.Sum512(body)
	if !bytes.Equal(sum[:], plain[:64]) {
		return nil
	}
	return body
}

func deviceFromStorage(raw []byte) (clientDevice, bool) {
	var doc map[string]json.RawMessage
	if json.Unmarshal(raw, &doc) != nil {
		return clientDevice{}, false
	}
	var devices []string
	for key := range doc {
		if strings.HasPrefix(key, "iCubeAuthInfo://icube-dc:") {
			devices = append(devices, strings.TrimPrefix(key, "iCubeAuthInfo://icube-dc:"))
		}
	}
	if len(devices) != 1 || !validDeviceID(devices[0]) {
		return clientDevice{}, false
	}
	var encoded string
	if json.Unmarshal(doc["iCubeAuthInfo://icube.cloudide"], &encoded) != nil {
		return clientDevice{}, false
	}
	var auth struct {
		UserID json.RawMessage `json:"userId"`
		Host   string          `json:"host"`
	}
	if json.Unmarshal(decodeClientAuth(encoded), &auth) != nil || strings.TrimRight(auth.Host, "/") != "https://api.trae.cn" {
		return clientDevice{}, false
	}
	uid := str(auth.UserID)
	if uid == "" {
		raw := string(auth.UserID)
		if raw != "" && strings.Trim(raw, "0123456789") == "" {
			uid = raw
		}
	}
	if uid == "" {
		return clientDevice{}, false
	}
	return clientDevice{uid: uid, device: devices[0]}, true
}

func readClientDevices(paths []string) []clientDevice {
	var devices []clientDevice
	for _, path := range paths {
		file, err := os.Open(path)
		if err != nil {
			continue
		}
		raw, readErr := io.ReadAll(io.LimitReader(file, (8<<20)+1))
		file.Close()
		if readErr != nil || len(raw) > 8<<20 {
			continue
		}
		if device, ok := deviceFromStorage(raw); ok {
			devices = append(devices, device)
		}
	}
	return devices
}

func (s *Store) useClientDevice(a *Account) {
	if s.localDevices == nil || a.AccountUID == "" || a.OAuth != nil {
		return
	}
	for _, profile := range s.localDevices() {
		if profile.uid == a.AccountUID && validDeviceID(profile.device) {
			a.DeviceID = profile.device
			return
		}
	}
}
