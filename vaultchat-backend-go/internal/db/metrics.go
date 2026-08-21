package db

import (
	"github.com/jackc/pgx/v5/pgxpool"

	"vaultchat/backend-go/internal/metrics"
)

// RegisterPoolGauges exposes pgxpool's own counters as Prometheus gauges.
//
// WHY THIS AND NOT QUERY TIMING
//
// The obvious way to "measure the database" is a pgx QueryTracer that times
// every statement. That was considered and rejected for this phase: a tracer
// runs on the hot path of every query in the process, and the instrumentation
// is supposed to be free. Per-statement timing with zero application overhead
// is what pg_stat_statements is for, and it belongs in the database rather than
// in this binary.
//
// What the pool knows, by contrast, is already counted — pgxpool maintains
// these numbers whether anybody reads them or not. Exposing them costs one
// closure per gauge, evaluated ONLY when Prometheus scrapes (metrics.SetGauge
// stores the func and calls it at exposition time), so between scrapes this
// adds nothing at all.
//
// The two that matter most are the ones that answer "is the pool the
// bottleneck":
//
//	db_pool_empty_acquires_total — a caller wanted a connection and none was
//	  free. Non-zero and rising means the pool is undersized for the load, and
//	  it is invisible from route latency alone (the request just looks slow).
//	db_pool_acquire_wait_seconds_total — cumulative time spent waiting for a
//	  connection. Divided by acquires, it is the queueing delay every query
//	  pays before it even reaches Postgres.
//
// Registered from cmd/api/main.go alongside routes.RegisterBodyGauges().
// Safe to call before or after Connect: each closure re-reads the package
// pointer, so a nil pool reports 0 rather than panicking at scrape time.
func RegisterPoolGauges() {
	register("db_pool", func() *poolStat { return statOf(Pool) })

	// SysPool aliases Pool unless DB_SYSTEM_USER is configured. Registering it
	// unconditionally would double every number under a second name and make
	// the dashboard lie about connection counts, so it is only exposed when it
	// is genuinely a second pool.
	if SysPool != nil && SysPool != Pool {
		register("db_syspool", func() *poolStat { return statOf(SysPool) })
	}
}

// poolStat is the subset of pgxpool.Stat this exposes, flattened so the
// registration below reads as a list rather than as reflection.
type poolStat struct {
	acquired, idle, total, max      float64
	acquireCount, emptyAcquireCount float64
	canceledAcquireCount            float64
	acquireWaitSeconds              float64
}

func statOf(p *pgxpool.Pool) *poolStat {
	if p == nil {
		return nil
	}
	s := p.Stat()
	if s == nil {
		return nil
	}
	return &poolStat{
		acquired:             float64(s.AcquiredConns()),
		idle:                 float64(s.IdleConns()),
		total:                float64(s.TotalConns()),
		max:                  float64(s.MaxConns()),
		acquireCount:         float64(s.AcquireCount()),
		emptyAcquireCount:    float64(s.EmptyAcquireCount()),
		canceledAcquireCount: float64(s.CanceledAcquireCount()),
		acquireWaitSeconds:   s.AcquireDuration().Seconds(),
	}
}

func register(prefix string, read func() *poolStat) {
	g := func(name string, pick func(*poolStat) float64) {
		metrics.SetGauge(prefix+"_"+name, func() float64 {
			st := read()
			if st == nil {
				return 0
			}
			return pick(st)
		})
	}
	g("acquired_conns", func(s *poolStat) float64 { return s.acquired })
	g("idle_conns", func(s *poolStat) float64 { return s.idle })
	g("total_conns", func(s *poolStat) float64 { return s.total })
	g("max_conns", func(s *poolStat) float64 { return s.max })
	g("acquires_total", func(s *poolStat) float64 { return s.acquireCount })
	g("empty_acquires_total", func(s *poolStat) float64 { return s.emptyAcquireCount })
	g("canceled_acquires_total", func(s *poolStat) float64 { return s.canceledAcquireCount })
	g("acquire_wait_seconds_total", func(s *poolStat) float64 { return s.acquireWaitSeconds })
}
