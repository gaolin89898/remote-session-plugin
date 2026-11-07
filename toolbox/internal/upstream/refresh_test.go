package upstream

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/linguo2625469/workbuddy2api-panel/internal/auth"
)

func TestEnsureFreshTokenPersistsRotation(t *testing.T) {
	hits := 0
	c := testClient(func(r *http.Request) (*http.Response, error) {
		hits++
		return jsonResp(200, `{"code":0,"data":{"accessToken":"new-at","refreshToken":"new-rt","expiresIn":3600}}`), nil
	})
	a := &auth.Auth{UID: "u1", AccessToken: "old-at", RefreshToken: "old-rt", ExpiresAt: 1,
		FilePath: filepath.Join(t.TempDir(), "account.json")}
	if err := c.EnsureFreshToken(a, 10*time.Minute); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(a.FilePath)
	if err != nil {
		t.Fatal(err)
	}
	saved, err := auth.Parse(raw)
	if err != nil || saved.RefreshTokenValue() != "new-rt" || saved.NeedsRefresh(10*time.Minute) {
		t.Fatalf("rotated credentials not persisted correctly: %v", err)
	}
	if err := c.EnsureFreshToken(a, 10*time.Minute); err != nil || hits != 1 {
		t.Fatalf("fresh token should not rotate again: hits=%d err=%v", hits, err)
	}
}
