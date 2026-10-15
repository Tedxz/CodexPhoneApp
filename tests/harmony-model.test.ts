import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import type {
  Bootstrap,
  Device,
  EventEnvelope,
  ThreadSnapshot,
  ThreadSummary,
  WorkspaceSummary,
} from '../shared/protocol';

// Execute the actual pure ArkTS source and the transport against native API
// doubles. This exercises wire behavior while device/SDK checks cover ArkTS.
function nativeModule<T>(entry: string, kits = new Map<string, object>()): T {
  const base = resolve('harmony/entry/src/main/ets');
  const cache = new Map<string, object>();
  function load(filename: string): object {
    const hit = cache.get(filename);
    if (hit) return hit;
    const exports: Record<string, unknown> = {};
    cache.set(filename, exports);
    const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const requireNative = (name: string): object => {
      const kit = kits.get(name);
      if (kit) return kit;
      if (name.startsWith('.')) return load(resolve(dirname(filename), `${name}.ets`));
      if (!kit) throw new Error(`Unexpected native kit: ${name}`);
      return kit;
    };
    new Function('exports', 'require', 'Observed', compiled)(
      exports,
      requireNative,
      (value: object) => value,
    );
    return exports;
  }
  return load(resolve(base, `${entry}.ets`)) as T;
}

interface EndpointModule {
  normalizeOrigin(value: string): string;
  parseConnectionInput(value: string): { origin: string; token: string };
  extractSessionCookie(value: string): string;
  safeImagePath(value: string): boolean;
}

const endpoint = nativeModule<EndpointModule>('transport/Endpoint');
const token = 'a'.repeat(43);
const installationKey = 'b'.repeat(43);

test('Harmony origins normalize ports and restrict plaintext to local/private hosts', () => {
  assert.equal(endpoint.normalizeOrigin(' HTTPS://Example.COM:443/ '), 'https://example.com');
  assert.equal(endpoint.normalizeOrigin('http://192.168.2.3:8787/'), 'http://192.168.2.3:8787');
  assert.equal(
    endpoint.normalizeOrigin('http://100.94.205.104:8787'),
    'http://100.94.205.104:8787',
  );
  assert.equal(endpoint.normalizeOrigin('http://mac.local:8787'), 'http://mac.local:8787');
  assert.equal(endpoint.normalizeOrigin('http://[fd00::1]:8787'), 'http://[fd00::1]:8787');
  for (const value of [
    'http://example.com',
    'http://100.128.0.1',
    'http://010.0.0.1',
    'http://192.168.1.300',
    'https://user:pass@example.com',
    'https://example.com/path',
    'https://example.com/?token=secret',
    'https://example.com:0',
    'https://example.com:65536',
    'file:///tmp/secrets',
  ])
    assert.throws(() => endpoint.normalizeOrigin(value), value);
});

test('Harmony pairing fragments and image paths cannot become credential-bearing external URLs', () => {
  assert.deepEqual(endpoint.parseConnectionInput(`https://example.com/#pair=${token}`), {
    origin: 'https://example.com',
    token,
  });
  assert.throws(() => endpoint.parseConnectionInput(`https://example.com/?pair=${token}`));
  assert.throws(() => endpoint.parseConnectionInput('https://example.com/#other=1'));
  assert.equal(
    endpoint.extractSessionCookie(`codex_phone=${token}; Path=/; HttpOnly`),
    `codex_phone=${token}`,
  );
  assert.equal(
    endpoint.extractSessionCookie(
      JSON.stringify({ 'set-cookie': [`codex_phone=${token}; Secure`] }),
    ),
    `codex_phone=${token}`,
  );
  assert.equal(endpoint.extractSessionCookie(`not_codex_phone=${token}`), '');
  assert.equal(endpoint.safeImagePath('/api/v1/uploads/a_1-b.png'), true);
  for (const value of [
    'https://evil.test/image.png',
    '//evil.test/x',
    '/api/v1/uploads/../secret',
    '/api/v1/uploads/a?redirect=1',
  ]) {
    assert.equal(endpoint.safeImagePath(value), false);
  }
});

interface NativeTracker {
  record(event: EventEnvelope): void;
  reconcile(
    current: ThreadSnapshot | undefined,
    incoming: ThreadSnapshot,
    prepend?: boolean,
  ): ThreadSnapshot;
}
interface StateModule {
  SnapshotTracker: new () => NativeTracker;
  EventCursor: new () => { accept(event: EventEnvelope): string };
  mergeItems: typeof import('../web/state').mergeItems;
}
const state = nativeModule<StateModule>('model/State');

function snapshot(text: string, seq: number): ThreadSnapshot {
  return {
    thread: {
      id: 'thread',
      title: 'Test',
      preview: '',
      cwd: '/repo',
      status: 'active',
      updatedAt: 1,
    },
    items: [{ id: 'message', turnId: 'turn', type: 'agentMessage', role: 'assistant', text }],
    nextCursor: null,
    pendingRequests: [],
    eventCursor: { epoch: 'epoch', seq },
  };
}

function delta(seq: number, text: string): EventEnvelope {
  return {
    type: 'event',
    epoch: 'epoch',
    seq,
    event: {
      type: 'item.delta',
      threadId: 'thread',
      itemId: 'message',
      turnId: 'turn',
      delta: text,
    },
  };
}

test('Harmony snapshot reconciliation preserves live deltas once across snapshot and history races', () => {
  const tracker = new state.SnapshotTracker();
  tracker.record(delta(2, ' B'));
  const current = snapshot('A B', 2);
  const next = tracker.reconcile(current, snapshot('A', 1));
  assert.equal(next.items[0].text, 'A B');
  const oldPage = snapshot('', 1);
  oldPage.items = [{ id: 'older', turnId: 'old-turn', type: 'userMessage', text: 'Old' }];
  const withHistory = tracker.reconcile(current, oldPage, true);
  assert.deepEqual(
    withHistory.items.map((item) => item.text),
    ['Old', 'A B'],
  );
});

