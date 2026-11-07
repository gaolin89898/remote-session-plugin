package trae

// OAuth protocol reference: smart-open/TraeWorkAssistant, revision 5113265.
// This Go implementation uses the documented wire format independently.
import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

const OAuthRedirectURI = "http://127.0.0.1:17388/authorize"
const oauthClientID = "ono9krqynydwx5"
const oauthAppVersion = "3.3.100"
const oauthExchangePath = "/trae/api/v3/oauth/ExchangeToken"

// OAuthIdentity is private account storage. Never include it in Status or logs.
type OAuthIdentity struct {
	DeviceID      string `json:"device_id"`
	MachineID     string `json:"machine_id"`
	PrivateKeyPEM string `json:"private_key_pem"`
	AppVersion    string `json:"app_version"`
	APIHost       string `json:"api_host"`
	RefreshToken  string `json:"refresh_token"`
}

// OAuthError contains only fixed descriptions and bounded numeric upstream codes.
type OAuthError struct{ message string }

func (e *OAuthError) Error() string   { return e.message }
func oauthError(message string) error { return &OAuthError{message} }

type OAuthLogin struct {
	identity        OAuthIdentity
	state, verifier string
	created         time.Time
	used            atomic.Bool
}

type OAuthCallback struct {
	code, host, uid, state string
}

func randomHex(n int) (string, error) {
	raw := make([]byte, n)
	if _, err := rand.Read(raw); err != nil {
		return "", oauthError("无法生成 Trae 登录随机信息")
	}
	return hex.EncodeToString(raw), nil
}

func NewOAuthLogin() (*OAuthLogin, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, oauthError("无法生成 Trae 设备密钥")
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, oauthError("无法保存 Trae 设备密钥")
	}
	n, err := rand.Int(rand.Reader, big.NewInt(900000000000000))
	if err != nil {
		return nil, oauthError("无法生成 Trae 设备号")
	}
	machine, err := randomHex(16)
	if err != nil {
		return nil, err
	}
	state, err := randomHex(16)
	if err != nil {
		return nil, err
	}
	verifier, err := randomHex(32)
	if err != nil {
		return nil, err
	}
	return &OAuthLogin{identity: OAuthIdentity{
		DeviceID: strconv.FormatInt(n.Int64()+100000000000000, 10), MachineID: machine,
		PrivateKeyPEM: string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})),
		AppVersion:    oauthAppVersion, APIHost: "https://api.trae.com.cn",
	}, state: state, verifier: verifier, created: time.Now()}, nil
}

func (l *OAuthLogin) URL() string {
	hostname, _ := os.Hostname()
	platform, osVersion := "windows", "Windows"
	if runtime.GOOS == "darwin" {
		platform, osVersion = "mac", "macOS"
	}
	if runtime.GOOS == "linux" {
		platform, osVersion = "linux", "Linux"
	}
	challenge := sha256.Sum256([]byte(l.verifier))
	q := url.Values{
		"login_version": {"1"}, "auth_from": {"trae"}, "login_channel": {"native_ide"},
		"plugin_version": {"2.3.83560"}, "auth_type": {"local"}, "client_id": {oauthClientID},
		"redirect": {"0"}, "login_trace_id": {l.state}, "auth_callback_url": {OAuthRedirectURI},
		"machine_id": {l.identity.MachineID}, "device_id": {l.identity.DeviceID},
		"x_device_id": {l.identity.DeviceID}, "x_machine_id": {l.identity.MachineID},
		"x_device_brand": {hostname}, "x_device_type": {platform}, "x_os_version": {osVersion},
		"x_env": {""}, "x_app_version": {l.identity.AppVersion}, "x_app_type": {"stable"},
		"code_challenge":        {base64.RawURLEncoding.EncodeToString(challenge[:])},
		"code_challenge_method": {"S256"}, "channel_name": {"common"},
	}
	return "https://www.trae.cn/authorization?" + q.Encode()
}

// Only exact CN HTTPS origins can receive an authorization code or refresh token.
func validOAuthHost(host string) bool {
	return host == "https://api.trae.cn" || host == "https://api.trae.com.cn"
}

