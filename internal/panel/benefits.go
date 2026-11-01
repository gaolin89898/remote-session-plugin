package panel

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sync"

	"github.com/linguo2625469/workbuddy2api-panel/internal/pool"
	"github.com/linguo2625469/workbuddy2api-panel/internal/upstream"
)

type benefitAccountStatus struct {
	pool.Status
	BenefitsSupported bool   `json:"benefits_supported"`
	BenefitsReason    string `json:"benefits_reason,omitempty"`
}

// Expose eligibility without sending credentials or JWT claims to the browser.
func (p *Panel) benefitAccountStatuses() []benefitAccountStatus {
	statuses := p.cfg.Pool.List()
	out := make([]benefitAccountStatus, 0, len(statuses))
	for _, status := range statuses {
		item := benefitAccountStatus{Status: status}
		a := p.cfg.Pool.AuthByUID(status.UID)
		switch {
		case a == nil:
			item.BenefitsReason = "账号已移除"
		case a.IsGlobal():
			item.BenefitsReason = "国际版暂不支持个人任务和活动奖励"
		case a.IsEnterprise():
			item.BenefitsReason = "企业账号不支持个人任务和活动奖励"
		case a.IsEnterpriseSession():
			item.BenefitsReason = "当前凭证属于企业会话，需要以国内版个人身份重新登录"
		case status.Disabled:
			item.BenefitsReason = "账号已停用，请先启用账号"
		default:
			item.BenefitsSupported = true
		}
		out = append(out, item)
	}
	return out
}

func (p *Panel) benefitRoutes() {
	p.mux.HandleFunc("GET /panel/api/accounts/{uid}/tasks", p.personalBenefit(p.accountTasks))
	p.mux.HandleFunc("POST /panel/api/accounts/{uid}/tasks/accept", p.personalBenefit(p.accountTaskAccept))
	p.mux.HandleFunc("POST /panel/api/accounts/{uid}/tasks/claim", p.personalBenefit(p.accountTaskClaim))
	p.mux.HandleFunc("POST /panel/api/accounts/{uid}/tasks/auto", p.personalBenefit(p.accountTaskAuto))
	p.mux.HandleFunc("POST /panel/api/tasks/scan_all", p.withAuth(p.tasksScanAll))
	p.mux.HandleFunc("POST /panel/api/tasks/run_queue", p.withAuth(p.tasksRunQueue))
	p.mux.HandleFunc("GET /panel/api/tasks/queue", p.withAuth(p.tasksQueueStatus))
	p.mux.HandleFunc("GET /panel/api/benefits/accounts/{uid}/rewards", p.personalBenefit(p.benefitRewards))
	p.mux.HandleFunc("POST /panel/api/benefits/accounts/{uid}/rewards", p.personalBenefit(p.benefitRewardAction))
	p.mux.HandleFunc("GET /panel/api/packages", p.withAuth(p.packages))
	p.mux.HandleFunc("GET /panel/api/credit_history", p.withAuth(p.creditHistory))
}

func (p *Panel) personalBenefit(next http.HandlerFunc) http.HandlerFunc {
	return p.withAuth(func(w http.ResponseWriter, r *http.Request) {
		a := p.accountByUID(w, r.PathValue("uid"))
		if a == nil {
			return
		}
		if a.IsGlobal() || a.IsEnterprise() || a.IsEnterpriseSession() {
			writeErr(w, http.StatusBadRequest, "任务与活动奖励仅支持 WorkBuddy 国内版个人身份账号")
			return
		}
		if status, ok := p.cfg.Pool.Status(a.UID); ok && status.Disabled && r.Method != http.MethodGet {
			writeErr(w, http.StatusConflict, "账号已停用，请先启用账号")
			return
		}
		next(w, r)
	})
}

