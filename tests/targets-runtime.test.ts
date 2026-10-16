import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, type Config, type SshTargetConfig } from '../server/config.js';
import type { CodexAdapter } from '../server/codex.js';
import { TargetManager } from '../server/targets.js';
import type { SftpTransfer, SshTunnel, TunnelState } from '../server/ssh.js';
import { UploadStore } from '../server/uploads.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJVkAAAAASUVORK5CYII=',
  'base64',
);
const remote: SshTargetConfig = {
  id: 'remote',
  name: 'Remote',
  sshHost: 'my-alias',
  socketPath: '/home/test/.codex/control.sock',
  projects: [{ id: 'p', name: 'Remote project', path: '/does-not-exist-here/project' }],
  uploadDir: '/home/test/.codex-phone/uploads',
};
class FakeAdapter extends EventEmitter {
  connection = { connected: false, sharedBackend: true as const, message: 'offline' };
  capabilities = { images: true, planMode: true, liveControl: true };
  listGate: Promise<void> = Promise.resolve();
  lists = 0;
  closed = 0;
  async connect() {
    this.connection = { ...this.connection, connected: true };
    this.emit('event', { type: 'connection', connection: this.connection });
  }
  async listThreads() {
    this.lists++;
    await this.listGate;
    return { data: [], nextCursor: null };
  }
  close() {
    this.closed++;
    this.connection = { ...this.connection, connected: false };
    this.emit('event', { type: 'connection', connection: this.connection });
  }
}
class FakeTunnel extends EventEmitter {
  socketPath = '/not-a-real-tunnel';
  state: TunnelState = { ready: false, stage: 'stopped', message: 'stopped' };
  start() {
    this.set({ ready: true, stage: 'ssh_ready', message: 'SSH ready' });
  }
  set(state: TunnelState) {
    this.state = state;
    this.emit('state', state);
  }
  async close() {
    this.set({ ready: false, stage: 'stopped', message: 'closed' });
  }
}
class FakeTransfer {
  calls: [string, string][] = [];
  failure = false;
  async probe() {}
  async upload(local: string, remote: string) {
    this.calls.push([local, remote]);
    if (this.failure) throw new Error('SFTP failed');
  }
  async remove() {}
  async close() {}
}
function fixture(imagePreparationTimeoutMs?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'phone-targets-'));
  const local = new FakeAdapter();
  const adapter = new FakeAdapter();
  const tunnel = new FakeTunnel();
  const transfer = new FakeTransfer();
  const config: Config = {
    host: '127.0.0.1',
    port: 8787,
    publicUrl: 'http://localhost:8787',
    allowedOrigins: [],
    socketPath: '/local',
    projects: [],
    dataDir: dir,
    sshTargets: [remote],
  };
  const manager = new TargetManager(config, local as unknown as CodexAdapter, {
    codexFactory: () => adapter as unknown as CodexAdapter,
    tunnelFactory: () => tunnel as unknown as SshTunnel,
    transferFactory: () => transfer as unknown as SftpTransfer,
    imagePreparationTimeoutMs,
  });
  return {
    dir,
    local,
    adapter,
    tunnel,
    transfer,
    manager,
    async close() {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('remote config validates identities and absolute paths without local filesystem lookup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-config-'));
  const file = join(dir, 'config.json');
  const write = (target: unknown) =>
    writeFileSync(file, JSON.stringify({ projects: [{ path: dir }], sshTargets: [target] }));
  try {
    write(remote);
    const config = loadConfig(file);
    assert.equal(config.sshTargets?.[0].projects[0].path, '/does-not-exist-here/project');
    assert.equal(config.sshTargets?.[0].uploadDir, remote.uploadDir);
    for (const override of [
      { id: 'local' },
      { id: '../bad' },
      { sshHost: '-oProxyCommand=bad' },
      { sshHost: 'host\ncommand' },
      { socketPath: '~/.codex/socket' },
      { socketPath: '/bad:path' },
      { uploadDir: '/' },
      { uploadDir: '/bad\nmkdir' },
      { projects: null },
    ]) {
      write({ ...remote, ...override });
      assert.throws(() => loadConfig(file));
    }
    writeFileSync(
      file,
      JSON.stringify({ projects: [{ path: dir }], sshTargets: [remote, remote] }),
    );
    assert.throws(() => loadConfig(file), /唯一/);
    writeFileSync(file, JSON.stringify({ projects: [{ path: dir }] }));
    assert.deepEqual(loadConfig(file).sshTargets, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SSH target is ready only after a real adapter list probe; disconnect is isolated and rechecks readiness', async () => {
  const f = fixture();
  let release!: () => void;
  f.adapter.listGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    f.manager.start();
    assert.equal(f.manager.get('local')?.connection.connected, true);
    assert.equal(f.manager.get('remote')?.connection.connected, false);
    assert.equal(f.manager.get('remote')?.connection.stage, 'codex_checking');
    release();
    await delay(0);
    assert.equal(f.manager.get('remote')?.connection.connected, true);
    assert.equal(f.adapter.lists, 1);
    f.tunnel.set({
      ready: false,
      stage: 'ssh_error',
      message: 'Auth failed',
      errorCode: 'SSH_AUTH',
    });
    assert.equal(f.manager.get('remote')?.connection.errorCode, 'SSH_AUTH');
    assert.equal(f.manager.get('local')?.connection.connected, true);
    f.tunnel.start();
    await delay(0);
    assert.equal(f.adapter.lists, 2);
    assert.equal(f.manager.get('remote')?.connection.connected, true);
  } finally {
    await f.close();
  }
});

