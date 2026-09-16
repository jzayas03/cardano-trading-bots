# Quickstart: proving VPS Alerting works

**Feature**: `specs/001-vps-alerting` | **Date**: 2026-09-16

Three layers, in this order. A layer passing does not excuse the next: the two rotation-script
fixes of 2026-09-16 (#127, #130) both passed a harness and failed on the box. Shapes are in
`contracts/`; entities in `data-model.md`.

## Layer 1 — local, no network, no box

Prerequisites: `nvm use`, `npm ci`, Docker running (for the PG gate and the shell harness).

```bash
npx vitest run packages/reports packages/cli      # inner loop: alerting, config, wiring guards
npm run lint                                       # eslint + typecheck
npm run lint:sh                                    # shellcheck over infra/**/*.sh (CI's older version is stricter: no {n} in regexes)
infra/vps/test-alert-unit-failure.sh               # handler harness in a throwaway container
npm run test:pg                                    # THE gate (constitution IV); alerting adds no PG test but the gate still runs
```

Expected:

- `packages/reports/test/alerting.test.ts`: `classify(200,'OK')` accepted; `classify(200,'OK (not
  found)')` rejected; `AbortError` unreachable; body never contains a known secret; body >8 kB is
  truncated with a final line saying so; `evaluateMaintenance` expired/malformed/over-cap rules.
- `packages/cli/test/alerting.test.ts`: `report(undefined, …)` is `disabled` and the `fetch` stub
  is never called; the stub that returns `200 'OK (not found)'` yields `rejected`.
- `packages/cli/test/watchWiring.guard.test.ts`: `watch.ts` calls `decideReport(` and `report(`
  after `verdict(` and never assigns `process.exitCode` from the report result.
- `packages/cli/test/maintenanceGuard.guard.test.ts`: no code path creates the window without
  `--minutes`; the cap constant is 240; expiry deletes the file.
- harness: six assertions from `contracts/unit-failure-handler.md` print `PASS`.

## Layer 2 — one-time setup in the service (founder, by hand)

1. Create one check named for the box; period **15 min**, grace **20 min**.
2. Add the phone push integration; set reminders to hourly, no quiet hours (FR-017).
3. Copy the ping URL into `/home/ctb/cardano-trading-bots/.env` on the box as
   `CTB_HEALTHCHECK_URL=https://…/<uuid>` — no trailing slash, no query. Do not paste it anywhere
   else. `chmod 600` is already enforced by `deploy.sh`.
4. Record the check's name, period and grace in `docs/ops/RUNBOOK-alerting.md`. Never the URL.

## Layer 3 — on the box, the five drills (recorded in the runbook with observed times)

All as `ctb` from `/home/ctb/cardano-trading-bots` unless stated. Expected bounds are the spec's;
write the observed time next to each in the runbook table.

| # | drill | steps | expected | must not |
|---|---|---|---|---|
| 0 | self-test | `npm run alert -- test` | labelled test entry in the service's ping log within 1 min; exit 0; output shows host and `OK` | print the URL |
| 0b | wrong credential | temporarily set a wrong UUID in a copy of `.env` and run the self-test against it (`env CTB_HEALTHCHECK_URL=… npm run alert -- test`) | exit 1 within 1 min; message says `OK (not found)` | leave the wrong value in `.env` |
| 1 | silence (P1) | as root: `systemctl stop ctb-watch.timer`; wait | push alert "down" at 35 min ± the service's scheduler tick; then `systemctl start ctb-watch.timer` → "up" within one cycle | stop anything else |
| 2 | failure (P2) | **only in a window where paper runs are already stopped** (a cutover), because a unit stopped for a cycle and restarted after 120 s forks its run: stop one paper unit, wait one cycle | push alert within 15 min whose text contains the failing check line; restart → recovery next cycle | run this on a live measurement week; until then use `npm run alert -- send --kind fail --body 'drill'` and cite the unit tests |
| 3 | unit failure (P3) | as root: `systemctl start ctb-paper@no-such-strategy` (a throwaway instance; `paper-start.sh` exits non-zero, `StartLimitBurst=5` trips in ≤ 5 min) | push alert naming `ctb-paper@no-such-strategy.service`, `start-limit-hit`, within 2 min of the fifth failure; `journalctl -u ctb-alert@…` shows one handler run | create a run row (a bad strategy never reaches `createRun`; verify with `SELECT count(*) FROM runs WHERE status='running'` unchanged) |
| 3b | backup failure | as root: `systemctl start ctb-backup` with R2 credentials temporarily unreadable in a copy of the env (or `scripts/scheduled-backup.sh` invoked with a bogus `R2_BUCKET`) | push alert naming `ctb-backup.service` within 2 min | touch the real `.env` |
| 4 | maintenance (P4) | `npm run maintenance -- start --minutes 45 --reason "drill"`; then repeat drill 3 | no push; the service's log shows a `/log` entry with the reason; `npm run maintenance -- end` → "maintenance ended" log entry; repeat drill 3 → push | suppress liveness: `alive` entries keep arriving every 15 min throughout |
| 4b | expiry | `maintenance start --minutes 1`; wait one cycle | the watchdog logs "maintenance ended (expired)" and the file is gone | leave a window open |
| 5 | memory (SC-008) | `free -m` before deploy and 30 min after, same four paper runs + collector | available within 20 MB | — |
| 6 | secrets (SC-007) | `grep -rl "$(grep '^CTB_HEALTHCHECK_URL=' .env \| cut -d= -f2- \| cut -c1-40)" /home/ctb/logs /home/ctb/cardano-trading-bots --exclude-dir=node_modules --exclude=.env` as ctb; review the service's ping-log bodies | no hits; bodies show unit names, run ids, ages, counts only | paste the URL into chat |

Deployment order (see plan.md, the founder's decision on timing): unit files + handler +
`daemon-reload` can go first and protect the live week (drills 0, 3, 3b, 4, 6); the watchdog
change lands with the next sha (drills 1, 2, 4b, 5).

## Done when

- Layer 1 green: `test:pg`, `lint`, `lint:sh`, harness.
- Layer 2 recorded in `RUNBOOK-alerting.md` without the URL.
- Layer 3: every drill row has an observed time, and drill 2 is either done in a stopped window
  or explicitly deferred to the next cutover in the runbook.
- SC-009 read back: a stopped paper run now pages within one watchdog period; the 2026-09-16
  eleven-hour gap could not recur unnoticed.