func (p *Panel) benefitRewards(w http.ResponseWriter, r *http.Request) {
	a := p.accountByUID(w, r.PathValue("uid"))
	if a == nil {
		return
	}
	var streak *upstream.StreakFull
	var chances *int
	var compensation *upstream.CompensationStatus
	var vouchers []upstream.SchoolVoucher
	errors := map[string]string{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	query := func(name string, fn func() error) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := fn(); err != nil {
				mu.Lock()
				errors[name] = err.Error()
				mu.Unlock()
			}
		}()
	}
	query("连登奖励", func() error { var err error; streak, err = p.cfg.Upstream.GrowthStreakFull(a); return err })
	query("抽奖活动", func() error {
		value, err := p.cfg.Upstream.LotteryChances(a)
		if err == nil {
			chances = &value
		}
		return err
	})
	query("官方补偿", func() error {
		value, err := p.cfg.Upstream.GetCompensationStatus(a)
		if err == nil {
			compensation = &value
		}
		return err
	})
	query("活动券码", func() error { var err error; vouchers, err = p.cfg.Upstream.SchoolVouchers(a); return err })
	wg.Wait()
	writeJSON(w, http.StatusOK, map[string]any{"streak": streak, "chances": chances, "compensation": compensation, "vouchers": vouchers, "errors": errors})
}

func (p *Panel) benefitRewardAction(w http.ResponseWriter, r *http.Request) {
	a := p.accountByUID(w, r.PathValue("uid"))
	if a == nil {
		return
	}
	var body struct {
		Action string `json:"action"`
		Tier   string `json:"tier"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&body) != nil || decoder.Decode(new(any)) != io.EOF {
		writeErr(w, 400, "无效的奖励操作")
		return
	}
	if body.Action != "redeem" && body.Action != "draw" && body.Action != "compensation" {
		writeErr(w, 400, "未知的奖励操作")
		return
	}
	if !p.tryLockAccount(a.UID) {
		writeErr(w, 409, "该账号正在执行任务，请稍后重试")
		return
	}
	defer p.unlockAccount(a.UID)
	var err error
	result := map[string]any{"ok": true}
	switch body.Action {
	case "redeem":
		var streak *upstream.StreakFull
		streak, err = p.cfg.Upstream.GrowthStreakFull(a)
		if err == nil {
			statuses := map[string]string{"7d": streak.RedemptionStatus.Tier7dStatus, "14d": streak.RedemptionStatus.Tier14dStatus, "28d": streak.RedemptionStatus.Tier28dStatus}
			eligible := false
			for _, tier := range streak.RedemptionStatus.Tiers {
				if tier.Tier == body.Tier && tier.Days > 0 && streak.Streak.Days >= tier.Days {
					eligible = true
				}
			}
			status := statuses[body.Tier]
			if !eligible || status == "" || status == "locked" || status == "claimed" || status == "redeemed" {
				writeErr(w, 409, "当前档位尚不可兑换或已领取")
				return
			}
			err = p.cfg.Upstream.GrowthRedeemTier(a, body.Tier)
		}
	case "draw":
		var chances int
		chances, err = p.cfg.Upstream.LotteryChances(a)
		if err == nil {
			if chances <= 0 {
				writeErr(w, 409, "当前没有可用抽奖次数")
				return
			}
			result["prize"], err = p.cfg.Upstream.LotteryDraw(a)
		}
	case "compensation":
		var status upstream.CompensationStatus
		status, err = p.cfg.Upstream.GetCompensationStatus(a)
		if err == nil {
			if !status.Pending() {
				writeErr(w, 409, "当前没有待领取的官方补偿")
				return
			}
			result["credit"], err = p.cfg.Upstream.ClaimCompensation(a)
		}
	}
	if err != nil {
		writeErr(w, http.StatusBadGateway, fmt.Sprintf("奖励操作失败：%v", err))
		return
	}
	p.refreshCreditsQuiet(a.UID)
	log.Printf("panel: 手动活动奖励 uid=%s action=%s tier=%s", a.UID, body.Action, body.Tier)
	writeJSON(w, http.StatusOK, result)
}
