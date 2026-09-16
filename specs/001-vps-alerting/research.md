# Research: VPS Alerting

**Feature**: `specs/001-vps-alerting/spec.md` | **Date**: 2026-09-16

Each entry: Decision / Rationale / Alternatives considered. Items marked *(code map)* were
confirmed against the repository in the second half of this document.

## R1. The ping API contract (healthchecks-compatible)

**Decision**: target the pinging API shape documented at healthchecks.io/docs/http_api and
implemented by its self-hosted and compatible clones, without naming a vendor in code. Verified
from the published docs on 2026-09-16:

| purpose | URL | method | body |
|---|---|---|---|
| alive | `<base>` | GET, POST or HEAD | POST body optional, first 100 kB kept |
| failure | `<base>/fail` | same | same |
| start of a run | `<base>/start` | same | same |
| attach text without changing state | `<base>/log` | same | same |
| report an exit status | `<base>/<exit-status>` | same | `0` counts as success, non-zero as failure |

Responses: `200` with body `OK` when accepted; **`200` with body `OK (not found)`** for an
unknown UUID and `200 OK (rate limited)` when throttled, so the HTTP status alone is not a
verdict; `400 invalid url format` for a malformed URL. Rate limit: more than 5 pings a minute may
be dropped; the box sends at most one per 15 minutes plus rare unit events. Period and grace are
configured per check in the service, not via the ping. Pausing is a management-API operation, not
a ping.

**Rationale**: the spec's P1 needs silence detection off the box; this API family is the
de-facto standard for it, has a free tier with push integrations, and the same client code works
against a self-hosted instance if the founder ever reverses FR-017.

**Alternatives considered**: a generic webhook to a push service (no silence detection, rejected
by FR-017); the service's management API for pause/resume during maintenance (needs a second,
more powerful credential on the box; rejected, maintenance lives on the box, see R4).

**Consequence for the client**: accepted means `status 200 AND body === 'OK'`; anything else is
`rejected` (2xx with a different body, 4xx) or `unreachable` (network error, timeout). The
self-test (FR-011) must surface the body text, which is how a wrong UUID is caught: it is a 200.

## R2. Period, grace and the 35-minute bound

**Decision**: check period 15 min, grace 20 min, configured in the service by hand at setup and
recorded in the runbook. Silence therefore alerts 35 min after the last `alive`, matching FR-003
and SC-001.

**Rationale**: `ctb-watch.timer` fires every 15 min (`OnUnitActiveSec=15min`) with `OnBootSec=5min`
after a reboot; a 20-minute grace absorbs one missed cycle plus a reboot without paging, and two
missed cycles page. Shorter grace (5 min) would page on every reboot; longer (60 min) would have
hidden today's stopped runs for an hour.

**Alternatives considered**: shortening the timer to 5 min (more pings, more load on a 2 GB box,
and the watchdog already reads the database each cycle; rejected); sending `/start` at the top of
each cycle for duration tracking (not needed for v1; `rid` support noted for later).

## R3. One report per cycle, sent after the verdict

**Decision**: the watchdog computes its verdict exactly as today, then makes one HTTP call:
`alive` (with the verdict lines as the body, including warnings) when there is no FAIL, `fail`
(same body) when there is at least one FAIL. The call happens after the verdict is printed and
does not change `process.exitCode`.

**Rationale**: FR-001, FR-004, FR-005, FR-015 and data-model invariant 1. Keeping the existing
verdict as the single source of "healthy" means the alerting cannot disagree with the dashboard
or the log. Sending after the verdict means a crash inside the checks is indistinguishable from
silence, which is what the spec wants (US1 scenario 4).

**Alternatives considered**: sending `/start` first and `alive`/`fail` after (adds a second
request and a `rid`; deferred); separate checks per subsystem (collector, each paper run,
backup) so the service shows which one is down (more checks on the free tier, more URLs in
`.env`, and the verdict body already names the failing check; rejected for v1).

## R4. Maintenance is a file on the box, not a service-side pause

**Decision**: `~/ctb-maintenance.json` with `until`, `reason`, `declaredAt` (data-model). The
watchdog and the unit failure handler read it. While active: `fail` becomes `alive` with a
`[maintenance]`-prefixed body; unit failures become `/log`. `alive` is never suppressed. Hard cap
240 minutes; expiry is by timestamp and is announced by the next cycle.

**Rationale**: FR-009 and FR-010. Pausing the check in the service would suppress the silence
alert too, which FR-010 forbids; and it would need a management-API key on the box. A file is
readable by a root-run systemd handler and a ctb-run watchdog alike, survives process restarts,
and cannot be forgotten because it expires.

**Alternatives considered**: an environment variable (does not survive across units and cannot
expire); a database row (the failure handler must work when Postgres is the thing that failed);
the service's pause endpoint (see above).

## R5. Unit failures via `OnFailure=` and one templated handler unit

