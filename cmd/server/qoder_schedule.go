package main

import (
	"context"
	"time"

	"github.com/linguo2625469/workbuddy2api-panel/internal/qoder"
)

func qoderHours(hours []int) []int {
	out := []int{}
	seen := map[int]bool{}
	for _, hour := range hours {
		if hour < 10 {
			hour = 10
		}
		if !seen[hour] {
			out = append(out, hour)
			seen[hour] = true
		}
	}
	return out
}
func qoderScheduleDue(now time.Time, schedule accountSchedule, last string) (bool, string) {
	now = now.In(time.FixedZone("Asia/Shanghai", 8*3600))
	key := now.Format("2006-01-02-15")
	if !schedule.Enabled || key == last {
		return false, last
	}
	for _, hour := range qoderHours(schedule.Hours) {
		if now.Hour() == hour && now.Minute() == 0 {
			return true, key
		}
	}
	return false, last
}
func runQoderSchedule(ctx context.Context, settings *accountSettings, store *qoder.Store) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	last := ""
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			settings.mu.Lock()
			schedule := settings.schedule
			schedule.Hours = append([]int(nil), schedule.Hours...)
			settings.mu.Unlock()
			due, key := qoderScheduleDue(now, schedule, last)
			if !due {
				continue
			}
			last = key
			runCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
			store.RunAll(runCtx, "checkin")
			cancel()
		}
	}
}
