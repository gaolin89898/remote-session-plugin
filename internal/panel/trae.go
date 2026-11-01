package panel

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/linguo2625469/workbuddy2api-panel/internal/trae"
)

func (p *Panel) traeRoutes() {
	p.mux.HandleFunc("GET /panel/api/trae/login/available", p.withAuth(p.traeLoginAvailable))
	p.mux.HandleFunc("POST /panel/api/trae/login/start", p.withAuth(p.traeLoginStart))
	p.mux.HandleFunc("GET /panel/api/trae/login/poll", p.withAuth(p.traeLoginPoll))
	p.mux.HandleFunc("POST /panel/api/trae/login/cancel", p.withAuth(p.traeLoginCancel))
	p.mux.HandleFunc("POST /panel/api/trae/accounts", p.withAuth(p.traeAdd))
	p.mux.HandleFunc("POST /panel/api/trae/import", p.withAuth(p.traeImport))
	p.mux.HandleFunc("POST /panel/api/trae/accounts/{uid}/{action}", p.withAuth(p.traeAction))
	p.mux.HandleFunc("POST /panel/api/trae/checkin_all", p.withAuth(p.traeCheckinAll))
	p.mux.HandleFunc("POST /panel/api/trae/balance_all", p.withAuth(p.traeBalanceAll))
}

func (p *Panel) traeAccounts() []trae.Status {
	if p.cfg.Trae == nil {
		return []trae.Status{}
	}
	return p.cfg.Trae.List()
}

func (p *Panel) traeReady(w http.ResponseWriter) bool {
	if p.cfg.Trae == nil {
		writeErr(w, http.StatusNotImplemented, "Trae 账号管理未启用")
		return false
	}
	return true
}

func (p *Panel) traeAdd(w http.ResponseWriter, r *http.Request) {
	if !p.traeReady(w) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 128<<10)
	var input struct {
		Nickname string `json:"nickname"`
		Session  string `json:"session"`
		Token    string `json:"token"`
		DeviceID string `json:"device_id"`
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&input); err != nil {
		writeErr(w, http.StatusBadRequest, "Trae 账号表单格式无效")
		return
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		writeErr(w, http.StatusBadRequest, "请提交单个账号对象")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	account, warnings, err := p.cfg.Trae.Add(ctx, trae.Account{Nickname: input.Nickname, Session: input.Session, Token: input.Token, DeviceID: input.DeviceID})
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "account": account, "warnings": warnings})
}

func (p *Panel) traeImport(w http.ResponseWriter, r *http.Request) {
	if !p.traeReady(w) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 9<<20)
	if r.ParseMultipartForm(1<<20) != nil {
		writeErr(w, http.StatusBadRequest, "Trae 导入文件过大或表单无效")
		return
	}
	defer r.MultipartForm.RemoveAll()
	file, _, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "请选择 TraeTools JSON 文件")
		return
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, (8<<20)+1))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "读取 Trae 备份失败")
		return
	}
	result, err := p.cfg.Trae.Import(raw, r.FormValue("password"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	log.Printf("trae: 导入新增 %d 个，更新 %d 个，跳过 %d 个", result.Imported, result.Updated, result.Skipped)
	writeJSON(w, http.StatusOK, result)
}

func (p *Panel) traeAction(w http.ResponseWriter, r *http.Request) {
	if !p.traeReady(w) {
		return
	}
	action := r.PathValue("action")
	if action != "checkin" && action != "balance" && action != "disable" && action != "revive" && action != "remove" {
		http.NotFound(w, r)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 100*time.Second)
	defer cancel()
	account, warning, err := p.cfg.Trae.Action(ctx, r.PathValue("uid"), action)
	if errors.Is(err, os.ErrNotExist) {
		writeErr(w, http.StatusNotFound, "Trae 账号不存在")
		return
	}
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "account": account, "checkin_done": account.CheckinDone, "balance_error": warning})
}

func (p *Panel) traeCheckinAll(w http.ResponseWriter, r *http.Request) {
	if !p.traeReady(w) {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		p.cfg.Trae.RunAll(ctx, "checkin")
	}()
	log.Printf("trae: 手动全部签到已开始")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "started": true})
}

func (p *Panel) traeBalanceAll(w http.ResponseWriter, r *http.Request) {
	if !p.traeReady(w) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	errors := p.cfg.Trae.RunAll(ctx, "balance")
	if ctx.Err() != nil {
		errors = append(errors, "Trae 积分刷新已超时，可重试未更新账号")
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "accounts": p.cfg.Trae.List(), "errors": errors})
}
