import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import type { Config } from '../server/config.js';
import type { CodexAdapter } from '../server/codex.js';
import type { TargetRuntime } from '../server/targets.js';
import type { ConnectionState, ThreadSnapshot } from '../shared/protocol.js';
import { createGateway } from '../server/gateway.js';
import { UploadStore } from '../server/uploads.js';

class TargetCodex extends EventEmitter {
  connection: ConnectionState = { connected: true, message: 'ready', sharedBackend: true };
  capabilities = { images: true, planMode: true, liveControl: true };
  sends: Record<string, unknown>[] = [];
  approvals: string[] = [];
  imagePath?: string;
  async listThreads() {
    return { data: [{ id: 'same-thread', title: this.connection.message }], nextCursor: null };
  }
  async listWorkspaces() {
    return [{ cwd: '/same/project', threadCount: 1, activeCount: 0, updatedAt: 0 }];
  }
  async snapshot(id: string): Promise<ThreadSnapshot> {
    return {
      thread: {
        id,
        title: 'same',
        preview: '',
        cwd: '/same/project',
        status: 'idle',
        updatedAt: 0,
      },
      items: this.imagePath
        ? [
            {
              id: 'image',
              turnId: 'turn',
              type: 'userMessage',
              text: '[图片]',
              images: [this.imagePath],
            },
          ]
        : [],
      pendingRequests: [],
      nextCursor: null,
    };
  }
  subscribe(id: string) {
    return this.snapshot(id);
  }
  async send(input: Record<string, unknown>) {
    this.sends.push(input);
    await delay(20);
    return { marker: this.connection.message };
  }
  async respond(id: string) {
    this.approvals.push(id);
    return { sent: true };
  }
  close() {}
}

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-target-gateway-'));
  const local = new TargetCodex(),
    remote = new TargetCodex();
  local.connection.message = 'local';
  remote.connection.message = 'remote';
  const config: Config = {
    host: '127.0.0.1',
    port: 0,
    publicUrl: 'https://phone.example',
    allowedOrigins: ['https://phone.example'],
    projects: [{ id: 'project', name: 'Local', path: dir }],
    socketPath: '/unused',
    dataDir: dir,
  };
  const make = (id: string, codex: TargetCodex): TargetRuntime => {
    const uploads = new UploadStore(join(dir, id));
    return {
      id,
      name: id,
      kind: id === 'local' ? 'local' : 'ssh',
      codex: codex as unknown as CodexAdapter,
      projects: [{ id: 'project', name: id, path: '/same/project' }],
      uploads,
      get connection() {
        return codex.connection;
      },
      get capabilities() {
        return codex.capabilities;
      },
      async prepareImages(ids: string[]) {
        return uploads.attach(ids);
      },
    };
  };
  const targets = [make('local', local), make('remote', remote)];
  const registry = {
    all: () => targets,
    get: (id: string) => targets.find((t) => t.id === id),
    close: async () => {},
  };
  const gateway = createGateway(config, registry);
  gateway.server.listen(0, '127.0.0.1');
  await once(gateway.server, 'listening');
  const port = (gateway.server.address() as AddressInfo).port;
  const paired = gateway.auth.pair(gateway.auth.createPairing().token, 'test')!;
  const cookie = 'codex_phone=' + paired.token;
  const sockets: WebSocket[] = [];
  const request = (path: string, options: RequestInit = {}, authenticated = true) =>
    new Promise<Response>((resolve, reject) => {
      const req = httpRequest(
        `http://127.0.0.1:${port}${path}`,
        {
          method: options.method || 'GET',
          headers: {
            Host: 'phone.example',
            Origin: 'https://phone.example',
            'x-codex-phone': '1',
            ...(authenticated ? { Cookie: cookie } : {}),
            ...((options.headers as Record<string, string>) || {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () =>
            resolve(new Response(Buffer.concat(chunks), { status: res.statusCode })),
          );
        },
      );
      req.on('error', reject);
      req.end(options.body);
    });
  async function connect(path: string) {
    const messages: any[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers: { Host: 'phone.example', Origin: 'https://phone.example', Cookie: cookie },
    });
    ws.on('message', (data) => messages.push(JSON.parse(String(data))));
    sockets.push(ws);
    await once(ws, 'open');
    const reply = async (id: string) => {
      for (let i = 0; i < 100; i++) {
        const value = messages.find((m) => m.id === id);
        if (value) return value;
        await delay(5);
      }
      throw new Error('reply timed out');
    };
    return { ws, messages, reply };
  }
  return {
    gateway,
    local,
    remote,
    targets,
    request,
    connect,
    async cleanup() {
      sockets.forEach((ws) => ws.terminate());
      await gateway.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('target catalog is authenticated and independent; legacy routes remain local', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/api/v1/targets', {}, false)).status, 401);
    f.remote.connection = {
      connected: false,
      message: 'SSH unavailable',
      sharedBackend: true,
      stage: 'ssh',
      errorCode: 'SSH_FAILED',
    };
    const catalog = await (await f.request('/api/v1/targets')).json();
    assert.deepEqual(
      catalog.data.map((t: any) => [t.id, t.connection.connected]),
      [
        ['local', true],
        ['remote', false],
      ],
    );
    assert.equal((await (await f.request('/api/v1/bootstrap')).json()).connection.message, 'local');
    assert.equal(
      (await (await f.request('/api/v1/targets/remote/bootstrap')).json()).target.id,
      'remote',
    );
    const unknown = await f.request('/api/v1/targets/missing/threads');
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, 'TARGET_NOT_FOUND');
    assert.equal((await f.request('/api/v1/targets/remote/devices')).status, 404);
  } finally {
    await f.cleanup();
  }
});

