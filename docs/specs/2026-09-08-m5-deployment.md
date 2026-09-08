# M5: off the laptop

Date: 2026-09-08. Status: draft design, pre-implementation.
Builds on: `docs/specs/2026-09-05-paper-trading-foundation.md` (M0-M3),
`docs/specs/2026-09-07-m4-dashboard.md` (M4).

## 1. Purpose

Run the collector and the paper loop unattended on a machine that is not the
founder's laptop, so that closing a lid, a reboot, or a power cut stops being a
data-loss event.

Success means: the collector and every paper run survive a reboot without a
human, the operator can see their state from a browser, and the database is
backed up somewhere that is not the same disk.

This milestone also decides where a **hot wallet** will eventually live. It does
not put one there.

## 2. Why now

Two facts from the first week of operation force it.

**`caffeinate -is` does not survive a closed lid.** The M1 run lost roughly 17
of 125 ticks overnight to a suspended machine, and the run that was supposed to
demonstrate 24 continuous hours managed 20.8. Every subsequent measurement
carries that asterisk.

**Nothing restarts.** A reboot ends the collector and all three paper runs at
once, and each needs a hand-typed resume. The crash-recovery drill exists
because this is expected, not hypothetical.

## 3. Decisions already made

- **Not on czi-middleware's infrastructure, and not in its AWS account.** A
  trading bot must not share a blast radius, an account boundary, or an audit
  surface with a HIPAA product. This is a founder decision and is not open for
  engineering convenience.
- **Cutover happens after the 7-day paper run ends**, not during. Runs 137, 138
  and 139 started 2026-09-08 00:50 UTC on this laptop; migrating mid-run ends
  the week. M5 is built in parallel and cut over on a clean boundary.
- **Design for a hot wallet, do not install one.** Retrofitting isolation onto a
  casually configured box is how keys are lost. The host is built as though it
  will hold trading keys; the keys themselves are a later milestone with its own
  spec.
- **One machine, not a cluster.** The measured footprint is 67 MB of database
  growing ~1.4 MB/day, and 216 MB resident across all four node processes.

## 4. Boundaries

- No live execution, no wallet, no signing, no key material. Out of scope here
  and gated behind its own spec.
- No change to strategy code, the fill model, or the collector's behaviour. M5
  moves where code runs, never what it computes. A week's equity curve must
  still come from one git sha.
- No public exposure of the dashboard. It binds 127.0.0.1 today and continues
  to; remote access is over an SSH tunnel, not a public port.
- No secrets in the repo, in images, or in shell history. The Blockfrost key
  today, wallet keys later, both from the same mechanism.

## 5. What has to run

| Component | Today | On the host |
|---|---|---|
| Postgres 16 | Docker on the laptop | same, with a real data volume |
| `collect` | `nohup caffeinate npm run collect` | supervised service, restarts on failure and on boot |
| `paper` (one per strategy) | three `nohup` processes | supervised, one unit per run |
| dashboard | started by hand | supervised, still 127.0.0.1 only |
| backups | **none** | scheduled dump to storage that is not this disk |

The `backups: none` row is the one that matters. The database now holds the only
copy of observed pool reserves that cannot be re-fetched — Blockfrost serves the
present, not the past. A week of paper results and every candle behind them
currently lives on one laptop SSD with no second copy.

## 6. Supervision and restart

Every process is supervised so that a reboot restores the system without a
human. The collector restarts cleanly on its own; **paper runs do not** — a
crashed run needs `--resume <id>` against a specific run row, which a naive
`Restart=always` cannot supply.

So supervision has two shapes:
- The collector and the dashboard restart unconditionally.
- Each paper run is supervised by a wrapper that reads its run id, checks the
  run's status and heartbeat, and resumes rather than starting a new run. The
  refusal path proven in the day-2 drill — a fresh heartbeat rejects a resume —
  is what makes this safe to automate.

## 7. Secrets

One mechanism, used from the start, for the Blockfrost key and later for wallet
keys: readable only by the service account, never in the repo, never in an
image, never printed. Rotation is a documented procedure, not a rediscovery.

## 8. Observability

The failure this must catch is the one the project keeps producing: something
stops and nothing says so. The dashboard is a pull surface and does not help
when nobody is looking.

The host therefore needs one push: a scheduled check that reads what `doctor`
already computes — collector tick freshness, paper heartbeat ages, quota pace,
disk — and notifies only when something is wrong. Silence must mean healthy, and
it must be proven to mean healthy by breaking something on purpose once.

## 9. Data migration

The database moves once, at cutover, after the week ends. It is not
reconstructible: candles derive from `pool_snapshots`, and those are
observations of a moment that Blockfrost will not serve again.

Procedure: stop the writers, dump, verify the restore by row counts and by the
`RETAINED` checks the schema guards already encode, then start on the host and
confirm the first tick lands before declaring the laptop free.

## 10. Milestones

| | |
|---|---|
| M5.1 | Host exists, hardened, secrets mechanism working, nothing running yet |
| M5.2 | Postgres + collector supervised, surviving a deliberate reboot |
| M5.3 | Backups running, and a restore proven by restoring |
| M5.4 | Push monitoring, proven by breaking something and being told |
| M5.5 | Cutover: database migrated, paper runs resumed on the host, laptop free |

M5.3 is not met by a backup job that runs. It is met by a restore that produced
a working database.

## 11. Out of scope

Live execution and wallet signing, high availability, a second region,
containerising the Node processes, a public dashboard, alerting anyone but the
founder.

## 12. Open questions

- **Host and budget.** A small VPS (~$6-12/month) or a separate AWS account.
  Founder decision; the design does not depend on which.
- **Does the founder want the 7-day run restarted on the host** rather than
  finished on the laptop? Finishing on the laptop keeps one git sha and one
  clean week; restarting costs seven days and buys a better substrate.
- **Where backups go.** Any destination that is not the host's own disk, and
  not the HIPAA account's buckets.