test('Harmony cursors detect epoch/gap changes and settle cached running items after interruption', () => {
  const cursor = new state.EventCursor();
  assert.equal(cursor.accept(delta(1, 'A')), 'apply');
  assert.equal(cursor.accept(delta(1, 'A')), 'duplicate');
  assert.equal(cursor.accept(delta(3, 'B')), 'resync');
  assert.equal(cursor.accept({ ...delta(1, 'C'), epoch: 'new' }), 'resync');
  const tracker = new state.SnapshotTracker();
  tracker.record(delta(3, 'B'));
  assert.throws(() =>
    tracker.reconcile(undefined, { ...snapshot('A', 1), eventCursor: { epoch: 'old', seq: 1 } }),
  );
  const items = state.mergeItems(
    [
      {
        id: 'command',
        turnId: 'turn',
        type: 'commandExecution',
        text: 'sleep',
        status: 'inProgress',
      },
    ],
    [{ id: 'outcome:turn', turnId: 'turn', type: 'notice', text: '', status: 'interrupted' }],
  );
  assert.equal(items[0].status, 'interrupted');
});

interface NativeResponse {
  responseCode: number;
  result: string | ArrayBuffer;
  cookies: string;
  header: object;
}
interface NativeOptions {
  method: string;
  header: Record<string, string>;
  extraData?: string | ArrayBuffer;
  expectDataType: string;
  usingCache: boolean;
  maxRedirects?: number;
}
interface NativeApi {
  origin: string;
  cookie: string;
  pair(token: string, name: string, clientKey: string): Promise<{ id: string }>;
  identify(clientKey: string): Promise<Device>;
  bootstrap(): Promise<object>;
  threads(search?: string, cwd?: string, cursor?: string): Promise<object>;
  upload(bytes: ArrayBuffer, mime: string): Promise<object>;
  image(path: string): Promise<ArrayBuffer>;
}
interface GatewayModule {
  GatewayApi: new (origin: string, cookie?: string) => NativeApi;
  GatewayError: new (message: string, status: number) => Error & { status: number };
}

function mockedGateway() {
  const requests: { url: string; options: NativeOptions }[] = [];
  let response: NativeResponse = { responseCode: 200, result: '{}', cookies: '', header: {} };
  let destroyed = 0;
  const kits = new Map<string, object>([
    ['@kit.BasicServicesKit', { deviceInfo: { sdkApiVersion: 26 } }],
    [
      '@kit.ArkTS',
      {
        util: {
          TextDecoder: {
            create: () => ({
              decodeToString: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
            }),
          },
        },
      },
    ],
    [
      '@kit.NetworkKit',
      {
        http: {
          RequestMethod: { GET: 'GET', POST: 'POST', DELETE: 'DELETE' },
          HttpDataType: { STRING: 'string', ARRAY_BUFFER: 'arraybuffer' },
          createHttp: () => {
            let headersCallback: ((headers: object) => void) | undefined;
            return {
              on: (_name: string, callback: (headers: object) => void) => {
                headersCallback = callback;
              },
              destroy: () => {
                destroyed++;
              },
              request: async (url: string, options: NativeOptions) => {
                requests.push({ url, options });
                headersCallback?.(response.header);
                return response;
              },
            };
          },
        },
      },
    ],
  ]);
  const module = nativeModule<GatewayModule>('transport/GatewayApi', kits);
  return {
    ...module,
    requests,
    setResponse(value: Partial<NativeResponse>) {
      response = { ...response, ...value };
    },
    destroyed: () => destroyed,
  };
}

test('Harmony native HTTP exchanges cookie and sends origin-bound authenticated JSON/pagination requests', async () => {
  const mocked = mockedGateway();
  const api = new mocked.GatewayApi('https://example.com/');
  mocked.setResponse({
    result: '{"device":{"id":"device"}}',
    cookies: `codex_phone=${token}; HttpOnly; Secure`,
  });
  assert.equal((await api.pair(token, '手机', installationKey)).id, 'device');
  assert.equal(api.cookie, `codex_phone=${token}`);
  assert.equal(mocked.requests[0].options.header.Origin, 'https://example.com');
  assert.equal(mocked.requests[0].options.header['X-Codex-Phone'], '1');
  assert.equal(mocked.requests[0].url.includes(token), false);
  assert.deepEqual(JSON.parse(mocked.requests[0].options.extraData as string), {
    token,
    name: '手机',
    clientKey: installationKey,
    clientType: 'harmony',
  });
  mocked.setResponse({ result: '{"data":[],"nextCursor":null}', cookies: '' });
  await api.threads('标题', '', 'next/cursor');
  const request = mocked.requests[1];
  assert.equal(request.options.header.Cookie, `codex_phone=${token}`);
  assert.equal(request.options.usingCache, false);
  assert.equal(request.options.maxRedirects, 0);
  assert.equal(
    request.url,
    'https://example.com/api/v1/threads?search=%E6%A0%87%E9%A2%98&cwd=&cursor=next%2Fcursor',
  );
  assert.equal(mocked.destroyed(), 2);
});

test('Harmony client identification requires an existing origin-bound cookie and never leaks its key in URLs or other requests', async () => {
  const mocked = mockedGateway();
  const api = new mocked.GatewayApi('https://example.com');
  await assert.rejects(api.identify(installationKey), /先登录/);
  await assert.rejects(api.pair('', '手机', installationKey), /配对凭据/);
  assert.equal(mocked.requests.length, 0);
  api.cookie = `codex_phone=${token}`;
  mocked.setResponse({ result: '{"device":{"id":"merged-client","name":"手机"}}' });
  const device = await api.identify(installationKey);
  assert.equal(device.id, 'merged-client');
  const request = mocked.requests[0];
  assert.equal(request.url, 'https://example.com/api/v1/devices/current/identify');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.header.Cookie, `codex_phone=${token}`);
  assert.equal(request.options.header['X-Codex-Phone'], '1');
  assert.deepEqual(JSON.parse(request.options.extraData as string), {
    clientKey: installationKey,
    clientType: 'harmony',
  });
  assert.equal(api.cookie, `codex_phone=${token}`);
  await api.bootstrap();
  await api.threads();
  for (const ordinary of mocked.requests.slice(1)) {
    assert.equal(JSON.stringify(ordinary).includes(installationKey), false);
  }
  const otherOrigin = new mocked.GatewayApi('https://another.example');
  await assert.rejects(otherOrigin.identify(installationKey), /先登录/);
  assert.equal(mocked.requests.length, 3);
});

