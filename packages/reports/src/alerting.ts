/**
 * The decision half of the dead-man's switch. Pure: what a watchdog cycle sends, how the service's
 * answer is read, whether a maintenance window is in force. The one function that talks to the
 * network (`report()`) lives in `packages/cli/src/alerting.ts`; this package's purity guard keeps
 * it out of here, and that split is what lets a maintenance window be PROVEN never to silence
 * liveness (decideReport's kind is a function of the checks alone, and the tests enumerate it).
 *
 * The failure being designed against is the one from 2026-09-16: a stopped paper run that nothing
 * reported for eleven hours. A rule that is easy to get subtly wrong — "accepted" on a 200 whose
 * body says the check was not found; a window that quietly suppresses the alive ping — belongs
 * where a test can pin it.
 */
import type { Check } from './doctor.js';

export type ReportKind = 'alive' | 'fail' | 'start' | 'log';
export type ReportOutcome = 'accepted' | 'rejected' | 'unreachable' | 'disabled';

/** The maintenance file's shape (data-model.md). `until` and `declaredAt` are ISO-8601 UTC. */
export interface MaintenanceState {
  until: string;
  reason: string;
  declaredAt: string;
}

/** Well under the service's 100 kB cap; a verdict longer than this is a bug, not information. */
export const MAX_BODY_BYTES = 8 * 1024;
/** The command refuses a longer window, and the reader treats a longer one as not ours. */
export const MAX_MAINTENANCE_MINUTES = 240;
/** At most this many characters of reason survive into the file and the notices. */
export const MAX_REASON_CHARS = 200;

const REDACTION_LINE = '[redacted: body failed the secret filter]';
const TRUNCATION_LINE = '[truncated to 8 kB]';

/**
 * `accepted` iff status 200 AND body exactly `OK`. The service answers a wrong UUID with a 200
 * and body "OK (not found)", and a rate limit with "OK (rate limited)": to anything that only
 * checks the status both look like success, which is how a rotated URL would go unnoticed.
 */
export function classify(status: number | null, body: string | null, error: unknown): ReportOutcome {
  if (error !== null && error !== undefined) return 'unreachable';
  if (status === null) return 'unreachable';
  if (status === 200 && body !== null && body.trim() === 'OK') return 'accepted';
  return 'rejected';
}

// A connection string; a 39-character alphanumeric run (a Blockfrost project id is `mainnet` +
// 32 hex); an e-mail address. The e-mail rule deliberately does not match a systemd instance
// name (`ctb-paper@ma-crossover.service`), which is data a failure body legitimately carries.
const SECRET_PATTERNS: readonly RegExp[] = [
  /postgres(?:ql)?:\/\//i,
  /(?<![A-Za-z0-9])[A-Za-z0-9]{39}(?![A-Za-z0-9])/,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(?!service\b|timer\b|socket\b|target\b|slice\b|mount\b|path\b)[A-Za-z]{2,}/,
];

/**
 * All or nothing: a body that fails the filter is replaced by one fixed line that says so, so a
 * redaction is visible in the service's log rather than a silently trimmed message.
 */
export function filterSecrets(body: string, knownSecrets: readonly string[]): { body: string; redacted: boolean } {
  const known = knownSecrets.filter((s): s is string => typeof s === 'string' && s.length > 0);
  if (known.some((s) => body.includes(s))) return { body: REDACTION_LINE, redacted: true };
  if (SECRET_PATTERNS.some((re) => re.test(body))) return { body: REDACTION_LINE, redacted: true };
  return { body, redacted: false };
}

const utf8 = new TextEncoder();

function truncate(body: string): string {
  if (utf8.encode(body).byteLength <= MAX_BODY_BYTES) return body;
  const budget = MAX_BODY_BYTES - utf8.encode(`\n${TRUNCATION_LINE}`).byteLength;
  let cut = body.slice(0, budget);
  while (utf8.encode(cut).byteLength > budget) cut = cut.slice(0, -1);
  return `${cut}\n${TRUNCATION_LINE}`;
}

/**
 * The lines `watch` prints — `STATUS: name — detail` per non-OK check — then the verdict line,
 * renamed from `doctor:` to `watch:` because that is the command that ran. An active window goes
 * first so the founder reads "[maintenance: ...]" before any FAIL line.
 */
export function buildBody(
  checks: readonly Check[], verdictLine: string, maintenance: MaintenanceState | null, knownSecrets: readonly string[] = [],
): string {
  const lines: string[] = [];
  if (maintenance) lines.push(`[maintenance: ${maintenance.reason} until ${maintenance.until}]`);
  for (const c of checks) if (c.status !== 'ok') lines.push(`${c.status.toUpperCase()}: ${c.name} — ${c.detail}`);
  lines.push(verdictLine.replace(/^doctor:/, 'watch:'));
  return truncate(filterSecrets(lines.join('\n'), knownSecrets).body);
}

/**
 * Reads the maintenance file's text. `null` means "no window": absent, malformed, or a window
 * longer than the command can write (which means the file was not written by our command and is
 * not trusted to suppress anything). `{ expired }` tells the caller to delete it and say so.
 */
export function evaluateMaintenance(fileText: string | null, now: Date): MaintenanceState | { expired: true; reason: string } | null {
  if (fileText === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileText);
  } catch {
    return null; // intentional: a malformed file is no window; the caller logs it
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { until, reason, declaredAt } = parsed as Record<string, unknown>;
  if (typeof until !== 'string' || typeof reason !== 'string' || typeof declaredAt !== 'string') return null;
  const untilMs = Date.parse(until);
  if (!Number.isFinite(untilMs)) return null;
  if (untilMs - now.getTime() > MAX_MAINTENANCE_MINUTES * 60_000) return null;
  if (untilMs <= now.getTime()) return { expired: true, reason };
  return { until, reason, declaredAt };
}

/**
 * One report per cycle, never zero: `fail` when any check FAILs outside a window, `alive`
 * otherwise. Maintenance changes `fail` into `alive` with the window named in the body; it never
 * removes the report. Warnings never page (f5acb93: every blip would become an alarm).
 */
export function decideReport(
  checks: readonly Check[], verdictLine: string, maintenance: MaintenanceState | null, knownSecrets: readonly string[] = [],
): { kind: 'alive' | 'fail'; body: string } {
  const anyFail = checks.some((c) => c.status === 'fail');
  const kind = anyFail && maintenance === null ? 'fail' : 'alive';
  return { kind, body: buildBody(checks, verdictLine, maintenance, knownSecrets) };
}