func (l *OAuthLogin) ParseCallback(raw string) (OAuthCallback, error) {
	bad := oauthError("Trae 授权回调无效或与本次登录不匹配，请重新登录")
	if len(raw) > 64<<10 || time.Since(l.created) > 15*time.Minute || l.used.Load() {
		return OAuthCallback{}, bad
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "http" || u.Host != "127.0.0.1:17388" || u.Path != "/authorize" || u.User != nil || u.Fragment != "" {
		return OAuthCallback{}, bad
	}
	q, err := url.ParseQuery(u.RawQuery)
	if err != nil {
		return OAuthCallback{}, bad
	}
	for _, values := range q {
		if len(values) != 1 {
			return OAuthCallback{}, bad
		}
	}
	trace := q.Get("loginTraceID")
	if trace == "" {
		trace = q.Get("login_trace_id")
	}
	if trace != l.state || q.Get("login_trace_id") != "" && q.Get("login_trace_id") != l.state {
		return OAuthCallback{}, bad
	}
	host := q.Get("host")
	if host == "" {
		host = l.identity.APIHost
	}
	if !validOAuthHost(host) {
		return OAuthCallback{}, oauthError("Trae 回调不是受支持的国内版 API 地址")
	}
	if region := q.Get("userRegion"); region != "" && !strings.EqualFold(region, "cn") {
		return OAuthCallback{}, oauthError("当前只支持 Trae 国内版授权")
	}
	code := q.Get("code")
	if rawInfo := q.Get("authCodeInfo"); rawInfo != "" {
		var info struct{ AuthCode string }
		if json.Unmarshal([]byte(rawInfo), &info) != nil {
			return OAuthCallback{}, bad
		}
		code = info.AuthCode
	}
	if code == "" || len(code) > 32768 || strings.ContainsAny(code, "\r\n\t ") {
		return OAuthCallback{}, bad
	}
	uid := q.Get("userId")
	if rawInfo := q.Get("userInfo"); rawInfo != "" {
		var info struct{ UserID json.RawMessage }
		if json.Unmarshal([]byte(rawInfo), &info) != nil {
			return OAuthCallback{}, bad
		}
		if value := identifier(info.UserID); value != "" {
			if uid != "" && uid != value {
				return OAuthCallback{}, bad
			}
			uid = value
		}
	}
	return OAuthCallback{code: code, host: host, uid: uid, state: l.state}, nil
}

func identifier(raw json.RawMessage) string {
	if value := str(raw); value != "" {
		return value
	}
	value := string(raw)
	if value != "" && strings.Trim(value, "0123456789") == "" {
		return value
	}
	return ""
}

func identityKey(identity *OAuthIdentity) (*ecdsa.PrivateKey, error) {
	if identity == nil || !validDeviceID(identity.DeviceID) || len(identity.MachineID) != 32 || !validOAuthHost(identity.APIHost) || identity.AppVersion == "" || len(identity.AppVersion) > 80 || len(identity.PrivateKeyPEM) > 4096 {
		return nil, oauthError("Trae OAuth 设备身份不完整，请重新授权登录")
	}
	block, rest := pem.Decode([]byte(identity.PrivateKeyPEM))
	if block == nil || len(bytes.TrimSpace(rest)) != 0 || block.Type != "PRIVATE KEY" {
		return nil, oauthError("Trae OAuth 设备密钥无效，请重新授权登录")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	key, ok := parsed.(*ecdsa.PrivateKey)
	if err != nil || !ok || key.Curve != elliptic.P256() {
		return nil, oauthError("Trae OAuth 设备密钥无效，请重新授权登录")
	}
	return key, nil
}

func (c *Client) oauthPost(ctx context.Context, host, path string, payload any, token, device string) (map[string]json.RawMessage, error) {
	if !validOAuthHost(host) {
		return nil, oauthError("Trae OAuth API 地址无效")
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, oauthError("无法创建 Trae OAuth 请求")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, host+path, bytes.NewReader(raw))
	if err != nil {
		return nil, oauthError("无法创建 Trae OAuth 请求")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("x-device-id", device)
	req.Header.Set("x-app-id", "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8")
	req.Header.Set("x-platform-code", "IDE_PC")
	req.Header["X-Cloudide-Token"] = []string{""}
	if token != "" {
		req.Header.Set("Authorization", "Cloud-IDE-JWT "+token)
	}
	// Do not follow redirects, including on a caller-supplied HTTP client.
	httpClient := *c.HTTP
	httpClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, oauthError("Trae OAuth 请求失败，请检查网络后重试")
	}
	defer resp.Body.Close()
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		return nil, &apiError{"Trae OAuth 凭证已失效，请重新授权登录", true}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, oauthError(fmt.Sprintf("Trae OAuth 返回 HTTP %d", resp.StatusCode))
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, (2<<20)+1))
	if err != nil || len(data) > 2<<20 {
		return nil, oauthError("Trae OAuth 响应读取失败或超过限制")
	}
	var root map[string]json.RawMessage
	if json.Unmarshal(data, &root) != nil || root == nil {
		return nil, oauthError("Trae OAuth 返回格式无效")
	}
	if e := object(object(root["ResponseMetadata"])["Error"]); len(e) > 0 {
		code := identifier(e["Code"])
		if code != "0" {
			return nil, oauthError("Trae OAuth 交换失败" + numericCodeSuffix(code))
		}
	}
	if rawCode, ok := root["code"]; ok {
		code, err := parseNumber(rawCode)
		if err != nil {
			return nil, oauthError("Trae OAuth 状态格式无效")
		}
		if code != 0 {
			return nil, oauthError("Trae OAuth 交换失败" + numericCodeSuffix(identifier(rawCode)))
		}
	}
	return root, nil
}

func numericCodeSuffix(code string) string {
	if len(code) > 0 && len(code) <= 12 && strings.Trim(strings.TrimPrefix(code, "-"), "0123456789") == "" {
		return "（code=" + code + "）"
	}
	return ""
}

