package scheduler

import (
	"context"
	"strings"
	"testing"
)

func TestCheckinOnlyDoesNotRunOtherTasks(t *testing.T) {
	s, rec := enterpriseTestScheduler(t, false)
	s.cfg.CheckinOnly = true
	s.RunCheckinNow()
	if !rec.has("daily-checkin") || !rec.has("get-user-resource") {
		t.Fatalf("check-in and balance must run: %v", rec.snapshot())
	}
	st, _ := s.cfg.Pool.Status("u1")
	if !st.CheckinDone {
		t.Fatal("check-in result not recorded")
	}
	for _, path := range rec.snapshot() {
		if !strings.HasSuffix(path, "/daily-checkin") && !strings.HasSuffix(path, "/get-user-resource") {
			t.Errorf("unexpected upstream operation in account mode: %s", path)
		}
	}
	before := len(rec.snapshot())
	s.RunCheckinNow()
	if len(rec.snapshot()) != before {
		t.Fatal("account already checked in should be skipped on restart/retry")
	}
}

func TestCheckinSlotRunsAdditionalProviderOnlyForAutomaticBatch(t *testing.T) {
	s, _ := enterpriseTestScheduler(t, false)
	s.cfg.CheckinOnly = true
	called := 0
	s.cfg.CheckinHook = func() { called++ }
	s.RunCheckinNow()
	if called != 0 {
		t.Fatal("WorkBuddy manual check-in triggered another provider")
	}
	s.runBatch(context.Background(), []taskKind{taskCheckin})
	if called != 1 {
		t.Fatal("automatic slot did not run additional account provider")
	}
}

func TestCheckinOnlyCanSkipBalanceRefresh(t *testing.T) {
	s, rec := enterpriseTestScheduler(t, false)
	s.cfg.CheckinOnly = true
	s.SetCheckinRefreshEnabled(false)
	s.RunCheckinNow()
	if !rec.has("daily-checkin") || rec.has("get-user-resource") {
		t.Fatalf("only check-in should run when balance refresh is off: %v", rec.snapshot())
	}
	st, _ := s.cfg.Pool.Status("u1")
	if !st.CheckinDone {
		t.Fatal("check-in must still be recorded")
	}
	s.SetCheckinRefreshEnabled(true)
	if !s.CheckinRefreshEnabled() {
		t.Fatal("refresh option was not restored")
	}
}
