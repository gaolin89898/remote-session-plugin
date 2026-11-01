// Package trae implements the Trae CN account protocol independently of the
// WorkBuddy pool. Endpoint and backup format reference: star620/TraeTools,
// revision 35b20af5340286db447ada8bff9d15e17365adc1.
package trae

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type Client struct {
	HTTP *http.Client
	base string
}

func NewClient() *Client {
	return &Client{HTTP: &http.Client{Timeout: 25 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}, base: "https://api.trae.cn"}
}

type apiError struct {
	message string
	expired bool
}

func (e *apiError) Error() string { return e.message }

func (c *Client) post(ctx context.Context, path string, a Account, sessionOnly bool) (map[string]json.RawMessage, error) {
	if a.OAuth != nil && strings.HasPrefix(path, "/cloudide/") && !sessionOnly {
		return c.oauthPost(ctx, a.OAuth.APIHost, path, map[string]any{}, a.Token, a.DeviceID)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+path, bytes.NewBufferString("{}"))
	if err != nil {
		return nil, fmt.Errorf("无法创建 Trae 请求")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "TraeCheckin/1.0")
	req.Header.Set("Origin", "https://www.trae.cn")
	req.Header.Set("Referer", "https://www.trae.cn/")
	if sessionOnly {
		req.AddCookie(&http.Cookie{Name: "X-Cloudide-Session", Value: a.Session})
	} else {
		req.Header.Set("Authorization", "Cloud-IDE-JWT "+a.Token)
		req.Header.Set("X-User-Region", "cn")
		req.Header.Set("x-device-id", a.DeviceID)
		// CloudIDE profile endpoints use web authentication (JWT + session),
		// unlike the credit endpoints which only require the JWT.
		if strings.HasPrefix(path, "/cloudide/") && a.Session != "" {
			req.AddCookie(&http.Cookie{Name: "X-Cloudide-Session", Value: a.Session})
		}
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("Trae 请求失败，请检查网络或稍后重试")
	}
	defer resp.Body.Close()
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		return nil, &apiError{"Trae 登录凭证已失效，请更新 Session 或 Token", true}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("Trae 返回 HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, (2<<20)+1))
	if err != nil || len(raw) > 2<<20 {
		return nil, fmt.Errorf("Trae 响应读取失败或超过限制")
	}
	var data map[string]json.RawMessage
	if json.Unmarshal(raw, &data) != nil || data == nil {
		return nil, fmt.Errorf("Trae 返回了无法解析的响应")
	}
	// Upstream messages may contain request details. Return bounded, fixed messages
	// so credentials can never leak through the UI, logs, or persisted errors.
	if code, ok := data["code"]; ok {
		if _, err := parseNumber(code); err != nil {
			return nil, fmt.Errorf("Trae 业务状态格式无效")
		}
		if number(code) != 0 {
			if number(code) == 9095 {
				return nil, fmt.Errorf("当前设备今日已签到（code=9095），该账号不一定已签到；请勿重复领取")
			}
			if number(code) == -9074 || number(code) == 9074 {
				// This code does not disclose whether the restriction is caused
				// by eligibility, device checks or traffic. Do not promise that
				// waiting/retrying will resolve it, and never retry it internally.
				return nil, fmt.Errorf("Trae 拒绝本次请求（code=%s）；原因尚未确认，请勿连续重试", safeCode(code))
			}
			return nil, &apiError{fmt.Sprintf("Trae 业务请求未成功（code=%s）", safeCode(code)), false}
		}
	}
	if meta := object(data["ResponseMetadata"]); len(meta["Error"]) > 0 && string(meta["Error"]) != "null" {
		return nil, &apiError{"Trae 会话请求未成功，请重新登录后更新凭证", true}
	}
	return data, nil
}

func safeCode(raw json.RawMessage) string {
	value := number(raw)
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return "unknown"
	}
	return strconv.FormatFloat(value, 'f', 0, 64)
}
func object(raw json.RawMessage) map[string]json.RawMessage {
	var value map[string]json.RawMessage
	_ = json.Unmarshal(raw, &value)
	return value
}
func str(raw json.RawMessage) string {
	var value string
	if json.Unmarshal(raw, &value) == nil {
		return value
	}
	return ""
}
func number(raw json.RawMessage) float64 {
	value, _ := parseNumber(raw)
	return value
}