test('Harmony native HTTP guards image ownership, MIME, size, redirects and expired sessions', async () => {
  const mocked = mockedGateway();
  const api = new mocked.GatewayApi('http://192.168.0.2:8787', `codex_phone=${token}`);
  await assert.rejects(api.image('https://evil.test/a'), /不属于当前网关/);
  await assert.rejects(api.upload(new ArrayBuffer(1), 'text/plain'), /PNG/);
  await assert.rejects(api.upload(new ArrayBuffer(10 * 1024 * 1024 + 1), 'image/png'), /10 MiB/);
  assert.equal(mocked.requests.length, 0);
  mocked.setResponse({ result: new Uint8Array([1, 2, 3]).buffer });
  assert.deepEqual(
    new Uint8Array(await api.image('/api/v1/uploads/test.png')),
    new Uint8Array([1, 2, 3]),
  );
  assert.equal(mocked.requests[0].options.header.Cookie, `codex_phone=${token}`);
  mocked.setResponse({
    responseCode: 401,
    result: '{"error":{"code":"UNAUTHORIZED","message":"请重新配对"}}',
  });
  await assert.rejects(
    api.bootstrap(),
    (error: Error & { status?: number }) =>
      error instanceof mocked.GatewayError && error.status === 401,
  );
  mocked.setResponse({ responseCode: 302, result: '', header: { Location: 'https://evil.test' } });
  await assert.rejects(api.bootstrap(), /跳转/);
  mocked.setResponse({ responseCode: 200, result: '<html>proxy</html>', header: {} });
  await assert.rejects(api.bootstrap(), /格式无效/);
});

interface NativeSession {
  origin: string;
  cookie: string;
  deviceName: string;
}
interface VaultModule {
  AuthSession: new (origin?: string, cookie?: string, name?: string) => NativeSession;
  SessionVault: new () => {
    save(session: NativeSession): Promise<void>;
    load(): Promise<NativeSession | undefined>;
    loadOrigin(origin: string): Promise<NativeSession | undefined>;
    clientKey(): Promise<string>;
    clear(origin: string): Promise<void>;
  };
}

function mockedVault() {
  const entries = new Map<string, Map<string, Uint8Array | number>>();
  let readFailure = false;
  let writeFailure = false;
  let randomCalls = 0;
  const alias = (value: Map<string, Uint8Array | number>) =>
    new TextDecoder().decode(value.get('alias') as Uint8Array);
  const kits = new Map<string, object>([
    ['@kit.BasicServicesKit', { deviceInfo: { sdkApiVersion: 26 } }],
    [
      '@kit.ArkTS',
      {
        util: {
          TextEncoder: class {
            encodeInto(text: string) {
              return new TextEncoder().encode(text);
            }
          },
          TextDecoder: {
            create: () => ({
              decodeToString: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
            }),
          },
          Base64Helper: class {
            encodeToStringSync(bytes: Uint8Array) {
              return Buffer.from(bytes).toString('base64url');
            }
          },
          Type: { BASIC_URL_SAFE: 2 },
        },
      },
    ],
    [
      '@kit.AssetStoreKit',
      {
        asset: {
          Tag: {
            ALIAS: 'alias',
            SECRET: 'secret',
            RETURN_TYPE: 'return',
            ACCESSIBILITY: 'access',
            AUTH_TYPE: 'auth',
            SYNC_TYPE: 'sync',
            CONFLICT_RESOLUTION: 'conflict',
          },
          ReturnType: { ALL: 0 },
          Accessibility: { DEVICE_UNLOCKED: 2 },
          AuthType: { NONE: 0 },
          SyncType: { NEVER: 0 },
          ConflictResolution: { OVERWRITE: 0, THROW_ERROR: 1 },
          query: async (query: Map<string, Uint8Array | number>) => {
            if (readFailure) throw { code: 24000005 };
            const stored = entries.get(alias(query));
            if (!stored) throw { code: 24000002 };
            return [stored];
          },
          add: async (value: Map<string, Uint8Array | number>) => {
            if (writeFailure) throw { code: 24000005 };
            if (value.get('conflict') === 1 && entries.has(alias(value))) {
              throw { code: 24000003 };
            }
            entries.set(alias(value), value);
          },
          remove: async (query: Map<string, Uint8Array | number>) => {
            entries.delete(alias(query));
          },
        },
      },
    ],
    [
      '@kit.CryptoArchitectureKit',
      {
        cryptoFramework: {
          createRandom: () => ({
            generateRandomSync: (length: number) => {
              randomCalls++;
              assert.equal(length, 32);
              return { data: new Uint8Array(length).fill(randomCalls) };
            },
          }),
        },
      },
    ],
  ]);
  const module = nativeModule<VaultModule>('transport/SessionVault', kits);
  return {
    ...module,
    entries,
    randomCalls: () => randomCalls,
    setReadFailure: (value: boolean) => {
      readFailure = value;
    },
    setWriteFailure: (value: boolean) => {
      writeFailure = value;
    },
  };
}

test('Harmony session vault stores all connection details only in Asset Store SECRET and never falls back on failure', async () => {
  const module = mockedVault();
  const vault = new module.SessionVault();
  assert.equal(await vault.load(), undefined);
  await vault.save(new module.AuthSession('https://example.com', `codex_phone=${token}`, '手机'));
  assert.equal((await vault.load())?.cookie, `codex_phone=${token}`);
  const stored = module.entries.get('codex-phone.sessions.v1');
  assert.ok(stored);
  assert.equal(
    new TextDecoder().decode(stored.get('alias') as Uint8Array).includes('example.com'),
    false,
  );
  assert.equal(stored.get('sync'), 0);
  assert.equal(stored.get('access'), 2);
  module.setReadFailure(true);
  await assert.rejects(vault.load(), /安全存储/);
  await assert.rejects(
    vault.save(new module.AuthSession('https://example.com', `codex_phone=${token}`, '手机')),
    /安全存储/,
  );
  module.setReadFailure(false);
  await vault.clear('https://example.com');
  assert.equal(await vault.load(), undefined);
});

