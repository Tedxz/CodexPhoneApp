import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ClientType, Device } from '../shared/protocol.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const safeId = /^[a-f0-9-]{36}$/;
interface Credential {
  tokenHash: string;
  origin: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt?: number;
}
interface DeviceRecord {
  id: string;
  name: string;
  createdAt: number;
  expiresAt: number;
  tokenHash?: string; // Read compatibility for pre-identity records.
  clientKeyHash?: string;
  clientType?: ClientType;
  credentials?: Credential[];
}
interface PairOptions {
  clientKey?: string;
  clientType?: ClientType;
  sessionToken?: string;
  origin?: string;
}
export class AuthError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'INVALID_CLIENT_IDENTITY',
  ) {
    super(message);
  }
}
function validateIdentity(key: unknown, type: unknown): asserts key is string {
  if (
    typeof key !== 'string' ||
    !tokenPattern.test(key) ||
    typeof type !== 'string' ||
    !['harmony', 'browser'].includes(type)
  )
    throw new AuthError(400, '客户端身份无效');
}

export class AuthStore {
  private pairs: string;
  private devices: string;
  private lock: string;
  constructor(
    dataDir: string,
    private now = Date.now,
  ) {
    this.pairs = join(dataDir, 'pairings');
    this.devices = join(dataDir, 'devices');
    this.lock = join(dataDir, 'auth-locks');
    mkdirSync(this.pairs, { recursive: true, mode: 0o700 });
    mkdirSync(this.devices, { recursive: true, mode: 0o700 });
    mkdirSync(this.lock, { recursive: true, mode: 0o700 });
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
  pair(
    token: string,
    name: string,
    options: PairOptions = {},
  ): { token: string; device: Device } | null {
    const { clientKey, clientType, sessionToken, origin = '' } = options;
    if (clientKey !== undefined || clientType !== undefined)
      validateIdentity(clientKey, clientType);
    if (!tokenPattern.test(token)) return null;
    return this.mutate(() => {
      const file = join(this.pairs, hash(token) + '.json');
      let pairing: { expiresAt: number };
      try {
        pairing = JSON.parse(readFileSync(file, 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      const records = this.records();
      const current = this.find(records, sessionToken);
      const keyHash = clientKey ? hash(clientKey) : undefined;
      let record = keyHash ? records.find((x) => x.clientKeyHash === keyHash) : undefined;
      if (record && record.clientType !== clientType)
        throw new AuthError(409, '客户端类型与已有身份不一致');
      const claim = keyHash && current && !current.clientKeyHash ? current : undefined;
      // Validate before consuming; exchange is serialized across the LAN/Funnel processes.
      unlinkSync(file);
      if (pairing.expiresAt <= this.now()) return null;
      if (!record)
        record = claim ?? { id: randomUUID(), name: '', createdAt: this.now(), expiresAt: 0 };
      let credentials = this.credentials(record);
      if (claim) {
        const claimed = this.credentials(claim).map((c) => ({ ...c, origin: c.origin || origin }));
        credentials = record.id === claim.id ? claimed : [...credentials, ...claimed];
      }
      const session = randomBytes(32).toString('base64url');
      credentials = credentials.filter((c) => c.expiresAt > this.now() && c.origin !== origin);
      credentials.push({
        tokenHash: hash(session),
        origin,
        createdAt: this.now(),
        expiresAt: this.now() + 30 * 86400_000,
        lastSeenAt: this.now(),
      });
      record.name = name.trim().slice(0, 80) || '我的手机';
      record.clientKeyHash = keyHash;
      record.clientType = clientType;
      this.setCredentials(record, credentials);
      this.write(record);
      if (claim && claim.id !== record.id) this.remove(claim.id);
      return { token: session, device: this.publicDevice(record) };
    });
  }
  identify(
    token: string | undefined,
    clientKey: string,
    clientType: ClientType,
    origin = '',
  ): Device | null {
    validateIdentity(clientKey, clientType);
    return this.mutate(() => {
      const records = this.records();
      const current = this.find(records, token);
      if (!current) return null;
      const keyHash = hash(clientKey);
      if (current.clientKeyHash && current.clientKeyHash !== keyHash)
        throw new AuthError(
          409,
          '当前授权已绑定另一客户端，请重新配对',
          'CLIENT_IDENTITY_CONFLICT',
        );
      const target = records.find((x) => x.clientKeyHash === keyHash) ?? current;
      if (target.clientType && target.clientType !== clientType)
        throw new AuthError(409, '客户端类型与已有身份不一致');
      const digest = hash(token!);
      const claimed = this.credentials(current).map((c) =>
        c.tokenHash === digest ? { ...c, origin, lastSeenAt: this.now() } : c,
      );
      const credentials =
        target.id === current.id ? claimed : [...this.credentials(target), ...claimed];
      target.clientKeyHash = keyHash;
      target.clientType = clientType;
      this.setCredentials(
        target,
        credentials.filter((c) => c.expiresAt > this.now()),
      );
      this.write(target);
      if (target.id !== current.id) this.remove(current.id);
      return this.publicDevice(target);
    });
  }
  list(): Device[] {
    return this.records()
      .filter((x) => this.credentials(x).some((c) => c.expiresAt > this.now()))
      .map((x) => this.publicDevice(x));
  }
  authenticate(token: string | undefined): Device | null {
    const record = this.find(this.records(), token);
    return record ? this.publicDevice(record) : null;
  }
  touch(token: string | undefined): Device | null {
    const record = this.find(this.records(), token);
    if (!record) return null;
    const digest = hash(token!);
    const credential = this.credentials(record).find((c) => c.tokenHash === digest)!;
    if (credential.lastSeenAt !== undefined && this.now() - credential.lastSeenAt < 60_000)
      return this.publicDevice(record);
    return this.mutate(() => {
      // Re-read under the shared lock: a concurrent revoke must never be resurrected.
      const latest = this.find(this.records(), token);
      if (!latest) return null;
      const credentials = this.credentials(latest);
      const active = credentials.find((c) => c.tokenHash === digest)!;
      if (active.lastSeenAt === undefined || this.now() - active.lastSeenAt >= 60_000) {
        active.lastSeenAt = this.now();
        this.setCredentials(latest, credentials);
        this.write(latest);
      }
      return this.publicDevice(latest);
    });
  }
  revokeSession(token: string | undefined): boolean {
    return this.mutate(() => {
      const current = this.find(this.records(), token);
      return current ? this.remove(current.id) : false;
    });
  }
  revoke(id: string): boolean {
    if (!safeId.test(id)) return false;
    return this.mutate(() => this.remove(id));
  }
  private find(records: DeviceRecord[], token: string | undefined): DeviceRecord | undefined {
    if (!token || !tokenPattern.test(token)) return undefined;
    const digest = hash(token);
    return records.find((x) =>
      this.credentials(x).some((c) => c.tokenHash === digest && c.expiresAt > this.now()),
    );
  }
  private credentials(record: DeviceRecord): Credential[] {
    return (
      record.credentials ??
      (record.tokenHash
        ? [
            {
              tokenHash: record.tokenHash,
              origin: '',
              createdAt: record.createdAt,
              expiresAt: record.expiresAt,
            },
          ]
        : [])
    );
  }
  private setCredentials(record: DeviceRecord, credentials: Credential[]) {
    record.credentials = [...new Map(credentials.map((c) => [c.tokenHash, c])).values()];
    record.expiresAt = Math.max(0, ...record.credentials.map((c) => c.expiresAt));
    delete record.tokenHash;
  }
  private publicDevice(record: DeviceRecord): Device {
    const credentials = this.credentials(record).filter((c) => c.expiresAt > this.now());
    const seen = credentials.flatMap((c) => (c.lastSeenAt === undefined ? [] : [c.lastSeenAt]));
    // Explicit whitelist: private identity and credential fields never reach the API.
    return {
      id: record.id,
      name: record.name,
      createdAt: record.createdAt,
      expiresAt: Math.max(0, ...credentials.map((c) => c.expiresAt)),
      authorizationCount: credentials.length,
      ...(record.clientType ? { clientType: record.clientType } : {}),
      ...(seen.length ? { lastSeenAt: Math.max(...seen) } : {}),
    };
  }
  private write(record: DeviceRecord) {
    const temporary = join(this.devices, `.${record.id}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, join(this.devices, record.id + '.json'));
    } finally {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  private remove(id: string): boolean {
    try {
      unlinkSync(join(this.devices, id + '.json'));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  private records(): DeviceRecord[] {
    return readdirSync(this.devices)
      .filter((x) => /^[a-f0-9-]{36}\.json$/.test(x))
      .flatMap((file) => {
        try {
          return [JSON.parse(readFileSync(join(this.devices, file), 'utf8')) as DeviceRecord];
        } catch {
          return [];
        }
      });
  }
  private mutate<T>(operation: () => T): T {
    // File-backed bakery lock: each contender owns a unique, never-reused file.
    // Choosing (ticket 0) precedes ticket publication, so concurrent processes
    // order their read/modify/write cycles without stale-lock reclamation races.
    const owner = `${process.pid}-${randomUUID()}.json`;
    const file = join(this.lock, owner);
    const temporary = file + '.tmp';
    const deadline = Date.now() + 3000;
    const wait = new Int32Array(new SharedArrayBuffer(4));
    const contenders = (): { owner: string; ticket: number }[] =>
      readdirSync(this.lock)
        .filter((name) => /^\d+-[a-f0-9-]{36}\.json$/.test(name))
        .flatMap((name) => {
          const pid = Number(name.split('-')[0]);
          try {
            process.kill(pid, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
              try {
                unlinkSync(join(this.lock, name));
              } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
              }
              return [];
            }
          }
          try {
            const ticket: unknown = JSON.parse(readFileSync(join(this.lock, name), 'utf8')).ticket;
            return [
              {
                owner: name,
                ticket:
                  typeof ticket === 'number' && Number.isSafeInteger(ticket) && ticket >= 0
                    ? ticket
                    : 0,
              },
            ];
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
            if (error instanceof SyntaxError) return [{ owner: name, ticket: 0 }];
            throw error;
          }
        });
    try {
      writeFileSync(file, JSON.stringify({ ticket: 0 }), { flag: 'wx', mode: 0o600 });
      const ticket = Math.max(0, ...contenders().map((x) => x.ticket)) + 1;
      writeFileSync(temporary, JSON.stringify({ ticket }), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, file);
      while (
        contenders().some(
          (x) =>
            x.owner !== owner &&
            (x.ticket === 0 || x.ticket < ticket || (x.ticket === ticket && x.owner < owner)),
        )
      ) {
        if (Date.now() >= deadline)
          throw new AuthError(503, '授权数据正在更新，请稍后重试', 'AUTH_STORE_BUSY');
        Atomics.wait(wait, 0, 0, 10);
      }
      return operation();
    } finally {
      try {
        unlinkSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      try {
        unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
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