test('same request, thread and approval identifiers on two targets stay independent', async () => {
  const f = await fixture();
  try {
    const a = await f.connect('/api/v1/ws'),
      b = await f.connect('/api/v1/targets/remote/ws');
    const send = JSON.stringify({
      id: 'same-request',
      method: 'turn.send',
      params: { threadId: 'same-thread', text: 'hello' },
    });
    a.ws.send(send);
    b.ws.send(send);
    assert.equal((await a.reply('same-request')).result.marker, 'local');
    assert.equal((await b.reply('same-request')).result.marker, 'remote');
    assert.equal(f.local.sends.length, 1);
    assert.equal(f.remote.sends.length, 1);
    const approval = JSON.stringify({
      id: 'same-approval-command',
      method: 'request.respond',
      params: { requestId: 'same-approval', decision: 'accept' },
    });
    a.ws.send(approval);
    b.ws.send(approval);
    await a.reply('same-approval-command');
    await b.reply('same-approval-command');
    assert.deepEqual(f.local.approvals, ['same-approval']);
    assert.deepEqual(f.remote.approvals, ['same-approval']);
    f.remote.emit('event', {
      type: 'item.delta',
      threadId: 'same-thread',
      itemId: 'i',
      turnId: 't',
      delta: 'REMOTE_ONLY',
    });
    await delay(20);
    assert.equal(
      a.messages.some((m) => m.event?.delta === 'REMOTE_ONLY'),
      false,
    );
    assert.equal(
      b.messages.some((m) => m.event?.delta === 'REMOTE_ONLY'),
      true,
    );
    assert.notEqual(a.messages[0].epoch, b.messages[0].epoch);
  } finally {
    await f.cleanup();
  }
});

