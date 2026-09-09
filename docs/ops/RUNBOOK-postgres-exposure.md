# The database was on the public internet

Date: 2026-09-09. Status: immediate block applied; durable fix is this PR plus the steps below.

## What was true

`docker-compose.yml` published `- "5433:5432"`. A published port with no bind address listens on
`0.0.0.0` **and** `[::]`. Three lines above it sat `POSTGRES_PASSWORD: ctb_local_only`, in a repo
that has been **public since 2026-09-06**.

Verified — not inferred — from a laptop, over the internet:

```
PGPASSWORD=ctb_local_only psql -h <ip> -p 5433 -U ctb -d ctb -c '...'
AUTHENTICATED as ctb from 66.9.164.17/32; rows in candles: 2375
```

**`ufw` reported "OpenSSH only" the whole time and was telling the truth.** Docker writes its own
rules into the `DOCKER` chain, which netfilter traverses *before* ufw's. A published container port
bypasses ufw. **Never conclude a port is closed from `ufw status`; test from another machine.**

`docker-compose.yml` and migration `0006_dashboard_role.sql` both carried a comment justifying the
weak password because the database was "bound to 127.0.0.1". That premise was never true on the VPS.
The reasoning was wrong in a way no reviewer re-derives, which is why this is now pinned by
`test/composePortsAndSecrets.guard.test.ts`.

## Blast radius

No funds, no keys, no PHI — that is a different repo. But the corpus was readable, and **writable**:
an attacker could have corrupted the live paper run or inserted candles the strategies trade against.
At M6 this database holds live order state for real money, so this was a hard blocker for it.

Only Postgres was published; no other container exposes a port.

## Step 1 — immediate block (DONE 2026-09-09 ~00:50 UTC)

```
iptables -I DOCKER-USER -i eth0 -p tcp --dport 5432 -j DROP
iptables -I DOCKER-USER -i eth0 -p tcp --dport 5433 -j DROP
```

Zero downtime, no container touched. Confirmed from off-host: `psql` rc=2 "timeout expired" where it
had authenticated instantly; `nc` rc=124; SSH still rc=0; the host's own access still worked.

**This does not survive a reboot,** and unattended-upgrades is enabled.

## Step 2 — durable, in this PR

* `- "127.0.0.1:5433:5432"` — the port is never published off-host again.
* `POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?...}` — compose REFUSES to start when it is unset. Not
  `${VAR:-default}`, which would put a secret back in a public file, and not a bare `${VAR}`, which
  becomes empty silently.
* `infra/vps/harden-docker-ports.sh` — persists the DOCKER-USER block in `/etc/ufw/after.rules`.
* `test/composePortsAndSecrets.guard.test.ts` — a port published to `0.0.0.0`, or any password
  literal, now fails CI.

### Deploy sequence

The container must be recreated, so the collector and the three paper runs will see a short gap.
**Do it just after a candle boundary (`:00`, `:15`, `:30`, `:45` UTC), never on one** — a run's
candle build is the worst moment to take the database away.

1. Put the **current** password in `.env` first, so nothing changes yet:
   `POSTGRES_PASSWORD=<the value already in use>` (mode 600, owner `ctb`).
2. Deploy: `ssh root@<ip> 'bash -s' < infra/vps/deploy.sh`
3. Recreate so the new binding takes effect — `up -d` alone will not re-bind an existing container:
   `sudo -u ctb bash -lc 'cd ~/cardano-trading-bots && docker compose up -d --force-recreate postgres'`
4. `ssh root@<ip> 'bash -s' < infra/vps/harden-docker-ports.sh`
5. Verify **from another machine**: `nc -z -w 8 <ip> 5433; echo rc=$?` — non-zero is the pass.
   And on the host: `ss -lntp | grep 5433` should show `127.0.0.1:5433`, not `0.0.0.0:5433`.

## Step 3 — rotate the password (scripted; timing is the whole question)

`infra/vps/rotate-postgres-password.sh` does all of it: generates the new value **on the host** with
`openssl` so it never leaves the box, ALTERs the role, rewrites `POSTGRES_PASSWORD` and
`DATABASE_URL` together, verifies **both** directions (new authenticates AND old is refused), and
rolls back — role and `.env` — if any step fails. Nothing is ever printed.

```
ssh root@<ip> 'bash -s' < infra/vps/rotate-postgres-password.sh
```

**Run it BETWEEN paper runs, not during one.** `createPool` does not set `idleTimeoutMillis`, so
pg's 10-second default applies: idle connections close and the next query opens a fresh one. The
instant ALTER ROLE lands, every process holding the old credentials fails to authenticate.

The collector is fine — it holds no run state and the script restarts it. The paper runs are the
risk. They *should* crash, be restarted by systemd, and resume the same run id, because a crash
leaves `runs.status = 'running'` and `paper-start.sh` resumes a running row. But a run that reaches
`maxTickFailures` (12) aborts and marks itself stopped, and the next start then creates a **new
run** — on a 7-day run, that is starting the week again. Observed 2026-09-09: a clean
`systemctl stop` produced `finished`/`stop_reason: signal`, and the following start created new ids
146/147/148.

The script deliberately does **not** restart the paper units, and prints the query to check whether
the ids survived.

### The old notes on why this is fiddly

`ctb_local_only` is public and stays public in git history. The port is closed, so this is no longer
urgent, but it must happen **before M6**.

**`POSTGRES_PASSWORD` is read only at initdb.** Changing it on an existing volume does nothing to the
existing role, so a rotation is three coordinated edits, in this order:

1. `docker exec -i ctb_postgres psql -U ctb -d ctb -c "ALTER ROLE ctb PASSWORD '<new>'"`
2. Update **both** `DATABASE_URL` and `POSTGRES_PASSWORD` in `.env` — they must agree, or the next
   deploy starts a container the CLI cannot authenticate to.
3. Restart the consumers: `systemctl restart ctb-collector ctb-paper@*`

Do not paste the new value into a chat, a commit, or a PR. Generate it on the host.

**Also public and not yet rotated:** `ctb_dashboard_local_only` in `0006_dashboard_role.sql`. That
role is SELECT-only and, with the port closed, only reachable from the host — lower priority, same
milestone.
