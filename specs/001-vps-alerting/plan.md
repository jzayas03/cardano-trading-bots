# Implementation Plan: VPS Alerting — dead-man's switch and failure notifications

**Branch**: `feat/vps-alerting` | **Date**: 2026-09-16 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-vps-alerting/spec.md`

## Summary

The watchdog that already runs every 15 minutes gains one outbound side effect: after it prints
its verdict it POSTs the verdict lines to a healthchecks-compatible ping URL, as `alive` when no
check failed and as `/fail` when one did. A service off the box pages the founder's phone when
that report stops arriving (35 minutes) or arrives as a failure. Three systemd units gain
`OnFailure=` pointing at one small shell handler that reports a unit failure within seconds. A
file on the box declares maintenance so a planned cutover does not page; it expires by itself and
never suppresses the liveness report. One command self-tests the whole path on demand. All pure
logic lives in `@ctb/reports` beside the existing checks; the only new I/O is one `fetch` in the
CLI package and one `curl` in the handler. Nothing long-running is added to a 2 GB box.

## Technical Context

**Language/Version**: TypeScript on Node 24 (`.nvmrc`, `engines.node >= 24`), ESM; bash for the
unit handler and its harness.

**Primary Dependencies**: none new. Node's global `fetch` with `AbortSignal.timeout`; `zod` v3
already used by `packages/cli/src/config.ts`; `curl`, `systemctl`, `systemd-escape` on the host.
The repo's precedent for "no fat HTTP client" is `packages/cli/src/r2.ts` (`aws4fetch` and nothing
else); `axios` exists only transitively and is pinned by a guard test.

**Storage**: no database change. One JSON file on the box, `/home/ctb/ctb-maintenance.json`
(mode 600), owned by the `maintenance` command. The check's schedule state lives in the external
service.

**Testing**: vitest (`packages/*/test/**/*.test.ts`, one root config); pure tests in
`packages/reports/test/`; source-text guard tests in `packages/cli/test/` following
`watchWiring.guard.test.ts`; a bash harness in `infra/vps/` following
`test-rotate-postgres-password.sh`; shellcheck via `npm run lint:sh`; the gate is `npm run test:pg`
and `npm run lint` (constitution IV). Drills on the real box recorded in the runbook (FR-016).

**Target Platform**: the existing Ubuntu VPS, systemd units run as `ctb` with
`WorkingDirectory=/home/ctb/cardano-trading-bots`, env from `.env` via `dotenv` (no
`EnvironmentFile=` anywhere).

**Project Type**: monorepo CLI (`packages/cli`) over a pure reports library (`packages/reports`)
plus host scripts under `infra/vps/`.

**Performance Goals**: one HTTPS request per watchdog cycle (every 15 min) plus rare unit
events; the service rate-limits above 5/min, we send well under 1/min. Handler completes in
under 30 s (`TimeoutStartSec`), `fetch` in under 10 s.

**Constraints**: no new long-running process (FR-014, SC-008 within 20 MB); the ping URL is a
secret that must never reach a log, argv or a commit (FR-012/13); warnings must not become
failures and the watchdog's exit code must not change (prior art f5acb93, FR-015); `@ctb/reports`
must stay pure (`purity.guard.test.ts`); shell must survive `bash -s` and CI's older shellcheck;
**a deploy during a measurement week is a founder decision** (constitution, "Stop and ask") — runs
150-153 are in flight from 2026-09-16 12:34 UTC.

**Scale/Scope**: one box, one check, one recipient. Five stories, seventeen requirements.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| principle / constraint | applies? | status |
|---|---|---|
| I. Cost model measured, never asserted | no cost-model change | pass |
| II. Units are part of the number | no monetary numbers in alerts beyond what the verdict already prints | pass |
| III. A quoted price is not a market | not touched | pass |
| IV. `npm test` is not the gate | plan requires `test:pg` and `lint` green, plus `lint:sh` and the harness, before "done"; drills on the box are additional evidence | pass |
| V. Promotion gate not gamed | not touched | pass |
| Stack: TypeScript, vitest, eslint, packages/ | followed; no new package (see Structure Decision) | pass |
| No real funds | none | pass |
| Merged is not deployed | plan separates merge from deploy; deploy timing is the founder's call because a measurement run is in flight | **needs founder decision, flagged below** |
| Development workflow: plan approved by founder, `speckit-implement` bounded by approved `tasks.md` | this plan and the tasks that follow await approval | pass |
| Never commit to `main` | branch `feat/vps-alerting`, PR #132 | pass |
| Spec Kit checks plans against this file | done here | pass |

**The one decision only the founder can make**: when to deploy. The `OnFailure=` lines need a
`daemon-reload` only, but `deploy.sh` also checks out a new sha and runs `npm ci` in the live tree
under four running paper processes, which is the "two code versions under one recorded sha"
situation the M3 report §7 documents. Options: (a) deploy at the next planned stop of runs
150-153 (the week ends 2026-09-23 12:34 UTC); (b) deploy mid-week and accept that 150-153's later
points come from newer code, recorded in the runs' report; (c) deploy the unit files and the
handler by hand now (they do not touch Node) and the watchdog change at the week's end. The plan
recommends (c): unit-failure alerting and the self-test start protecting the live week within a
day, and the watchdog ping lands with the next sha. Nothing in the tasks assumes which one is
chosen; the drills section of the runbook is written for whichever window is used.

Re-check after Phase 1 design: unchanged. No violation is introduced by the design; the
Complexity Tracking table is empty.

## Project Structure

### Documentation (this feature)

```text
specs/001-vps-alerting/
├── spec.md
├── plan.md              # this file
├── research.md          # Phase 0: ping API contract, design decisions, code map
├── data-model.md        # Phase 1: check, report, alert, maintenance window, unit failure event
├── quickstart.md        # Phase 1: how to prove it works, locally and on the box
├── contracts/
│   ├── cli.md           # watch side effect, `alert`, `maintenance`, the alerting module
│   └── unit-failure-handler.md   # OnFailure= wiring, ctb-alert@.service, the handler, its harness
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks), not created here
```

### Source Code (repository root)

```text
packages/reports/src/
├── alerting.ts          # NEW, pure: buildBody, filterSecrets, classify, evaluateMaintenance,
│                        #   decideReport(checks, maintenance) -> {kind, body}
├── index.ts             # export * from './alerting.js'
packages/reports/test/
├── alerting.test.ts     # NEW: body/filter/classify/maintenance rules from contracts/cli.md
└── purity.guard.test.ts # existing; alerting.ts must pass it (no node:fs, no fetch here)

