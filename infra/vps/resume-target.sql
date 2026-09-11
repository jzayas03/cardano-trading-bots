-- Which run, if any, should a restarting paper unit take over?
--
-- Read by BOTH `paper-start.sh` and `packages/cli/test/resumeTarget.pg.test.ts`, so the test
-- exercises the query that actually runs rather than a copy of it that can drift.
--
-- THE RACE THIS CLOSES (observed live 2026-09-11 06:16). The old version selected only
-- `status = 'running'`. On `systemctl restart`, the outgoing process catches SIGINT and writes
-- `finished` / `stop_reason = 'signal'`; the incoming one then asks the database what to resume.
-- Whether it finds a `running` row depends entirely on which of those two won — and on that morning
-- run 146 flushed within 5 seconds and was FORKED into a new run 149, while runs 147 and 148 had not
-- yet flushed and were RESUMED. Same restart, opposite outcomes, and the ids look fine either way.
--
-- Note the direction of the old bug: the CLEANER the shutdown, the likelier the fork. A run that
-- tidied up properly lost its identity; a slow one kept it.
--
-- So a recently SIGNALLED run counts as resumable too. `:window_seconds` separates a restart from a
-- deliberate stop: a restart is bounded by process teardown plus startup (5s observed), while ending
-- an experiment and starting another is minutes at least — the 16th's cutover spans a password
-- rotation and a deploy, so it cannot trip this.
--
-- Only `stop_reason = 'signal'`. An `aborted` run, or one stopped by a feed failure, stays stopped:
-- something went wrong and a human should look before it silently continues.
SELECT r.id,
       r.status,
       coalesce(r.stop_reason, ''),
       coalesce(round(extract(epoch FROM (now() - r.finished_at)))::text, '')
  FROM runs r
  JOIN tokens t ON t.unit = r.base_unit
 WHERE r.mode = 'paper'
   AND r.strategy_id = :'strategy'
   AND t.ticker = :'ticker'
   AND (
         r.status = 'running'
         OR (
              r.status = 'finished'
              AND r.stop_reason = 'signal'
              AND r.finished_at > now() - make_interval(secs => :window_seconds)
            )
       )
 ORDER BY r.id DESC
 LIMIT 1;
