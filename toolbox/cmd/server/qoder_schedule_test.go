package main

import (
	"reflect"
	"testing"
	"time"
)

func TestQoderScheduleUsesBeijingRewardWindow(t *testing.T) {
	if got := qoderHours([]int{0, 9, 10, 21}); !reflect.DeepEqual(got, []int{10, 21}) {
		t.Fatal(got)
	}
	for _, tc := range []struct {
		instant, last string
		enabled, want bool
	}{
		{"2026-11-01T01:00:00Z", "", true, false},
		{"2026-11-01T02:00:15Z", "", true, true},
		{"2026-11-01T02:00:45Z", "2026-11-01-10", true, false},
		{"2026-11-01T02:01:00Z", "", true, false},
		{"2026-11-01T02:00:15Z", "", false, false},
		{"2026-11-01T13:00:15Z", "2026-11-01-10", true, true},
	} {
		now, _ := time.Parse(time.RFC3339, tc.instant)
		due, _ := qoderScheduleDue(now, accountSchedule{Enabled: tc.enabled, Hours: []int{9, 21}}, tc.last)
		if due != tc.want {
			t.Fatalf("%+v: %v", tc, due)
		}
	}
}
