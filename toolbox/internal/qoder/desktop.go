package qoder

import (
	"context"
	"fmt"
	"os"
	"time"
)

// DesktopCredential is private application state, never an API response.
type DesktopCredential struct {
	UID, Name, Token, Refresh   string
	ExpiresAt, RefreshExpiresAt time.Time
}

func (s *Store) SetDesktopSource(source func() *Account) {
	s.mu.Lock()
	s.desktopSource = source
	s.mu.Unlock()
}

func (s *Store) syncDesktop(ctx context.Context, accounts []Account) error {
	s.mu.RLock()
	source := s.desktopSource
	s.mu.RUnlock()
	if source == nil {
		return nil
	}
	native := source()
	if native == nil || !status(*native).DesktopSupported || !cleanToken(native.Token) || !cleanToken(native.RefreshToken) || !native.ExpiresAt.After(time.Now()) {
		return nil
	}
	for i := range accounts {
		a := &accounts[i]
		if a.AccountUID != native.AccountUID || a.PAT != "" || !native.ExpiresAt.After(a.ExpiresAt) || native.Token == a.Token {
			continue
		}
		if err := s.client.identify(ctx, native); err != nil {
			return err
		}
		a.Token, a.RefreshToken, a.ExpiresAt, a.RefreshExpiresAt = native.Token, native.RefreshToken, native.ExpiresAt, native.RefreshExpiresAt
		if native.Nickname != "" {
			a.Nickname = native.Nickname
		}
		return s.commit(accounts)
	}
	return nil
}

func (s *Store) DesktopCredential(ctx context.Context, id string) (DesktopCredential, error) {
	if err := s.lock(ctx); err != nil {
		return DesktopCredential{}, err
	}
	defer s.op.Unlock()
	accounts := s.snapshot()
	if err := s.syncDesktop(ctx, accounts); err != nil {
		return DesktopCredential{}, err
	}
	for i := range accounts {
		a := &accounts[i]
		if a.ID != id {
			continue
		}
		if !status(*a).DesktopSupported {
			return DesktopCredential{}, fmt.Errorf("请先用浏览器授权此 Qoder 账号，再切换客户端")
		}
		if a.RefreshExpiresAt.IsZero() {
			if err := s.client.refresh(ctx, a); err != nil {
				return DesktopCredential{}, err
			}
			if err := s.commit(accounts); err != nil {
				return DesktopCredential{}, err
			}
		} else if err := s.fresh(ctx, accounts, i); err != nil {
			return DesktopCredential{}, err
		}
		if err := s.client.identify(ctx, a); err != nil {
			return DesktopCredential{}, err
		}
		if err := s.commit(accounts); err != nil {
			return DesktopCredential{}, err
		}
		return DesktopCredential{UID: a.AccountUID, Name: a.Nickname, Token: a.Token, Refresh: a.RefreshToken, ExpiresAt: a.ExpiresAt, RefreshExpiresAt: a.RefreshExpiresAt}, nil
	}
	return DesktopCredential{}, os.ErrNotExist
}
