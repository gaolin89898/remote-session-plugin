package panel

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"mime/multipart"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/linguo2625469/workbuddy2api-panel/internal/pool"
	"github.com/linguo2625469/workbuddy2api-panel/internal/trae"
)

func TestTraeImportRoutesAndSanitizedOverview(t *testing.T) {
	s, err := trae.Open(filepath.Join(t.TempDir(), "trae.json"), nil)
	if err != nil {
		t.Fatal(err)
	}
	accounts := pool.New("")
	defer accounts.Close()
	p := New(Config{AccountsOnly: true, Pool: accounts, Trae: s, APIKey: "test-admin"})
	request := func(method, endpoint string, body *bytes.Buffer, contentType string) *httptest.ResponseRecorder {
		if body == nil {
			body = new(bytes.Buffer)
		}
		req := httptest.NewRequest(method, endpoint, body)
		req.Header.Set("Authorization", "Bearer test-admin")
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		rec := httptest.NewRecorder()
		p.ServeHTTP(rec, req)
		return rec
	}
	payload, _ := json.Marshal(map[string]any{"data": map[string]any{"id": "test-user"}, "exp": time.Now().Add(time.Hour).Unix()})
	token := "eyJhbGciOiJub25lIn0." + base64.RawURLEncoding.EncodeToString(payload) + ".fake-signature"
	backup, _ := json.Marshal(map[string]any{"Accounts": []map[string]any{{"Token": token, "Session": "do-not-return-this-session", "DeviceId": "1234567890123456", "Name": "测试 Trae"}}})
	body := new(bytes.Buffer)
	form := multipart.NewWriter(body)
	file, _ := form.CreateFormFile("file", "trae.json")
	file.Write(backup)
	form.Close()
	rec := request("POST", "/panel/api/trae/import", body, form.FormDataContentType())
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"imported":1`) {
		t.Fatalf("import: %d %s", rec.Code, rec.Body.String())
	}
	rec = request("GET", "/panel/api/overview", nil, "")
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"provider":"trae"`) {
		t.Fatalf("overview: %d %s", rec.Code, rec.Body.String())
	}
	for _, secret := range []string{token, "do-not-return-this-session", "1234567890123456"} {
		if strings.Contains(rec.Body.String(), secret) {
			t.Fatal("overview leaked Trae credentials")
		}
	}
	id := s.List()[0].UID
	for _, action := range []string{"disable", "revive"} {
		rec = request("POST", "/panel/api/trae/accounts/"+id+"/"+action, nil, "")
		if rec.Code != 200 {
			t.Fatalf("action %s: %d", action, rec.Code)
		}
	}
	rec = request("POST", "/panel/api/trae/accounts/"+id+"/tasks", nil, "")
	if rec.Code != 404 {
		t.Fatal("unrelated Trae action was exposed")
	}
	rec = request("POST", "/panel/api/trae/accounts/"+id+"/remove", nil, "")
	if rec.Code != 200 || len(s.List()) != 0 {
		t.Fatal("remove route did not persist deletion")
	}
	rec = request("POST", "/panel/api/trae/accounts/missing/remove", nil, "")
	if rec.Code != 404 {
		t.Fatal("missing account should return 404")
	}
}
