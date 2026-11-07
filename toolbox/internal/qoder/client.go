// Package qoder implements Qoder CN account authorization, usage and daily
// credit campaigns. Wire formats reference smart-open/TraeWorkAssistant (MIT).
package qoder

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const apiBase = "https://openapi.qoder.com.cn"
const webBase = "https://qoder.cn"
const clientID = "732aef47-9cf2-46a2-95fe-4cebb5d0d1fa"

var china = time.FixedZone("Asia/Shanghai", 8*3600)

// RewardPeriod is the start of the 10:00-to-10:00 daily reward window.
func RewardPeriod(now time.Time) string {
	return now.In(china).Add(-10 * time.Hour).Format("2006-01-02")
}

type Client struct {
	HTTP *http.Client
	base string
}

func NewClient() *Client {
	return &Client{base: apiBase, HTTP: &http.Client{Timeout: 25 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

type responseError struct{ code int }

func (e *responseError) Error() string {
	if e.code == 401 || e.code == 403 {
		return "Qoder 登录凭证失效或无权访问，请重新授权"
	}
	return fmt.Sprintf("Qoder 请求未成功（HTTP %d），请稍后检查活动或网络", e.code)
}
func (c *Client) request(ctx context.Context, method, path, token string, body any) (map[string]json.RawMessage, error) {
	var input io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("Qoder 请求参数无效")
		}
		input = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, input)
	if err != nil {
		return nil, fmt.Errorf("Qoder 请求参数无效")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Qoder")
	req.Header.Set("Cosy-ClientType", "10")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("Qoder 请求失败，请检查网络")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &responseError{resp.StatusCode}
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, (2<<20)+1))
	if err != nil || len(raw) > 2<<20 {
		return nil, fmt.Errorf("Qoder 响应读取失败或超过限制")
	}
	var root map[string]json.RawMessage
	if json.Unmarshal(raw, &root) != nil || root == nil {
		return nil, fmt.Errorf("Qoder 响应格式无效")
	}
	// Never forward server errors: upstream messages may contain credential data.
	if text(root, "errorCode", "error_code") != "" || string(root["success"]) == "false" {
		return nil, fmt.Errorf("Qoder 业务请求未成功，请检查账号或活动资格")
	}
	if raw, ok := root["code"]; ok {
		code := strings.Trim(string(raw), `"`)
		if code != "0" && code != "200" && code != "OK" && code != "SUCCESS" && code != "null" {
			return nil, fmt.Errorf("Qoder 业务状态异常，请检查账号或活动资格")
		}
	}
	if nested := object(root["data"]); nested != nil {
		return nested, nil
	}
	return root, nil
}
func object(raw json.RawMessage) map[string]json.RawMessage {
	var v map[string]json.RawMessage
	_ = json.Unmarshal(raw, &v)
	return v
}
func text(m map[string]json.RawMessage, keys ...string) string {
	for _, key := range keys {
		var s string
		if json.Unmarshal(m[key], &s) == nil && s != "" {
			return s
		}
	}
	return ""
}
func number(raw json.RawMessage) (float64, bool) {
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return 0, false
	}
	var n float64
	if json.Unmarshal(raw, &n) != nil {
		var s string
		if json.Unmarshal(raw, &s) != nil {
			return 0, false
		}
		var err error
		n, err = strconv.ParseFloat(s, 64)
		if err != nil {
			return 0, false
		}
	}
	return n, !math.IsNaN(n) && !math.IsInf(n, 0)
}
func cleanToken(s string) bool {
	return s != "" && len(s) <= 32768 && !strings.ContainsAny(s, " \r\n\t")
}
func randomID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	s := hex.EncodeToString(b[:])
	return s[:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:], nil
}

type Login struct {
	URL                      string
	nonce, verifier, machine string
	created                  time.Time
}

