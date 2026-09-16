---
description: "Task list for VPS Alerting — dead-man's switch and failure notifications"
---

# Tasks: VPS Alerting — dead-man's switch and failure notifications

**Input**: Design documents from `/specs/001-vps-alerting/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/cli.md,
contracts/unit-failure-handler.md, quickstart.md

**Tests**: Requested. TDD order everywhere: the test task precedes the implementation task and
must be seen to FAIL before the implementation is written. Guard tests (source-text pins in the
style of `packages/cli/test/watchWiring.guard.test.ts`) count as tests.

**Organization**: by user story. Phases 1-2 are shared; phases 3-7 are the five stories in
priority order; phase 8 is the founder's deploy decision and the deploys; phase 9 is the drills
on the real box, which every story's "done" depends on; phase 10 is polish and the gate.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: US1 silence · US2 failing check · US3 unit failure · US4 maintenance · US5 self-test and drills
- Every path is repository-relative. "Green" means the named command exits 0 with output shown.

## Standing constraints (apply to every task)

- `@ctb/reports` stays pure: `packages/reports/test/purity.guard.test.ts` must keep passing; no
  `node:fs`, no `fetch`, no process access under `packages/reports/src/`.
- The only `fetch` is in `packages/cli/src/alerting.ts`.
- Shell passes CI's shellcheck (older than local 0.11): no `{n}` brace quantifiers in regexes;
  every script survives `bash -s` (no bare `docker exec -i`, none are needed here).
- Never print, log, commit or paste `CTB_HEALTHCHECK_URL` or any `.env` value. Error paths carry
  host and status only.
- Warnings never become failures; `watch`'s `process.exitCode` logic is untouched (f5acb93).
- Nothing is "implemented" until `npm run test:pg`, `npm run lint` and `npm run lint:sh` are green
  and the output is shown. Citing `npm test` alone is citing the wrong suite (constitution IV).
- A box drill must not fork a live paper run: a unit stopped for a watchdog cycle and restarted
  after 120 s starts a new run. Drills that stop a real paper unit run only in a stopped window.

---

## Phase 1: Setup (shared)

**Purpose**: the config key, the scripts, and the example env, so every later task has a place to plug in.

- [X] T001 Write `packages/cli/test/configAlerting.test.ts`: `loadConfig` accepts `CTB_HEALTHCHECK_URL` absent (→ `undefined`), blank `''` (→ `undefined`, the dotenv `KEY=` case), and `https://example.test/abc` (→ same string); rejects `http://…` (message names the key), a query string `?x=1`, and a trailing `/`. Run `npx vitest run packages/cli/test/configAlerting.test.ts` and show it FAIL.
- [X] T002 Add `CTB_HEALTHCHECK_URL` to `packages/cli/src/config.ts`: the `z.preprocess((v) => (v === '' ? undefined : v), z.string().optional())` idiom at `config.ts:45`, then `.refine` for `https://`, no `?`, no trailing `/`; add `healthcheckUrl?: string` to the `Config` interface (`config.ts:7-27`) and map it in the return object (`config.ts:161-175`). T001 green.
- [X] T003 [P] Add `"alert": "tsx packages/cli/src/main.ts alert"` and `"maintenance": "tsx packages/cli/src/main.ts maintenance"` to the root `package.json` scripts, in the existing pattern beside `"watch"`.
- [X] T004 [P] Add a commented `# CTB_HEALTHCHECK_URL=https://<service>/<uuid>   (no trailing slash, no query; absent = alerting off)` line to `.env.example`.

---

## Phase 2: Foundational (blocking)

**Purpose**: the pure decision module and the one I/O function every story uses.

**⚠️ CRITICAL**: no story phase starts until T005-T012 are green.

