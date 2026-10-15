import { asset } from '@kit.AssetStoreKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { isSessionCookie, normalizeOrigin } from './Endpoint';

export class AuthSession {
  origin: string;
  cookie: string;
  deviceName: string;

  constructor(origin: string = '', cookie: string = '', deviceName: string = '') {
    this.origin = origin;
    this.cookie = cookie;
    this.deviceName = deviceName;
  }
}

interface VaultData {
  version: number;
  lastOrigin: string;
  sessions: AuthSession[];
}

// Only the non-sensitive constant alias is stored as an unencrypted asset
// attribute. Origins, device labels and cookies are all in encrypted SECRET.
// SYNC_TYPE.NEVER prevents credentials from migrating to another device.
export class SessionVault {
  private readonly alias: string = 'codex-phone.sessions.v1';
  private readonly clientAlias: string = 'codex-phone.installation.v1';
  private clientKeyTask: Promise<string> | undefined = undefined;

  // Installation identity is separate from the bounded cookie vault. Logout
  // removes origin credentials only; this random, non-syncing key stays stable.
  // It identifies a client after authentication and never grants access itself.
  async clientKey(): Promise<string> {
    if (this.clientKeyTask) return this.clientKeyTask;
    const task = this.readOrCreateClientKey();
    this.clientKeyTask = task;
    try { return await task; }
    finally { if (this.clientKeyTask === task) this.clientKeyTask = undefined; }
  }

  private async readClientKey(): Promise<string> {
    const query: asset.AssetMap = new Map();
    query.set(asset.Tag.ALIAS, this.encode(this.clientAlias));
    query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
    try {
      const found = await asset.query(query);
      if (found.length === 0) return '';
      const secret = found[0].get(asset.Tag.SECRET);
      if (!(secret instanceof Uint8Array)) throw new Error('invalid');
      const value = util.TextDecoder.create('utf-8').decodeToString(secret);
      if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('invalid');
      return value;
    } catch (caught) {
      if ((caught as BusinessError).code === 24000002) return '';
      throw new Error('无法读取客户端身份，请解锁手机后重试。');
    }
  }

  private async readOrCreateClientKey(): Promise<string> {
    const existing = await this.readClientKey();
    if (existing) return existing;
    let value = '';
    try {
      const random = cryptoFramework.createRandom().generateRandomSync(32);
      value = new util.Base64Helper().encodeToStringSync(random.data, util.Type.BASIC_URL_SAFE).replace(/=+$/, '');
      if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('invalid');
    } catch { throw new Error('无法生成安全的客户端身份，请重试。'); }
    const attributes: asset.AssetMap = new Map();
    attributes.set(asset.Tag.ALIAS, this.encode(this.clientAlias));
    attributes.set(asset.Tag.SECRET, this.encode(value));
    attributes.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_UNLOCKED);
    attributes.set(asset.Tag.AUTH_TYPE, asset.AuthType.NONE);
    attributes.set(asset.Tag.SYNC_TYPE, asset.SyncType.NEVER);
    attributes.set(asset.Tag.CONFLICT_RESOLUTION, asset.ConflictResolution.THROW_ERROR);
    try { await asset.add(attributes); }
    catch (caught) {
      // Another vault instance may have created the identity while we waited.
      // Never overwrite it with a second identity for the same installation.
      if ((caught as BusinessError).code === 24000003) {
        const saved = await this.readClientKey();
        if (saved) return saved;
      }
      throw new Error('无法保存客户端身份，请解锁手机后重试。');
    }
    return value;
  }

  async load(): Promise<AuthSession | undefined> {
    const data = await this.read();
    return data.sessions.find((session: AuthSession) => session.origin === data.lastOrigin);
  }

  async loadOrigin(origin: string): Promise<AuthSession | undefined> {
    const normalized = normalizeOrigin(origin);
    const data = await this.read();
    return data.sessions.find((session: AuthSession) => session.origin === normalized);
  }

  async save(session: AuthSession): Promise<void> {
    const origin = normalizeOrigin(session.origin);
    if (!isSessionCookie(session.cookie)) throw new Error('登录凭据格式无效，请重新配对。');
    const data = await this.read();
    data.sessions = data.sessions.filter((item: AuthSession) => item.origin !== origin);
    data.sessions.push(new AuthSession(origin, session.cookie, session.deviceName.slice(0, 80)));
    // Small bounded vault, below Asset Store's 1024-byte SECRET limit.
    while (data.sessions.length > 2) data.sessions.shift();
    data.lastOrigin = origin;
    await this.write(data);
  }

  async clear(origin: string): Promise<void> {
    const normalized = normalizeOrigin(origin);
    const data = await this.read();
    data.sessions = data.sessions.filter((item: AuthSession) => item.origin !== normalized);
    if (data.lastOrigin === normalized) data.lastOrigin = data.sessions.length > 0 ? data.sessions[data.sessions.length - 1].origin : '';
    if (data.sessions.length > 0) {
      await this.write(data);
      return;
    }
    const query: asset.AssetMap = new Map();
    query.set(asset.Tag.ALIAS, this.encode(this.alias));
    try {
      await asset.remove(query);
    } catch (caught) {
      const error = caught as BusinessError;
      if (error.code !== 24000002) throw new Error('无法清除系统中的登录凭据，请重试。');
    }
  }

  private async read(): Promise<VaultData> {
    const query: asset.AssetMap = new Map();
    query.set(asset.Tag.ALIAS, this.encode(this.alias));
    query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
    try {
      const found = await asset.query(query);
      if (found.length === 0) return this.empty();
      const secret = found[0].get(asset.Tag.SECRET);
      if (!(secret instanceof Uint8Array)) throw new Error('凭据数据无效。');
      const data = JSON.parse(util.TextDecoder.create('utf-8').decodeToString(secret)) as VaultData;
      if (data.version !== 1 || !Array.isArray(data.sessions) || typeof data.lastOrigin !== 'string') throw new Error('凭据数据无效。');
      data.sessions.forEach((session: AuthSession) => {
        if (normalizeOrigin(session.origin) !== session.origin || !isSessionCookie(session.cookie)) throw new Error('凭据数据无效。');
      });
      return data;
    } catch (caught) {
      const error = caught as BusinessError;
      if (error.code === 24000002) return this.empty();
      throw new Error('无法读取系统安全存储，请解锁手机后重试。');
    }
  }

  private async write(data: VaultData): Promise<void> {
    const bytes = this.encode(JSON.stringify(data));
    if (bytes.byteLength > 1024) throw new Error('保存的连接信息过长，请缩短设备名称或先移除旧连接。');
    const attributes: asset.AssetMap = new Map();
    attributes.set(asset.Tag.ALIAS, this.encode(this.alias));
    attributes.set(asset.Tag.SECRET, bytes);
    attributes.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_UNLOCKED);
    attributes.set(asset.Tag.AUTH_TYPE, asset.AuthType.NONE);
    attributes.set(asset.Tag.SYNC_TYPE, asset.SyncType.NEVER);
    attributes.set(asset.Tag.CONFLICT_RESOLUTION, asset.ConflictResolution.OVERWRITE);
    try {
      await asset.add(attributes);
    } catch {
      throw new Error('无法将登录凭据保存到系统安全存储，本次连接仍可使用，重启后需重新配对。');
    }
  }

  private encode(value: string): Uint8Array {
    return new util.TextEncoder().encodeInto(value);
  }

  private empty(): VaultData {
    return { version: 1, lastOrigin: '', sessions: [] };
  }
}
