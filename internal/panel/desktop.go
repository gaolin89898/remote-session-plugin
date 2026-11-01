package panel

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"time"

	"github.com/linguo2625469/workbuddy2api-panel/internal/desktop"
	"github.com/linguo2625469/workbuddy2api-panel/internal/trae"
)

func (p *Panel) desktopRoutes() {
	p.mux.HandleFunc("GET /panel/api/desktop/status", p.withAuth(p.desktopStatus))
	p.mux.HandleFunc("POST /panel/api/desktop/capture", p.withAuth(p.desktopCapture))
	p.mux.HandleFunc("POST /panel/api/desktop/switch", p.withAuth(p.desktopSwitch))
}

func desktopLocal(w http.ResponseWriter, r *http.Request) bool {
	if !localDesktopRequest(r) {
		writeErr(w, http.StatusForbidden, "客户端切换仅限本机，请用 http://127.0.0.1:7863/panel/ 打开面板")
		return false
	}
	return true
}
func (p *Panel) desktopStatus(w http.ResponseWriter, r *http.Request) {
	if !desktopLocal(w, r) {
		return
	}
	clients, job := p.desktop.Status()
	writeJSON(w, http.StatusOK, map[string]any{"clients": clients, "job": job})
}

type desktopInput struct {
	Provider  string `json:"provider"`
	Realm     string `json:"realm"`
	UID       string `json:"uid"`
	Confirmed bool   `json:"confirmed"`
}

func readDesktopInput(w http.ResponseWriter, r *http.Request) (desktopInput, bool) {
	var input desktopInput
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if dec.Decode(&input) != nil || dec.Decode(new(any)) != io.EOF || (input.Provider != "trae" && input.Provider != "workbuddy" && input.Provider != "qoder") || (input.Realm != "" && input.Realm != "cn" && input.Realm != "global") || len(input.UID) > 200 || input.Provider != "workbuddy" && input.Realm == "global" {
		writeErr(w, http.StatusBadRequest, "客户端操作参数无效")
		return input, false
	}
	return input, true
}
func clientID(input desktopInput) string {
	if input.Provider == "workbuddy" && input.Realm == "global" {
		return "workbuddy-global"
	}
	return input.Provider
}

func (p *Panel) desktopCapture(w http.ResponseWriter, r *http.Request) {
	if !desktopLocal(w, r) {
		return
	}
	input, ok := readDesktopInput(w, r)
	if !ok {
		return
	}
	uid, name, raw, err := p.desktop.SaveCurrent(clientID(input))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if input.Provider == "trae" && p.cfg.Trae != nil {
		a, parseErr := trae.DesktopAccount(raw)
		if parseErr != nil {
			writeErr(w, http.StatusBadRequest, parseErr.Error())
			return
		}
		if _, err = p.cfg.Trae.RememberDesktop(a); err != nil {
			writeErr(w, http.StatusInternalServerError, "登录态已保存，但同步面板账号失败，请重试")
			return
		}
	}
	log.Printf("desktop: 已保存 %s 当前客户端登录态", input.Provider)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "current_uid": uid, "current_name": name})
}

func (p *Panel) desktopSwitch(w http.ResponseWriter, r *http.Request) {
	if !desktopLocal(w, r) {
		return
	}
	input, ok := readDesktopInput(w, r)
	if !ok {
		return
	}
	if !input.Confirmed {
		writeErr(w, http.StatusBadRequest, "请先确认已保存工作，并同意退出和重启客户端")
		return
	}
	uid := input.UID
	var credential *desktop.WorkBuddyAuth
	if input.Provider == "qoder" {
		if !p.qoderReady(w) {
			return
		}
		found := false
		for _, a := range p.qoderAccounts() {
			if a.UID == uid {
				found = true
				break
			}
		}
		if !found {
			writeErr(w, http.StatusNotFound, "Qoder 账号不存在")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
		defer cancel()
		a, err := p.cfg.Qoder.DesktopCredential(ctx, uid)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		job, err := p.desktop.StartQoder(a.UID, &desktop.QoderAuth{UID: a.UID, Name: a.Name, Token: a.Token, Refresh: a.Refresh, ExpiresAt: a.ExpiresAt, RefreshExpiresAt: a.RefreshExpiresAt})
		if err != nil {
			writeErr(w, http.StatusConflict, err.Error())
			return
		}
		log.Printf("desktop: 开始切换 qoder 客户端")
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "job": job})
		return
	}
	if input.Provider == "trae" {
		found := false
		for _, a := range p.traeAccounts() {
			if a.UID == input.UID {
				uid = a.AccountUID
				found = true
				break
			}
		}
		if !found {
			writeErr(w, http.StatusNotFound, "Trae 账号不存在")
			return
		}
	} else {
		if p.cfg.Pool == nil {
			writeErr(w, http.StatusNotImplemented, "WorkBuddy 账号管理未启用")
			return
		}
		a := p.cfg.Pool.AuthByUID(uid)
		if a == nil {
			writeErr(w, http.StatusNotFound, "WorkBuddy 账号不存在")
			return
		}
		input.Realm = a.Realm() // The selected account determines the client; never trust the supplied realm.
		if p.cfg.Upstream != nil {
			if err := p.cfg.Upstream.EnsureFreshToken(a, 5*time.Minute); err != nil {
				writeErr(w, http.StatusBadGateway, "刷新 WorkBuddy 凭证失败，请重新授权账号后切换")
				return
			}
		}
		a.Lock()
		credential = &desktop.WorkBuddyAuth{UID: a.UID, Name: a.Nickname, Access: a.AccessToken, Refresh: a.RefreshToken, Domain: a.Domain, Expires: a.ExpiresAt, Enterprise: a.EnterpriseID}
		a.Unlock()
	}
	job, err := p.desktop.Start(clientID(input), uid, credential)
	if err != nil {
		writeErr(w, http.StatusConflict, err.Error())
		return
	}
	log.Printf("desktop: 开始切换 %s 客户端", input.Provider)
	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "job": job})
}