test('Harmony installation identity survives vault recreation, both gateway origins and logout without entering session metadata', async () => {
  const module = mockedVault();
  const vault = new module.SessionVault();
  const [first, concurrent] = await Promise.all([vault.clientKey(), vault.clientKey()]);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(concurrent, first);
  assert.equal(module.randomCalls(), 1);
  const identity = module.entries.get('codex-phone.installation.v1');
  assert.ok(identity);
  assert.equal(identity.get('sync'), 0);
  assert.equal(identity.get('access'), 2);
  assert.equal(identity.get('conflict'), 1);
  assert.equal(new TextDecoder().decode(identity.get('secret') as Uint8Array), first);
  for (const [tag, value] of identity) {
    if (tag !== 'secret' && value instanceof Uint8Array) {
      assert.equal(new TextDecoder().decode(value).includes(first), false);
    }
  }
  await vault.save(
    new module.AuthSession('http://192.168.0.2:8787', `codex_phone=${token}`, '手机'),
  );
  await vault.save(new module.AuthSession('https://example.com', `codex_phone=${token}`, '手机'));
  assert.equal((await vault.loadOrigin('https://example.com'))?.cookie, `codex_phone=${token}`);
  assert.equal(await vault.loadOrigin('https://other.example'), undefined);
  assert.equal(
    new TextDecoder()
      .decode(module.entries.get('codex-phone.sessions.v1')!.get('secret') as Uint8Array)
      .includes(first),
    false,
  );
  await vault.clear('https://example.com');
  await vault.clear('http://192.168.0.2:8787');
  const restarted = new module.SessionVault();
  assert.equal(await restarted.load(), undefined);
  assert.equal(await restarted.clientKey(), first);
  assert.equal(module.randomCalls(), 1);
});

test('Harmony concurrent vaults converge on one persisted identity and never fabricate identity when secure storage fails', async () => {
  const module = mockedVault();
  const a = new module.SessionVault();
  const b = new module.SessionVault();
  const keys = await Promise.all([a.clientKey(), b.clientKey()]);
  assert.equal(keys[0], keys[1]);
  assert.equal(module.entries.size, 1);
  module.setReadFailure(true);
  await assert.rejects(a.clientKey(), /客户端身份/);
  module.setReadFailure(false);
  module.entries.clear();
  module.setWriteFailure(true);
  await assert.rejects(a.clientKey(), /保存客户端身份/);
  assert.equal(module.entries.size, 0);
  module.setWriteFailure(false);
  const saved = await a.clientKey();
  assert.equal(await b.clientKey(), saved);
});

interface NativeLive {
  connect(): void;
  command(method: string, params: string): Promise<string>;
  close(): void;
}
interface NativeLiveHandlers {
  status(connected: boolean): void;
  event(envelope: EventEnvelope): void;
  resync(): void;
  unauthorized(): void;
}
interface NativeLiveModule {
  NativeLiveClient: new (
    api: Pick<NativeApi, 'origin' | 'cookie' | 'bootstrap'>,
    handlers: NativeLiveHandlers,
  ) => NativeLive;
}

