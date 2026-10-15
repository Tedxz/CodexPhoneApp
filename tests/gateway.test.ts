import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../server/gateway.js';
import type { CodexAdapter } from '../server/codex.js';
import type { Config } from '../server/config.js';
import { WebSocket } from 'ws';
import type { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

class FakeCodex extends EventEmitter {
  connection = { connected: true, message: 'Connected', sharedBackend: true };
  capabilities = { images: true, planMode: true, liveControl: true };
  calls = 0;
  listOptions?: { cursor?: string; search?: string; cwd?: string };
  close() {}
  async listThreads(options: { cursor?: string; search?: string; cwd?: string }) {
    this.calls++;
    this.listOptions = options;
    return { data: [], nextCursor: null };
  }
  async listWorkspaces() {
    this.calls++;
    return [{ cwd: '/project', threadCount: 41, activeCount: 2, updatedAt: 1000 }];
  }
  async models() {
    return [];
  }
  async send() {
    this.calls++;
    await delay(10);
    return { turn: { id: 'turn-1' } };
  }
  async subscribe(id: string) {
    return {
      thread: { id, title: 'test', cwd: '/project', preview: '', status: 'idle', updatedAt: 0 },
      items: [],
      pendingRequests: [],
      nextCursor: null,
    };
  }
}
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'phone-gateway-'));
  const config: Config = {
    host: '127.0.0.1',
    port: 8787,
    publicUrl: 'https://phone.example',
    allowedOrigins: ['https://phone.example'],
    projects: [{ id: 'repo', name: 'Repo', path: dir }],
    dataDir: dir,
    socketPath: '/unused',
  };
  const codex = new FakeCodex();
  const gateway = createGateway(config, codex as unknown as CodexAdapter);
  const request = async (
    path: string,
    options: {
      method?: string;
      host?: string;
      origin?: string;
      cookie?: string;
      input?: unknown;
      contentType?: string;
      bytes?: Buffer;
      csrf?: boolean;
    } = {},
  ) => {
    const bytes =
      options.bytes ||
      (options.input === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(options.input)));
    const req = Readable.from([bytes]) as unknown as IncomingMessage;
    Object.assign(req, {
      method: options.method || 'GET',
      url: path,
      socket: { remoteAddress: '127.0.0.1' },
      headers: {
        host: options.host || 'phone.example',
        ...(options.origin ? { origin: options.origin } : {}),
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.csrf ? { 'x-codex-phone': '1' } : {}),
        'content-type': options.contentType || 'application/json',
        'content-length': String(bytes.length),
      },
    });
    let status = 200;
    let data = '';
    const headers: Record<string, string> = {};
    const res = {
      headersSent: false,
      setHeader(key: string, value: string) {
        headers[key.toLowerCase()] = value;
      },
      writeHead(code: number, h: Record<string, string>) {
        status = code;
        Object.entries(h).forEach(([k, v]) => {
          headers[k.toLowerCase()] = v;
        });
      },
      end(value?: Buffer | string) {
        data = value?.toString() || '';
      },
    } as unknown as ServerResponse;
    await gateway.handler(req, res);
    return { status, headers, data, json: () => JSON.parse(data) };
  };
  return {
    gateway,
    codex,
    request,
    async cleanup() {
      await gateway.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test('HTTP enforces auth, host/origin and CSRF; revoked session immediately fails', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/api/v1/threads')).status, 401);
    assert.equal(f.codex.calls, 0);
    assert.equal((await f.request('/api/v1/health', { host: 'evil.example' })).status, 403);
    const token = f.gateway.auth.createPairing().token;
    const input = { token, name: 'Safari' };
    assert.equal(
      (
        await f.request('/api/v1/pair', {
          method: 'POST',
          input,
          csrf: true,
          origin: 'https://evil.example',
        })
      ).status,
      403,
    );
    assert.equal(
      (await f.request('/api/v1/pair', { method: 'POST', input, origin: 'https://phone.example' }))
        .status,
      403,
    );
    assert.equal(
      (await f.request('/api/v1/pair', { method: 'POST', input, csrf: true })).status,
      403,
    );
    const paired = await f.request('/api/v1/pair', {
      method: 'POST',
      input,
      csrf: true,
      origin: 'https://phone.example',
    });
    assert.equal(paired.status, 200);
    const cookie = paired.headers['set-cookie'];
    assert.ok(cookie.includes('Secure'));
    assert.equal((await f.request('/api/v1/threads', { cookie })).status, 200);
    assert.equal(f.codex.calls, 1);
    const devices = await f.request('/api/v1/devices', { cookie });
    assert.equal(devices.json().data[0].current, true);
    const revoked = await f.request('/api/v1/devices/' + paired.json().device.id, {
      method: 'DELETE',
      cookie,
      csrf: true,
      origin: 'https://phone.example',
    });
    assert.equal(revoked.status, 200);
    assert.equal((await f.request('/api/v1/bootstrap', { cookie })).status, 401);
  } finally {
    await f.cleanup();
  }
});