- [X] T005 Write `packages/reports/test/alerting.test.ts` from contracts/cli.md "Rules the tests pin": `classify(200,'OK',null)` → `accepted`; `classify(200,'OK (not found)',null)` → `rejected`; `classify(200,'OK (rate limited)',null)` → `rejected`; `classify(400,'invalid url format',null)` → `rejected`; `classify(null,null,abortError)` → `unreachable`; `filterSecrets(body, ['s3cr3t'])` replaces the WHOLE body with `[redacted: body failed the secret filter]` and returns `redacted: true` when `'s3cr3t'` appears anywhere, also for a `postgres://u:p@h/db` URL and a 39-char alphanumeric token; `buildBody(checks, verdictLine, null)` equals the `STATUS: name — detail` lines for every non-OK check followed by the verdict line, with `doctor:` replaced by `watch:`; a body over 8 kB is truncated and ends with a line `[truncated to 8 kB]`; `evaluateMaintenance` returns `null` for `null` text, `null` for malformed JSON, `null` when `until` is more than 240 min after `now`, `{ expired: true, reason }` when `until < now`, and `{ until, reason, declaredAt }` when active; `decideReport(checks, verdictLine, null)` → `{ kind: 'alive' }` when no FAIL (including WARN-only), `{ kind: 'fail' }` when any FAIL; `decideReport(checks-with-FAIL, verdictLine, activeMaintenance)` → `{ kind: 'alive' }` with body prefixed `[maintenance: <reason> until <until>]`. Run it; show FAIL.
- [X] T006 Implement `packages/reports/src/alerting.ts` with exactly those pure exports (`ReportKind`, `ReportOutcome`, `MaintenanceState`, `buildBody`, `filterSecrets`, `classify`, `evaluateMaintenance`, `decideReport`); constants `MAX_BODY_BYTES = 8 * 1024`, `MAX_MAINTENANCE_MINUTES = 240`. No imports from `node:*`. T005 green.
- [X] T007 Export the module from `packages/reports/src/index.ts` (`export * from './alerting.js';` beside the `watch.js` line) and run `npx vitest run packages/reports/test/purity.guard.test.ts` green.
- [X] T008 Write `packages/cli/test/alerting.test.ts` for `report(baseUrl, kind, body, fetchImpl)`: `report(undefined, 'alive', '')` → `{ outcome: 'disabled' }` and the `fetch` stub is never called; stub returning `Response(200, 'OK')` → `accepted` with `host` set and no `path` property anywhere in the result; stub returning `Response(200, 'OK (not found)')` → `rejected` with `responseBody` `'OK (not found)'`; stub that throws `DOMException('…','AbortError')` → `unreachable`; kind `'fail'` POSTs to `<base>/fail`, kind `'log'` to `<base>/log`, numeric kind `3` to `<base>/3`, `'alive'` to `<base>` exactly; the request is `POST` with the body as text and a `signal`; `report` never throws (stub throwing a plain `Error` → `unreachable`). Show FAIL.
- [X] T009 Implement `packages/cli/src/alerting.ts`: `report()` per contracts/cli.md using global `fetch` with `AbortSignal.timeout(10_000)`, `classify` from `@ctb/reports`; plus `readMaintenanceFile(path)` / `writeMaintenanceFile(path, state)` / `deleteMaintenanceFile(path)` over `node:fs` with mode `0o600`, and `MAINTENANCE_PATH = join(homedir(), 'ctb-maintenance.json')`. T008 green.
- [X] T010 [P] Write `packages/cli/test/maintenanceGuard.guard.test.ts` (source-text pin over `packages/cli/src/commands/maintenance.ts` and `packages/cli/src/alerting.ts`): asserts the string `MAX_MAINTENANCE_MINUTES` is used in the `start` path; asserts no default value for `--minutes`; asserts `deleteMaintenanceFile(` appears in both the `end` path and the expiry path of `watch.ts`; control test that the files exist and exceed 500 chars. (Fails until T028/T030.)
- [X] T011 [P] Extend `packages/cli/test/watchWiring.guard.test.ts`: assert `watch.ts` contains `decideReport(` and `report(`, that both appear AFTER `verdict(checks)` by index, and that no line assigns `process.exitCode` from an identifier named `result`/`outcome`/`reportResult`. (Fails until T014.)
- [X] T012 Run `npx vitest run packages/reports packages/cli` and `npm run lint`; show T005-T009 green, T010-T011 red as expected.

