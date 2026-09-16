import { hostname as osHostname } from 'node:os';
import { filterSecrets } from '@ctb/reports';
import type { Logger } from 'pino';
import { knownSecretsFrom, report as sendReport, type ReportResult } from '../alerting.js';
import { loadConfig } from '../config.js';

/**
 * `alert test | alert send --kind alive|fail|log [--body <text>]`
 *
 * The operator's proof that the pipe works, from the box, with one command. The exit code is the
 * contract: 0 only when the service answered "OK"; 1 when it answered anything else (a rotated
 * URL is a 200 with body "OK (not found)") or could not be reached; 2 when misused or when
 * alerting is off. Messages name the host and the status, never the path.
 */
const USAGE = 'usage: alert test | alert send --kind alive|fail|log [--body <text>]';
const SEND_KINDS = ['alive', 'fail', 'log'] as const;
type SendKind = (typeof SEND_KINDS)[number];

export interface AlertDeps {
  report?: typeof sendReport;
  env?: NodeJS.ProcessEnv;
  hostname?: () => string;
  now?: () => Date;
}

function arg(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function isSendKind(k: string | undefined): k is SendKind {
  return (SEND_KINDS as readonly string[]).includes(k ?? '');
}

/** One line per outcome, in the shape the runbook's drills quote. */
export function describeOutcome(r: ReportResult): string {
  const host = `host=${r.host ?? '?'}`;
  switch (r.outcome) {
    case 'accepted': return `accepted (http ${r.status} ${r.responseBody ?? ''}) ${host}`;
    case 'rejected': return `rejected (http ${r.status ?? '-'} ${JSON.stringify(r.responseBody ?? '')}) ${host}`;
    case 'unreachable': return `unreachable ${host}: ${r.reason ?? 'no response'}`;
    case 'disabled': return 'disabled: CTB_HEALTHCHECK_URL is not set; alerting is off';
  }
}

export async function alertCommand(log: Logger, args: readonly string[], deps: AlertDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const report = deps.report ?? sendReport;
  const host = deps.hostname ?? osHostname;
  const now = deps.now ?? (() => new Date());
  const [sub, ...rest] = args;

  let kind: SendKind;
  let body: string;
  if (sub === 'send') {
    const k = arg(rest, '--kind');
    if (!isSendKind(k)) {
      console.error(USAGE);
      process.exitCode = 2;
      return;
    }
    kind = k;
    body = arg(rest, '--body') ?? `${kind} from ${host()} at ${now().toISOString()}`;
  } else {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  const cfg = loadConfig(env, { blockfrost: false });
  if (cfg.healthcheckUrl === undefined) {
    console.error('CTB_HEALTHCHECK_URL is not set; alerting is off');
    process.exitCode = 2;
    return;
  }

  const filtered = filterSecrets(body, knownSecretsFrom(env));
  if (filtered.redacted) log.warn('body failed the secret filter; sending the redaction line instead');
  const r = await report(cfg.healthcheckUrl, kind, filtered.body);
  log.info({ kind, outcome: r.outcome, status: r.status, host: r.host }, 'healthcheck report');
  const line = describeOutcome(r);
  if (r.outcome === 'accepted') {
    console.log(line);
    process.exitCode = 0;
  } else {
    console.error(line);
    process.exitCode = 1;
  }
}
