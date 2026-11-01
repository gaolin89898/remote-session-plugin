package trae

import (
	"encoding/json"
	"path/filepath"
	"testing"
	"time"
)

func TestDesktopCaptureDoesNotReplaceIndependentOAuthOrCheckinState(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "trae.json"), nil)
	if err != nil {
		t.Fatal(err)
	}
	a := testOAuthAccount(t, "123456789012345")
	a.ID = accountID(a.AccountUID)
	a.LastCheckinDate = chinaDay(time.Now())
	a.Credits = 600
	a.Nickname = "原备注"
	if err = s.commit([]Account{a}); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{"token": a.Token, "userId": a.AccountUID, "host": "https://api.trae.cn", "account": map[string]string{"username": "本地名字"}})
	raw := storageFixture(a.AccountUID, "223456789012345", string(body))
	captured, err := DesktopAccount(raw)
	if err != nil {
		t.Fatal(err)
	}
	if captured.OAuth != nil || captured.Session != "" {
		t.Fatal("imported refresh credentials")
	}
	result, err := s.RememberDesktop(captured)
	if err != nil {
		t.Fatal(err)
	}
	if !result.CheckinDone || result.Credits != 600 || result.Nickname != "原备注" || !result.HasOAuth {
		t.Fatal("replaced existing account state")
	}
	stored := s.snapshot()[0]
	if stored.OAuth.DeviceID != a.OAuth.DeviceID || stored.OAuth.RefreshToken != a.OAuth.RefreshToken {
		t.Fatal("replaced independent device identity")
	}
	captured.AccountUID = "another-user"
	if _, err = s.RememberDesktop(captured); err == nil {
		t.Fatal("accepted mismatched UID")
	}
}

func TestDesktopCaptureRejectsExpiredOrMismatchedClientToken(t *testing.T) {
	for _, tc := range []struct {
		uid, tokenUID string
		expiry        time.Time
	}{
		{"123456789012345", "223456789012345", time.Now().Add(time.Hour)},
		{"123456789012345", "123456789012345", time.Now().Add(-time.Hour)},
	} {
		body, _ := json.Marshal(map[string]any{"token": testToken(tc.tokenUID, tc.expiry), "userId": tc.uid, "host": "https://api.trae.cn"})
		if _, err := DesktopAccount(storageFixture(tc.uid, "123456789012345", string(body))); err == nil {
			t.Fatal("accepted wrong/expired token")
		}
	}
}
