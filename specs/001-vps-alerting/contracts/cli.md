# Contract: CLI commands and the reporting module

**Feature**: `specs/001-vps-alerting` | **Date**: 2026-09-16

Three surfaces: the existing `watch` command gains one side effect; two new subcommands `alert`
and `maintenance`; and one small module they share. Exact registration follows the existing
dispatch in `packages/cli/src/main.ts` and the `"<cmd>": "tsx packages/cli/src/main.ts <cmd>"`
pattern in the root `package.json`.

## `watch` (existing; one added side effect)

Unchanged: facts, verdict, printed lines, `--verbose`, `process.exitCode` (0 when no FAIL, 1
otherwise). Added, after the verdict is printed:

```text
if CTB_HEALTHCHECK_URL is set:
  body   := verdict lines (every check line + the verdict line), then "\n" + maintenance note if active
  kind   := 'fail' if any FAIL and maintenance is not active, else 'alive'
  result := report(kind, body)          # one HTTP request, 10 s timeout
  log one line: {kind, outcome, status, host}   # never the path, never the body
```

`result` never affects the exit code. If the maintenance file has expired, `watch` deletes it and
sends one extra `log` report "maintenance ended (expired): <reason>" before the cycle's own
report.

## `alert`

```text
usage: alert test | alert send --kind alive|fail|log [--body <text>]
```

- `alert test`: sends a `log` report with body `TEST from <hostname> at <ISO time>`; prints the
  outcome and the service's response body; exits 0 only on `accepted`. Refuses (exit 2) when
  `CTB_HEALTHCHECK_URL` is unset, with the message `CTB_HEALTHCHECK_URL is not set; alerting is off`.
- `alert send`: same plumbing with an explicit kind; for drills and the runbook only. The body
  passes the secret filter like any other.

Exit codes: `0` accepted, `1` rejected or unreachable (message names host and status/body), `2`
usage or unset URL.

## `maintenance`

```text
usage: maintenance start --minutes <1..240> --reason "<text>" | maintenance end | maintenance status
```

- `start`: writes `~/ctb-maintenance.json` (mode 600) with `until = now + minutes`, sends a `log`
  report `maintenance started until <ISO> (<minutes> min): <reason>`, prints the same. Refuses
  (exit 2) above 240 minutes or with an empty reason; refuses (exit 1) if a window is already
  active (use `end` first, so a window cannot be silently extended).
- `end`: deletes the file, sends a `log` report `maintenance ended (manual): <reason>`, prints it.
  Exit 0 also when no window was active (idempotent), with a note.
- `status`: prints `active until <ISO> (<n> min left): <reason>` or `no maintenance window`; exit 0
  either way. Never sends a report.

The file's shape and the expiry rule are in `data-model.md` (Maintenance window).

## Module: `alerting` (consumed by `watch`, `alert`, `maintenance`)

Split by the purity guard (`packages/reports/test/purity.guard.test.ts`): the pure functions
(`buildBody`, `filterSecrets`, `classify`, `evaluateMaintenance`, and `decideReport(checks,
verdictLine, maintenance) -> { kind, body }`) live in `packages/reports/src/alerting.ts`; the one
function that performs I/O, `report()`, plus the maintenance file read/write, live in
`packages/cli/src/alerting.ts` beside `r2.ts`. Tests stub `fetch` only.

```ts
export type ReportKind = 'alive' | 'fail' | 'start' | 'log';
export type ReportOutcome = 'accepted' | 'rejected' | 'unreachable' | 'disabled';

export interface ReportResult {
  outcome: ReportOutcome;
  status?: number;        // HTTP status when a response was received
  responseBody?: string;  // first 200 chars of the response, for the self-test's output
  host?: string;          // URL host only, for messages; never the path
}

/** The verdict lines that go on the wire. Pure. Applies the secret filter. */
export function buildBody(checks: Check[], verdictLine: string, maintenance: MaintenanceState | null): string;

/** Replaces the whole body when it fails the filter; the replacement says so. Pure. */
export function filterSecrets(body: string, knownSecrets: readonly string[]): { body: string; redacted: boolean };

/** `accepted` iff status 200 AND body === 'OK'. Pure. */
export function classify(status: number | null, body: string | null, error: unknown): ReportOutcome;

/** Reads, validates and expires the maintenance file. Pure given the file's text and `now`. */
export function evaluateMaintenance(fileText: string | null, now: Date): MaintenanceState | { expired: true; reason: string } | null;

/** The only I/O. Builds `<base>` + suffix, POSTs the body with a 10 s timeout, returns the classification. Never throws. */
export async function report(baseUrl: string | undefined, kind: ReportKind | number, body: string, fetchImpl?: typeof fetch): Promise<ReportResult>;
```

Rules the tests pin:

1. `report(undefined, ...)` returns `{ outcome: 'disabled' }` without calling `fetch`.
2. `classify(200, 'OK (not found)', null)` is `rejected`; `classify(200, 'OK', null)` is `accepted`;
   a thrown `AbortError` is `unreachable`.
3. `buildBody` output never contains any string from `knownSecrets`; when it would, the whole body
   is the redaction line and `redacted` is true.
4. `evaluateMaintenance` with `until` in the past returns `{ expired: true }`; with malformed JSON
   returns `null` (treated as no window) and the caller logs it; with `until` more than 240 min
   ahead returns `null` (the file was not written by our command).
5. The body is at most 8 kB; longer verdicts are truncated with a final line saying so.

## Configuration key

| key | required | validation | effect when absent |
|---|---|---|---|
| `CTB_HEALTHCHECK_URL` | no | `https://` scheme, no query, no trailing `/` | alerting disabled; `watch` unchanged; `alert` exits 2; `maintenance` still writes the file and prints, but sends nothing |

Declared in the config loader beside the other optional keys, with the same default/validation
pattern the loader uses today.
