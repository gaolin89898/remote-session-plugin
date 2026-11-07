package upstream

import (
	"time"

	"github.com/linguo2625469/workbuddy2api-panel/internal/auth"
)

// EnsureFreshToken persists rotated credentials before account maintenance continues.
func (c *Client) EnsureFreshToken(a *auth.Auth, within time.Duration) error {
	if !a.NeedsRefresh(within) {
		return nil
	}
	if err := c.RefreshToken(a); err != nil {
		return err
	}
	return a.SaveAtomic()
}
