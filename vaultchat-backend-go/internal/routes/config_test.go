package routes

import (
	"fmt"
	"testing"
)

func ptr(n int) *int { return &n }

// The kill switch is the whole reason this channel exists. It must outrank
// every other lever, including a fully rolled-out flag on a current build.
func TestKillSwitchOutranksEverything(t *testing.T) {
	row := flagRow{key: "VB_SEAMLESS_RESUME", killed: true, rolloutPct: 100, minBuild: ptr(1)}
	for _, dev := range []string{"", "device-a", "device-b", "device-c"} {
		for _, build := range []int{0, 1, 999999} {
			v, has := resolve(row, dev, build)
			if !has || v {
				t.Fatalf("killed flag resolved to %v (has=%v) for device %q build %d", v, has, dev, build)
			}
		}
	}
}

// A version floor must hold at any percentage: a flag can be safe at 100%
// among new builds and still unsafe against an old one.
func TestMinBuildFloor(t *testing.T) {
	row := flagRow{key: "VB_SEAMLESS_RESUME", rolloutPct: 100, minBuild: ptr(120)}
	if v, _ := resolve(row, "device-a", 119); v {
		t.Fatal("a build below the floor must never receive the flag")
	}
	if v, _ := resolve(row, "device-a", 120); !v {
		t.Fatal("a build at the floor must receive a 100% flag")
	}
	// An unparseable/absent build arrives as 0 and must fail the floor.
	if v, _ := resolve(row, "device-a", 0); v {
		t.Fatal("an unidentifiable build must not receive new behaviour")
	}
}

// Raising the dial may only ADD devices. If a device could fall out of the
// cohort on the way up, a user would see the feature appear and then vanish,
// and — for VaultBeam — could switch segment-plan version between transfers.
func TestRolloutIsMonotone(t *testing.T) {
	const key = "VB_SEAMLESS_RESUME"
	devices := make([]string, 2000)
	for i := range devices {
		devices[i] = fmt.Sprintf("device-%04d", i)
	}

	prev := map[string]bool{}
	for _, pct := range []int{0, 1, 10, 25, 50, 100} {
		row := flagRow{key: key, rolloutPct: pct}
		enabled := 0
		for _, d := range devices {
			v, has := resolve(row, d, 1)
			if !has {
				t.Fatalf("a row must always express an opinion (pct=%d)", pct)
			}
			if prev[d] && !v {
				t.Fatalf("device %s was enabled at a lower percentage and dropped out at %d%%", d, pct)
			}
			if v {
				enabled++
			}
			prev[d] = v
		}
		// The bucket distribution should track the dial closely. A wide margin
		// here would hide a hash that clumps, which is the failure that makes a
		// "1%" canary silently 12%.
		want := len(devices) * pct / 100
		if diff := enabled - want; diff > len(devices)/50 || diff < -len(devices)/50 {
			t.Fatalf("pct=%d enabled %d devices, expected ~%d", pct, enabled, want)
		}
	}
}

// Buckets must be stable across calls, and independent across flags — otherwise
// every 1% canary lands on the same devices and one cohort absorbs the risk of
// every experiment.
func TestBucketStableAndPerKey(t *testing.T) {
	if bucketOf("A", "device-a") != bucketOf("A", "device-a") {
		t.Fatal("bucketing must be deterministic")
	}
	same := 0
	for i := 0; i < 500; i++ {
		d := fmt.Sprintf("device-%d", i)
		if bucketOf("FLAG_A", d) == bucketOf("FLAG_B", d) {
			same++
		}
	}
	// Independent buckets collide ~1% of the time; correlated ones collide 100%.
	if same > 30 {
		t.Fatalf("flags share buckets (%d/500 collisions) — the same devices carry every canary", same)
	}
}

// A caller we cannot bucket stably must not flap in and out of a partial
// rollout on every request.
func TestMissingDeviceIdIsNeverInAPartialRollout(t *testing.T) {
	for _, pct := range []int{1, 10, 50, 99} {
		if v, _ := resolve(flagRow{key: "K", rolloutPct: pct}, "", 1); v {
			t.Fatalf("an un-bucketable caller was admitted to a %d%% rollout", pct)
		}
	}
	// …but a full rollout is unambiguous and still applies.
	if v, _ := resolve(flagRow{key: "K", rolloutPct: 100}, "", 1); !v {
		t.Fatal("a 100% rollout must apply even without a device id")
	}
}

// Zero percent is a real answer ("off for everyone"), distinct from the absence
// of a row (which the handler never emits and the client reads as "no opinion").
func TestZeroPercentIsAnExplicitOff(t *testing.T) {
	v, has := resolve(flagRow{key: "K", rolloutPct: 0}, "device-a", 1)
	if !has || v {
		t.Fatalf("pct=0 must resolve to an explicit false, got v=%v has=%v", v, has)
	}
}
