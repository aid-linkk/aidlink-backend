# Database Connection Pooling, Monitoring and Query Metrics

How AidLink sizes its PostgreSQL connection pool, what it measures, and how to
profile connection behaviour when tuning a deployment.

Related code:

- `src/config/dbPool.ts` — pool sizing and connection-URL construction (pure, unit tested)
- `src/config/database.ts` — Prisma client, timeouts, monitoring, health checks
- `src/utils/dbMetrics.ts` — in-process query metrics collector
- `scripts/profile-db-pool.ts` — connection-behaviour profiler

## 1. How Prisma pools connections

Prisma does not expose a pool object; the pool is configured through query-string
parameters on `DATABASE_URL` and lives inside the query engine:

| Parameter | Meaning |
|-----------|---------|
| `connection_limit` | Max connections this process opens against PostgreSQL |
| `pool_timeout` | Seconds a query waits for a free connection before failing with `P2024` |
| `connect_timeout` | Seconds to wait while establishing a new connection |
| `socket_timeout` | Seconds a single statement may hold a connection |

Connections are opened lazily up to `connection_limit` and are handed to queries
one at a time. A query that finds every connection busy is queued; if it is still
queued when `pool_timeout` elapses, Prisma rejects it with:

```
P2024: Timed out fetching a new connection from the connection pool
```

That error is the definitive signal that the pool, not the database, is the
bottleneck. It is counted separately in the metrics (`connections.poolTimeouts`).

Rather than requiring operators to hand-write these parameters,
`buildPooledDatabaseUrl()` appends them at startup. **Parameters already present
in `DATABASE_URL` are never overwritten**, so a deployment behind PgBouncer that
pins `?connection_limit=1&pgbouncer=true` keeps its own settings.

## 2. Pool sizing

Sizing is resolved once at startup by `resolveConnectionLimit()`:

```
cpuDerived = cpus * 2 + 1 + cpus          # Prisma's default, plus IO headroom
fairShare  = DB_SERVER_CONNECTION_BUDGET / DB_POOL_INSTANCES
limit      = clamp(min(cpuDerived, fairShare), 5, 100)
```

Rationale:

- **`cpus * 2 + 1` is Prisma's default** and assumes CPU-bound work. AidLink's
  request path is IO-bound (Prisma queries interleaved with Stellar RPC, S3 and
  SMTP calls), so connections spend time idle inside a request; one extra
  connection per CPU absorbs that without oversubscribing PostgreSQL.
- **`fairShare` is the hard ceiling.** PostgreSQL enforces a global
  `max_connections` (default 100). Every API replica, worker process and
  `prisma studio` session draws from the same pool of slots, so the per-process
  limit is divided by the number of processes sharing the server.
  `DB_SERVER_CONNECTION_BUDGET` should be `max_connections` minus headroom for
  migrations, psql sessions and monitoring (default 80 of 100).
- **The floor of 5** keeps a 1-vCPU container usable; the ceiling of 100 makes a
  mistyped `DB_POOL_MAX` incapable of exhausting the server.

`DB_POOL_MAX` overrides the heuristic entirely (still clamped to 5..100).

### Worked examples

| Deployment | CPUs | Instances | Budget | Limit |
|------------|------|-----------|--------|-------|
| Local dev (1 process) | 4 | 1 | 80 | 13 |
| Small prod (2 API replicas + 1 worker) | 4 | 3 | 80 | 13 |
| Large prod (4 replicas) | 16 | 4 | 80 | 20 |
| Behind PgBouncer (transaction pooling) | any | any | any | set `?connection_limit=1` in `DATABASE_URL` |

Note the second row: the CPU-derived value (13) is already below the fair share
(26), so it wins. The fair share only binds when the process is large relative
to the server budget.

## 3. Timeout handling

Four distinct timeouts, in the order a request encounters them:

1. **`DB_CONNECT_TIMEOUT_SECONDS`** (`connect_timeout`, default 10) — establishing
   a new TCP/TLS connection. Prevents a request hanging indefinitely when the
   database host is unreachable.
2. **`DB_POOL_TIMEOUT_SECONDS`** (`pool_timeout`, default 10) — waiting for a
   free pooled connection. On expiry Prisma raises `P2024`, which
   `classifyConnectionError()` counts and logs together with the current pool
   settings so the log line is actionable on its own.
3. **`DB_SOCKET_TIMEOUT_SECONDS`** (`socket_timeout`, default 0 = disabled) —
   server-side statement duration. Enable this when a runaway query holding a
   connection is a bigger risk than a query being killed mid-flight.
4. **`DB_QUERY_TIMEOUT_MS`** (default 0 = disabled) — a client-side abort applied
   by Prisma middleware. It rejects the caller with `DatabaseQueryTimeoutError`
   once the budget elapses. **This does not cancel the underlying statement**;
   the connection is released only when PostgreSQL finishes. It is therefore a
   latency guard for the API, not a resource guard — use `socket_timeout` for
   the latter. Off by default so long-running analytics rollups are not broken
   by a global budget.

Startup connection is retried with exponential backoff
(`DB_CONNECT_RETRIES`, `DB_CONNECT_RETRY_BASE_DELAY_MS`: 5 attempts at
500ms/1s/2s/4s). Container start order — the API booting before PostgreSQL
accepts connections — is the common case this handles; previously the process
exited on the first failure.

## 4. Monitoring

### Pool gauges

Live pool state comes from Prisma's `metrics` preview feature, enabled in
`prisma/schema.prisma`. `getPoolStats()` reads:

| Gauge | Reported as |
|-------|-------------|
| `prisma_pool_connections_open` | `open` |
| `prisma_pool_connections_busy` | `busy` |
| `prisma_pool_connections_idle` | `idle` |
| `prisma_client_queries_wait` | `waiting` (queries queued for a connection right now) |

plus a derived `utilization` (`busy / limit`). If the client was generated
without the preview feature, `available: false` is returned and everything else
keeps working — no endpoint fails because metrics are unavailable.

A background sampler (`DB_MONITOR_INTERVAL_MS`, default 60s) logs the gauges at
debug level, escalating to a warning once `utilization` reaches
`DB_POOL_SATURATION_THRESHOLD` (default 0.8) or any query is queued. Waiting
queries are the leading indicator: they appear well before the first `P2024`.

### Query performance metrics

`DatabaseMetrics` records every Prisma operation via middleware — duration,
success, and `model.action` — and derives:

- totals, error count and error rate, queries/second
- latency avg / p50 / p95 / p99 / max over a rolling 1000-query window
- a fixed-bucket latency histogram (1ms .. 5s)
- the ten operations with the highest cumulative time (where pool pressure
  actually comes from — 1000 x 20ms costs the pool more than 1 x 2s)
- the last 20 slow queries (>= `DB_SLOW_QUERY_THRESHOLD_MS`, default 500ms)
- connection-event counters: connect attempts/failures/retries, disconnects,
  pool timeouts, query timeouts

All structures are bounded (ring buffers, a 200-key operation cap), so the
collector is safe to leave enabled in production. Separately, SQL-level slow
statements are logged from Prisma's `query` event with the statement text
truncated to 500 characters — parameters are not interpolated into it.

### Endpoints

| Endpoint | Access | Purpose |
|----------|--------|---------|
| `GET /health/db` | Public | Round-trip latency, pool gauges, query summary |
| `GET /api/v1/admin/database/metrics` | Admin | Full metrics snapshot including slow queries |
| `POST /api/v1/admin/database/metrics/reset` | Admin | Clear counters, e.g. before a load test |

`/health/db` returns three states:

- `healthy` — `SELECT 1` succeeded and the pool has room
- `degraded` — the database answered, but queries are queueing or utilisation is
  at/above the saturation threshold (HTTP 200: still serving, needs attention)
- `unhealthy` — the probe query failed (HTTP 503, so a load balancer drains the
  instance)

## 5. Profiling connection behaviour

`scripts/profile-db-pool.ts` drives a read-only workload at increasing
concurrency and reports latency percentiles, peak busy/waiting connections and
pool timeouts per phase.

```bash
npm run db:profile                                  # sweep 1,5,10,25,50,100
CONCURRENCY=1,10,50 ITERATIONS=500 npm run db:profile
```

Point it at a development or staging database; it opens as many connections as
the configured pool allows.

Record results per environment:

| Concurrency | Throughput/s | p50 | p95 | p99 | Peak busy | Peak waiting | Pool timeouts |
|-------------|--------------|-----|-----|-----|-----------|--------------|---------------|
| 1 | | | | | | | |
| 10 | | | | | | | |
| 50 | | | | | | | |
| 100 | | | | | | | |

### Reading the results

The shape to look for is the same in every environment:

- **Below the pool limit**, p95 tracks raw query latency and `peakWaiting` stays
  at 0. Throughput rises roughly linearly with concurrency.
- **At the pool limit**, `peakBusy` pins to `connection_limit` and `peakWaiting`
  becomes non-zero. Throughput flattens; p95 starts growing because latency is
  now queue time, not query time. This is the pool working as intended, and it
  is where the saturation warning fires.
- **Well beyond the limit**, queue time exceeds `pool_timeout` and `poolTimeouts`
  becomes non-zero — requests now fail rather than queue.

Tuning follows from which of these you see under real traffic:

- Waiting > 0 but no timeouts, and PostgreSQL has spare `max_connections`:
  raise `DB_POOL_MAX` (and `DB_SERVER_CONNECTION_BUDGET` if the fair share is
  binding).
- Timeouts with a large `peakWaiting` and PostgreSQL already near
  `max_connections`: add PgBouncer rather than more connections, or reduce
  per-request query count.
- p95 high while `peakBusy` is well below the limit: the queries themselves are
  slow. Use `topOperations` and `slowQueries` from the admin metrics endpoint to
  find them; more connections will not help.

## 6. Configuration reference

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_POOL_MAX` | auto | Per-process pool size; overrides the heuristic |
| `DB_POOL_INSTANCES` | 1 | Processes/replicas sharing this PostgreSQL server |
| `DB_SERVER_CONNECTION_BUDGET` | 80 | Connections the fleet may use in total |
| `DB_POOL_TIMEOUT_SECONDS` | 10 | Wait for a free pooled connection |
| `DB_CONNECT_TIMEOUT_SECONDS` | 10 | Wait while establishing a connection |
| `DB_SOCKET_TIMEOUT_SECONDS` | 0 | Statement duration cap (0 disables) |
| `DB_CONNECT_RETRIES` | 5 | Startup connect attempts |
| `DB_CONNECT_RETRY_BASE_DELAY_MS` | 500 | Backoff base for startup retries |
| `DB_MONITOR_INTERVAL_MS` | 60000 | Pool sampling interval (0 disables) |
| `DB_POOL_SATURATION_THRESHOLD` | 0.8 | Utilisation at which warnings fire |
| `DB_SLOW_QUERY_THRESHOLD_MS` | 500 | Slow-query threshold |
| `DB_LOG_SLOW_QUERIES` | true | Log slow SQL statements |
| `DB_QUERY_TIMEOUT_MS` | 0 | Client-side query abort (0 disables) |

All are optional: with none set, the pool is auto-sized and monitoring runs with
the defaults above.
