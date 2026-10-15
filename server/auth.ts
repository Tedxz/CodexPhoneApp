import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Device } from '../shared/protocol.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const safeId = /^[a-f0-9-]{36}$/;
export class AuthStore {
  private pairs: string;
  private devices: string;
  constructor(
    dataDir: string,
    private now = Date.now,
  ) {
    this.pairs = join(dataDir, 'pairings');
    this.devices = join(dataDir, 'devices');
    mkdirSync(this.pairs, { recursive: true, mode: 0o700 });
    mkdirSync(this.devices, { recursive: true, mode: 0o700 });
  }
  createPairing(): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + 5 * 60_000;
    writeFileSync(join(this.pairs, hash(token) + '.json'), JSON.stringify({ expiresAt }), {
      flag: 'wx',
      mode: 0o600,
    });
    return { token, expiresAt };
  }
  pair(token: string, name: string): { token: string; device: Device } | null {
    if (!tokenPattern.test(token)) return null;
    const file = join(this.pairs, hash(token) + '.json');
    try {
      const pairing = JSON.parse(readFileSync(file, 'utf8'));
      // Synchronous consume: no two requests can exchange the same credential.
      unlinkSync(file);
      if (pairing.expiresAt <= this.now()) return null;
      const session = randomBytes(32).toString('base64url');
      const device: Device = {
        id: randomUUID(),
        name: name.trim().slice(0, 80) || '我的手机',
        createdAt: this.now(),
        expiresAt: this.now() + 30 * 86400_000,
      };
      writeFileSync(
        join(this.devices, device.id + '.json'),
        JSON.stringify({ ...device, tokenHash: hash(session) }),
        { flag: 'wx', mode: 0o600 },
      );
      return { token: session, device };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  list(): Device[] {
    return this.records()
      .filter((x) => x.expiresAt > this.now())
      .map(({ tokenHash: _, ...device }) => device);
  }
  authenticate(token: string | undefined): Device | null {
    if (!token || !tokenPattern.test(token)) return null;
    const digest = hash(token);
    const record = this.records().find((x) => x.tokenHash === digest && x.expiresAt > this.now());
    if (!record) return null;
    const { tokenHash: _, ...device } = record;
    return device;
  }
  revoke(id: string): boolean {
    if (!safeId.test(id)) return false;
    try {
      unlinkSync(join(this.devices, id + '.json'));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  private records(): (Device & { tokenHash: string })[] {
    return readdirSync(this.devices)
      .filter((x) => /^[a-f0-9-]{36}\.json$/.test(x))
      .flatMap((file) => {
        try {
          return [JSON.parse(readFileSync(join(this.devices, file), 'utf8'))];
        } catch {
          return [];
        }
      });
  }
}
export function sessionToken(cookie?: string): string | undefined {
  return cookie
    ?.split(';')
    .map((x) => x.trim())
    .find((x) => x.startsWith('codex_phone='))
    ?.slice('codex_phone='.length);
}
export function sessionCookie(token: string, secure: boolean, clear = false): string {
  return `codex_phone=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 30 * 86400}${secure ? '; Secure' : ''}`;
}

/** Count attempts before checking credentials. Trust the socket address, never X-Forwarded-For. */
export class PairingLimiter {
  private buckets = new Map<string, { count: number; reset: number }>();
  constructor(private now = Date.now) {}
  allow(address: string): boolean {
    const now = this.now();
    for (const [key, value] of this.buckets) if (value.reset <= now) this.buckets.delete(key);
    const item = this.buckets.get(address) ?? { count: 0, reset: now + 60_000 };
    if (this.buckets.size >= 1000 && !this.buckets.has(address)) return false;
    item.count++;
    this.buckets.set(address, item);
    return item.count <= 10;
  }
}
