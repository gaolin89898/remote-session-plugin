package trae

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func storageFixture(uid, device, envelope string) []byte {
	if envelope == "" {
		envelope = `{"userId":"` + uid + `","host":"https://api.trae.cn","token":"not-imported"}`
	}
	raw, _ := json.Marshal(map[string]string{"iCubeAuthInfo://icube-dc:" + device: "private-key-not-imported", "iCubeAuthInfo://icube.cloudide": envelope})
	return raw
}

func encodeClientFixture(body []byte, header string) []byte {
	salt, _ := hex.DecodeString(clientSalts[header])
	random := bytes.Repeat([]byte{0x42}, 32)
	randomHash := sha512.Sum512(random)
	key := sha512.Sum512(append(randomHash[:], salt...))
	sum := sha512.Sum512(body)
	plain := append(sum[:], body...)
	pad := aes.BlockSize - len(plain)%aes.BlockSize
	plain = append(plain, bytes.Repeat([]byte{byte(pad)}, pad)...)
	block, _ := aes.NewCipher(key[:16])
	encrypted := make([]byte, len(plain))
	cipher.NewCBCEncrypter(block, key[16:32]).CryptBlocks(encrypted, plain)
	magic, _ := hex.DecodeString(header)
	return append(append(magic, random...), encrypted...)
}

func TestLocalProfileCodecAndAccountMatching(t *testing.T) {
	body := []byte(`{"userId":"fixture-user","host":"https://api.trae.cn","token":"must-not-import"}`)
	for header := range clientSalts {
		encoded := encodeClientFixture(body, header)
		raw := storageFixture("fixture-user", "123456789012345", base64.StdEncoding.EncodeToString(encoded))
		profile, ok := deviceFromStorage(raw)
		if !ok || profile.uid != "fixture-user" || profile.device != "123456789012345" {
			t.Fatal("valid client profile was not decoded")
		}
		encoded[len(encoded)-1] ^= 1
		if decodeClientAuth(base64.StdEncoding.EncodeToString(encoded)) != nil {
			t.Fatal("corrupted encrypted envelope accepted")
		}
		// A well-padded envelope with the wrong embedded checksum must fail too.
		encoded = encodeClientFixture(body, header)
		encoded[38] ^= 1
		if decodeClientAuth(base64.StdEncoding.EncodeToString(encoded)) != nil {
			t.Fatal("corrupted checksum accepted")
		}
	}
	for _, raw := range [][]byte{
		[]byte(`{broken`),
		storageFixture("wrong-realm", "123456789012345", `{"userId":"wrong-realm","host":"https://api.trae.ai"}`),
		storageFixture("", "123456789012345", `{"host":"https://api.trae.cn"}`),
		storageFixture("fixture-user", "abc", ""),
		storageFixture("fixture-user", "123456789012345", "invalid-envelope"),
		[]byte(`{"iCubeAuthInfo://icube-dc:123456789012345":"key","iCubeAuthInfo://icube-dc:223456789012345":"key"}`),
	} {
		if _, ok := deviceFromStorage(raw); ok {
			t.Fatal("invalid or ambiguous client profile accepted")
		}
	}
}

func TestAllLocalProfilesAreReadAndOnlyMatchingAccountIsUsed(t *testing.T) {
	dir := t.TempDir()
	first, broken, second := filepath.Join(dir, "first.json"), filepath.Join(dir, "broken.json"), filepath.Join(dir, "second.json")
	os.WriteFile(first, storageFixture("other-user", "123456789012345", ""), 0600)
	os.WriteFile(broken, []byte(`invalid`), 0600)
	os.WriteFile(second, storageFixture("target-user", "223456789012345", ""), 0600)
	profiles := readClientDevices([]string{first, broken, filepath.Join(dir, "missing"), second})
	s := &Store{localDevices: func() []clientDevice { return profiles }}
	a := Account{AccountUID: "target-user", DeviceID: "3334567890123456"}
	s.useClientDevice(&a)
	if a.DeviceID != "223456789012345" {
		t.Fatal("another profile hid target account")
	}
	a.AccountUID, a.DeviceID = "unknown-user", "3334567890123456"
	s.useClientDevice(&a)
	if a.DeviceID != "3334567890123456" {
		t.Fatal("borrowed another account's device")
	}
}

func TestCheckinUsesOwnClientDeviceAndDoesNotMarkDeviceLimitAsSuccess(t *testing.T) {
	claims := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-device-id") != "223456789012345" {
			t.Error("check-in did not use matching client's device")
		}
		if strings.HasSuffix(r.URL.Path, "/claim") {
			claims++
			w.Write([]byte(`{"code":9095,"message":"private diagnostic"}`))
		} else {
			w.Write([]byte(`{"code":0,"enable":true,"checked_in":false}`))
		}
	}))
	defer server.Close()
	client := NewClient()
	client.base = server.URL
	s, err := Open(filepath.Join(t.TempDir(), "accounts.json"), client)
	if err != nil {
		t.Fatal(err)
	}
	s.localDevices = func() []clientDevice {
		return []clientDevice{{uid: "another", device: "123456789012345"}, {uid: "test-user", device: "223456789012345"}}
	}
	if err := s.commit([]Account{{ID: "fixture-account", AccountUID: "test-user", Token: testToken("test-user", time.Now().Add(time.Hour)), DeviceID: "3334567890123456"}}); err != nil {
		t.Fatal(err)
	}
	account, _, err := s.Action(context.Background(), "fixture-account", "checkin")
	if err == nil || !strings.Contains(err.Error(), "9095") || !strings.Contains(err.Error(), "当前设备今日已签到") || account.CheckinDone || claims != 1 {
		t.Fatalf("device cap was retried or counted as account success: %v", err)
	}
	reopened, err := Open(s.path, client)
	if err != nil || reopened.snapshot()[0].DeviceID != "223456789012345" {
		t.Fatal("matching client identity was not persisted")
	}
}

func TestClientDeviceLengthCompatibility(t *testing.T) {
	for _, device := range []string{"123456789012", "123456789012345", "1234567890123456", "12345678901234567890"} {
		a := Account{Token: "fixture.payload.signature", DeviceID: device}
		if err := prepare(&a); err != nil {
			t.Fatal(err)
		}
	}
	for _, device := range []string{"12345678901", "123456789012345678901", "123456789012x45"} {
		a := Account{Token: "fixture.payload.signature", DeviceID: device}
		if prepare(&a) == nil {
			t.Fatal("invalid device id accepted")
		}
	}
}