test('workspace catalog requires authentication and thread routes preserve exact cwd with search and cursor', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/api/v1/workspaces')).status, 401);
    assert.equal(f.codex.calls, 0);
    const paired = f.gateway.auth.pair(f.gateway.auth.createPairing().token, 'Phone')!;
    const cookie = 'codex_phone=' + paired.token;
    const catalog = await f.request('/api/v1/workspaces', { cookie });
    assert.equal(catalog.status, 200);
    assert.deepEqual(catalog.json(), {
      data: [{ cwd: '/project', threadCount: 41, activeCount: 2, updatedAt: 1000 }],
    });
    const options = { cwd: '/Users/test/同名 repo', search: '关键词', cursor: 'next/cursor+1' };
    assert.equal(
      (await f.request('/api/v1/threads?' + new URLSearchParams(options), { cookie })).status,
      200,
    );
    assert.deepEqual(f.codex.listOptions, options);
    await f.request('/api/v1/threads?cwd=', { cookie });
    assert.equal(f.codex.listOptions?.cwd, '');
    await f.request('/api/v1/threads', { cookie });
    assert.equal(f.codex.listOptions?.cwd, undefined);
    f.gateway.auth.revoke(paired.device.id);
    assert.equal((await f.request('/api/v1/workspaces', { cookie })).status, 401);
  } finally {
    await f.cleanup();
  }
});

class FakeBrowserSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: Record<string, any>[] = [];
  closedCode?: number;
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  close(code?: number) {
    this.closedCode = code;
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
  terminate() {
    this.close();
  }
  ping() {
    this.emit('pong');
  }
}

test('WebSocket rejects foreign origin, deduplicates writes and closes revoked devices', async () => {
  const f = await fixture();
  try {
    const paired = f.gateway.auth.pair(f.gateway.auth.createPairing().token, 'Phone')!;
    const ws = new FakeBrowserSocket();
    f.gateway.wsServer.handleUpgrade = (_req, _socket, _head, callback) =>
      callback(ws as unknown as WebSocket, _req);
    let rejected = '';
    const socket = {
      end(value: string) {
        rejected = value;
      },
    } as unknown as Duplex;
    const req = (origin: string) =>
      ({
        url: '/api/v1/ws',
        headers: { host: 'phone.example', origin, cookie: 'codex_phone=' + paired.token },
      }) as IncomingMessage;
    f.gateway.server.emit('upgrade', req('https://evil.example'), socket, Buffer.alloc(0));
    assert.match(rejected, /403/);
    assert.equal(ws.sent.length, 0);
    f.gateway.server.emit('upgrade', req('https://phone.example'), socket, Buffer.alloc(0));
    assert.equal(ws.sent[0].event.type, 'connection');
    const command = {
      id: 'one',
      method: 'turn.send',
      params: { threadId: 'thread-1', text: 'hello' },
    };
    ws.emit('message', Buffer.from(JSON.stringify(command)));
    ws.emit('message', Buffer.from(JSON.stringify(command)));
    await delay(30);
    assert.equal(f.codex.calls, 1);
    assert.equal(ws.sent.filter((x) => x.id === 'one' && x.result).length, 2);
    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ ...command, params: { ...command.params, text: 'different' } })),
    );
    await delay(1);
    assert.ok(ws.sent.at(-1)?.error);
    assert.equal(f.codex.calls, 1);
    f.gateway.auth.revoke(paired.device.id);
    ws.emit('message', Buffer.from(JSON.stringify({ ...command, id: 'two' })));
    assert.equal(ws.closedCode, 4001);
    assert.equal(f.codex.calls, 1);
  } finally {
    await f.cleanup();
  }
});
test('images require authenticated reads and reject forged payload; no raw RPC/file endpoints', async () => {
  const f = await fixture();
  try {
    const paired = f.gateway.auth.pair(f.gateway.auth.createPairing().token, 'Phone')!;
    const cookie = 'codex_phone=' + paired.token;
    const options = {
      method: 'POST',
      cookie,
      csrf: true,
      origin: 'https://phone.example',
      contentType: 'image/png',
      bytes: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJVkAAAAASUVORK5CYII=',
        'base64',
      ),
    };
    const saved = await f.request('/api/v1/uploads', options);
    assert.equal(saved.status, 201);
    assert.equal((await f.request(saved.json().url)).status, 401);
    assert.equal((await f.request(saved.json().url, { cookie })).status, 200);
    assert.equal(
      (
        await f.request('/api/v1/uploads', {
          ...options,
          bytes: Buffer.from('<script>alert(1)</script>'),
        })
      ).status,
      400,
    );
    assert.equal((await f.request('/api/v1/rpc', { cookie })).status, 404);
    assert.equal((await f.request('/api/v1/file?path=/etc/passwd', { cookie })).status, 404);
  } finally {
    await f.cleanup();
  }
});