**Decision**: add `OnFailure=ctb-alert@%n.service` to `ctb-paper@.service`, `ctb-collector.service`
and `ctb-backup.service`; add `ctb-alert@.service`, a oneshot that runs a small shell script
`infra/vps/alert-unit-failure.sh <unit>` as `ctb`, which reads `Result`/`ExecMainStatus` via
`systemctl show`, reads the maintenance file, builds a body with the unit name and reason, and
sends `/<exit-status>` (or `/log` in maintenance) with `curl`.

**Rationale**: FR-008, SC-003. systemd enters `failed` once per restart-limit event, which gives
the "one alert per event, not per restart" property for free. A shell handler with `curl` has no
Node startup cost and works when `node_modules` is mid-`npm ci` (the deploy window), when the
database is down, and when the failing unit is the collector that the Node CLI would otherwise
share code with. The script must survive `bash -s` (no bare `docker exec -i`; it needs none) and
shellcheck on CI's older version (no `{n}` in regexes).

**Alternatives considered**: `ExecStopPost=` on each unit (runs on every stop, including clean
ones, and cannot see the restart limit); a Node command as the handler (startup cost, and the
handler must not depend on the tree it is alerting about); journald forwarding to a log shipper
(a daemon; rejected by FR-014).

## R6. The credential and the body filter

**Decision**: `CTB_HEALTHCHECK_URL` in `.env`, optional in the config loader; absent means alerting
is off and the watchdog is byte-for-byte today's behaviour. The client never logs or prints the
URL; error messages carry the host and the status code only. Every body passes a secret filter
before sending (data-model, Report). The shell handler reads the URL from `.env` with a
`grep '^CTB_HEALTHCHECK_URL=' | cut -d= -f2-` guarded by `set +x`, the same discipline as
`rotate-postgres-password.sh`.

**Rationale**: FR-012, FR-013, the global rule "never print resolved secrets", and this repo's
history (`ctb_local_only` is in the public git log forever).

**Alternatives considered**: a separate secrets file for the handler (a second file to keep at
mode 600; `.env` already is); passing the URL as a unit `Environment=` (visible in `systemctl show`;
rejected).

## R7. Transport from Node: built-in `fetch`, with a timeout

**Decision** *(code map)*: use Node's global `fetch` with an `AbortSignal.timeout(10_000)`, no new
dependency. See the code-map section for the Node version and the absence of an existing HTTP
client in the watchdog's package.

**Alternatives considered**: `axios` (already a dependency elsewhere in the repo for Blockfrost;
brings interceptors and retries the alerting must not have); `undici` (what `fetch` is built on;
no reason to import it directly).

## R8. Verification strategy

**Decision**: three layers, all required before "done" (FR-016, SC-001..SC-009):

1. **Unit tests** on the pure parts: body construction from `Check[]`, the secret filter, the
   accepted/rejected/unreachable classification from a stubbed `fetch`, maintenance-file
   evaluation (active, expired, malformed, over-cap), and a guard test that the watchdog's exit
   code is unchanged when the report fails. The `fetch` stub must reproduce the property under
   test: a `200 OK (not found)` must classify as rejected.
2. **A shell harness** for `alert-unit-failure.sh` in the style of
   `infra/vps/test-rotate-postgres-password.sh`: a stubbed `systemctl show` and a stubbed `curl`
   that records URL suffix and body, run under `bash -s`, asserting suffix, body and the
   maintenance branch.
3. **Drills on the real box**, recorded in the runbook with observed times: silence (stop the
   timer), failure (stop a paper unit), unit failure (force a start-limit hit on a throwaway
   strategy instance), maintenance (declare, stop units, no page; end, page), self-test with a
   good and a deliberately wrong URL, and a memory measurement before/after (SC-008).

**Rationale**: the constitution's principle that stand-ins must reproduce the property under
test, and this week's two rotation-script failures that harnesses passed.

## R9. What is out of scope for v1