func parseNumber(raw json.RawMessage) (float64, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return 0, fmt.Errorf("missing number")
	}
	var value float64
	if json.Unmarshal(raw, &value) == nil {
		return value, nil
	}
	return strconv.ParseFloat(str(raw), 64)
}

func tokenInfo(token string) (string, time.Time) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", time.Time{}
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return "", time.Time{}
	}
	root := object(raw)
	data := object(root["data"])
	uid := str(data["id"])
	if uid == "" && len(data["id"]) > 0 && data["id"][0] >= '0' && data["id"][0] <= '9' {
		uid = string(data["id"])
	}
	exp := number(root["exp"])
	if exp == 0 {
		exp = number(data["exp"])
	}
	if exp < 1e9 || exp > 4102444800 {
		return uid, time.Time{}
	}
	return uid, time.Unix(int64(exp), 0)
}

func (c *Client) refreshToken(ctx context.Context, a *Account) error {
	if a.OAuth != nil {
		return c.refreshOAuth(ctx, a)
	}
	data, err := c.post(ctx, "/cloudide/api/v3/common/GetUserToken", *a, true)
	if err != nil {
		return err
	}
	token := str(object(data["Result"])["Token"])
	if token == "" {
		return fmt.Errorf("Trae Session 无法换取 Token，请重新登录后更新凭证")
	}
	if strings.ContainsAny(token, "\r\n\t ") || len(token) > 32768 {
		return fmt.Errorf("Trae Token 格式无效")
	}
	a.Token = token
	a.TokenUpdatedAt = time.Now()
	return nil
}

func (c *Client) authorize(ctx context.Context, a *Account) error {
	if a.OAuth != nil {
		if _, err := identityKey(a.OAuth); err != nil {
			return err
		}
		if a.DeviceID != a.OAuth.DeviceID {
			return oauthError("Trae OAuth 设备绑定不一致，请重新授权登录")
		}
	}
	_, expiry := tokenInfo(a.Token)
	if a.Token != "" && (expiry.IsZero() || expiry.After(time.Now().Add(5*time.Minute))) {
		return nil
	}
	if a.Session == "" && a.OAuth == nil {
		return fmt.Errorf("Trae Token 已过期，请补充 Session 或重新登录")
	}
	return c.refreshToken(ctx, a)
}

func (c *Client) request(ctx context.Context, path string, a *Account) (map[string]json.RawMessage, error) {
	if err := c.authorize(ctx, a); err != nil {
		return nil, err
	}
	data, err := c.post(ctx, path, *a, false)
	if e, ok := err.(*apiError); ok && e.expired && (a.Session != "" || a.OAuth != nil) {
		if err = c.refreshToken(ctx, a); err != nil {
			return nil, err
		}
		return c.post(ctx, path, *a, false)
	}
	return data, err
}

func (c *Client) identify(ctx context.Context, a *Account) error {
	if a.OAuth != nil {
		// Native OAuth JWTs are accepted by billing, while the web CloudIDE
		// profile endpoint can require a separate browser session cookie.
		if err := c.authorize(ctx, a); err != nil {
			return err
		}
		uid, _ := tokenInfo(a.Token)
		if uid == "" || a.AccountUID != "" && a.AccountUID != uid {
			return oauthError("Trae OAuth 账号验证不一致，已取消保存")
		}
		a.AccountUID = uid
		if _, _, err := c.status(ctx, a); err != nil {
			return err
		}
		if a.Nickname == "" {
			a.Nickname = "Trae 账号"
		}
		return nil
	}
	data, err := c.request(ctx, "/cloudide/api/v3/trae/GetUserInfo", a)
	if err != nil {
		return err
	}
	profile := object(data["Result"])
	uid := str(profile["UserID"])
	// Preserve numeric identifiers exactly; float64 would round large IDs.
	if uid == "" {
		raw := strings.TrimSpace(string(profile["UserID"]))
		if raw != "" && strings.Trim(raw, "0123456789") == "" {
			uid = raw
		}
	}
	if uid == "" {
		return fmt.Errorf("Trae 账号验证失败，响应缺少 UserID")
	}
	if tokenUID, _ := tokenInfo(a.Token); a.OAuth != nil && tokenUID != uid {
		return oauthError("Trae OAuth 账号验证不一致，已取消保存")
	}
	a.AccountUID = uid
	if name := str(profile["ScreenName"]); name != "" {
		a.Nickname = name
	}
	return nil
}

