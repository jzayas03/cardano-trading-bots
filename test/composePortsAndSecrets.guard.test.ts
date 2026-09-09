import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `docker-compose.yml` must not publish a port to every interface, and must not carry a password.
 *
 * On 2026-09-09 it did both at once. `ports: - "5433:5432"` publishes on 0.0.0.0 and [::], and
 * `POSTGRES_PASSWORD: ctb_local_only` sat three lines above it in a repo that has been PUBLIC since
 * 2026-09-06. `ufw status` reported "OpenSSH only" throughout and was telling the truth about its
 * own chain — Docker writes into the DOCKER chain, which is traversed first. Verified by connecting
 * from a laptop over the internet and reading 2,375 rows.
 *
 * Neither half was noticed for three days, because both look completely ordinary. A comment in the
 * file and in migration 0006 even justified the weak password on the grounds that the database was
 * "bound to 127.0.0.1" — a premise that was never true in production. That is exactly what a guard
 * is for: the reasoning was wrong in a way no reviewer re-derives.
 */
const COMPOSE_PATH = fileURLToPath(new URL('../docker-compose.yml', import.meta.url));
const COMPOSE = readFileSync(COMPOSE_PATH, 'utf8');

/** Every `- "..."` entry underneath a `ports:` key, comments and blank lines skipped. */
export function publishedPorts(yaml: string): string[] {
  const out: string[] = [];
  const lines = yaml.split('\n');
  let inPorts = false;
  let portsIndent = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (/^ports:\s*$/.test(trimmed)) { inPorts = true; portsIndent = indent; continue; }
    if (inPorts) {
      if (indent <= portsIndent) { inPorts = false; }
      else if (trimmed.startsWith('- ')) { out.push(trimmed.slice(2).replace(/^["']|["']$/g, '')); continue; }
    }
  }
  return out;
}

describe('docker-compose port publishing', () => {
  it('publishes nothing to every interface', () => {
    const ports = publishedPorts(COMPOSE);
    // A guard that finds nothing to check passes forever. Assert there is a corpus first.
    expect(ports.length).toBeGreaterThan(0);
    for (const p of ports) {
      expect(p, `"${p}" publishes to 0.0.0.0 — bind it, e.g. "127.0.0.1:${p}"`).toMatch(/^127\.0\.0\.1:/);
    }
  });

  it('CONTROL: the parser actually finds the bare form it is meant to reject', () => {
    // Without this, a parser that silently matched nothing would pass the test above forever.
    expect(publishedPorts('services:\n  db:\n    ports:\n      - "5433:5432"\n')).toEqual(['5433:5432']);
    expect(publishedPorts('services:\n  db:\n    ports:\n      - "127.0.0.1:5433:5432"\n')).toEqual(['127.0.0.1:5433:5432']);
  });

  it('CONTROL: the parser stops at the end of the ports block', () => {
    // A parser that ran on past `ports:` would sweep up volumes and report nonsense.
    const yaml = 'services:\n  db:\n    ports:\n      - "127.0.0.1:5433:5432"\n    volumes:\n      - pgdata:/var/lib/postgresql/data\n';
    expect(publishedPorts(yaml)).toEqual(['127.0.0.1:5433:5432']);
  });

  it('CONTROL: comments inside the block are not mistaken for entries', () => {
    const yaml = 'services:\n  db:\n    ports:\n      # a comment\n      - "127.0.0.1:5433:5432"\n';
    expect(publishedPorts(yaml)).toEqual(['127.0.0.1:5433:5432']);
  });
});

describe('docker-compose secrets', () => {
  it('carries no password literal — this repo is public', () => {
    // Only the interpolation form is allowed. `${VAR:?msg}` refuses to start when unset; a plain
    // `${VAR}` would silently become empty, and `${VAR:-default}` would put a secret back in the file.
    const passwordLines = COMPOSE.split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .filter((l) => /(PASSWORD|SECRET|TOKEN|_KEY)\s*:/i.test(l));
    expect(passwordLines.length).toBeGreaterThan(0);
    for (const line of passwordLines) {
      const value = line.split(':').slice(1).join(':').trim();
      expect(value, `${line.trim()} — use \${VAR:?message}, read from the gitignored .env`).toMatch(/^\$\{[A-Z_]+:\?/);
    }
  });

  it('does not contain the leaked literal that was published', () => {
    expect(COMPOSE).not.toContain('ctb_local_only');
  });
});
