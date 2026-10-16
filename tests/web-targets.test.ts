import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, type api } from '../web/api.js';
import {
  loadTargetDirectory,
  StaleTargetRequest,
  TargetRequestScope,
  targetPath,
} from '../web/targets.js';
import { readDraft, safeImageUrl, storeDraft } from '../web/state.js';
import type { Bootstrap, TargetSummary } from '../shared/protocol.js';

const connection = { connected: true, message: 'ready', sharedBackend: true as const };
const capabilities = { images: true, planMode: true, liveControl: true };
const target: TargetSummary = {
  id: 'local',
  name: '本机',
  kind: 'local',
  connection,
  capabilities,
};
const boot: Bootstrap = {
  device: { id: 'device', name: 'browser', createdAt: 1, expiresAt: 2 },
  projects: [],
  connection,
  capabilities,
};

test('target directory falls back only for an explicitly missing endpoint', async () => {
  const paths: string[] = [];
  const legacy = await loadTargetDirectory((async (path: string) => {
    paths.push(path);
    if (path === '/targets') throw new ApiError('not found', 404);
    return boot;
  }) as typeof api);
  assert.deepEqual(paths, ['/targets', '/bootstrap']);
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.targets[0].id, 'local');
  for (const status of [401, 403, 500, 503]) {
    const requests: string[] = [];
    await assert.rejects(
      loadTargetDirectory((async (path: string) => {
        requests.push(path);
        throw new ApiError('unavailable', status);
      }) as typeof api),
      (error: unknown) => error instanceof ApiError && error.status === status,
    );
    assert.deepEqual(requests, ['/targets']);
  }
  const current = await loadTargetDirectory((async () => ({ data: [target] })) as typeof api);
  assert.equal(current.legacy, false);
  await assert.rejects(
    loadTargetDirectory((async () => ({ data: [] })) as typeof api),
    /列表不完整/,
  );
});

test('switch invalidates late data, uploads and 401 errors without affecting the next machine', async () => {
  const requests: {
    path: string;
    signal: AbortSignal;
    resolve(value: unknown): void;
    reject(error: unknown): void;
  }[] = [];
  const request = ((path: string, options: RequestInit) =>
    new Promise((resolve, reject) => {
      requests.push({ path, signal: options.signal as AbortSignal, resolve, reject });
    })) as typeof api;
  const first = new TargetRequestScope('a', false, request);
  const second = new TargetRequestScope('b', false, request);
  const staleList = assert.rejects(first.fetch('/threads'), StaleTargetRequest);
  const staleUpload = assert.rejects(
    first.fetch('/uploads', { method: 'POST', body: 'image' }),
    StaleTargetRequest,
  );
  first.invalidate();
  const next = second.fetch('/threads');
  requests[0].reject(new ApiError('expired', 401));
  requests[1].resolve({ id: 'same-id', url: '/api/v1/targets/a/uploads/same-id' });
  requests[2].resolve({ data: [{ id: 'same-thread', title: 'machine b' }] });
  await Promise.all([staleList, staleUpload]);
  assert.deepEqual(await next, { data: [{ id: 'same-thread', title: 'machine b' }] });
  assert.deepEqual(
    requests.map((item) => item.path),
    ['/targets/a/threads', '/targets/a/uploads', '/targets/b/threads'],
  );
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests[1].signal.aborted, true);
  assert.equal(requests[2].signal.aborted, false);
  assert.equal(targetPath('a/b', '/models'), '/targets/a%2Fb/models');
  assert.equal(targetPath('local', '/threads', true), '/threads');
});

test('local legacy draft migration and equal thread ids remain isolated by target', (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  t.after(() =>
    descriptor
      ? Object.defineProperty(globalThis, 'sessionStorage', descriptor)
      : Reflect.deleteProperty(globalThis, 'sessionStorage'),
  );
  values.set('codex-phone:draft:same', 'old local message');
  assert.equal(readDraft('same', 'remote'), '');
  assert.equal(readDraft('same', 'local'), 'old local message');
  assert.equal(values.has('codex-phone:draft:same'), false);
  storeDraft('same', 'remote draft', 'remote');
  storeDraft('same', 'local draft', 'local');
  assert.equal(readDraft('same', 'remote'), 'remote draft');
  assert.equal(readDraft('same', 'local'), 'local draft');
  storeDraft('same', '', 'remote');
  assert.equal(readDraft('same', 'remote'), '');
  assert.equal(readDraft('same', 'local'), 'local draft');
  storeDraft('b:c', 'one', 'a');
  storeDraft('c', 'two', 'a:b');
  assert.equal(readDraft('b:c', 'a'), 'one');
  assert.equal(readDraft('c', 'a:b'), 'two');
});

test('image rendering rejects another target and never lets remote history use the local upload alias', () => {
  const remote = '/api/v1/targets/remote/uploads/same-image.png';
  assert.equal(safeImageUrl(remote, 'remote'), remote);
  assert.equal(safeImageUrl(remote, 'local'), undefined);
  assert.equal(safeImageUrl('/api/v1/uploads/same-image.png', 'remote'), undefined);
  assert.equal(
    safeImageUrl('/api/v1/uploads/same-image.png', 'local'),
    '/api/v1/uploads/same-image.png',
  );
  assert.equal(
    safeImageUrl('/api/v1/targets/local/uploads/same-image.png'),
    '/api/v1/targets/local/uploads/same-image.png',
  );
  for (const url of [
    'https://tracker.example/i.png',
    '//tracker.example/i.png',
    '/api/v1/targets/remote/uploads/../secret',
    '/api/v1/targets/remote/uploads/a?target=local',
  ])
    assert.equal(safeImageUrl(url, 'remote'), undefined);
});