func (c *Client) status(ctx context.Context, a *Account) (bool, bool, error) {
	data, err := c.request(ctx, "/trae/api/v2/ug/checkin_credits/status", a)
	if err != nil {
		return false, false, err
	}
	var checked, enabled bool
	if json.Unmarshal(data["checked_in"], &checked) != nil || json.Unmarshal(data["enable"], &enabled) != nil {
		return false, false, fmt.Errorf("Trae 签到状态响应不完整")
	}
	a.CheckinSupported = &enabled
	if checked {
		a.LastCheckinDate = chinaDay(time.Now())
	}
	return checked, enabled, nil
}

func (c *Client) checkin(ctx context.Context, a *Account) error {
	checked, enabled, err := c.status(ctx, a)
	if err != nil {
		return fmt.Errorf("查询签到状态失败：%w", err)
	}
	if checked {
		return nil
	}
	if !enabled {
		return fmt.Errorf("该 Trae 账号当前不支持每日签到")
	}
	if _, err = c.request(ctx, "/trae/api/v2/ug/checkin_credits/claim", a); err != nil {
		return fmt.Errorf("领取签到奖励失败：%w", err)
	}
	// A successful claim response alone does not prove credits were issued.
	checked, _, err = c.status(ctx, a)
	if err != nil {
		return fmt.Errorf("确认签到结果失败：%w", err)
	}
	if !checked {
		return fmt.Errorf("Trae 尚未确认签到完成，请稍后刷新")
	}
	return nil
}

func (c *Client) balance(ctx context.Context, a *Account) error {
	data, err := c.request(ctx, "/trae/api/v2/pay/user_current_entitlement_list", a)
	if err != nil {
		return err
	}
	// Current responses include both subscription privileges (without a
	// credits_limit) and credit packages. The billing summary is authoritative;
	// summing every entitlement would mistake privileges for malformed credits.
	var creditsBilling, dollarBilling bool
	_ = json.Unmarshal(data["is_credits_billing"], &creditsBilling)
	_ = json.Unmarshal(data["is_dollar_usage_billing"], &dollarBilling)
	if dollarBilling && !creditsBilling {
		return fmt.Errorf("该 Trae 账号采用金额计费，暂不支持积分汇总")
	}
	if creditsBilling && len(data["usage_summary"]) > 0 {
		summary := object(data["usage_summary"])
		total, totalErr := parseNumber(summary["total_amount"])
		consumed, consumedErr := parseNumber(summary["consumed_amount"])
		if totalErr != nil || consumedErr != nil || math.IsNaN(total) || math.IsInf(total, 0) || math.IsNaN(consumed) || math.IsInf(consumed, 0) || total < 0 || consumed < 0 {
			return fmt.Errorf("Trae 积分汇总数据无效，保留上次余额")
		}
		a.Credits, a.Total, a.BalanceKnown = math.Max(0, total-consumed), total, true
		a.BalanceUpdatedAt = time.Now()
		return nil
	}
	var packs []map[string]json.RawMessage
	if json.Unmarshal(data["user_entitlement_pack_list"], &packs) != nil || len(packs) == 0 {
		return fmt.Errorf("Trae 积分包数据为空，保留上次余额")
	}
	var total, remaining float64
	for _, pack := range packs {
		quota := object(object(pack["entitlement_base_info"])["quota"])
		if _, ok := quota["credits_limit"]; !ok {
			return fmt.Errorf("Trae 积分包数据不完整，保留上次余额")
		}
		limit, limitErr := parseNumber(quota["credits_limit"])
		used, usedErr := parseNumber(object(pack["usage"])["credits_amount"])
		if limitErr != nil || usedErr != nil {
			return fmt.Errorf("Trae 积分包数值缺失，保留上次余额")
		}
		if math.IsNaN(limit) || math.IsInf(limit, 0) || math.IsNaN(used) || math.IsInf(used, 0) || limit < 0 || used < 0 {
			return fmt.Errorf("Trae 积分数据无效")
		}
		total += limit
		remaining += math.Max(0, limit-used)
	}
	a.Credits, a.Total, a.BalanceKnown = remaining, total, true
	a.BalanceUpdatedAt = time.Now()
	return nil
}