test('Harmony native live client authenticates WSS, filters duplicate events and never replays uncertain commands', async () => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const sent: string[] = [];
  const endpoints: {
    endpoint: string;
    headers: Record<string, string>;
    supportOriginPort?: boolean;
  }[] = [];
  let nextId = 1;
  const socket = {
    on(name: string, callback: (...args: unknown[]) => void) {
      listeners.set(name, callback);
    },
    off(name: string) {
      listeners.delete(name);
    },
    async connect(
      endpoint: string,
      options: { header: Record<string, string>; supportOriginPort?: boolean },
    ) {
      endpoints.push({
        endpoint,
        headers: options.header,
        supportOriginPort: options.supportOriginPort,
      });
      return true;
    },
    async send(payload: string) {
      sent.push(payload);
      return true;
    },
    async close() {
      return true;
    },
  };
  const kits = new Map<string, object>([
    ['@kit.BasicServicesKit', { deviceInfo: { sdkApiVersion: 26 } }],
    ['@kit.ArkTS', { util: { generateRandomUUID: () => `request-${nextId++}` } }],
    ['@kit.NetworkKit', { webSocket: { createWebSocket: () => socket }, http: {} }],
  ]);
  const module = nativeModule<NativeLiveModule>('transport/NativeLiveClient', kits);
  let resyncs = 0;
  let unauthorized = 0;
  const statuses: boolean[] = [];
  const events: EventEnvelope[] = [];
  const client = new module.NativeLiveClient(
    { origin: 'https://example.com', cookie: `codex_phone=${token}`, bootstrap: async () => ({}) },
    {
      status: (value) => statuses.push(value),
      event: (event) => events.push(event),
      resync: () => {
        resyncs++;
      },
      unauthorized: () => {
        unauthorized++;
      },
    },
  );
  try {
    client.connect();
    listeners.get('open')?.(undefined, {});
    assert.equal(endpoints[0].endpoint, 'wss://example.com/api/v1/ws');
    assert.equal(endpoints[0].headers.Cookie, `codex_phone=${token}`);
    assert.equal(endpoints[0].headers.Origin, undefined);
    assert.equal(endpoints[0].supportOriginPort, true);
    assert.equal(resyncs, 1);
    listeners.get('message')?.(undefined, JSON.stringify(delta(1, 'A')));
    listeners.get('message')?.(undefined, JSON.stringify(delta(1, 'A')));
    listeners.get('message')?.(undefined, JSON.stringify(delta(3, 'B')));
    assert.equal(events.length, 2);
    assert.equal(resyncs, 2);
    const successful = client.command('thread.subscribe', '{"threadId":"thread"}');
    const request = JSON.parse(sent[0]) as { id: string };
    listeners.get('message')?.(
      undefined,
      JSON.stringify({ id: request.id, result: { subscribed: true } }),
    );
    assert.equal(await successful, '{"subscribed":true}');
    const uncertain = client.command('turn.send', '{"threadId":"thread","text":"hello"}');
    const rejection = assert.rejects(uncertain, /结果尚未确认/);
    listeners.get('close')?.(undefined, { code: 4401, reason: 'revoked' });
    await rejection;
    assert.equal(unauthorized, 1);
    client.connect();
    assert.equal(endpoints.length, 1);
    assert.equal(sent.length, 2);
    assert.deepEqual(statuses, [true, false]);
    await assert.rejects(client.command('turn.send', '{}'), /尚未恢复/);
  } finally {
    client.close();
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function connectedBootstrap(): Bootstrap {
  return {
    device: { id: 'phone', name: '手机', createdAt: 0, expiresAt: 100 },
    projects: [{ id: 'project', name: 'Project', path: '/repo' }],
    connection: { connected: true, message: '已连接', sharedBackend: true },
    capabilities: { images: true, planMode: true, liveControl: true },
  };
}

interface ThreadPageResult {
  data: ThreadSummary[];
  nextCursor: string | null;
}
interface StorePreferences {
  get(key: string, fallback: string): Promise<string>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  flush(): Promise<void>;
}
interface StoreApi {
  origin: string;
  cookie: string;
  bootstrap(): Promise<Bootstrap>;
  identify(clientKey: string): Promise<Device>;
  pair(token: string, name: string, clientKey: string): Promise<Device>;
  threads(search: string, cwd?: string, cursor?: string): Promise<ThreadPageResult>;
  workspaces(): Promise<{ data: WorkspaceSummary[] }>;
  models(): Promise<{ data: object[] }>;
  devices(): Promise<{ data: Device[] }>;
  snapshot(id: string, cursor?: string): Promise<ThreadSnapshot>;
  revoke(id: string): Promise<void>;
}
interface StoreContext {
  cacheDir: string;
  eventHub: {
    on(name: string, callback: () => void): void;
    off(name: string, callback: () => void): void;
  };
}
interface NativeAppStore {
  boot?: Bootstrap;
  api?: StoreApi;
  client?: NativeLive;
  drafts?: StorePreferences;
  selected: string;
  live: boolean;
  checked: boolean;
  error: string;
  notice: string;
  mode: string;
  workspace: string | null;
  search: string;
  searchTimer: number;
  draft: string;
  snapshot?: ThreadSnapshot;
  threads: ThreadSummary[];
  sending: boolean;
  busy: boolean;
  olderBusy: boolean;
  uploading: boolean;
  devices: Device[];
  endpoint: string;
  pairToken: string;
  deviceName: string;
  pair(): Promise<void>;
  loadList(cursor?: string): Promise<void>;
  selectWorkspace(cwd: string): void;
  chooseThread(id: string): Promise<void>;
  setDraft(text: string): void;
  initialize(context: StoreContext): Promise<void>;
  refresh(): Promise<void>;
  send(): Promise<void>;
  loadOlder(): Promise<void>;
  loadDevices(): Promise<void>;
  revokeDevice(id: string): Promise<void>;
  interrupt(): Promise<void>;
  answerRequest(id: string, decision: string, answers: object[]): Promise<void>;
  forget(): Promise<void>;
  dispose(): void;
}

function mockedStore() {
  const preferences = new Map<string, string>();
  const savedSessions = new Map<string, NativeSession>([
    [
      'https://example.com',
      { origin: 'https://example.com', cookie: `codex_phone=${token}`, deviceName: '手机' },
    ],
  ]);
  const calls = {
    identify: [] as { origin: string; cookie: string; key: string }[],
    pair: [] as { origin: string; cookie: string; key: string; token: string; name: string }[],
    cleared: [] as string[],
  };
  const prefs: StorePreferences = {
    get: async (key, fallback) => preferences.get(key) ?? fallback,
    put: async (key, value) => {
      preferences.set(key, value);
    },
    delete: async (key) => {
      preferences.delete(key);
    },
    flush: async () => {},
  };
  const responses = {
    bootstrap: async (): Promise<Bootstrap> => connectedBootstrap(),
    identify: async (): Promise<Device> => connectedBootstrap().device,
    pair: async (): Promise<Device> => connectedBootstrap().device,
    save: async (_session: NativeSession): Promise<void> => {},
    clientKey: async (): Promise<string> => installationKey,
    threads: async (
      _search: string,
      _cwd?: string,
      _cursor?: string,
    ): Promise<ThreadPageResult> => ({ data: [], nextCursor: null }),
    command: async (_method: string, _params: string): Promise<string> =>
      JSON.stringify(snapshot('confirmed', 4)),
    devices: async (): Promise<{ data: Device[] }> => ({ data: [] }),
    snapshot: async (_id: string, _cursor?: string): Promise<ThreadSnapshot> =>
      snapshot('confirmed', 4),
    revoke: async (_id: string): Promise<void> => {},
  };
  class FakeGatewayError extends Error {
    constructor(
      message: string,
      public status: number,
    ) {
      super(message);
    }
  }
  class FakeGateway implements StoreApi {
    constructor(
      public origin: string,
      public cookie: string = '',
    ) {}
    bootstrap() {
      return responses.bootstrap();
    }
    identify(key: string) {
      calls.identify.push({ origin: this.origin, cookie: this.cookie, key });
      return responses.identify();
    }
    async pair(pairingToken: string, name: string, key: string) {
      calls.pair.push({ origin: this.origin, cookie: this.cookie, key, token: pairingToken, name });
      const device = await responses.pair();
      this.cookie = `codex_phone=${'c'.repeat(43)}`;
      return device;
    }
    threads(search: string, cwd?: string, cursor?: string) {
      return responses.threads(search, cwd, cursor);
    }
    async workspaces() {
      return { data: [] };
    }
    async models() {
      return { data: [] };
    }
    devices() {
      return responses.devices();
    }
    snapshot(id: string, cursor?: string) {
      return responses.snapshot(id, cursor);
    }
    revoke(id: string) {
      return responses.revoke(id);
    }
  }
  class FakeLive implements NativeLive {
    closed = false;
    constructor(
      _api: StoreApi,
      private handlers: NativeLiveHandlers,
    ) {}
    connect() {
      queueMicrotask(() => {
        if (this.closed) return;
        this.handlers.status(true);
        this.handlers.resync();
      });
    }
    command(method: string, params: string) {
      return responses.command(method, params);
    }
    close() {
      this.closed = true;
    }
  }
  const kits = new Map<string, object>([
    ['@kit.ArkData', { preferences: { getPreferences: async () => prefs } }],
    ['@kit.CoreFileKit', { fileIo: {} }],
    ['@kit.MediaLibraryKit', { photoAccessHelper: {} }],
    ['@kit.ImageKit', { image: {} }],
    ['../transport/GatewayApi', { GatewayApi: FakeGateway, GatewayError: FakeGatewayError }],
    ['../transport/NativeLiveClient', { NativeLiveClient: FakeLive }],
    [
      '../transport/SessionVault',
      {
        AuthSession: class {
          constructor(
            public origin: string,
            public cookie: string,
            public deviceName: string,
          ) {}
        },
        SessionVault: class {
          async load() {
            return savedSessions.get('https://example.com');
          }
          async loadOrigin(origin: string) {
            return savedSessions.get(origin);
          }
          clientKey() {
            return responses.clientKey();
          }
          async save(session: NativeSession) {
            await responses.save(session);
            savedSessions.set(session.origin, session);
          }
          async clear(origin: string) {
            calls.cleared.push(origin);
            savedSessions.delete(origin);
          }
        },
      },
    ],
  ]);
  const module = nativeModule<{ AppStore: new () => NativeAppStore }>('state/AppStore', kits);
  const store = new module.AppStore();
  const api = new FakeGateway('https://example.com', `codex_phone=${token}`);
  const context: StoreContext = { cacheDir: '/unused-test-cache', eventHub: { on() {}, off() {} } };
  function activate() {
    store.api = api;
    store.drafts = prefs;
    store.boot = connectedBootstrap();
    store.live = true;
    store.client = new FakeLive(api, { status() {}, event() {}, resync() {}, unauthorized() {} });
  }
  return {
    store,
    responses,
    preferences,
    savedSessions,
    calls,
    context,
    activate,
    unauthorized: () => new FakeGatewayError('旧登录已失效', 401),
    gatewayError: (status: number) => new FakeGatewayError('identity unavailable', status),
  };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('Harmony upgrades an authenticated legacy login in place and follows its merged client ID', async () => {
  const { store, responses, calls, context } = mockedStore();
  let device = connectedBootstrap().device;
  responses.bootstrap = async () => ({ ...connectedBootstrap(), device });
  responses.identify = async () => {
    device = { ...device, id: 'same-installation', clientType: 'harmony', authorizationCount: 2 };
    return device;
  };
  try {
    await store.initialize(context);
    await tick();
    assert.equal(store.boot?.device.id, 'same-installation');
    assert.equal(store.boot?.device.authorizationCount, 2);
    assert.equal(store.api?.cookie, `codex_phone=${token}`);
    assert.deepEqual(calls.identify, [
      { origin: 'https://example.com', cookie: `codex_phone=${token}`, key: installationKey },
    ]);
    assert.deepEqual(calls.pair, []);
    assert.deepEqual(calls.cleared, []);
  } finally {
    store.dispose();
  }
});

test('Harmony sends no installation identity before authenticated bootstrap succeeds', async () => {
  const { store, responses, calls, context, unauthorized } = mockedStore();
  responses.bootstrap = async () => {
    throw unauthorized();
  };
  try {
    await store.initialize(context);
    assert.equal(calls.identify.length, 0);
    assert.equal(calls.pair.length, 0);
    assert.equal(store.boot, undefined);
    assert.deepEqual(calls.cleared, ['https://example.com']);
  } finally {
    store.dispose();
  }
});

test('Harmony skips missing identity APIs and preserves an authenticated login on identity or secure storage failures', async () => {
  for (const failure of [404, 401, 500, 'vault']) {
    const { store, responses, calls, context, gatewayError } = mockedStore();
    if (failure === 'vault')
      responses.clientKey = async () => {
        throw new Error('安全存储不可用');
      };
    else
      responses.identify = async () => {
        throw gatewayError(failure as number);
      };
    try {
      await store.initialize(context);
      await tick();
      assert.equal(store.boot?.device.id, 'phone', String(failure));
      assert.equal(store.api?.cookie, `codex_phone=${token}`, String(failure));
      assert.deepEqual(calls.cleared, [], String(failure));
      if (failure === 404) {
        assert.equal(store.notice, '');
        assert.equal(calls.identify.length, 1);
      } else {
        assert.match(store.notice, /已有登录仍可使用/);
        responses.clientKey = async () => installationKey;
        responses.identify = async () => connectedBootstrap().device;
        await store.refresh();
        await tick();
        assert.equal(store.notice, '');
      }
    } finally {
      store.dispose();
    }
  }
});

test('Harmony re-pairing restores only the selected origin cookie and retains cookie-save warnings', async () => {
  for (const origin of ['https://example.com', 'https://other.example']) {
    const { store, responses, calls } = mockedStore();
    responses.save = async () => {
      throw new Error('登录凭据保存失败，重启后需重新配对。');
    };
    store.endpoint = origin;
    store.pairToken = token;
    store.deviceName = 'Mate 90 Pro Max';
    try {
      await store.pair();
      assert.deepEqual(calls.pair, [
        {
          origin,
          cookie: origin === 'https://example.com' ? `codex_phone=${token}` : '',
          key: installationKey,
          token,
          name: 'Mate 90 Pro Max',
        },
      ]);
      assert.match(store.notice, /保存失败/);
      assert.equal(store.boot?.device.id, 'phone');
      assert.equal(store.pairToken, '');
    } finally {
      store.dispose();
    }
  }
});

test('Harmony ignores identity results after logout and never uses client type or recent-use labels as online presence', async () => {
  const { store, responses, context, calls } = mockedStore();
  const pending = deferred<Device>();
  responses.identify = async () => pending.promise;
  try {
    const initializing = store.initialize(context);
    await tick();
    assert.equal(calls.identify.length, 1);
    await store.forget();
    pending.resolve({ ...connectedBootstrap().device, id: 'late-client' });
    await initializing;
    assert.equal(store.boot, undefined);
    assert.equal(store.api, undefined);
    assert.equal(store.live, false);
  } finally {
    store.dispose();
  }
  const theme = nativeModule<{
    clientTypeLabel(type?: string): string;
    lastUsedLabel(time?: number): string;
  }>('components/Theme');
  assert.equal(theme.clientTypeLabel('harmony'), 'HarmonyOS App');
  assert.equal(theme.clientTypeLabel('browser'), '浏览器');
  assert.equal(theme.clientTypeLabel(undefined), '旧版授权');
  assert.equal(theme.lastUsedLabel(undefined), '最近使用未知');
  assert.equal(theme.lastUsedLabel(0), '最近使用未知');
  assert.equal(theme.lastUsedLabel(Number.NaN), '最近使用未知');
  assert.match(theme.lastUsedLabel(1780000000000), /^最近使用 · /);
});

test('Harmony native store ignores late list and thread replies after the user changes directory or session', async () => {
  const { store, responses, activate } = mockedStore();
  activate();
  try {
    const oldList = deferred<ThreadPageResult>();
    const newThread = { ...snapshot('new', 1).thread, id: 'new', cwd: '/new' };
    responses.threads = async (_search, cwd) =>
      cwd === '/new' ? { data: [newThread], nextCursor: null } : oldList.promise;
    store.mode = 'all';
    store.search = 'old';
    const previous = store.loadList();
    store.selectWorkspace('/new');
    clearTimeout(store.searchTimer);
    await store.loadList();
    oldList.resolve({ data: [snapshot('old', 1).thread], nextCursor: 'old-page' });
    await previous;
    assert.equal(store.threads[0].id, 'new');
    assert.equal(store.workspace, '/new');
    const oldSnapshot = deferred<string>();
    responses.command = async (_method, params) => {
      const id = (JSON.parse(params) as { threadId: string }).threadId;
      if (id === 'old') return oldSnapshot.promise;
      const fresh = snapshot('latest', 1);
      fresh.thread.id = id;
      return JSON.stringify(fresh);
    };
    const oldChoice = store.chooseThread('old');
    await tick();
    await store.chooseThread('new');
    const stale = snapshot('stale', 1);
    stale.thread.id = 'old';
    oldSnapshot.resolve(JSON.stringify(stale));
    await oldChoice;
    assert.equal(store.snapshot?.thread.id, 'new');
    assert.equal(store.snapshot?.items[0].text, 'latest');
  } finally {
    store.dispose();
  }
});

test('Harmony native store can restore a saved login after the first offline bootstrap fails', async () => {
  const { store, responses, context } = mockedStore();
  let bootstraps = 0;
  responses.bootstrap = async () => {
    bootstraps++;
    if (bootstraps === 1) throw new Error('离线');
    return connectedBootstrap();
  };
  try {
    await store.initialize(context);
    assert.equal(store.checked, true);
    assert.equal(store.boot, undefined);
    await store.refresh();
    await tick();
    await store.refresh();
    const recovered = store.boot as Bootstrap | undefined;
    assert.equal(recovered?.device.id, 'phone');
    assert.equal(store.live, true);
    assert.ok(bootstraps >= 2 && bootstraps <= 5);
  } finally {
    store.dispose();
  }
});

test('Harmony native store preserves a newer draft typed while send acknowledgement is pending', async () => {
  const { store, responses, preferences, activate } = mockedStore();
  activate();
  const pending = deferred<string>();
  responses.command = async (method) =>
    method === 'turn.send' ? pending.promise : JSON.stringify(snapshot('confirmed', 4));
  store.selected = 'thread';
  store.snapshot = snapshot('previous', 1);
  store.draft = 'submitted';
  try {
    const sending = store.send();
    assert.equal(store.sending, true);
    store.setDraft('new follow-up');
    pending.resolve('{"turnId":"turn"}');
    await sending;
    assert.equal(store.draft, 'new follow-up');
    assert.equal(preferences.get('https://example.com|thread'), 'new follow-up');
    assert.equal(store.sending, false);
  } finally {
    store.dispose();
  }
});

test('Harmony native store ignores device/history replies from a login that has already been replaced', async () => {
  for (const request of ['devices', 'history']) {
    for (const outcome of ['success', 'unauthorized']) {
      const { store, responses, activate, unauthorized } = mockedStore();
      activate();
      const pending = deferred<void>();
      responses.devices = async () => {
        await pending.promise;
        return { data: [{ id: 'old-device', name: '旧设备', createdAt: 0, expiresAt: 100 }] };
      };
      responses.snapshot = async () => {
        await pending.promise;
        return snapshot('old-history', 1);
      };
      store.selected = 'thread';
      store.snapshot = snapshot('old', 1);
      store.snapshot.nextCursor = 'older';
      try {
        const work = request === 'devices' ? store.loadDevices() : store.loadOlder();
        await store.forget();
        activate();
        store.boot!.device.id = 'new-device';
        store.snapshot = snapshot('new', 2);
        store.error = '';
        if (outcome === 'success') pending.resolve();
        else pending.reject(unauthorized());
        await work;
        assert.equal(store.boot?.device.id, 'new-device', `${request}/${outcome}`);
        assert.deepEqual(store.devices, [], `${request}/${outcome}`);
        assert.equal(store.snapshot?.items[0].text, 'new', `${request}/${outcome}`);
        assert.equal(store.error, '', `${request}/${outcome}`);
      } finally {
        store.dispose();
      }
    }
  }
});

test('Harmony stale mutation replies cannot refresh a replacement login or clear its in-flight action state', async () => {
  for (const operation of ['interrupt', 'answer', 'revoke']) {
    for (const outcome of ['success', 'failure']) {
      const { store, responses, activate } = mockedStore();
      activate();
      const pending = deferred<void>();
      let subscriptions = 0;
      responses.command = async (method) => {
        if (method === 'thread.subscribe') {
          subscriptions++;
          return JSON.stringify(snapshot('response', 1));
        }
        await pending.promise;
        return '{}';
      };
      responses.revoke = async () => {
        await pending.promise;
      };
      store.selected = 'thread';
      store.snapshot = snapshot('old', 1);
      store.snapshot.thread.activeTurnId = 'turn';
      try {
        const work =
          operation === 'interrupt'
            ? store.interrupt()
            : operation === 'answer'
              ? store.answerRequest('request', 'accept', [])
              : store.revokeDevice('phone');
        assert.equal(store.busy, true);
        await store.forget();
        assert.equal(store.busy, false);
        activate();
        store.selected = 'thread';
        store.boot!.device.id = 'new-device';
        store.busy = true;
        store.error = '';
        if (outcome === 'success') pending.resolve();
        else pending.reject(new Error('old operation failed'));
        await work;
        assert.equal(store.boot?.device.id, 'new-device', `${operation}/${outcome}`);
        assert.equal(store.busy, true, `${operation}/${outcome}`);
        assert.equal(subscriptions, 0, `${operation}/${outcome}`);
        assert.equal(store.error, '', `${operation}/${outcome}`);
      } finally {
        store.dispose();
      }
    }
  }
});

test('Harmony delayed draft reads cannot resurrect an old selection with the same thread ID after pairing changes', async () => {
  const { store, activate } = mockedStore();
  activate();
  const pending = deferred<string>();
  store.drafts!.get = async () => pending.promise;
  try {
    const choosing = store.chooseThread('same-thread-id');
    await tick();
    await store.forget();
    activate();
    store.selected = 'same-thread-id';
    store.draft = 'new-session-draft';
    store.snapshot = snapshot('new-session', 2);
    pending.resolve('old-session-draft');
    await choosing;
    assert.equal(store.draft, 'new-session-draft');
    assert.equal(store.snapshot?.items[0].text, 'new-session');
  } finally {
    store.dispose();
  }
});

const emptyRolloutError =
  'failed to read thread: thread-store internal error: failed to read session metadata /sessions/rollout-test.jsonl: rollout at /sessions/rollout-test.jsonl is empty';

test('Harmony retries only the fresh rollout subscription read and sends the user message exactly once', async () => {
  const { store, responses, activate } = mockedStore();
  activate();
  const commands: string[] = [];
  let subscriptions = 0;
  responses.command = async (method) => {
    commands.push(method);
    if (method === 'turn.send') return '{"turnId":"turn"}';
    if (++subscriptions < 3) throw new Error(emptyRolloutError);
    return JSON.stringify(snapshot('real response', 4));
  };
  store.selected = 'thread';
  store.snapshot = snapshot('previous', 1);
  store.draft = 'send once';
  try {
    await store.send();
    assert.deepEqual(commands, [
      'turn.send',
      'thread.subscribe',
      'thread.subscribe',
      'thread.subscribe',
    ]);
    assert.equal(store.snapshot?.items[0].text, 'real response');
    assert.equal(store.error, '');
    assert.equal(store.draft, '');
  } finally {
    store.dispose();
  }
});

test('Harmony caps empty-rollout retries and distinguishes an acknowledged send from a failed synchronization', async () => {
  for (const readError of [emptyRolloutError, 'permission denied reading session']) {
    const { store, responses, activate } = mockedStore();
    activate();
    const commands: string[] = [];
    responses.command = async (method) => {
      commands.push(method);
      if (method === 'turn.send') return '{"turnId":"turn"}';
      throw new Error(readError);
    };
    store.selected = 'thread';
    store.snapshot = snapshot('previous', 1);
    store.draft = 'already acknowledged';
    try {
      await store.send();
      assert.equal(commands.filter((method) => method === 'turn.send').length, 1);
      assert.equal(
        commands.filter((method) => method === 'thread.subscribe').length,
        readError === emptyRolloutError ? 3 : 1,
      );
      assert.match(store.notice, /消息已发送.*同步.*不要重复发送/);
      assert.equal(store.error, '');
      assert.equal(store.draft, '');
    } finally {
      store.dispose();
    }
  }
});

test('Harmony abandons delayed subscribe retries when the selected session or login changes', async () => {
  for (const change of ['selection', 'login']) {
    const { store, responses, activate } = mockedStore();
    activate();
    const firstRead = deferred<void>();
    let oldReads = 0;
    let sends = 0;
    responses.command = async (method, params) => {
      if (method === 'turn.send') {
        sends++;
        return '{"turnId":"turn"}';
      }
      const id = (JSON.parse(params) as { threadId: string }).threadId;
      if (id === 'thread') {
        oldReads++;
        firstRead.resolve();
        throw new Error(emptyRolloutError);
      }
      const incoming = snapshot('new selection', 4);
      incoming.thread.id = id;
      return JSON.stringify(incoming);
    };
    store.selected = 'thread';
    store.snapshot = snapshot('previous', 1);
    store.draft = 'send once';
    try {
      const sending = store.send();
      await firstRead.promise;
      await tick();
      if (change === 'login') {
        await store.forget();
        activate();
      }
      await store.chooseThread('other-thread');
      await sending;
      assert.equal(oldReads, 1, change);
      assert.equal(sends, 1, change);
      assert.equal(store.snapshot?.thread.id, 'other-thread', change);
      assert.equal(store.snapshot?.items[0].text, 'new selection', change);
    } finally {
      store.dispose();
    }
  }
});