**Checkpoint**: pure module and `report()` exist and are tested; nothing calls them yet.

---

## Phase 3: User Story 1 — the box goes silent and the founder finds out (P1) 🎯 MVP

**Goal**: every healthy watchdog cycle sends `alive`; the service pages at 35 minutes of silence.

**Independent Test**: on the box, stop `ctb-watch.timer`; a "down" push arrives within 35 min; start it; "up" arrives within one cycle (T059).

- [X] T013 [US1] Write the test half of `packages/cli/test/watchWiring.guard.test.ts` additions from T011 if not already, plus a new assertion that `watch.ts` reads `cfg.healthcheckUrl` and passes it to `report(`. Show FAIL.
- [X] T014 [US1] Modify `packages/cli/src/commands/watch.ts`: after the existing verdict/print block, `const maint = evaluateMaintenance(readMaintenanceFile(MAINTENANCE_PATH), new Date())`; if `maint` is `{expired}`, delete the file and `await report(cfg.healthcheckUrl, 'log', 'maintenance ended (expired): ' + reason)`; then `const { kind, body } = decideReport(checks, v.line, activeMaint)`; `const r = await report(cfg.healthcheckUrl, kind, body)`; `log.info({ kind, outcome: r.outcome, status: r.status, host: r.host }, 'healthcheck report')`. The exit-code lines are not moved or changed. T011/T013 green; `npx vitest run packages/cli` green.
- [X] T015 [P] [US1] Create `docs/ops/RUNBOOK-alerting.md` with sections: "What it is" (one paragraph, the dead-man's switch off the box), "Setup in the service" (one check named for the host, period 15 min, grace 20 min, push integration, hourly reminders, no quiet hours; the URL goes into `.env` as `CTB_HEALTHCHECK_URL` with no trailing slash and nowhere else), "What each report means" (alive / fail / log / exit-status), "Rotating the URL" (edit `.env`, run `npm run alert -- test`), and an empty "Drills" table with columns drill · expected · observed (date, time) · notes, rows 0, 0b, 1, 2, 3, 3b, 4, 4b, 5, 6 from quickstart.md.

**Checkpoint**: with the URL set, a watchdog cycle sends `alive`; without it, `watch` is unchanged.

---

## Phase 4: User Story 2 — a check fails and the alert says which one (P2)

**Goal**: a cycle with a FAIL sends `/fail` with the verdict lines; the founder reads the failing check on the phone; recovery follows the next healthy cycle.

**Independent Test**: in a stopped window, stop one paper unit and wait one cycle; the push text contains the failing check line (T060). Until such a window: `npm run alert -- send --kind fail --body 'drill'` plus T005's `decideReport` cases.

- [X] T016 [US2] Add to `packages/reports/test/alerting.test.ts`: `decideReport` with one FAIL and two WARN returns kind `fail` and a body that contains all three `STATUS:` lines and the `watch: 1 FAIL (…)` verdict line; with WARN only returns `alive` and the body still contains the WARN lines (FR-005). Show FAIL if any case is new, else confirm covered.
- [X] T017 [US2] Adjust `packages/reports/src/alerting.ts` if T016 exposed a gap; T016 green.
- [X] T018 [US2] Write `packages/cli/test/alertCommand.test.ts`: `alert send --kind fail --body 'x'` calls `report` with `('fail', 'x')` and exits 0 on `accepted`, 1 on `rejected` (message contains the status and the response body, never the URL path), 2 when `cfg.healthcheckUrl` is unset with message `CTB_HEALTHCHECK_URL is not set; alerting is off`; `--kind` other than `alive|fail|log` exits 2 with usage. Inject `report` via a parameter or module mock. Show FAIL.
- [X] T019 [US2] Implement `packages/cli/src/commands/alert.ts` (`alertCommand(log, args, deps)`) covering `send`; register `case 'alert': return alertCommand(log, rest);` in `packages/cli/src/main.ts` and add `alert test | alert send --kind alive|fail|log [--body <text>]` to the usage string (`main.ts:67-77`). T018 green.
- [X] T020 [US2] Add to `docs/ops/RUNBOOK-alerting.md` "Drills" the bold warning for drill 2: "Only in a window where the paper runs are already stopped. A unit stopped for one cycle and restarted after 120 s forks its run (`infra/vps/paper-start.sh`, `infra/vps/resume-target.sql`). Otherwise prove the pipe with `npm run alert -- send --kind fail --body drill` and record 'deferred to the next stopped window'."

**Checkpoint**: failing cycles page with the verdict; the pipe is provable without touching a live run.

---

## Phase 5: User Story 3 — a unit dies and the alert is immediate (P3)

**Goal**: `ctb-paper@*`, `ctb-collector`, `ctb-backup` alert within two minutes of entering `failed`, via one template unit and a shell handler that needs neither Node nor the database.

**Independent Test**: on the box, `systemctl start ctb-paper@no-such-strategy`; a push naming the unit and `start-limit-hit` arrives within 2 min of the fifth failure; no run row is created (T061).

- [X] T021 [US3] Write `infra/vps/test-alert-unit-failure.sh` per contracts/unit-failure-handler.md "Harness": throwaway container, stubs for `systemctl` (answers `show -p Result -p ExecMainStatus -p NRestarts <unit>` from env vars `STUB_RESULT`/`STUB_STATUS`/`STUB_NRESTARTS`), `systemd-escape --unescape`, `hostname`, and `curl` (records URL suffix after the base and the `--data-binary` body to `/stub/calls`, returns `200` and prints `OK`, or simulates a network error when `STUB_CURL_FAIL=1`); fake `.env` with `CTB_HEALTHCHECK_URL=https://example.test/ping/abc` (placeholder, not a real check); the six assertions (suffix `/1` for `start-limit-hit`/`1`; `/log` with an active maintenance file and the reason in the body; `/fail` when status is `0`; no curl call and exit 0 without the key; body never contains `example.test`; exit 0 on curl failure). Run it: it must FAIL because the handler does not exist yet.
- [X] T022 [US3] Implement `infra/vps/alert-unit-failure.sh` per the contract's nine steps: `set -euo pipefail; set +x`; unescape `$1`; `systemctl show`; read the URL with `grep '^CTB_HEALTHCHECK_URL=' .env | cut -d= -f2-` into a variable that is never echoed; read `~/ctb-maintenance.json` and compare `until` to `date -u +%s` using `date -d` (GNU) without brace quantifiers in any regex; body lines `hostname, ISO time, unit, result, exit, restarts[, maintenance]`; `curl -fsS -m 10 --retry 2 --retry-delay 5 -X POST --data-binary "$BODY" "$URL$SUFFIX" -o "$TMP" -w '%{http_code}'` with `TMP=$(mktemp)` unlinked after; one log line `unit result/status -> suffix: http <code> <first 40 chars>`; `exit 0` on every path. `chmod +x`. T021 green. `npm run lint:sh` green.
- [X] T023 [P] [US3] Add `infra/vps/systemd/ctb-alert@.service` exactly as in contracts/unit-failure-handler.md (oneshot, `User=ctb`, `WorkingDirectory=/home/ctb/cardano-trading-bots`, `ExecStart=… alert-unit-failure.sh %i`, logs to `/home/ctb/logs/alert.log`, `TimeoutStartSec=30`, comment "No OnFailure here: an alert handler that alerts about itself loops").
- [X] T024 [P] [US3] Add `OnFailure=ctb-alert@%n.service` under `[Unit]` (not `[Service]`; see the `StartLimit*` comment in the same files) in `infra/vps/systemd/ctb-paper@.service`, `infra/vps/systemd/ctb-collector.service`, `infra/vps/systemd/ctb-backup.service`, each with a one-line comment pointing at `docs/ops/RUNBOOK-alerting.md`.
- [X] T025 [US3] Add to `infra/vps/deploy.sh`, after `systemctl daemon-reload` in the "systemd units" block (`deploy.sh:116-127`): `systemd-analyze verify /etc/systemd/system/ctb-*.service /etc/systemd/system/ctb-*.timer || die "systemd unit verification failed; a bad OnFailure= would never fire"`. Do NOT add `ctb-alert@.service` to `UNITS` (a template is never enabled). `npm run lint:sh` green. Verify locally with `systemd-analyze verify` unavailable on macOS: instead run `infra/vps/test-alert-unit-failure.sh` and, in the harness container (Debian has systemd-analyze in the `systemd` package), `systemd-analyze verify` over `infra/vps/systemd/*` — add that as a seventh harness step.
- [X] T026 [P] [US3] Update `docs/ops/RUNBOOK-backups.md` "How you find out it stopped" (:46-52): the `OnFailure=` path now pages within two minutes of `scheduled-backup.sh` exiting non-zero; the 26 h / 48 h watchdog checks remain the backstop.

**Checkpoint**: harness green, units verify, deploy script refuses a broken unit.

---

## Phase 6: User Story 4 — planned maintenance does not page anyone (P4)

**Goal**: `maintenance start|end|status`; failures become logged `alive`, unit failures become `/log`, liveness never suppressed, window expires by itself, cap 240 minutes.

**Independent Test**: on the box, declare maintenance, run drill 3: no push, a `/log` entry with the reason; `maintenance end`; drill 3 again: push (T062).

- [X] T027 [US4] Write `packages/cli/test/maintenanceCommand.test.ts`: `start --minutes 45 --reason drill` writes the file with `until = now + 45 min`, `reason`, `declaredAt`, mode `0o600`, sends `log` with `maintenance started until <ISO> (45 min): drill`; `start --minutes 241` exits 2 without writing; `start` with empty reason exits 2; `start` while a window is active exits 1 with "use `maintenance end` first"; `end` deletes the file and sends `log` `maintenance ended (manual): drill`; `end` with no file exits 0 with a note; `status` prints `active until … (n min left): drill` or `no maintenance window` and never calls `report`; with `cfg.healthcheckUrl` unset, `start`/`end` still write/delete the file and print, and `report` returns `disabled`. Use a temp dir for the path and inject `report`. Show FAIL.
- [X] T028 [US4] Implement `packages/cli/src/commands/maintenance.ts` (`maintenanceCommand(log, args, deps)`) using `MAX_MAINTENANCE_MINUTES` and the file helpers from T009; register `case 'maintenance'` in `packages/cli/src/main.ts` and add `maintenance start --minutes <1..240> --reason "<text>" | maintenance end | maintenance status` to the usage string. T027 green.
- [X] T029 [US4] Add to `packages/cli/test/alertCommand.test.ts` / T018 stubs nothing new; instead add to `packages/reports/test/alerting.test.ts` the invariant test: for every `checks` fixture (OK, WARN-only, one FAIL, all FAIL) and an active maintenance, `decideReport(...).kind === 'alive'` and the body starts with `[maintenance:` (FR-010 by construction: liveness is never suppressed). Show green or fix in `packages/reports/src/alerting.ts`.
- [X] T030 [US4] Confirm `watch.ts` (T014) handles expiry: `evaluateMaintenance` → `{expired}` deletes the file and sends the `log` line before the cycle's own report; T010's guard is now green. Run `npx vitest run packages/cli/test/maintenanceGuard.guard.test.ts` and show it.
- [X] T031 [P] [US4] Add to `docs/ops/RUNBOOK-7day-run.md` "The cutover, in order": step 0 `npm run maintenance -- start --minutes 180 --reason "M<N> cutover"` before the before-stop gate, and a final step `npm run maintenance -- end` after the new runs are up; plus the sentence "maintenance suppresses failure pages, never the dead-man's switch: if the box goes silent mid-cutover you will still be paged".

**Checkpoint**: maintenance is declarable, bounded, expiring, and provably never silences liveness.

---

## Phase 7: User Story 5 — the founder can prove it works, on demand (P5)

**Goal**: `alert test` sends a labelled `log` report and exits 0 only on `accepted`, printing host and response body; the runbook's drill table is complete.

**Independent Test**: on the box, `npm run alert -- test` → a labelled entry in the service's ping log within 1 min and exit 0; with a wrong UUID → exit 1 naming `OK (not found)` (T057, T058).

- [X] T032 [US5] Extend `packages/cli/test/alertCommand.test.ts`: `alert test` sends kind `log` with body matching `/^TEST from \S+ at \d{4}-\d{2}-\d{2}T/`; prints `accepted (http 200 OK) host=<host>` on success and exits 0; on `rejected` prints `rejected (http 200 "OK (not found)") host=<host>` and exits 1; on `unreachable` prints `unreachable host=<host>: <reason>` and exits 1; never prints the path. Show FAIL.
- [X] T033 [US5] Implement `test` in `packages/cli/src/commands/alert.ts`. T032 green.
- [X] T034 [P] [US5] Complete the "Drills" section of `docs/ops/RUNBOOK-alerting.md` with the exact commands and expected bounds for rows 0, 0b, 1, 2, 3, 3b, 4, 4b, 5, 6 from quickstart.md, the deployment-order note (unit files + handler first, watchdog ping with the next sha), and the SC-009 read-back sentence.

**Checkpoint**: everything is testable from the box with one command; the drill table awaits observed times.

---

## Phase 8: Deploy — the founder's decision, then the two deploys

**Purpose**: the constitution's "stop and ask before deploying while a measurement run is in flight". Runs 150-153 started 2026-09-16 12:34 UTC; the week ends 2026-09-23 12:34 UTC.

- [X] T035 **STOP AND ASK THE FOUNDER**: present the three options from plan.md ("Constitution Check": (a) deploy everything at the next planned stop of 150-153; (b) deploy mid-week and record in the runs' report that later points came from a newer sha; (c) recommended: deploy the unit files, the template unit, the handler and `systemd-analyze verify` now — no Node, no `npm ci`, no checkout of the live tree, `daemon-reload` only — and the watchdog/CLI changes with the next sha). Do not proceed to T036 or T038 without an explicit answer. Record the answer and time in `docs/ops/RUNBOOK-alerting.md` under "Deployment history". **Answered 2026-09-16 ~16:50 UTC: option (c), handler outside the checkout at `/usr/local/lib/ctb/alert-unit-failure.sh`.**
- [X] T036 [option (c), chosen] Hand-deploy the shell half as root, without `deploy.sh`, from the MERGED sha of PR #135 (state it): `scp` `infra/vps/alert-unit-failure.sh` and `infra/vps/systemd/{ctb-alert@.service,ctb-paper@.service,ctb-collector.service,ctb-backup.service}` to a staging dir on the box, `diff` each unit against the live copy and show the diff, `install -D -m 755 -o root -g root` the handler to `/usr/local/lib/ctb/alert-unit-failure.sh` (OUTSIDE the checkout, so `git status` in the live tree stays clean for the cutover gate), `install -m 644` the four units to `/etc/systemd/system/`, `systemctl daemon-reload`, `systemd-analyze verify /etc/systemd/system/ctb-*`, and `systemctl show -p OnFailure ctb-paper@ma-crossover ctb-collector ctb-backup` showing `ctb-alert@%n.service`. Do NOT restart any paper unit. Confirm `git -C /home/ctb/cardano-trading-bots status --porcelain` is empty afterwards.
- [X] T037 [if (c) or (b)] Add `CTB_HEALTHCHECK_URL` to the box's `.env` (founder, by hand; never through an agent session) and run T057 (self-test) as the first proof that the URL works; the watchdog ping is not yet deployed, so create the check in the service in a paused state or with a long grace until T038, and record that in the runbook.
- [ ] T038 [when the founder's chosen window arrives] Deploy the merged sha with `ssh root@<ip> 'bash -s' -- --sha <sha> --no-start < infra/vps/deploy.sh` per the cutover runbook (gates before and after), then set the check's grace to 20 min, then run T057 again. This is the deploy that turns on the watchdog ping.

---

## Phase 9: Drills on the real box (recorded)

**Purpose**: FR-016 and SC-001..SC-009. Every row is done when the observed time is written in
`docs/ops/RUNBOOK-alerting.md` "Drills". Pre-T038, only rows marked † are possible.

- [ ] T057 [US5] Drill 0, self-test: `npm run alert -- test` as ctb; expect a labelled entry in the service's ping log within 1 min, exit 0, output shows host and `OK`. Record.
- [ ] T058 [US5] Drill 0b, wrong credential: `env CTB_HEALTHCHECK_URL=https://<same host>/<zeros-uuid> npm run alert -- test`; expect exit 1 within 1 min, message contains `OK (not found)`. Confirm `.env` untouched. Record.
- [ ] T059 [US1] Drill 1, silence: as root `systemctl stop ctb-watch.timer`; expect the "down" push at 35 min (± the service's scheduler tick); `systemctl start ctb-watch.timer`; expect "up" within one cycle. Record both times.
- [ ] T060 [US2] Drill 2, failing check: ONLY in a stopped window (a cutover) — stop one paper unit, wait one cycle, expect a push whose text contains the failing check line within 15 min; restart, expect recovery next cycle. If no stopped window exists before the feature is declared done, run `npm run alert -- send --kind fail --body 'drill 2 deferred'` and record "deferred to the next stopped window" with the date. Never on a live run.
- [ ] T061 † [US3] Drill 3, unit failure: as root `systemctl start ctb-paper@no-such-strategy`; expect five failures within ~5 min then `start-limit-hit`, a push naming `ctb-paper@no-such-strategy.service` within 2 min of the fifth failure, `journalctl -u 'ctb-alert@*' --since -10min` showing one handler run, and `SELECT count(*) FROM runs WHERE status='running'` unchanged (4). `systemctl reset-failed ctb-paper@no-such-strategy` afterwards. Record.
- [ ] T062 [US4] Drill 4, maintenance: `npm run maintenance -- start --minutes 45 --reason drill`; repeat T061 → no push, a `/log` entry with the reason; `npm run maintenance -- end` → "maintenance ended (manual)" entry; repeat T061 → push. Record. (Liveness entries continue only after T038; note it.)
- [ ] T063 [US4] Drill 4b, expiry: `npm run maintenance -- start --minutes 1 --reason expiry`; wait one watchdog cycle; expect `watch.log` "maintenance ended (expired)" and the file gone. Record.
- [ ] T064 † [US3] Drill 3b, backup failure: as root, `systemd-run --unit=ctb-backup-drill -p User=ctb -p WorkingDirectory=/home/ctb/cardano-trading-bots -p OnFailure=ctb-alert@ctb-backup-drill.service env R2_BUCKET=does-not-exist scripts/scheduled-backup.sh` (a transient unit with the same hook, so the real `.env` is untouched); expect a push naming `ctb-backup-drill.service` within 2 min. Record. If `systemd-run` property syntax differs on the box's systemd version, adjust and record the exact command.
- [ ] T065 [US5] Drill 5, memory: `free -m` before T036/T038 and 30 min after each, same four paper runs and collector; expect "available" within 20 MB. Record all numbers.
- [X] T066 † [US5] Drill 6, secrets: as ctb, `grep -rl "$(grep '^CTB_HEALTHCHECK_URL=' .env | cut -d= -f2- | cut -c1-40)" /home/ctb/logs /home/ctb/cardano-trading-bots --exclude-dir=node_modules --exclude=.env`; expect no hits; review the service's ping-log bodies for anything beyond unit names, run ids, ages, counts, timestamps. Record "no hits" with the date. Never paste the value. **Done 2026-09-16 17:25Z: no hits outside `.env`; `alert.log` lines carry unit name, result, exit, restarts, suffix and HTTP code only.**

---

## Phase 10: Polish and the gate

- [X] T067 Run `npm run lint`, `npm run lint:sh`, `npm test`, `npm run test:pg`, and `infra/vps/test-alert-unit-failure.sh`; paste the tail of each into the PR description. All green or the feature is not implemented. **Green on `main` 2026-09-16: lint (eslint+tsc) clean; `npm test` 1038 passed / 69 skipped; `npm run test:pg` 1105 passed / 2 skipped; `lint:sh` clean; handler harness PASS 7/7.**
- [X] T068 [P] Add a "SC-009 read-back" paragraph to `docs/ops/RUNBOOK-alerting.md`: a stopped paper run now pages within one watchdog period; the 2026-09-16 eleven-hour gap could not recur unnoticed, with the drill rows that prove it. **Already written when the runbook was created; verified present.**
- [X] T069 [P] Add `docs/ops/RUNBOOK-alerting.md` to the "Runbooks" list in `README.md` if such a list exists (check first; if not, skip and say so).
- [X] T070 Open the PR(s): one PR per intention — (1) the reports module + CLI + tests + docs; (2) the shell handler, harness, units and `deploy.sh` change. Each PR body: Implemented / Risks / Controls / Tests (with output) / Follow-ups, ending with the attribution line. Never stacked; both off `main`. **Done: #135/#136/#137/#139 (shell) and #138 (TypeScript), all merged.**

---

## Dependencies & Execution Order

### Phase dependencies

- Phase 1 → Phase 2 → (Phases 3, 4, 6, 7 in any order; Phase 5 independent of 3/4/6/7 except T031's runbook edit) → Phase 8 (founder gate) → Phase 9 → Phase 10.
- Phase 5 (shell) touches no TypeScript and can be built and harness-tested in parallel with Phases 3-4 by a second worker.
- Phase 8 T035 blocks every deploy and therefore every non-† drill. † drills need only T036+T037.

### Story dependencies

- US1 needs T014 (watch side effect) and T038 (deployed with a sha).
- US2 needs US1's `decideReport` fail branch (Phase 2) and `alert send` (T019); its box drill needs a stopped window.
- US3 is independent of the TypeScript side entirely; needs T036.
- US4 needs Phase 2 helpers, T028, T014's expiry branch; its box drill needs T036 (for the handler's maintenance branch) and T038 (for the watchdog's).
- US5 needs T019/T033; its drills 0/0b need only T037.

### Parallel opportunities

- T003, T004 with T001/T002.
- T010, T011 with T005-T009 (they are red until later; writing them early is the point).
- T015, T020, T026, T031, T034 (docs) with any code task.
- Phase 5 (T021-T026) with Phases 3-4 and 6-7.
- Drills T057, T058, T061, T062, T064, T066 after T036/T037, before T038.

---

## Parallel Example: after Phase 2

```bash
# Worker A (TypeScript): T013 → T014 → T018 → T019 → T027 → T028 → T032 → T033
# Worker B (shell):      T021 → T022 → T023 → T024 → T025 → T026
# Worker C (docs):       T015 → T020 → T031 → T034
```

---

## Implementation Strategy

### MVP first (User Story 1)

1. Phase 1, Phase 2.
2. T013-T015: `watch` sends `alive`; the service pages on silence.
3. T035 founder decision; T038 at the chosen window; T057, T059 recorded.
4. **STOP and validate**: SC-001 holds. This alone closes the 2026-09-16 gap.

### Incremental delivery

- Add US3 (shell half) next: it can go live before the watchdog change (option (c)) and protects the current week within a day.
- Then US2 and US4 with the same sha as US1; US5 rides along.
- Each story's drill row is its acceptance; a story without an observed time is not done.

---

## Notes

- `[P]` = different files, no dependency on an unfinished task.
- Every test task is run and shown red before its implementation task; every implementation task is shown green.
- Commit after each task or logical group; never on `main`.
- Task IDs jump from T038 to T057 on purpose: T039-T056 are reserved for founder-requested additions during implementation so drill numbering (T057+) stays stable in the runbook.
