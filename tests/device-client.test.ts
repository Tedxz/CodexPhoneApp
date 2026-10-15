import test from 'node:test';
import assert from 'node:assert/strict';
import {
  browserIdentityPayload,
  clientTypeLabel,
  createBrowserIdentityReader,
  identifyBrowserSession,
} from '../web/device-client.js';
import { ApiError } from '../web/api.js';
import type { Bootstrap } from '../shared/protocol.js';

const bootstrap: Bootstrap = {
  device: { id: 'legacy', name: 'My phone', createdAt: 1, expiresAt: 10 },
  projects: [],
  connection: { connected: true, message: 'Ready', sharedBackend: true },
  capabilities: { images: true, planMode: true, liveControl: true },
};
function memoryStorage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
}

test('browser identity survives a new page reader and re-pairing without depending on a cookie', () => {
  const storage = memoryStorage();
  let generations = 0;
  const random = (bytes: Uint8Array) => {
    generations++;
    assert.equal(bytes.length, 32);
    bytes.forEach((_, index) => {
      bytes[index] = index + 200;
    });
  };
  const read = createBrowserIdentityReader(() => storage, random);
  const first = read();
  assert.equal(first.clientKey?.length, 43);
  assert.match(first.clientKey!, /^[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(first.clientKey!, 'base64url').length, 32);
  assert.equal(first.notice, '');
  assert.deepEqual(createBrowserIdentityReader(() => storage, random)(), first);
  assert.deepEqual(read(), first);
  assert.equal(generations, 1);
  assert.deepEqual(browserIdentityPayload(first), {
    clientKey: first.clientKey,
    clientType: 'browser',
  });
  // An independent origin/browser profile must not accidentally share this identity.
  const other = createBrowserIdentityReader(
    () => memoryStorage(),
    (bytes) => bytes.fill(3),
  )();
  assert.notEqual(other.clientKey, first.clientKey);
});

test('invalid saved identities are replaced only after the replacement can be persisted', () => {
  const storage = memoryStorage('broken-or-old-format');
  const read = createBrowserIdentityReader(
    () => storage,
    (bytes) => bytes.fill(17),
  );
  assert.equal(read().clientKey, Buffer.alloc(32, 17).toString('base64url'));
  assert.equal(createBrowserIdentityReader(() => storage)().clientKey, read().clientKey);
});

test('denied or silently discarded persistence never supplies an ephemeral pairing identity', () => {
  for (const failure of ['access', 'write', 'discard'] as const) {
    let generations = 0;
    const read = createBrowserIdentityReader(
      () => {
        if (failure === 'access') throw new Error('Access denied');
        return {
          getItem: () => null,
          setItem: () => {
            if (failure === 'write') throw new Error('Quota exceeded');
          },
        };
      },
      () => {
        generations++;
      },
    );
    const first = read();
    assert.equal(first.clientKey, undefined);
    assert.match(first.notice, /无法保存/);
    assert.deepEqual(browserIdentityPayload(first), {});
    assert.equal(read(), first);
    assert.equal(generations, failure === 'access' ? 0 : 1);
  }
});

test('unavailable crypto leaves the existing browser session usable without weak random fallback', async () => {
  const identity = createBrowserIdentityReader(
    () => memoryStorage(),
    () => {
      throw new Error('Crypto unavailable');
    },
  )();
  const result = await identifyBrowserSession(bootstrap, identity, async () => {
    assert.fail('An unpersisted identity must not be sent to the server');
  });
  assert.equal(result.bootstrap, bootstrap);
  assert.match(result.notice, /无法保存/);
});

test('existing browser session adopts a merged device id and retains the rest of bootstrap', async () => {
  const identity = { clientKey: Buffer.alloc(32, 7).toString('base64url'), notice: '' };
  const identified = { ...bootstrap.device, id: 'canonical', clientType: 'browser' as const };
  const result = await identifyBrowserSession(bootstrap, identity, async (payload) => {
    assert.deepEqual(payload, { clientKey: identity.clientKey, clientType: 'browser' });
    return { device: identified };
  });
  assert.equal(result.bootstrap.device, identified);
  assert.equal(result.bootstrap.connection, bootstrap.connection);
  assert.equal(bootstrap.device.id, 'legacy');
  assert.equal(result.notice, '');
});

test('old gateways and temporary migration failures preserve login with an explicit notice; expiry does not', async () => {
  const identity = { clientKey: Buffer.alloc(32, 7).toString('base64url'), notice: '' };
  for (const status of [404, 403, 503]) {
    const result = await identifyBrowserSession(bootstrap, identity, async () => {
      throw new ApiError(`Request rejected: ${identity.clientKey}`, status);
    });
    assert.equal(result.bootstrap, bootstrap);
    assert.match(result.notice, status === 404 ? /更新网关/ : /暂未同步/);
    assert.ok(!result.notice.includes(identity.clientKey));
  }
  await assert.rejects(
    identifyBrowserSession(bootstrap, identity, async () => {
      throw new ApiError('Session expired', 401);
    }),
    (error: unknown) => error instanceof ApiError && error.status === 401,
  );
});

test('device labels distinguish the native app, browser and unidentified legacy grants', () => {
  assert.equal(clientTypeLabel(bootstrap.device), '旧版授权');
  assert.equal(clientTypeLabel({ ...bootstrap.device, clientType: 'browser' }), '浏览器');
  assert.equal(clientTypeLabel({ ...bootstrap.device, clientType: 'harmony' }), 'HarmonyOS App');
});