func NewLogin() (*Login, error) {
	nonce, err := randomID()
	if err != nil {
		return nil, fmt.Errorf("无法创建 Qoder 授权会话")
	}
	machine, err := randomID()
	if err != nil {
		return nil, fmt.Errorf("无法创建 Qoder 授权会话")
	}
	var secret [32]byte
	if _, err = rand.Read(secret[:]); err != nil {
		return nil, fmt.Errorf("无法创建 Qoder 授权会话")
	}
	verifier := hex.EncodeToString(secret[:])
	digest := sha256.Sum256([]byte(verifier))
	query := url.Values{"challenge": {base64.RawURLEncoding.EncodeToString(digest[:])}, "challenge_method": {"S256"}, "nonce": {nonce}, "machine_id": {machine}, "directLogin": {"true"}, "client_id": {clientID}}
	callback := webBase + "/device/selectAccounts?" + query.Encode()
	return &Login{URL: webBase + "/sso/login/aliyun?" + url.Values{"oauth_callback": {callback}}.Encode(), nonce: nonce, verifier: verifier, machine: machine, created: time.Now()}, nil
}
func (c *Client) Poll(ctx context.Context, l *Login) (*Account, error) {
	if l == nil || time.Since(l.created) > 10*time.Minute {
		return nil, fmt.Errorf("Qoder 授权已过期，请重新登录")
	}
	path := "/api/v1/deviceToken/poll?" + url.Values{"nonce": {l.nonce}, "verifier": {l.verifier}, "challenge_method": {"S256"}}.Encode()
	root, err := c.request(ctx, "GET", path, "", nil)
	var httpErr *responseError
	if errors.As(err, &httpErr) && httpErr.code == 404 {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if text(root, "nonce") != l.nonce {
		return nil, fmt.Errorf("Qoder 授权会话不一致，已拒绝保存")
	}
	a := Account{MachineID: l.machine, AccountUID: text(root, "user_id", "userId", "uid")}
	if err = applyTokens(&a, root); err != nil {
		return nil, err
	}
	if a.AccountUID == "" {
		return nil, fmt.Errorf("Qoder 授权未返回账号身份")
	}
	return &a, nil
}
func expiry(root map[string]json.RawMessage, absolute, relative []string) time.Time {
	for _, key := range absolute {
		if s := text(root, key); s != "" {
			if t, err := time.Parse(time.RFC3339, s); err == nil {
				return t
			}
		}
	}
	for _, key := range relative {
		if n, ok := number(root[key]); ok && n > 0 {
			if n <= 2592000 {
				n *= 1000
			}
			if n <= float64(400*24*time.Hour/time.Millisecond) {
				return time.Now().Add(time.Duration(n) * time.Millisecond)
			}
		}
	}
	return time.Time{}
}
func applyTokens(a *Account, root map[string]json.RawMessage) error {
	token := text(root, "token", "access_token", "accessToken", "device_token", "deviceToken")
	if !cleanToken(token) {
		return fmt.Errorf("Qoder 未返回有效访问凭证")
	}
	refresh := text(root, "refresh_token", "refreshToken")
	if refresh != "" && !cleanToken(refresh) {
		return fmt.Errorf("Qoder 刷新凭证格式无效")
	}
	if uid := text(root, "user_id", "userId", "uid"); uid != "" && a.AccountUID != "" && uid != a.AccountUID {
		return fmt.Errorf("Qoder 续期返回其他账号，已拒绝保存")
	}
	a.Token = token
	if refresh != "" {
		a.RefreshToken = refresh
	}
	a.ExpiresAt = expiry(root, []string{"expires_at", "expiresAt"}, []string{"expires_in", "expiresIn"})
	if t := expiry(root, []string{"refresh_token_expires_at", "refreshTokenExpiresAt"}, []string{"refresh_token_expires_in", "refreshTokenExpiresIn"}); !t.IsZero() {
		a.RefreshExpiresAt = t
	}
	if a.ExpiresAt.IsZero() {
		a.ExpiresAt = time.Now().Add(12 * time.Hour)
	}
	return nil
}
func (c *Client) refresh(ctx context.Context, a *Account) error {
	var root map[string]json.RawMessage
	var err error
	if a.PAT != "" {
		root, err = c.request(ctx, "POST", "/api/v1/me/jobToken", a.PAT, map[string]string{"clientId": a.MachineID})
	} else {
		if a.RefreshToken == "" {
			return fmt.Errorf("Qoder 凭证已过期，请重新授权")
		}
		path := "/api/v1/deviceToken/refresh"
		if strings.HasPrefix(a.RefreshToken, "jrt-") {
			path = "/api/v1/jobToken/refresh"
		}
		root, err = c.request(ctx, "POST", path, "", map[string]string{"refresh_token": a.RefreshToken})
	}
	if err != nil {
		return err
	}
	return applyTokens(a, root)
}
func (c *Client) identify(ctx context.Context, a *Account) error {
	root, err := c.request(ctx, "GET", "/api/v1/userinfo", a.Token, nil)
	if err != nil {
		var upstream *responseError
		if !errors.As(err, &upstream) || upstream.code != 404 && upstream.code != 405 {
			return err
		}
	}
	uid := text(root, "uid", "userId", "user_id", "id")
	if uid == "" {
		// Some CN deployments no longer expose userinfo. Usage carries the
		// authenticated account ID and is also verified against the OAuth ID.
		usage, usageErr := c.request(ctx, "GET", "/sash/api/v2/me/usage", a.Token, nil)
		if usageErr != nil {
			return usageErr
		}
		uid = text(object(usage["qoderUsage"]), "userId", "user_id")
		if uid == "" {
			return fmt.Errorf("Qoder 用量信息缺少用户 ID，无法确认账号身份")
		}
	}
	if a.AccountUID != "" && a.AccountUID != uid {
		return fmt.Errorf("Qoder 授权账号不一致，已拒绝更新")
	}
	a.AccountUID = uid
	if name := text(root, "nickname", "nickName", "name", "displayName"); name != "" {
		a.Nickname = name
	}
	return nil
}
func (c *Client) balance(ctx context.Context, a *Account) error {
	root, err := c.request(ctx, "GET", "/sash/api/v2/me/usage", a.Token, nil)
	if err != nil {
		return err
	}
	q := object(root["qoderUsage"])
	if q == nil {
		return fmt.Errorf("Qoder 用量响应未包含可识别的余额")
	}
	if uid := text(q, "userId", "user_id"); uid != "" && uid != a.AccountUID {
		return fmt.Errorf("Qoder 用量账号不一致")
	}
	remaining, total := 0.0, 0.0
	known := false
	for _, key := range []string{"userQuota", "addOnQuota"} {
		quota := object(q[key])
		if quota == nil {
			continue
		}
		r, ok := number(quota["remaining"])
		t, tok := number(quota["total"])
		if !ok && tok {
			u, uok := number(quota["used"])
			if uok {
				r = math.Max(0, t-u)
				ok = true
			}
		}
		if !ok || r < 0 {
			return fmt.Errorf("Qoder 余额格式异常")
		}
		known = true
		remaining += r
		if tok {
			total += math.Max(r, t)
		} else {
			total += r
		}
	}
	if !known {
		return fmt.Errorf("Qoder 用量响应未包含可识别的余额")
	}
	a.Credits, a.Total, a.BalanceKnown, a.BalanceUpdatedAt = remaining, total, true, time.Now()
	return nil
}

type Campaign struct {
	ID      string          `json:"campaignId"`
	Name    string          `json:"name"`
	Status  string          `json:"claimStatus"`
	Action  string          `json:"actionType"`
	Start   json.RawMessage `json:"startAt"`
	End     json.RawMessage `json:"endAt"`
	Benefit struct {
		Kind   string  `json:"kind"`
		Amount float64 `json:"amount"`
	} `json:"benefit"`
}

func campaignTime(raw json.RawMessage) time.Time {
	if n, ok := number(raw); ok {
		if n > 1e12 {
			return time.UnixMilli(int64(n))
		}
		if n > 1e9 {
			return time.Unix(int64(n), 0)
		}
	}
	var s string
	_ = json.Unmarshal(raw, &s)
	t, _ := time.Parse(time.RFC3339, s)
	return t
}
func (a Campaign) active(now time.Time) bool {
	start, end := campaignTime(a.Start), campaignTime(a.End)
	return !start.IsZero() && !end.IsZero() && !now.Before(start) && now.Before(end)
}
func (a Campaign) credits() bool {
	window := campaignTime(a.End).Sub(campaignTime(a.Start))
	return strings.EqualFold(a.Action, "CLAIM_BENEFIT") && strings.EqualFold(a.Benefit.Kind, "CREDITS") && a.Benefit.Amount == 100 && window > 0 && window <= 25*time.Hour
}

var campaignID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

func (c *Client) campaigns(ctx context.Context, a *Account) ([]Campaign, error) {
	root, err := c.request(ctx, "GET", "/sash/api/v1/me/campaigns", a.Token, nil)
	if err != nil {
		return nil, err
	}
	var list []Campaign
	if json.Unmarshal(root["campaigns"], &list) != nil || list == nil {
		return nil, fmt.Errorf("Qoder 活动列表为空或格式变更，请在客户端查看活动")
	}
	return list, nil
}
func confirmedCampaign(list []Campaign, id string, now time.Time) bool {
	for _, a := range list {
		if a.ID == id && a.active(now) && a.credits() && strings.EqualFold(a.Status, "CLAIMED") {
			return true
		}
	}
	return false
}
func (c *Client) checkin(ctx context.Context, a *Account, claim bool) error {
	list, err := c.campaigns(ctx, a)
	if err != nil {
		return err
	}
	a.LastPeriod, a.ClaimedUntil = "", time.Time{}
	var active []Campaign
	for _, item := range list {
		if item.credits() && item.active(time.Now()) && campaignID.MatchString(item.ID) {
			active = append(active, item)
		}
	}
	if len(active) == 0 {
		if claim {
			return fmt.Errorf("Qoder 当前没有可识别的每日积分活动，请在客户端查看活动资格")
		}
		return nil
	}
	all := true
	for _, item := range active {
		if strings.EqualFold(item.Status, "CLAIMED") {
			continue
		}
		if !claim || !strings.EqualFold(item.Status, "CLAIMABLE") {
			all = false
			continue
		}
		_, claimErr := c.request(ctx, "POST", "/sash/api/v1/me/campaigns/"+item.ID+"/claim", a.Token, nil)
		// After any claim result, confirm by GET. Never retry a possibly
		// successful POST, and never infer success from an empty response.
		latest, verifyErr := c.campaigns(ctx, a)
		if verifyErr != nil || !confirmedCampaign(latest, item.ID, time.Now()) {
			if claimErr != nil {
				return claimErr
			}
			return fmt.Errorf("Qoder 领取结果尚未确认，请刷新状态，勿连续领取")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
	if all {
		a.LastPeriod = RewardPeriod(time.Now())
		end := campaignTime(active[0].End)
		for _, item := range active {
			if t := campaignTime(item.End); t.Before(end) {
				end = t
			}
		}
		a.ClaimedUntil = end
	} else if claim {
		return fmt.Errorf("Qoder 部分活动暂不可领取，请在客户端查看条件")
	}
	return nil
}
