/**
 * Cloudflare R2 as an off-machine home for backups.
 *
 * R2 is S3-compatible, so this is SigV4 over `fetch` — `aws4fetch` and nothing else, chosen over
 * `@aws-sdk/client-s3` because it has zero transitive dependencies and this repo has already been
 * bitten once by a fat dependency tree it did not choose (axios CVEs via Dexter). A recovery path
 * is a bad place to carry fifty packages nobody audited.
 *
 * Credentials are never logged, echoed, or included in an error message. Everything here reports
 * presence and length, never a value.
 */
import { AwsClient } from 'aws4fetch';

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** What the env said, and whether it is usable. */
export type R2Setting =
  | { kind: 'absent' }
  | { kind: 'configured'; config: R2Config }
  | { kind: 'partial'; missing: string[] };

export const R2_VARS = ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'] as const;

/**
 * All four, or none. A PARTIAL configuration is an error, never a silent fall back to local-only.
 *
 * The failure being designed against: someone sets three of the four, backups quietly stay on the
 * one disk they were trying to get off, and nobody learns until a restore is needed. Silence must
 * not be able to mean "off-site backups are not happening".
 */
export function readR2Setting(env: NodeJS.ProcessEnv): R2Setting {
  const present = R2_VARS.filter((v) => (env[v] ?? '').trim() !== '');
  if (present.length === 0) return { kind: 'absent' };
  if (present.length < R2_VARS.length) return { kind: 'partial', missing: R2_VARS.filter((v) => !present.includes(v)) };
  return {
    kind: 'configured',
    config: {
      accountId: env.R2_ACCOUNT_ID!.trim(),
      bucket: env.R2_BUCKET!.trim(),
      accessKeyId: env.R2_ACCESS_KEY_ID!.trim(),
      secretAccessKey: env.R2_SECRET_ACCESS_KEY!.trim(),
    },
  };
}

/** R2's S3 endpoint for an account. The bucket is a path segment, not a subdomain. */
export function endpointFor(cfg: Pick<R2Config, 'accountId' | 'bucket'>): string {
  return `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}`;
}

/** Objects are stored under a prefix so a shared bucket stays legible. */
export function objectKey(fileName: string): string {
  return `ctb/${fileName}`;
}

/** Parses a ListObjectsV2 response. R2 returns S3-shaped XML; only <Key> is needed. */
export function keysFromListXml(xml: string): string[] {
  return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]!);
}

export class R2Store {
  private readonly client: AwsClient;
  constructor(private readonly cfg: R2Config) {
    // 'auto' is R2's region. It is not optional: SigV4 signs it, and a wrong value fails to
    // authenticate with an error that reads like bad credentials.
    this.client = new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, region: 'auto', service: 's3' });
  }

  /** Uploads one object. `body` is a Buffer so the caller controls what it reads into memory. */
  async put(key: string, body: Buffer, contentType = 'application/octet-stream'): Promise<void> {
    const res = await this.client.fetch(`${endpointFor(this.cfg)}/${key}`, {
      // `Uint8Array.from` rather than the Buffer itself: this project compiles with
      // `types: ["node"]` and no DOM lib, so BodyInit comes from undici's types, which want a
      // Uint8Array backed by a plain ArrayBuffer — a Buffer's ArrayBufferLike (which admits
      // SharedArrayBuffer) does not match. The cost is one copy of the dump in memory, which is
      // nothing at today's ~2 MB and is the line to change to a stream if dumps ever get large.
      method: 'PUT',
      body: Uint8Array.from(body),
      headers: { 'content-type': contentType, 'content-length': String(body.byteLength) },
    });
    if (!res.ok) throw new Error(`R2 PUT ${key} failed: ${res.status} ${res.statusText}`);
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.fetch(`${endpointFor(this.cfg)}/${key}`);
    if (!res.ok) throw new Error(`R2 GET ${key} failed: ${res.status} ${res.statusText}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async list(prefix = 'ctb/'): Promise<string[]> {
    const res = await this.client.fetch(`${endpointFor(this.cfg)}?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1000`);
    if (!res.ok) throw new Error(`R2 LIST failed: ${res.status} ${res.statusText}`);
    return keysFromListXml(await res.text());
  }

  async delete(key: string): Promise<void> {
    const res = await this.client.fetch(`${endpointFor(this.cfg)}/${key}`, { method: 'DELETE' });
    // 204 on success; 404 is already-gone, which is the desired end state either way.
    if (!res.ok && res.status !== 404) throw new Error(`R2 DELETE ${key} failed: ${res.status} ${res.statusText}`);
  }
}