func exchangeTokens(root map[string]json.RawMessage) (string, string, error) {
	result := object(root["Result"])
	token, refresh := str(result["Token"]), str(result["RefreshToken"])
	clean, err := normalizeCredential(token, false)
	uid, _ := tokenInfo(clean)
	if err != nil || uid == "" || clean == "" {
		return "", "", oauthError("Trae OAuth 响应缺少有效登录凭证")
	}
	if refresh != "" {
		if _, err := normalizeCredential(refresh, false); err != nil {
			return "", "", oauthError("Trae OAuth 刷新凭证格式无效")
		}
	}
	return clean, refresh, nil
}

func (c *Client) CompleteOAuth(ctx context.Context, l *OAuthLogin, cb OAuthCallback) (Account, error) {
	if l == nil || cb.state != l.state || cb.code == "" || !validOAuthHost(cb.host) || time.Since(l.created) > 15*time.Minute || !l.used.CompareAndSwap(false, true) {
		return Account{}, oauthError("Trae 授权已使用或过期，请重新登录")
	}
	identity := l.identity
	identity.APIHost = cb.host
	key, err := identityKey(&identity)
	if err != nil {
		return Account{}, err
	}
	pub, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		return Account{}, oauthError("无法生成 Trae 设备公钥")
	}
	root, err := c.oauthPost(ctx, identity.APIHost, oauthExchangePath, map[string]any{
		"ClientID": oauthClientID, "AuthCode": cb.code, "CodeVerifier": l.verifier, "IDEVersion": identity.AppVersion,
		"DeviceInfo": map[string]string{"DeviceID": identity.DeviceID, "MachineID": identity.MachineID,
			"PlatformCode": "IDE_PC", "DeviceType": "PC", "ClientVersion": identity.AppVersion,
			"DevicePublicKey": string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: pub})),
			"DeviceName":      "", "DeviceModel": "", "DeviceBrand": "", "DeviceCPU": "", "OSInfo": "", "OSVersion": ""},
	}, "", identity.DeviceID)
	if err != nil {
		return Account{}, err
	}
	token, refresh, err := exchangeTokens(root)
	if err != nil {
		return Account{}, err
	}
	uid, _ := tokenInfo(token)
	if cb.uid != "" && cb.uid != uid {
		return Account{}, oauthError("Trae 授权账号与登录凭证不一致，已取消保存")
	}
	if refresh == "" {
		return Account{}, oauthError("Trae OAuth 未返回刷新凭证，请重新授权")
	}
	identity.RefreshToken = refresh
	return Account{Token: token, DeviceID: identity.DeviceID, AccountUID: uid, OAuth: &identity, TokenUpdatedAt: time.Now()}, nil
}

func (c *Client) refreshOAuth(ctx context.Context, a *Account) error {
	key, err := identityKey(a.OAuth)
	if err != nil {
		return err
	}
	if a.DeviceID != a.OAuth.DeviceID || a.OAuth.RefreshToken == "" {
		return oauthError("Trae OAuth 设备绑定不完整，请重新授权登录")
	}
	nonce, err := randomHex(16)
	if err != nil {
		return err
	}
	ts := time.Now().Unix()
	message := fmt.Sprintf("POST\n%s\n%s\n%s\n%d\n%s", oauthExchangePath, oauthClientID, a.OAuth.RefreshToken, ts, nonce)
	digest := sha256.Sum256([]byte(message))
	r, s, err := ecdsa.Sign(rand.Reader, key, digest[:])
	if err != nil {
		return oauthError("无法签署 Trae 设备凭证")
	}
	signature := make([]byte, 64)
	r.FillBytes(signature[:32])
	s.FillBytes(signature[32:])
	root, err := c.oauthPost(ctx, a.OAuth.APIHost, oauthExchangePath, map[string]any{
		"ClientID": oauthClientID, "RefreshToken": a.OAuth.RefreshToken, "DeviceID": a.OAuth.DeviceID, "PlatformCode": "IDE_PC",
		"DeviceProof": map[string]any{"Signature": base64.StdEncoding.EncodeToString(signature), "Timestamp": ts, "Nonce": nonce},
	}, "", a.DeviceID)
	if err != nil {
		return err
	}
	token, refresh, err := exchangeTokens(root)
	if err != nil {
		return err
	}
	uid, _ := tokenInfo(token)
	expected := a.AccountUID
	if expected == "" {
		expected, _ = tokenInfo(a.Token)
	}
	if expected == "" || uid != expected {
		return oauthError("Trae OAuth 续期返回了其他账号，已拒绝更新")
	}
	identity := *a.OAuth // copy-on-write: snapshots retain their original private state
	if refresh != "" {
		identity.RefreshToken = refresh
	}
	a.Token, a.OAuth, a.TokenUpdatedAt = token, &identity, time.Now()
	return nil
}

// IsOAuthError lets the login controller expose only our bounded protocol errors.
func IsOAuthError(err error) bool { var target *OAuthError; return errors.As(err, &target) }
