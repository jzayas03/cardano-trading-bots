/**
 * The I/O half of the dead-man's switch: the one `fetch` in this repository that talks to the
 * hosted service, and the maintenance file on disk. Every rule about WHAT to send and how to read
 * the answer is in `@ctb/reports` (`packages/reports/src/alerting.ts`), where it is pure and
 * tested; this file only moves bytes.
 *
 * The ping URL is a credential. It never appears in a log line, an error message, a thrown value
 * or a result: `ReportResult.host` is the URL's host and nothing else, so a message can say WHERE
 * a report went without saying the path that would let anyone else send one.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { classify, type MaintenanceState, type ReportKind, type ReportOutcome } from '@ctb/reports';

export interface ReportResult {
  outcome: ReportOutcome;
  /** HTTP status when a response was received. */
  status?: number;
  /** First 200 characters of the response, for the self-test's output. */
  responseBody?: string;
  /** URL host only, for messages; never the path. */
  host?: string;
}

/** Ten seconds: a watchdog cycle must not hang on the service, and the service answers in tens of ms. */
export const REPORT_TIMEOUT_MS = 10_000;
const RESPONSE_BODY_CHARS = 200;

/** `alive` is the bare URL; every other kind is a suffix (`/fail`, `/log`, `/<exit-status>`). */
export function reportUrl(baseUrl: string, kind: ReportKind | number): string {
  return kind === 'alive' ? baseUrl : `${baseUrl}/${kind}`;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined; // intentional: an unparsable URL still must not leak; the config layer already rejected it
  }
}

/**
 * The only I/O. POSTs the body with a timeout and returns the classification. Never throws: a
 * report failure must never change the watchdog's exit status or the unit's own outcome (FR-015),
 * so the caller gets an outcome to log, not an exception to handle.
 */
export async function report(
  baseUrl: string | undefined, kind: ReportKind | number, body: string, fetchImpl: typeof fetch = fetch,
): Promise<ReportResult> {
  if (baseUrl === undefined) return { outcome: 'disabled' };
  const host = hostOf(baseUrl);
  let status: number | null = null;
  let text: string | null = null;
  let error: unknown = null;
  try {
    const res = await fetchImpl(reportUrl(baseUrl, kind), {
      method: 'POST',
      body,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
    status = res.status;
    text = (await res.text()).slice(0, RESPONSE_BODY_CHARS);
  } catch (e) {
    error = e ?? new Error('fetch failed');
  }
  const outcome = classify(status, text, error);
  const out: ReportResult = { outcome };
  if (host !== undefined) out.host = host;
  if (status !== null) out.status = status;
  if (text !== null) out.responseBody = text;
  return out;
}

/** The env keys whose VALUES must never travel in a report body (data-model.md, Report). */
const SECRET_ENV_KEYS = [
  'DATABASE_URL', 'DASHBOARD_DATABASE_URL', 'POSTGRES_PASSWORD', 'BLOCKFROST_PROJECT_ID',
  'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'CTB_HEALTHCHECK_URL',
] as const;

/**
 * The strings `filterSecrets` must never let through: each secret env value, and for the URLs
 * also the password component on its own, because a check's detail is far more likely to quote a
 * password than an entire connection string. The result is handed to a pure function and never
 * logged.
 */
export function knownSecretsFrom(env: NodeJS.ProcessEnv): string[] {
  const out = new Set<string>();
  for (const key of SECRET_ENV_KEYS) {
    const value = (env[key] ?? '').trim();
    if (value === '') continue;
    out.add(value);
    if (value.includes('://')) {
      try {
        const pw = new URL(value).password;
        if (pw) out.add(decodeURIComponent(pw));
      } catch {
        // intentional: a value that is not a URL is still a secret by itself, already added
      }
    }
  }
  return [...out];
}

// --- Maintenance window file -------------------------------------------------------------------

/**
 * In the home directory, not the checkout: the checkout is what `deploy.sh` and the cutover gate
 * measure for cleanliness, and a runtime file inside it would fail `before-stop` on "worktree
 * clean". The shell handler reads the same path.
 */
export const MAINTENANCE_PATH = join(homedir(), 'ctb-maintenance.json');

/** The file's text, or null when it does not exist. Any other read error propagates. */
export function readMaintenanceFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return null;
    throw e;
  }
}

/** Mode 0600: the reason is the founder's own text, and the file sits beside `.env`'s owner. */
export function writeMaintenanceFile(path: string, state: MaintenanceState): void {
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

/** Idempotent: deleting an absent window is not an error (the `end` command relies on this). */
export function deleteMaintenanceFile(path: string): void {
  rmSync(path, { force: true });
}
