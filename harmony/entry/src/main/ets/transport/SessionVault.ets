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

export class ServerProfile extends AuthSession {
  id: string;
  name: string;
  lastTargetId: string;
  updatedAt: number;

  constructor(id: string, origin: string, cookie: string = '', deviceName: string = '', name: string = '', lastTargetId: string = 'local', updatedAt: number = Date.now()) {
    super(origin, cookie, deviceName);
    this.id = id;
    this.name = name || origin;
    this.lastTargetId = lastTargetId;
    this.updatedAt = updatedAt;
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
  private migrationTask: Promise<void> | undefined = undefined;
  private writeTask: Promise<void> = Promise.resolve();
  private readonly profileLabel: string = 'codex-phone.server.v2';

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

  async list(): Promise<ServerProfile[]> {
    if (!this.migrationTask) this.migrationTask = this.migrate();
    const task = this.migrationTask;
    try { await task; }
    catch (error) { if (this.migrationTask === task) this.migrationTask = undefined; throw error as Error; }
    return this.readProfiles();
  }

  async load(): Promise<AuthSession | undefined> {
    const profiles = await this.list();
    return profiles.filter((profile: ServerProfile) => !!profile.cookie)
      .sort((a: ServerProfile, b: ServerProfile) => b.updatedAt - a.updatedAt)[0];
  }

  async loadOrigin(origin: string): Promise<AuthSession | undefined> {
    const normalized = normalizeOrigin(origin);
    return (await this.list()).find((profile: ServerProfile) => profile.origin === normalized);
  }

  async save(session: AuthSession): Promise<void> {
    const profiles = await this.list();
    const saved = profiles.find((profile: ServerProfile) => profile.origin === normalizeOrigin(session.origin));
    await this.saveProfile(new ServerProfile(saved?.id || util.generateRandomUUID(true), session.origin, session.cookie,
      session.deviceName, saved?.name || session.origin, saved?.lastTargetId || 'local'));
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.writeTask.catch(() => {}).then(task);
    this.writeTask = next;
    return next;
  }

  async saveProfile(profile: ServerProfile): Promise<void> {
    return this.enqueue(() => this.writeProfile(profile));
  }

  private async writeProfile(profile: ServerProfile): Promise<void> {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile.id)) throw new Error('Server 标识无效。');
    const origin = normalizeOrigin(profile.origin);
    if (profile.cookie && !isSessionCookie(profile.cookie)) throw new Error('登录凭据格式无效，请重新配对。');
    const saved = new ServerProfile(profile.id, origin, profile.cookie, profile.deviceName.slice(0, 80),
      profile.name.trim().slice(0, 80) || origin, profile.lastTargetId, profile.updatedAt);
    const bytes = this.encode(JSON.stringify(saved));
    if (bytes.byteLength > 1024) throw new Error('单个 Server 连接信息过长，请缩短名称或地址。');
    const attributes: asset.AssetMap = new Map();
    attributes.set(asset.Tag.ALIAS, this.encode(`codex-phone.server.${profile.id}`));
    attributes.set(asset.Tag.DATA_LABEL_NORMAL_1, this.encode(this.profileLabel));
    attributes.set(asset.Tag.SECRET, bytes);
    attributes.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_UNLOCKED);
    attributes.set(asset.Tag.AUTH_TYPE, asset.AuthType.NONE);
    attributes.set(asset.Tag.SYNC_TYPE, asset.SyncType.NEVER);
    attributes.set(asset.Tag.CONFLICT_RESOLUTION, asset.ConflictResolution.OVERWRITE);
    try { await asset.add(attributes); }
    catch { throw new Error('无法保存 Server 登录凭据，请解锁手机后重试。'); }
  }

  async remove(id: string): Promise<void> {
    await this.enqueue(() => this.removeAlias(`codex-phone.server.${id}`));
  }

  // Logout clears this origin's authorization, but keeps the saved Server.
  async clear(origin: string, expectedCookie?: string): Promise<void> {
    const normalized = normalizeOrigin(origin);
    await this.list();
    await this.enqueue(async () => {
      const saved = (await this.readProfiles()).find((profile: ServerProfile) => profile.origin === normalized);
      if (!saved || (expectedCookie !== undefined && saved.cookie !== expectedCookie)) return;
      await this.writeProfile(new ServerProfile(saved.id, saved.origin, '', saved.deviceName, saved.name, saved.lastTargetId, saved.updatedAt));
    });
  }

  private async migrate(): Promise<void> {
    const legacy = await this.read();
    if (legacy.sessions.length === 0) return;
    const existing = await this.readProfiles();
    for (const session of legacy.sessions) {
      if (existing.some((profile: ServerProfile) => profile.origin === session.origin)) continue;
      const profile = new ServerProfile(util.generateRandomUUID(true), session.origin, session.cookie,
        session.deviceName, session.origin, 'local', session.origin === legacy.lastOrigin ? Date.now() : 0);
      await this.saveProfile(profile);
      existing.push(profile);
    }
    // Keep v1 until every independent v2 asset is durable. Retrying after a
    // partial failure finds existing origins and never overwrites newer cookies.
    await this.removeAlias(this.alias);
  }

  private async readProfiles(): Promise<ServerProfile[]> {
    const query: asset.AssetMap = new Map();
    query.set(asset.Tag.DATA_LABEL_NORMAL_1, this.encode(this.profileLabel));
    // The system rejects bulk plaintext queries. Enumerate public aliases,
    // then decrypt each profile with a separate exact-alias query.
    query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ATTRIBUTES);
    query.set(asset.Tag.RETURN_LIMIT, 40);
    try {
      const all: asset.AssetMap[] = [];
      while (true) {
        if (all.length > 0) query.set(asset.Tag.RETURN_OFFSET, all.length);
        let found: asset.AssetMap[];
        try { found = await asset.query(query); }
        catch (caught) {
          if ((caught as BusinessError).code === 24000002) break;
          throw caught as Error;
        }
        all.push(...found);
        if (found.length < 40) break;
      }
      const profiles: ServerProfile[] = [];
      for (const attributes of all) {
        const alias = attributes.get(asset.Tag.ALIAS);
        if (!(alias instanceof Uint8Array)) throw new Error('invalid');
        const exact: asset.AssetMap = new Map();
        exact.set(asset.Tag.ALIAS, alias);
        exact.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
        const entries = await asset.query(exact);
        if (entries.length !== 1) throw new Error('invalid');
        const secret = entries[0].get(asset.Tag.SECRET);
        if (!(secret instanceof Uint8Array)) throw new Error('invalid');
        const value = JSON.parse(util.TextDecoder.create('utf-8').decodeToString(secret)) as ServerProfile;
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value.id) || normalizeOrigin(value.origin) !== value.origin ||
          (value.cookie && !isSessionCookie(value.cookie)) || typeof value.name !== 'string') throw new Error('invalid');
        if (util.TextDecoder.create('utf-8').decodeToString(alias) !== `codex-phone.server.${value.id}`) throw new Error('invalid');
        profiles.push(new ServerProfile(value.id, value.origin, value.cookie, value.deviceName, value.name, value.lastTargetId, value.updatedAt));
      }
      return profiles;
    } catch (caught) {
      if ((caught as BusinessError).code === 24000002) return [];
      const code = (caught as BusinessError).code;
      if (code === 24000005) throw new Error('无法读取系统安全存储，请解锁手机后重试。');
      throw new Error(`无法读取系统安全存储${typeof code === 'number' ? `（${code}）` : ''}，请重试。`);
    }
  }

  private async removeAlias(alias: string): Promise<void> {
    const query: asset.AssetMap = new Map();
    query.set(asset.Tag.ALIAS, this.encode(alias));
    try { await asset.remove(query); }
    catch (caught) {
      if ((caught as BusinessError).code !== 24000002) throw new Error('无法清除系统中的登录凭据，请重试。');
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

  private encode(value: string): Uint8Array {
    return new util.TextEncoder().encodeInto(value);
  }

  private empty(): VaultData {
    return { version: 1, lastOrigin: '', sessions: [] };
  }
}
