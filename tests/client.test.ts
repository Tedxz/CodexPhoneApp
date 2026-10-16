import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises';
import { LiveClient } from '../web/api.js';

class BrowserSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static instances: BrowserSocket[] = [];
  readyState = BrowserSocket.CONNECTING;
  failSend = false;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number }) => void;
  onerror?: () => void;
  constructor(readonly url: string) {
    BrowserSocket.instances.push(this);
  }
  open() {
    this.readyState = BrowserSocket.OPEN;
    this.onopen?.();
  }
  close() {
    this.readyState = BrowserSocket.CLOSED;
    this.onclose?.({ code: 1000 });
  }
  send() {
    if (this.failSend) throw new Error('Socket closed between readyState check and send');
  }
}
function setup(t: TestContext, routePrefix = '') {
  const originals = new Map(
    ['WebSocket', 'location', 'fetch'].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  BrowserSocket.instances = [];
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    writable: true,
    value: BrowserSocket,
  });
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    writable: true,
    value: { protocol: 'https:', host: 'phone.example' },
  });
  const calls = { statuses: [] as boolean[], events: 0, resync: 0, unauthorized: 0 };
  const client = new LiveClient(
    {
      status: (value) => calls.statuses.push(value),
      event: () => calls.events++,
      resync: () => calls.resync++,
      unauthorized: () => calls.unauthorized++,
    },
    routePrefix,
  );
  t.after(() => {
    client.close();
    for (const [name, descriptor] of originals)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
  });
  return { client, calls, socket: () => BrowserSocket.instances.at(-1)! };
}

test('closing a client rejects pending commands and late callbacks cannot revive a logged-out session', async (t) => {
  const { client, calls, socket } = setup(t);
  client.connect();
  client.connect();
  assert.equal(BrowserSocket.instances.length, 1);
  const ws = socket();
  ws.open();
  const pending = assert.rejects(
    client.command('turn.send', { threadId: 't', text: 'once' }),
    /连接已关闭/,
  );
  client.close();
  await pending;
  ws.onopen?.();
  ws.onclose?.({ code: 4001 });
  ws.onmessage?.({
    data: JSON.stringify({ type: 'event', epoch: 'old', seq: 1, event: { type: 'resync' } }),
  });
  assert.deepEqual(calls, { statuses: [true], events: 0, resync: 1, unauthorized: 0 });
});

test('a synchronous browser send failure is rejected immediately and leaves no pending timeout', async (t) => {
  const { client, socket } = setup(t);
  client.connect();
  socket().open();
  socket().failSend = true;
  await assert.rejects(
    client.command('turn.send', { threadId: 't', text: 'once' }),
    /发送时连接中断/,
  );
  assert.equal((client as unknown as { pending: Map<string, unknown> }).pending.size, 0);
});

test('opaque failed upgrade probes HTTP authentication and does not retry an expired session', async (t) => {
  const { client, calls, socket } = setup(t);
  let probes = 0;
  globalThis.fetch = async () => {
    probes++;
    return new Response(JSON.stringify({ error: { message: 'expired' } }), { status: 401 });
  };
  client.connect();
  socket().readyState = BrowserSocket.CLOSED;
  socket().onclose?.({ code: 1006 });
  await tick();
  await tick();
  assert.equal(probes, 1);
  assert.equal(calls.unauthorized, 1);
  client.connect();
  await delay(1050);
  assert.equal(BrowserSocket.instances.length, 1);
});

test('stale authentication probes and old socket callbacks cannot affect a newer connection', async (t) => {
  const { client, calls, socket } = setup(t);
  let finish!: (response: Response) => void;
  globalThis.fetch = () =>
    new Promise<Response>((resolve) => {
      finish = resolve;
    });
  client.connect();
  const old = socket();
  old.readyState = BrowserSocket.CLOSED;
  old.onclose?.({ code: 1006 });
  client.connect();
  socket().open();
  finish(new Response('{}', { status: 401 }));
  await tick();
  await tick();
  old.onclose?.({ code: 4001 });
  old.onmessage?.({
    data: JSON.stringify({ type: 'event', epoch: 'e', seq: 5, event: { type: 'resync' } }),
  });
  assert.equal(calls.unauthorized, 0);
  assert.equal(calls.events, 0);
  assert.equal(calls.statuses.at(-1), true);
});

test('malformed JSON primitives and incomplete event envelopes are ignored', (t) => {
  const { client, calls, socket } = setup(t);
  client.connect();
  socket().open();
  for (const data of [
    'null',
    '3',
    '"text"',
    '{}',
    '{bad-json',
    '{"type":"event","seq":-1}',
    '{"type":"event","epoch":"e","seq":1}',
  ])
    socket().onmessage?.({ data });
  assert.equal(calls.events, 0);
  assert.equal(calls.resync, 1);
});

test('target sockets and authentication probes remain bound to the same machine', async (t) => {
  const { client, calls, socket } = setup(t, '/targets/remote-a');
  const requests: string[] = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return new Response('{}', { status: 401 });
  };
  client.connect();
  assert.equal(socket().url, 'wss://phone.example/api/v1/targets/remote-a/ws');
  socket().readyState = BrowserSocket.CLOSED;
  socket().onclose?.({ code: 1006 });
  await tick();
  await tick();
  assert.deepEqual(requests, ['/api/v1/targets/remote-a/bootstrap']);
  assert.equal(calls.unauthorized, 1);
});