test('target uploads cannot cross machines and snapshots use the requesting route namespace', async () => {
  const f = await fixture();
  try {
    const png = Buffer.from('89504e470d0a1a0a0000000000000000', 'hex');
    const result = await f.request('/api/v1/targets/remote/uploads', {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: png,
    });
    const image = await result.json();
    assert.equal(result.status, 201);
    assert.equal(image.url, `/api/v1/targets/remote/uploads/${image.id}`);
    assert.equal((await f.request(image.url)).status, 200);
    assert.equal((await f.request('/api/v1/uploads/' + image.id)).status, 404);
    const a = await f.connect('/api/v1/targets/local/ws');
    a.ws.send(
      JSON.stringify({
        id: 'cross',
        method: 'turn.send',
        params: { threadId: 'same-thread', text: '', imageIds: [image.id] },
      }),
    );
    assert.ok((await a.reply('cross')).error);
    assert.equal(f.local.sends.length, 0);
    f.remote.imagePath = f.targets[1].uploads.get(image.id)!.path;
    const snapshot = await (await f.request('/api/v1/targets/remote/threads/same-thread')).json();
    assert.deepEqual(snapshot.items[0].images, [image.url]);
    const localImage = f.targets[0].uploads.save(png, 'image/png');
    f.local.imagePath = f.targets[0].uploads.get(localImage.id)!.path;
    assert.deepEqual(
      (await (await f.request('/api/v1/threads/same-thread')).json()).items[0].images,
      [localImage.url],
    );
    assert.deepEqual(
      (await (await f.request('/api/v1/targets/local/threads/same-thread')).json()).items[0].images,
      [`/api/v1/targets/local/uploads/${localImage.id}`],
    );
  } finally {
    await f.cleanup();
  }
});

test('failed remote image staging never starts a turn', async () => {
  const f = await fixture();
  try {
    f.targets[1].prepareImages = async () => {
      throw new Error('SFTP failed');
    };
    const b = await f.connect('/api/v1/targets/remote/ws');
    b.ws.send(
      JSON.stringify({
        id: 'failed',
        method: 'turn.send',
        params: { threadId: 'same-thread', text: 'hello', imageIds: ['unavailable'] },
      }),
    );
    assert.ok((await b.reply('failed')).error);
    assert.equal(f.remote.sends.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('revoking authorization during image staging prevents the subsequent Codex mutation', async () => {
  const f = await fixture();
  try {
    let staged = false;
    let release!: () => void;
    f.targets[1].prepareImages = async () => {
      staged = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return ['/remote/image.png'];
    };
    const b = await f.connect('/api/v1/targets/remote/ws');
    b.ws.send(
      JSON.stringify({
        id: 'revoke-staging',
        method: 'turn.send',
        params: { threadId: 'same-thread', text: 'hello', imageIds: ['image'] },
      }),
    );
    for (let i = 0; i < 50 && !staged; i++) await delay(5);
    assert.equal(staged, true);
    f.gateway.auth.revoke(f.gateway.auth.list()[0].id);
    release();
    await delay(30);
    assert.equal(f.remote.sends.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('losing verified target readiness during image staging prevents the subsequent turn', async () => {
  const f = await fixture();
  try {
    f.targets[1].prepareImages = async () => {
      f.remote.connection = {
        connected: false,
        message: 'verifying reconnected backend',
        sharedBackend: true,
      };
      return ['/remote/image.png'];
    };
    const b = await f.connect('/api/v1/targets/remote/ws');
    b.ws.send(
      JSON.stringify({
        id: 'readiness-staging',
        method: 'turn.send',
        params: { threadId: 'same-thread', text: 'hello', imageIds: ['image'] },
      }),
    );
    assert.ok((await b.reply('readiness-staging')).error);
    assert.equal(f.remote.sends.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('a cached local snapshot is formatted for each legacy or scoped client without changing deduplication scope', async () => {
  const f = await fixture();
  try {
    const image = f.targets[0].uploads.save(
      Buffer.from('89504e470d0a1a0a0000000000000000', 'hex'),
      'image/png',
    );
    f.local.imagePath = f.targets[0].uploads.get(image.id)!.path;
    const legacy = await f.connect('/api/v1/ws');
    const scoped = await f.connect('/api/v1/targets/local/ws');
    const request = JSON.stringify({
      id: 'same-subscription',
      method: 'thread.subscribe',
      params: { threadId: 'same-thread' },
    });
    legacy.ws.send(request);
    scoped.ws.send(request);
    assert.deepEqual((await legacy.reply('same-subscription')).result.items[0].images, [image.url]);
    assert.deepEqual((await scoped.reply('same-subscription')).result.items[0].images, [
      `/api/v1/targets/local/uploads/${image.id}`,
    ]);
  } finally {
    await f.cleanup();
  }
});