packages/cli/src/
├── alerting.ts          # NEW, the one I/O: report(baseUrl, kind, body, fetchImpl) with 10 s timeout;
│                        #   readMaintenanceFile/writeMaintenanceFile (node:fs), hostname
├── config.ts            # + CTB_HEALTHCHECK_URL, optional, z.preprocess('' -> undefined), https, no query/trailing slash
├── main.ts              # + case 'alert', case 'maintenance', usage string
└── commands/
    ├── watch.ts         # + after the verdict: decideReport -> report(); log outcome; exit code untouched
    ├── alert.ts         # NEW: `alert test`, `alert send --kind`
    └── maintenance.ts   # NEW: start/end/status
packages/cli/test/
├── alerting.test.ts     # NEW: report() classification with a stubbed fetch (200 'OK (not found)' -> rejected; AbortError -> unreachable; undefined url -> disabled, fetch not called)
├── watchWiring.guard.test.ts        # + asserts watch.ts calls decideReport and report, after verdict, and never assigns exitCode from the result
├── maintenanceGuard.guard.test.ts   # NEW: the window cannot be open by default, cannot exceed 240 min, expiry deletes the file
└── configAlerting.test.ts           # NEW: loadConfig accepts absent/blank/valid, rejects http://, query strings, trailing slash

