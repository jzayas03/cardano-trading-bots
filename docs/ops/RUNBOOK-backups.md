# Runbook: backups

The database holds the only copy of `pool_snapshots` — observations of pool reserves at a moment
Blockfrost will not serve again. Every candle and every paper result derives from them. They cannot
be re-fetched, only restored.

## What runs, and when

A launchd user agent runs the backup **daily at 03:30 local**. If the Mac is asleep or off at that
time, launchd runs the job once on the next wake rather than skipping the day.

```bash
./scripts/install-backup-schedule.sh            # install or reinstall
./scripts/install-backup-schedule.sh --remove   # uninstall, and confirm it is gone
launchctl kickstart -p gui/$(id -u)/com.cuadradozayas.ctb-backup   # run it now
tail -f ~/ctb-backups/scheduled-backup.log      # what it did
```

The installer **generates** the plist with this machine's absolute paths rather than asking you to
edit a template, because a documented prerequisite the adjacent command does not perform is a
footgun rather than an instruction.

## What one run does

1. `pg_dump` at an exported snapshot, into `~/ctb-backups/` (14 kept).
2. Row counts captured **inside that same snapshot**, written to a manifest beside the dump.
3. Upload of both to R2, when configured, with the same retention applied remotely.
4. `backup:verify:remote` — downloads the object it just wrote, restores it into a scratch
   database, and compares the counts against the manifest.

Step 4 is the point. A backup job that runs is not a backup; a restore that worked is.

## Why the wrapper looks paranoid

`launchd` does not read a login shell. There is no `~/.zshrc`, no `nvm`, and on this machine
`launchctl getenv PATH` is empty. So `scripts/scheduled-backup.sh` resolves node through `nvm.sh`
itself, hunts for `docker` in the usual install locations, and refuses to continue — loudly, into
the log — if either is missing or if the `ctb_postgres` container is not running.

Test it the way launchd will run it, with no environment at all:

```bash
env -i HOME="$HOME" /bin/bash scripts/scheduled-backup.sh
```

## How you find out it stopped

`npm run watch` checks backup freshness: **warn past 26 hours, fail past 48**, and a **fail** when
no backup has ever been taken. An empty directory because the schedule never once fired looks
exactly like a directory nobody has looked at, so absence is treated as a failure rather than a
skip.

The likely causes of a stopped schedule, in order: Docker Desktop not running, a rotated R2 key,
and a node upgrade that moved the binary.

## Restoring for real

```bash
npm run backup:verify              # newest local dump, into a scratch database
npm run backup:verify:remote       # pull the newest from R2 and verify THAT
```

To restore over the live database, stop every writer first — the collector and all paper runs —
then `pg_restore` by hand. There is deliberately no command that overwrites the live database:
that is a decision, not a routine.

## What this does not protect against

`~/ctb-backups` is on the same disk as the database. R2 is the copy that survives the disk; the
local one survives a bad migration and a wrong `DROP`. If R2 is not configured, there is exactly
one copy of everything.

## Two machines, one R2 bucket, one Blockfrost key

During the M5 cutover both the laptop and the VPS hold the same `.env`. That means one Blockfrost
key with one 50,000/day quota between them, and one R2 prefix that both would prune with the same
14-dump retention — each deleting the other's copies.

So exactly one machine backs up at a time, and the handover is ordered. **Stopping the laptop's
agent is part of the cutover, not preparation for it**: until the VPS is live, the laptop holds the
only database that matters and must keep protecting it.

```bash
# 1. Take a final backup on the laptop, and verify the copy that will be restored.
cd ~/code/cardano-trading-bots
npm run backup && npm run backup:verify:remote

# 2. Stop the laptop's writers. The collector first, so no tick lands mid-dump.
pkill -TERM -f 'main.ts collect'
pkill -INT  -f 'main.ts paper'

# 3. Stop the laptop's backup schedule. From here the VPS owns the bucket.
./scripts/install-backup-schedule.sh --remove

# 4. On the VPS: restore, then start the units.
#    (see docs/plans/2026-09-08-m5-vps.md, task 6)

# 5. Confirm exactly one collector exists, across BOTH machines.
pgrep -f 'main.ts collect' | wc -l          # laptop: must be 0
ssh ctb@<vps> 'pgrep -f "main.ts collect" | wc -l'   # vps: must be 1
```

Step 5 is the one to actually run rather than assume. Two collectors on one key is not a loud
failure — it is a quota that runs out early and 402s that look like a Blockfrost outage.

### Reversing it

The laptop's agent comes back with `./scripts/install-backup-schedule.sh`. Do that only after
stopping the VPS timer (`systemctl disable --now ctb-backup.timer`), for the same reason.