- Per-subsystem checks (R3).
- `/start` + `rid` duration tracking (R2).
- Alert routing to anyone but the founder; quiet hours (FR-017 default).
- Dashboard display of alert state (the service's own UI is the display).
- Replacing the 15-minute timer with a daemon (FR-014).

---

## Code map (facts confirmed against the repository)

Facts checked against the tree at `2aa996f` on 2026-09-16.

- **The watchdog.** `packages/cli/src/commands/watch.ts:22` `watchCommand(log, args)`; loads
  config via `loadConfig(process.env, { blockfrost: false })` (:24); builds one `Check[]` from
  processes, paper-run rows, the snapshot digest, tick health, quota, backup age and disk
  (:27-57); `verdict(checks)` from `@ctb/reports` (:62); prints `STATUS: name — detail` per
  non-OK check and sets `process.exitCode = v.exitCode === 0 ? 0 : 1` (:62-72). `--verbose` only
  adds `watch: OK` on a clean run. **No side effect today** beyond a DB pool, `ps` and `statfs`:
  the ping will be its first outbound call. The report body is those printed lines plus
  `v.line` with `doctor:` replaced by `watch:`.
- **`Check` and `verdict`.** `packages/reports/src/doctor.ts:10-11` `Status = 'ok'|'warn'|'fail'`,
  `Check { name, status, detail }`; `verdict(checks): { exitCode, line }` (:112-117). Warn never
  exits non-zero, deliberately (f5acb93's body: "making warnings exit non-zero would turn every
  blip into an alarm"). Watch-specific checks in `packages/reports/src/watch.ts`
  (`checkPaperRuns` :102, `checkBackupFreshness` :154, warn 26 h / fail 48 h).
- **Purity guard.** `packages/reports/test/purity.guard.test.ts:16` forbids `pg`, `@ctb/db`,
  `@ctb/cli`, `node:child_process`, `node:fs`, `node:net`, `node:http` imports anywhere under
  `packages/reports/src`. Global `fetch` would slip the regex but not the intent; hence
  `decideReport`/`classify`/`evaluateMaintenance` in reports, `report()` with `fetch` in cli.
- **Config.** `packages/cli/src/config.ts:130` `loadConfig`, zod v3, first issue thrown as
  `config: <path>: <message>`. Optional string idiom (:45):
  `z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional())` — needed
  because dotenv turns `KEY=` into `''`. `Config` interface at :7-27, mapped at :161-175.
- **Dispatch.** `packages/cli/src/main.ts:26-79` `switch (cmd)`; `case 'watch': return
  watchCommand(log, rest)` (:60-61); usage string at :67-77 lists every command and must gain
  `alert` and `maintenance`. Root `package.json` scripts are
  `"<name>": "tsx packages/cli/src/main.ts <name>"`; `backup:verify:remote` is the precedent for a
  script with a fixed flag.
- **HTTP.** `.nvmrc` 24; global `fetch` available; only `packages/cli/src/r2.ts` does HTTP today
  (`aws4fetch`, header comment explains the no-fat-client rule); `axios` is transitive and pinned
  by `packages/collector/test/axiosOverride.guard.test.ts`.
- **Units.** No unit has `OnFailure=` or `EnvironmentFile=`. All run `User=ctb`,
  `WorkingDirectory=/home/ctb/cardano-trading-bots`, logs appended under `/home/ctb/logs/`.
  `ctb-watch.service` is a oneshot with no `[Install]` (timer-activated); `ctb-watch.timer`
  `OnBootSec=5min`, `OnUnitActiveSec=15min`. `ctb-backup.service` runs
  `scripts/scheduled-backup.sh` (dump, R2 upload, remote verify; `fail()` = exit 1 into
  `backup.log` and nothing else). `ctb-paper@.service` `Restart=always RestartSec=60
  StartLimitBurst=5 StartLimitIntervalSec=600 KillSignal=SIGINT`; `ctb-collector.service`
  `Restart=always RestartSec=30 StartLimitIntervalSec=1h StartLimitBurst=5`. Load-bearing comment
  in both: `StartLimit*` belongs in `[Unit]` or systemd silently ignores it; `systemd-analyze
  verify` caught that once. `OnFailure=` is a `[Unit]` key too.
- **deploy.sh.** Required-env loop at :68-71 (`DATABASE_URL BLOCKFROST_PROJECT_ID
  POSTGRES_PASSWORD`) — an optional key must not be added there. Install block :116-127 globs
  `*.service *.timer`, so `ctb-alert@.service` lands without editing the script; `UNITS`/`TIMERS`
  arrays enable only the four services and two timers; a template needs no enable. Post-deploy
  state block :130-132 hard-codes unit names.
- **Tests.** `vitest.config.ts:6` includes `packages/*/test/**/*.test.ts`; the PG gate is
  `packages/db/test/helpers.ts:4` `PG_ENABLED = process.env.RUN_PG_TESTS === '1'`, not a config
  filter. Guard-test template: `packages/cli/test/watchWiring.guard.test.ts` reads `watch.ts` as
  text and asserts `checks.push(<fn>(` per check plus a control that the file is the right one.
  `packages/reports/test/watchdogSilence.test.ts` pins the 2026-09-08 silent-watchdog rows: old
  check set exit 0, new set exit 1. CI: one job `lint, unit, postgres`: shellcheck over
  `infra/**/*.sh scripts/*.sh`, `npm ci`, `npm run lint`, `npm test`, `npm run test:pg`.
- **Runbooks.** `RUNBOOK-7day-run.md` "The two drills, on day 2" (:80-117) is the shape to
  imitate for the alerting drills. `RUNBOOK-backups.md` "How you find out it stopped" (:46-52)
  says the only signal is `watch`'s 26 h warn / 48 h fail. **No runbook mentions any
  notification**; the only acknowledgement is `docs/ops/2026-09-16-m3-report.md:287`.
- **Prior art f5acb93** (2026-09-08): the watchdog ran fifteen times and exited 0 through a
  four-hour dead feed. Fix: three pure checks in reports, a wiring guard in cli, and a test that
  keeps the old check set failing to see it. Constraints inherited: do not make warn fail; new
  logic pure in reports with a `Check`-shaped input and a wiring guard; a maintenance window that
  could suppress the ping is the same "silently wrong" shape, so it gets its own guard and the
  self-test is the operator's proof the check runs.