infra/vps/
├── alert-unit-failure.sh            # NEW handler (contracts/unit-failure-handler.md)
├── test-alert-unit-failure.sh       # NEW harness, same shape as test-rotate-postgres-password.sh
├── deploy.sh                        # + `systemd-analyze verify` over installed units; no UNITS change
└── systemd/
    ├── ctb-alert@.service           # NEW template
    ├── ctb-paper@.service           # + OnFailure=ctb-alert@%n.service in [Unit]
    ├── ctb-collector.service        # + OnFailure=
    └── ctb-backup.service           # + OnFailure=

package.json                         # + "alert", "maintenance" scripts in the existing pattern
.env.example                         # + CTB_HEALTHCHECK_URL= (commented, with the no-trailing-slash note)
docs/ops/RUNBOOK-alerting.md         # NEW: setup in the service (period 15, grace 20), the five drills with expected bounds and a table for observed times, rotation of the URL
docs/ops/RUNBOOK-7day-run.md         # + maintenance start/end around the cutover; pointer to the drills
docs/ops/RUNBOOK-backups.md          # "How you find out it stopped" gains the OnFailure path
```

**Structure Decision**: no new package. `@ctb/reports` is already the shared pure layer consumed
by `cli` and `dashboard`, and its purity guard is exactly the boundary this feature wants: every
decision (what to send, whether maintenance applies, whether a response counts as accepted, what
a body may contain) is a pure function there with the same `Check[]` input the verdict uses. The
single `fetch` sits in `packages/cli/src/alerting.ts` beside `r2.ts` and `backupAge.ts`, the
established home for impure helpers, and is called from `watchCommand` after `verdict()`. The
unit handler is shell on purpose (research R5): it must work when Node, `node_modules` or the
database is the thing that failed.

## Phase 0 and Phase 1 outputs

- `research.md`: R1 ping API contract (verified from the published docs), R2 period/grace,
  R3 one report per cycle after the verdict, R4 maintenance as a file, R5 `OnFailure=` plus a
  shell handler, R6 credential and body filter, R7 `fetch`, R8 three-layer verification, R9 out
  of scope; then the code map with `path:line` facts.
- `data-model.md`: entities, validation, the maintenance state machine, five invariants.
- `contracts/cli.md` and `contracts/unit-failure-handler.md`: the shapes tasks implement against.
- `quickstart.md`: the proof sequence, local then box.

## Risks the tasks must carry

1. **Forking a live run during a drill.** Stopping a paper unit for a full watchdog cycle and
   restarting it more than 120 s later starts a new run (`paper-start.sh`, `resume-target.sql`).
   The P2 drill therefore runs only in a window where runs are stopped anyway (a cutover), or on
   a throwaway strategy instance; until then P2 is proven by `alert send --kind fail` plus the
   unit tests. The runbook says this in bold.
2. **A silently wrong watchdog, again.** f5acb93 is the precedent. The guard tests pin that
   `watch.ts` calls the report after the verdict, that maintenance cannot be open by default or
   forever, and that `alive` is still sent in maintenance. `alert test` is the operator-facing
   proof that the check is running, the same argument that added `--verbose`.
3. **The `200 OK (not found)` trap.** A wrong UUID is a 200. `classify` treats only body `OK` as
   accepted; the stubbed `fetch` in tests returns that exact body.
4. **Secret in a body or a log.** The filter is applied to every body; error paths print host and
   status only; the handler runs `set +x`; the harness's `curl` stub asserts the body never
   contains the URL. A grep of logs and the service's ping log is part of the drill (SC-007).
5. **`OnFailure=` in the wrong section or misspelled never fires.** `systemd-analyze verify` is
   added to `deploy.sh`, and the unit drill on the box proves it end to end.
6. **CI's shellcheck.** No `{n}` quantifiers; every `docker exec` (none needed here) redirects
   stdin; the handler is run under `bash -s`-equivalent conditions by its harness.

## Complexity Tracking

No constitution violations to justify.
