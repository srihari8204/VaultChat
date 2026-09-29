// Package services decides which parts of the backend this process runs.
//
// One image, one binary, started as core, as a single feature service, or as
// everything (docs/MICROSERVICES_PLAN.html, openspec: microservices-prepare).
// SERVICES is read once at boot: `all` or a comma-separated list of the names
// below. Unset or empty means `all`, which is what production runs until a
// feature is moved out, so this package changes nothing by default.
package services

import (
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
)

// The services, as the plan names them. Core is everything that is not a
// feature: accounts, chat, the CC-Wire socket and its jobs.
const (
	Core     = "core"
	GoLive   = "golive"
	Family   = "family"
	Games    = "games"
	Maps     = "maps"
	ShopBook = "shopbook"
	Calls    = "calls"
)

var known = []string{Core, GoLive, Family, Games, Maps, ShopBook, Calls}

var (
	once    sync.Once
	enabled map[string]bool
	loadErr error
)

// Parse turns a SERVICES value into the set it enables. An unknown name is an
// error rather than ignored: a typo that silently starts nothing is an outage
// that looks like a healthy container.
func Parse(v string) (map[string]bool, error) {
	set := map[string]bool{}
	v = strings.TrimSpace(v)
	if v == "" || v == "all" {
		for _, s := range known {
			set[s] = true
		}
		return set, nil
	}
	for _, part := range strings.Split(v, ",") {
		name := strings.TrimSpace(part)
		if name == "" {
			continue
		}
		if !isKnown(name) {
			return nil, fmt.Errorf("SERVICES names unknown service %q (known: all, %s)", name, strings.Join(known, ", "))
		}
		set[name] = true
	}
	if len(set) == 0 {
		return nil, fmt.Errorf("SERVICES=%q names no service", v)
	}
	return set, nil
}

func isKnown(name string) bool {
	for _, s := range known {
		if s == name {
			return true
		}
	}
	return false
}

func load() {
	enabled, loadErr = Parse(os.Getenv("SERVICES"))
}

// Load parses SERVICES. main calls it first and exits on the error.
func Load() error {
	once.Do(load)
	return loadErr
}

// Enabled reports whether this process runs the named service. Before Load,
// or after a failed Load, nothing is enabled.
func Enabled(name string) bool {
	once.Do(load)
	return enabled[name]
}

// List names the enabled services in a stable order, for the boot log.
func List() []string {
	once.Do(load)
	out := make([]string, 0, len(enabled))
	for s := range enabled {
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}

// SetForTest replaces the enabled set, for tests that exercise one mode after
// another in a single process.
func SetForTest(v string) error {
	once.Do(func() {})
	enabled, loadErr = Parse(v)
	return loadErr
}