test('remote images retain local previews, persist remote mappings, and reject another target upload', async () => {
  const f = fixture();
  try {
    f.manager.start();
    await delay(0);
    const target = f.manager.get('remote')!;
    const saved = target.uploads.save(png, 'image/png');
    const local = f.manager.get('local')!.uploads.save(png, 'image/png');
    await assert.rejects(target.prepareImages([local.id]), /其他机器/);
    const paths = await target.prepareImages([saved.id]);
    assert.equal(paths[0], remote.uploadDir + '/' + saved.id + '.png');
    assert.equal(f.transfer.calls.length, 1);
    assert.equal(target.uploads.get(saved.id)?.attached, true);
    assert.equal(target.uploads.get(saved.id)?.remotePendingPath, undefined);
    assert.equal(target.uploads.urlForPath(paths[0]), saved.url);
    assert.equal(target.uploads.urlForPath('/home/test/arbitrary.png'), undefined);
    const restored = new UploadStore(
      join(f.dir, 'targets', 'remote'),
      '/api/v1/targets/remote/uploads',
    );
    assert.equal(restored.urlForPath(paths[0]), saved.url);
    assert.deepEqual(readFileSync(restored.get(saved.id)!.path), png);
    await target.prepareImages([saved.id]);
    assert.equal(f.transfer.calls.length, 1);
  } finally {
    await f.close();
  }
});

test('failed SFTP staging leaves an unreferenced retryable upload and cleanup record', async () => {
  const f = fixture();
  try {
    f.manager.start();
    await delay(0);
    const target = f.manager.get('remote')!;
    const saved = target.uploads.save(png, 'image/png');
    f.transfer.failure = true;
    await assert.rejects(target.prepareImages([saved.id]), /SFTP failed/);
    assert.equal(target.uploads.get(saved.id)?.attached, false);
    assert.equal(target.uploads.get(saved.id)?.remotePath, undefined);
    assert.ok(target.uploads.get(saved.id)?.remotePendingPath);
    assert.equal(target.capabilities.images, false);
    assert.equal(target.connection.connected, true);
    assert.equal(target.connection.errorCode, 'SFTP_UNAVAILABLE');
    f.transfer.failure = false;
    f.tunnel.start();
    await delay(0);
    const paths = await target.prepareImages([saved.id]);
    assert.equal(paths.length, 1);
    assert.equal(target.uploads.get(saved.id)?.attached, true);
  } finally {
    await f.close();
  }
});

test('pending remote cleanup metadata survives local expiry cleanup; referenced images are retained', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-remote-uploads-'));
  try {
    const store = new UploadStore(dir);
    const a = store.save(png, 'image/png');
    store.recordRemotePendingPath(a.id, '/remote/' + a.id + '.png');
    const file = join(dir, 'uploads', a.id + '.json');
    const entry = store.get(a.id)!;
    writeFileSync(file, JSON.stringify({ ...entry, createdAt: 1 }));
    const restored = new UploadStore(dir);
    assert.ok(restored.get(a.id));
    assert.equal(restored.expiredRemoteUploads().length, 1);
    restored.recordRemotePath(a.id, '/remote/' + a.id + '.png');
    restored.attachRemote([a.id]);
    assert.equal(restored.expiredRemoteUploads().length, 0);
    restored.remove(a.id);
    assert.ok(restored.get(a.id));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('image preparation deadline aborts staging before images can become attached', async () => {
  const f = fixture(10);
  f.transfer.upload = async (_local: string, _remote: string, signal?: AbortSignal) => {
    await new Promise<void>((_resolve, reject) =>
      signal!.addEventListener('abort', () => reject(new Error('staging aborted')), { once: true }),
    );
  };
  try {
    f.manager.start();
    await delay(0);
    const target = f.manager.get('remote')!;
    const saved = target.uploads.save(png, 'image/png');
    await assert.rejects(target.prepareImages([saved.id]), /staging aborted/);
    assert.equal(target.uploads.get(saved.id)?.attached, false);
    assert.equal(target.uploads.get(saved.id)?.remotePath, undefined);
  } finally {
    await f.close();
  }
});
