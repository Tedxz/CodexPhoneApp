import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexAdapter, type CodexSocket } from '../server/codex.js';
import type { GatewayEvent } from '../shared/protocol.js';

type Message = { id?: string | number; method?: string; params?: any; result?: any; error?: any };
class FakeSocket extends EventEmitter implements CodexSocket {
  sent: Message[] = [];
  dead = false;
  holdWrites = false;
  constructor(private readonly handle: (message: Message, socket: FakeSocket) => void) {
    super();
    queueMicrotask(() => this.emit('open'));
  }
  send(raw: string, callback?: (error?: Error) => void): void {
    const message = JSON.parse(raw) as Message;
    this.sent.push(message);
    if (!this.holdWrites) queueMicrotask(() => callback?.());
    queueMicrotask(() => {
      if (!this.dead) this.handle(message, this);
    });
  }
  reply(request: Message, result: unknown): void {
    this.push({ id: request.id, result });
  }
  push(message: Message): void {
    this.emit('message', JSON.stringify(message));
  }
  close(): void {
    this.terminate();
  }
  terminate(): void {
    if (!this.dead) {
      this.dead = true;
      this.emit('close');
    }
  }
}
const baseThread = (overrides: Record<string, unknown> = {}): Record<string, any> => ({
  id: 'thread-1',
  name: '测试会话',
  preview: 'hello',
  cwd: '/project',
  updatedAt: 1_800_000_000,
  model: 'gpt-test',
  reasoningEffort: 'medium',
  status: { type: 'idle' },
  source: 'cli',
  canAcceptDirectInput: true,
  turns: [],
  ...overrides,
});
function fixture(
  t: { after: (fn: () => void) => unknown },
  overrides: {
    handler?: (message: Message, socket: FakeSocket) => boolean;
    active?: boolean;
    replayRequest?: boolean;
    timeout?: number;
    reconnect?: number;
  } = {},
) {
  const events: GatewayEvent[] = [],
    sockets: FakeSocket[] = [];
  const state = {
    thread: baseThread(overrides.active ? { status: { type: 'active', activeFlags: [] } } : {}),
    settings: {
      model: 'gpt-test',
      reasoningEffort: 'medium',
      collaborationMode: { mode: 'default' },
    },
  };
  const adapter = new CodexAdapter({
    socketPath: '/tmp/existing-shared.sock',
    requestTimeoutMs: overrides.timeout ?? 500,
    reconnectDelayMs: overrides.reconnect ?? 10_000,
    socketFactory(url) {
      assert.equal(url, 'ws+unix:///tmp/existing-shared.sock:/');
      const socket = new FakeSocket((message, s) => {
        if (overrides.handler?.(message, s)) return;
        switch (message.method) {
          case 'initialize':
            s.reply(message, {
              userAgent: 'codex/0.162.1',
              codexHome: '/private/not-forwarded',
              platformOs: 'macos',
            });
            break;
          case 'collaborationMode/list':
            s.reply(message, { data: [{ mode: 'plan' }, { mode: 'default' }] });
            break;
          case 'thread/list':
            s.reply(message, { data: [state.thread], nextCursor: 'next-threads' });
            break;
          case 'thread/read':
            s.reply(message, { thread: state.thread });
            break;
          case 'thread/resume':
            s.reply(message, {
              thread: state.thread,
              ...state.settings,
              initialTurnsPage: {
                data: overrides.active ? [{ id: 'turn-1', status: 'inProgress' }] : [],
              },
            });
            if (overrides.replayRequest)
              s.push({
                id: 7,
                method: 'item/commandExecution/requestApproval',
                params: { threadId: 'thread-1', command: 'echo hello' },
              });
            break;
          case 'thread/items/list':
            s.reply(message, {
              data: [
                {
                  turnId: 'turn-0',
                  item: { id: 'assistant-0', type: 'agentMessage', text: 'answer' },
                },
                {
                  turnId: 'turn-0',
                  item: {
                    id: 'user-0',
                    type: 'userMessage',
                    content: [
                      { type: 'text', text: 'question' },
                      { type: 'localImage', path: '/private/upload.png' },
                    ],
                  },
                },
              ],
              nextCursor: 'older-items',
            });
            break;
          case 'thread/turns/list':
            s.reply(message, {
              data: overrides.active ? [{ id: 'turn-1', status: 'inProgress', items: [] }] : [],
              nextCursor: null,
            });
            break;
          case 'model/list':
            s.reply(message, {
              data: [
                {
                  id: 'catalog-id',
                  model: 'gpt-test',
                  displayName: 'GPT Test',
                  supportedReasoningEfforts: [
                    { reasoningEffort: 'medium' },
                    { reasoningEffort: 'high' },
                  ],
                  defaultReasoningEffort: 'medium',
                  isDefault: true,
                },
              ],
              nextCursor: null,
            });
            break;
          case 'turn/start':
          case 'turn/steer':
          case 'turn/interrupt':
            s.reply(message, { turn: { id: 'new-turn' } });
            break;
          case 'thread/start':
            s.reply(message, { thread: state.thread, ...state.settings });
            break;
          case 'thread/settings/update':
            s.reply(message, { threadSettings: { ...state.settings, ...message.params } });
            break;
        }
      });
      sockets.push(socket);
      return socket;
    },
  });
  adapter.on('event', (event) => events.push(event));
  t.after(() => adapter.close());
  return {
    adapter,
    events,
    sockets,
    state,
    get socket() {
      return sockets.at(-1)!;
    },
  };
}
const requests = (socket: FakeSocket, method: string) =>
  socket.sent.filter((m) => m.method === method);
const pending = (events: GatewayEvent[]) =>
  events.filter(
    (e): e is Extract<GatewayEvent, { type: 'request.pending' }> => e.type === 'request.pending',
  );

test('connects only to existing Unix socket, negotiates experimental protocol, lists all main session sources', async (t) => {
  const f = fixture(t);
  await f.adapter.connect();
  assert.equal(f.adapter.connection.connected, true);
  assert.equal(f.adapter.capabilities.planMode, true);
  assert.deepEqual(requests(f.socket, 'initialize')[0].params.capabilities, {
    experimentalApi: true,
    requestAttestation: false,
  });
  const page = await f.adapter.listThreads({ search: 'hello', cursor: 'page-1' });
  assert.deepEqual(requests(f.socket, 'thread/list')[0].params.sourceKinds, [
    'cli',
    'vscode',
    'appServer',
    'exec',
    'unknown',
  ]);
  assert.equal(page.data[0].source, 'cli');
  assert.equal(page.data[0].updatedAt, 1_800_000_000_000);
  assert.equal(page.nextCursor, 'next-threads');
  assert.equal(JSON.stringify(f.adapter.connection).includes('/private/not-forwarded'), false);
});

test('passive subscription preserves backend settings and pages chronological items with original image paths', async (t) => {
  const f = fixture(t, { active: true });
  await f.adapter.connect();
  const snapshot = await f.adapter.subscribe('thread-1');
  assert.deepEqual(requests(f.socket, 'thread/resume')[0].params, {
    threadId: 'thread-1',
    excludeTurns: true,
    initialTurnsPage: { limit: 1, sortDirection: 'desc', itemsView: 'summary' },
  });
  assert.equal(snapshot.thread.activeTurnId, 'turn-1');
  assert.deepEqual(
    snapshot.items.map((i) => i.id),
    ['user-0', 'assistant-0'],
  );
  assert.deepEqual(snapshot.items[0].images, ['/private/upload.png']);
  assert.equal(snapshot.settings?.mode, 'default');
  await f.adapter.snapshot('thread-1', 'older-items');
  assert.equal(requests(f.socket, 'thread/items/list').at(-1)?.params.cursor, 'older-items');
  assert.equal(requests(f.socket, 'turn/start').length, 0);
});

test('explicit unsupported item pagination falls back to full turn pages with independent cursors', async (t) => {
  const f = fixture(t, {
    handler(message, socket) {
      if (message.method === 'thread/items/list') {
        socket.push({
          id: message.id,
          error: { code: -32601, message: 'thread/items/list is not supported yet' },
        });
        return true;
      }
      if (message.method === 'thread/turns/list' && message.params.itemsView === 'full') {
        socket.reply(message, {
          data: message.params.cursor
            ? [
                {
                  id: 'turn-old',
                  itemsView: 'full',
                  items: [
                    {
                      id: 'older',
                      type: 'userMessage',
                      content: [{ type: 'text', text: 'older' }],
                    },
                  ],
                },
              ]
            : [
                {
                  id: 'turn-new',
                  itemsView: 'full',
                  items: [
                    {
                      id: 'new-user',
                      type: 'userMessage',
                      content: [{ type: 'text', text: 'new' }],
                    },
                    { id: 'new-agent', type: 'agentMessage', text: 'reply' },
                  ],
                },
                {
                  id: 'turn-before',
                  itemsView: 'full',
                  items: [
                    {
                      id: 'before-user',
                      type: 'userMessage',
                      content: [{ type: 'text', text: 'before' }],
                    },
                    { id: 'before-agent', type: 'agentMessage', text: 'previous' },
                  ],
                },
              ],
          nextCursor: message.params.cursor ? null : 'opaque-server-turn-cursor',
        });
        return true;
      }
      return false;
    },
  });
  await f.adapter.connect();
  const first = await f.adapter.subscribe('thread-1');
  assert.deepEqual(
    first.items.map((i) => i.id),
    ['before-user', 'before-agent', 'new-user', 'new-agent'],
  );
  assert.match(first.nextCursor!, /^phone-turns-v1:/);
  const second = await f.adapter.snapshot('thread-1', first.nextCursor!);
  assert.deepEqual(
    second.items.map((i) => i.id),
    ['older'],
  );
  assert.equal(second.nextCursor, null);
  assert.equal(requests(f.socket, 'thread/items/list').length, 1);
  assert.equal(
    requests(f.socket, 'thread/turns/list')
      .filter((m) => m.params.itemsView === 'full')
      .at(-1)?.params.cursor,
    'opaque-server-turn-cursor',
  );
  await assert.rejects(f.adapter.snapshot('thread-1', 'old-native-item-cursor'), {
    code: 'HISTORY_CURSOR_CHANGED',
  });
});

test('history fallback never masks unloaded-thread or permission errors', async (t) => {
  const f = fixture(t, {
    handler(message, socket) {
      if (message.method === 'thread/items/list') {
        socket.push({ id: message.id, error: { code: -32600, message: 'thread not loaded' } });
        return true;
      }
      return false;
    },
  });
  await f.adapter.connect();
  await assert.rejects(f.adapter.snapshot('thread-1'), { code: 'CODEX_-32600' });
  assert.equal(
    requests(f.socket, 'thread/turns/list').filter((m) => m.params.itemsView === 'full').length,
    0,
  );
});

test('fresh idle threads have empty history and peers can join before the first user message', async (t) => {
  const f = fixture(t, {
    handler(message, socket) {
      if (message.method === 'thread/items/list') {
        socket.push({
          id: message.id,
          error: { code: -32601, message: 'thread/items/list is not supported yet' },
        });
        return true;
      }
      if (
        message.method === 'thread/turns/list' ||
        (message.method === 'thread/resume' && message.params.initialTurnsPage)
      ) {
        socket.push({
          id: message.id,
          error: {
            code: -32600,
            message:
              'thread thread-1 is not materialized yet; thread/turns/list is unavailable before first user message',
          },
        });
        return true;
      }
      return false;
    },
  });
  await f.adapter.connect();
  const joined = await f.adapter.subscribe('thread-1');
  assert.deepEqual(joined.items, []);
  assert.equal(joined.nextCursor, null);
  assert.equal(joined.thread.status, 'idle');
  assert.deepEqual(requests(f.socket, 'thread/resume')[1].params, {
    threadId: 'thread-1',
    excludeTurns: true,
  });
  const created = await f.adapter.createThread({ cwd: '/project' });
  assert.deepEqual(created.items, []);
  assert.equal(requests(f.socket, 'thread/start').length, 1);
});

test('unmaterialized history error is not hidden when runtime metadata is active', async (t) => {
  const f = fixture(t, {
    active: true,
    handler(message, socket) {
      if (message.method === 'thread/turns/list') {
        socket.push({
          id: message.id,
          error: {
            code: -32600,
            message:
              'thread thread-1 is not materialized yet; thread/turns/list is unavailable before first user message',
          },
        });
        return true;
      }
      return false;
    },
  });
  await f.adapter.connect();
  await assert.rejects(f.adapter.snapshot('thread-1'), { code: 'CODEX_-32600' });
});

test('transient list_turns rejection reads real full history with stable item anchors, then retries native pages', async (t) => {
  let unavailable = true;
  const items = Array.from({ length: 65 }, (_, i) => ({
    id: `item-${i}`,
    type: 'agentMessage',
    text: `message ${i}`,
  }));
  const f = fixture(t, {
    handler(message, socket) {
      if (message.method === 'thread/items/list') {
        socket.push({
          id: message.id,
          error: { code: -32601, message: 'thread/items/list is not supported yet' },
        });
        return true;
      }
      if (message.method === 'thread/turns/list' && unavailable) {
        socket.push({
          id: message.id,
          error: { code: -32601, message: 'list_turns is not supported yet' },
        });
        return true;
      }
      if (message.method === 'thread/turns/list' && message.params.itemsView === 'full') {
        socket.reply(message, {
          data: [{ id: 'turn-full', status: 'completed', itemsView: 'full', items }],
          nextCursor: null,
        });
        return true;
      }
      if (message.method === 'thread/read' && message.params.includeTurns) {
        socket.reply(message, {
          thread: baseThread({
            turns: [{ id: 'turn-full', status: 'completed', itemsView: 'full', items }],
          }),
        });
        return true;
      }
      return false;
    },
  });
  await f.adapter.connect();
  const first = await f.adapter.snapshot('thread-1');
  assert.deepEqual(
    first.items.map((i) => i.id),
    items.slice(5).map((i) => i.id),
  );
  assert.match(first.nextCursor!, /^phone-read-v1:/);
  assert.equal(requests(f.socket, 'thread/read').filter((m) => m.params.includeTurns).length, 1);
  items.push({ id: 'item-65', type: 'agentMessage', text: 'appended while paging' });
  unavailable = false;
  const older = await f.adapter.snapshot('thread-1', first.nextCursor!);
  assert.deepEqual(
    older.items.map((i) => i.id),
    items.slice(0, 5).map((i) => i.id),
  );
  assert.equal(older.nextCursor, null);
  const fullListCalls = requests(f.socket, 'thread/turns/list').filter(
    (m) => m.params.itemsView === 'full',
  ).length;
  const recovered = await f.adapter.snapshot('thread-1');
  assert.equal(
    requests(f.socket, 'thread/turns/list').filter((m) => m.params.itemsView === 'full').length,
    fullListCalls + 1,
  );
  assert.deepEqual(
    recovered.items.map((i) => i.id),
    items.map((i) => i.id),
  );
});

test('active steering and passive resume recover only the precise transient turn-list error', async (t) => {
  const f = fixture(t, {
    active: true,
    handler(message, socket) {
      if (
        message.method === 'thread/turns/list' ||
        (message.method === 'thread/resume' && message.params.initialTurnsPage)
      ) {
        socket.push({
          id: message.id,
          error: { code: -32601, message: 'list_turns is not supported yet' },
        });
        return true;
      }
      if (message.method === 'thread/read' && message.params.includeTurns) {
        socket.reply(message, {
          thread: baseThread({
            status: { type: 'active' },
            turns: [{ id: 'actual-active', status: 'inProgress', itemsView: 'full', items: [] }],
          }),
        });
        return true;
      }
      return false;
    },
  });
  await f.adapter.connect();
  await f.adapter.send({ threadId: 'thread-1', text: 'continue' });
  assert.deepEqual(requests(f.socket, 'thread/resume')[1].params, {
    threadId: 'thread-1',
    excludeTurns: true,
  });
  assert.equal(requests(f.socket, 'turn/steer')[0].params.expectedTurnId, 'actual-active');
  assert.equal(requests(f.socket, 'turn/start').length, 0);
});

test('unrelated turn-list errors and incomplete full reads never become empty successful history', async (t) => {
  let exact = false;
  const f = fixture(t, {
    handler(message, socket) {
      if (message.method === 'thread/turns/list') {
        socket.push({
          id: message.id,
          error: {
            code: -32601,
            message: exact ? 'list_turns is not supported yet' : 'another method is unavailable',
          },
        });
        return true;
      }
      if (message.method === 'thread/read' && message.params.includeTurns) {
        socket.reply(message, { thread: { id: 'thread-1', status: { type: 'idle' } } });
        return true;
      }
      return false;
    },
  });
  await f.adapter.connect();
  await assert.rejects(f.adapter.snapshot('thread-1'), /another method is unavailable/);
  assert.equal(requests(f.socket, 'thread/read').filter((m) => m.params.includeTurns).length, 0);
  exact = true;
  await assert.rejects(f.adapter.snapshot('thread-1'), { code: 'INCOMPLETE_HISTORY' });
});

test('live notifications normalize stream deltas, tool completion and authoritative turn state', async (t) => {
  const f = fixture(t);
  await f.adapter.connect();
  await f.adapter.subscribe('thread-1');
  f.socket.push({
    method: 'turn/started',
    params: { threadId: 'thread-1', turn: { id: 'turn-live', items: [] } },
  });
  f.socket.push({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread-1', turnId: 'turn-live', itemId: 'a-live', delta: '你好' },
  });
  f.socket.push({
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-live',
      item: {
        id: 'cmd',
        type: 'commandExecution',
        command: 'pwd',
        aggregatedOutput: '/project',
        exitCode: 0,
        status: 'completed',
      },
    },
  });
  f.socket.push({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: 'turn-live', items: [] } },
  });
  assert.ok(f.events.some((e) => e.type === 'item.delta' && e.delta === '你好'));
  assert.ok(
    f.events.some(
      (e) => e.type === 'item.updated' && e.item.id === 'cmd' && e.item.text.includes('退出码：0'),
    ),
  );
  assert.ok(
    f.events.some((e) => e.type === 'thread.changed' && e.thread.activeTurnId === 'turn-live'),
  );
  assert.equal(
    f.events
      .filter(
        (e): e is Extract<GatewayEvent, { type: 'thread.changed' }> => e.type === 'thread.changed',
      )
      .at(-1)?.thread.status,
    'idle',
  );
});

test('idle send uses turn/start with proper text, image and collaboration mode wire shapes', async (t) => {
  const f = fixture(t);
  await f.adapter.connect();
  await f.adapter.send({
    threadId: 'thread-1',
    text: 'Plan this',
    imagePaths: ['/upload/one.png'],
    mode: 'plan',
    model: 'gpt-test',
    effort: 'high',
  });
  const params = requests(f.socket, 'turn/start')[0].params;
  assert.deepEqual(params.input, [
    { type: 'text', text: 'Plan this', text_elements: [] },
    { type: 'localImage', path: '/upload/one.png' },
  ]);
  assert.deepEqual(params.collaborationMode, {
    mode: 'plan',
    settings: { model: 'gpt-test', reasoning_effort: 'high', developer_instructions: null },
  });
  assert.equal(params.permissions, undefined);
  assert.equal(params.approvalPolicy, undefined);
  assert.equal((await f.adapter.models())[0].id, 'gpt-test');
});

test('active send steers exact turn and rejects settings changes; stale steer never falls back to start', async (t) => {
  const f = fixture(t, {
    active: true,
    handler(message, socket) {
      if (message.method === 'turn/steer' && message.params.expectedTurnId === 'stale-turn') {
        socket.push({ id: message.id, error: { code: -32000, message: 'expected turn mismatch' } });
        return true;
      }
      return false;
    },
  });
  await f.adapter.connect();
  await f.adapter.send({ threadId: 'thread-1', text: '继续' });
  assert.equal(requests(f.socket, 'turn/steer')[0].params.expectedTurnId, 'turn-1');
  await assert.rejects(f.adapter.send({ threadId: 'thread-1', text: 'change', mode: 'plan' }), {
    code: 'TURN_ACTIVE',
  });
  await assert.rejects(
    f.adapter.send({ threadId: 'thread-1', text: 'late', expectedTurnId: 'stale-turn' }),
    /expected turn mismatch/,
  );
  assert.equal(requests(f.socket, 'turn/start').length, 0);
});

test('thread creation inherits permissions and applies explicit mode without starting a turn', async (t) => {
  const f = fixture(t);
  await f.adapter.connect();
  const snapshot = await f.adapter.createThread({ cwd: '/project', mode: 'plan', effort: 'high' });
  assert.deepEqual(requests(f.socket, 'thread/start')[0].params, { cwd: '/project' });
  assert.equal(
    requests(f.socket, 'thread/settings/update')[0].params.collaborationMode.mode,
    'plan',
  );
  assert.equal(snapshot.settings?.mode, 'plan');
  assert.equal(requests(f.socket, 'turn/start').length, 0);
});

test('unsupported model/effort and executors reject before sending any turn', async (t) => {
  const f = fixture(t);
  await f.adapter.connect();
  await assert.rejects(
    f.adapter.send({ threadId: 'thread-1', text: 'x', model: 'not-available' }),
    { code: 'INVALID_MODEL' },
  );
  await assert.rejects(f.adapter.send({ threadId: 'thread-1', text: 'x', effort: 'ultra' }), {
    code: 'INVALID_EFFORT',
  });
  f.state.thread.canAcceptDirectInput = false;
  await assert.rejects(f.adapter.send({ threadId: 'thread-1', text: 'x' }), {
    code: 'INPUT_UNAVAILABLE',
  });
  assert.equal(requests(f.socket, 'turn/start').length, 0);
});

test('approval races allow one response; server resolution invalidates requests from other clients', async (t) => {
  const f = fixture(t);
  await f.adapter.connect();
  f.socket.push({
    id: 10,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'thread-1',
      command: 'echo safe',
      availableDecisions: ['accept', 'decline', 'acceptForSession'],
    },
  });
  const request = pending(f.events).at(-1)!.request;
  assert.deepEqual(request.decisions, ['accept', 'decline']);
  const first = f.adapter.respond(request.id, { decision: 'accept' });
  await assert.rejects(f.adapter.respond(request.id, { decision: 'decline' }), {
    code: 'REQUEST_EXPIRED',
  });
  assert.deepEqual(await first, { sent: true });
  assert.deepEqual(
    f.socket.sent.filter((m) => m.id === 10),
    [{ id: 10, result: { decision: 'accept' } }],
  );
  f.socket.push({
    id: 'other',
    method: 'item/fileChange/requestApproval',
    params: { threadId: 'thread-1', reason: 'edit file' },
  });
  const other = pending(f.events).at(-1)!.request;
  f.socket.push({
    method: 'serverRequest/resolved',
    params: { threadId: 'thread-1', requestId: 'other' },
  });
  await assert.rejects(f.adapter.respond(other.id, { decision: 'accept' }), {
    code: 'REQUEST_EXPIRED',
  });
});

test('permission grants are exact and turn scoped; user answers use nested protocol objects', async (t) => {
  const f = fixture(t);
  await f.adapter.connect();
  const permissions = { network: { enabled: true }, fileSystem: null };
  f.socket.push({
    id: 'p',
    method: 'item/permissions/requestApproval',
    params: { threadId: 'thread-1', cwd: '/project', permissions },
  });
  await f.adapter.respond(pending(f.events).at(-1)!.request.id, { decision: 'accept' });
  assert.deepEqual(f.socket.sent.find((m) => m.id === 'p')?.result, {
    permissions: { network: { enabled: true } },
    scope: 'turn',
  });
  f.socket.push({
    id: 'd',
    method: 'item/permissions/requestApproval',
    params: { threadId: 'thread-1', permissions },
  });
  await f.adapter.respond(pending(f.events).at(-1)!.request.id, { decision: 'decline' });
  assert.deepEqual(f.socket.sent.find((m) => m.id === 'd')?.result, {
    permissions: {},
    scope: 'turn',
  });
  f.socket.push({
    id: 'q',
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-1',
      questions: [
        { id: 'choice', question: '选什么？', options: [{ label: 'A', description: 'option' }] },
      ],
    },
  });
  const id = pending(f.events).at(-1)!.request.id;
  await assert.rejects(f.adapter.respond(id, { answers: {} }), { code: 'INVALID_ANSWER' });
  await f.adapter.respond(id, { answers: { choice: ['A'] } });
  assert.deepEqual(f.socket.sent.find((m) => m.id === 'q')?.result, {
    answers: { choice: { answers: ['A'] } },
  });
});

test('disconnect invalidates old approval IDs; reconnect resumes subscriptions and accepts replayed requests', async (t) => {
  const f = fixture(t, { replayRequest: true, reconnect: 5 });
  await f.adapter.connect();
  await f.adapter.subscribe('thread-1');
  const old = pending(f.events).at(-1)!.request.id;
  f.socket.terminate();
  await assert.rejects(f.adapter.respond(old, { decision: 'accept' }), { code: 'REQUEST_EXPIRED' });
  for (let i = 0; i < 30 && f.sockets.length < 2; i++) await delay(5);
  for (let i = 0; i < 30 && pending(f.events).at(-1)!.request.id === old; i++) await delay(5);
  assert.equal(f.sockets.length, 2);
  assert.equal(requests(f.socket, 'thread/resume').length, 1);
  const replayed = pending(f.events).at(-1)!.request.id;
  assert.notEqual(replayed, old);
  await f.adapter.respond(replayed, { decision: 'decline' });
  assert.equal(
    f.events.some((e) => e.type === 'resync'),
    true,
  );
});

test('missing approval replay is shown as a limitation, not an empty successful approval state', async (t) => {
  const f = fixture(t, { active: true });
  f.state.thread.status = { type: 'active', activeFlags: ['waitingOnApproval'] };
  await f.adapter.connect();
  const snapshot = await f.adapter.subscribe('thread-1');
  assert.match(snapshot.warning!, /尚未.*转发请求/);
  assert.deepEqual(snapshot.pendingRequests, []);
});

test('unknown plugins and auth requests are never automatically approved or leaked', async (t) => {
  const f = fixture(t);
  await f.adapter.connect();
  f.socket.push({
    id: 'auth',
    method: 'account/chatgptAuthTokens/refresh',
    params: { secret: 'never-forward' },
  });
  f.socket.push({
    id: 'plugin',
    method: 'item/tool/call',
    params: { threadId: 'thread-1', arguments: { secret: 'never-forward' } },
  });
  assert.equal(pending(f.events).length, 1);
  assert.equal(pending(f.events)[0].request.kind, 'unsupported');
  assert.equal(JSON.stringify(f.events).includes('never-forward'), false);
  await assert.rejects(f.adapter.respond(pending(f.events)[0].request.id, { decision: 'accept' }), {
    code: 'UNSUPPORTED_REQUEST',
  });
  assert.equal(
    f.socket.sent.some((m) => m.id === 'auth' || m.id === 'plugin'),
    false,
  );
});

test('mutation timeout is outcome unknown and never retries the turn', async (t) => {
  const f = fixture(t, {
    timeout: 25,
    handler(message) {
      return message.method === 'turn/start';
    },
  });
  await f.adapter.connect();
  await assert.rejects(f.adapter.send({ threadId: 'thread-1', text: 'once' }), {
    code: 'OUTCOME_UNKNOWN',
  });
  assert.equal(requests(f.socket, 'turn/start').length, 1);
});

test('snapshot issued before live updates preserves newer text, new items and active turn state', async (t) => {
  let hold = false;
  const held: { message: Message; socket: FakeSocket }[] = [];
  const f = fixture(t, {
    handler(message, socket) {
      if (hold && ['thread/read', 'thread/items/list'].includes(message.method ?? '')) {
        held.push({ message, socket });
        return true;
      }
      return false;
    },
  });
  await f.adapter.connect();
  await f.adapter.subscribe('thread-1');
  hold = true;
  const snapshot = f.adapter.snapshot('thread-1');
  await delay(0);
  assert.equal(held.length, 2);
  f.socket.push({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread-1', turnId: 'turn-0', itemId: 'assistant-0', delta: ' newer' },
  });
  f.socket.push({
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-live',
      item: { id: 'new-item', type: 'agentMessage', text: 'fresh' },
    },
  });
  f.socket.push({
    method: 'turn/started',
    params: { threadId: 'thread-1', turn: { id: 'turn-live', items: [] } },
  });
  for (const { message, socket } of held)
    socket.reply(
      message,
      message.method === 'thread/read'
        ? { thread: baseThread() }
        : {
            data: [
              {
                turnId: 'turn-0',
                item: { id: 'assistant-0', type: 'agentMessage', text: 'answer' },
              },
            ],
            nextCursor: null,
          },
    );
  const result = await snapshot;
  assert.equal(result.items.find((i) => i.id === 'assistant-0')?.text, 'answer newer');
  assert.equal(result.items.filter((i) => i.id === 'new-item').length, 1);
  assert.equal(result.thread.activeTurnId, 'turn-live');
  assert.equal(result.thread.status, 'active');
});

test('live items and runtime received before a snapshot survive delayed history persistence', async (t) => {
  const f = fixture(t);
  await f.adapter.connect();
  await f.adapter.subscribe('thread-1');
  f.socket.push({
    method: 'turn/started',
    params: { threadId: 'thread-1', turn: { id: 'turn-0', status: 'inProgress', items: [] } },
  });
  f.socket.push({
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-0',
      item: {
        id: 'live-command',
        type: 'commandExecution',
        command: '/bin/sleep 20',
        status: 'inProgress',
      },
    },
  });
  f.socket.push({
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-0',
      itemId: 'assistant-0',
      delta: ' NEW LIVE TEXT',
    },
  });
  const snapshot = await f.adapter.snapshot('thread-1');
  assert.equal(snapshot.items.find((i) => i.id === 'assistant-0')?.text, 'answer NEW LIVE TEXT');
  assert.equal(
    snapshot.items.some((i) => i.id === 'live-command'),
    true,
  );
  assert.equal(snapshot.thread.status, 'active');
  assert.equal(snapshot.thread.activeTurnId, 'turn-0');
  await f.adapter.send({ threadId: 'thread-1', text: 'steer while history lags' });
  assert.equal(requests(f.socket, 'turn/steer').at(-1)?.params.expectedTurnId, 'turn-0');
  assert.equal(requests(f.socket, 'turn/start').length, 0);
  f.socket.push({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: 'turn-0', status: 'completed', items: [] } },
  });
  f.state.thread.status = { type: 'active', activeFlags: [] };
  const completed = await f.adapter.snapshot('thread-1');
  assert.equal(completed.thread.status, 'idle');
  assert.equal(completed.thread.activeTurnId, undefined);
});

test('history confirmation releases live overlays, and cached older pages do not pollute the latest page', async (t) => {
  let data: unknown[] = [],
    nextCursor: string | null = null;
  const f = fixture(t, {
    handler(message, socket) {
      if (message.method === 'thread/items/list') {
        socket.reply(message, {
          data: message.params.cursor
            ? [
                {
                  turnId: 'older-turn',
                  item: { id: 'old-page-item', type: 'agentMessage', text: 'old page' },
                },
              ]
            : data,
          nextCursor,
        });
        return true;
      }
      return false;
    },
  });
  await f.adapter.connect();
  await f.adapter.subscribe('thread-1');
  const command = {
    id: 'confirmed-command',
    type: 'commandExecution',
    command: 'pwd',
    status: 'completed',
    aggregatedOutput: '/project',
    exitCode: 0,
  };
  f.socket.push({
    method: 'item/completed',
    params: { threadId: 'thread-1', turnId: 'turn-live', item: command },
  });
  assert.equal(
    (await f.adapter.snapshot('thread-1')).items.some((i) => i.id === command.id),
    true,
  );
  data = [{ turnId: 'turn-live', item: command }];
  await f.adapter.snapshot('thread-1');
  data = [{ turnId: 'newer-turn', item: { id: 'latest', type: 'agentMessage', text: 'latest' } }];
  nextCursor = 'older';
  await f.adapter.snapshot('thread-1', 'older');
  const latest = await f.adapter.snapshot('thread-1');
  assert.deepEqual(
    latest.items.map((i) => i.id),
    ['latest'],
  );
  nextCursor = null;
  assert.deepEqual(
    (await f.adapter.snapshot('thread-1')).items.map((i) => i.id),
    ['latest'],
  );
});

test('an older overlapping read retains a live overlay after a newer read confirms persistence', async (t) => {
  let holdNext = false,
    caughtUp = false;
  let held: { message: Message; socket: FakeSocket } | undefined;
  const f = fixture(t, {
    handler(message, socket) {
      if (message.method === 'thread/items/list' && holdNext) {
        holdNext = false;
        held = { message, socket };
        return true;
      }
      if (message.method === 'thread/items/list' && caughtUp) {
        socket.reply(message, {
          data: [
            {
              turnId: 'turn-0',
              item: { id: 'assistant-0', type: 'agentMessage', text: 'answer NEW LIVE TEXT' },
            },
          ],
          nextCursor: null,
        });
        return true;
      }
      return false;
    },
  });
  await f.adapter.connect();
  await f.adapter.subscribe('thread-1');
  f.socket.push({
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-0',
      itemId: 'assistant-0',
      delta: ' NEW LIVE TEXT',
    },
  });
  holdNext = true;
  const olderRead = f.adapter.snapshot('thread-1');
  await delay(0);
  assert.ok(held);
  caughtUp = true;
  assert.equal((await f.adapter.snapshot('thread-1')).items[0].text, 'answer NEW LIVE TEXT');
  held.socket.reply(held.message, {
    data: [{ turnId: 'turn-0', item: { id: 'assistant-0', type: 'agentMessage', text: 'answer' } }],
    nextCursor: null,
  });
  assert.equal((await olderRead).items[0].text, 'answer NEW LIVE TEXT');
});

test('reconnecting discards old-generation item and runtime overlays before rebuilding from history', async (t) => {
  const f = fixture(t);
  await f.adapter.connect();
  await f.adapter.subscribe('thread-1');
  f.socket.push({
    method: 'turn/started',
    params: {
      threadId: 'thread-1',
      turn: { id: 'old-live-turn', status: 'inProgress', items: [] },
    },
  });
  f.socket.push({
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: 'old-live-turn',
      item: { id: 'old-generation-item', type: 'agentMessage', text: 'old live content' },
    },
  });
  f.socket.terminate();
  await f.adapter.connect();
  const snapshot = await f.adapter.snapshot('thread-1');
  assert.equal(snapshot.thread.status, 'idle');
  assert.equal(snapshot.thread.activeTurnId, undefined);
  assert.equal(
    snapshot.items.some((i) => i.id === 'old-generation-item'),
    false,
  );
});

test('a later-started overlapping read cannot revert an earlier request that confirms persistence first', async (t) => {
  let hold = false;
  const held: { message: Message; socket: FakeSocket }[] = [];
  const f = fixture(t, {
    handler(message, socket) {
      if (hold && message.method === 'thread/items/list') {
        held.push({ message, socket });
        return true;
      }
      return false;
    },
  });
  await f.adapter.connect();
  await f.adapter.subscribe('thread-1');
  f.socket.push({
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-0',
      itemId: 'assistant-0',
      delta: ' NEW LIVE TEXT',
    },
  });
  hold = true;
  const first = f.adapter.snapshot('thread-1'),
    second = f.adapter.snapshot('thread-1');
  await delay(0);
  assert.equal(held.length, 2);
  held[0].socket.reply(held[0].message, {
    data: [
      {
        turnId: 'turn-0',
        item: { id: 'assistant-0', type: 'agentMessage', text: 'answer NEW LIVE TEXT' },
      },
    ],
    nextCursor: null,
  });
  assert.equal((await first).items[0].text, 'answer NEW LIVE TEXT');
  held[1].socket.reply(held[1].message, {
    data: [{ turnId: 'turn-0', item: { id: 'assistant-0', type: 'agentMessage', text: 'answer' } }],
    nextCursor: null,
  });
  assert.equal((await second).items[0].text, 'answer NEW LIVE TEXT');
});

test('runtime overlay waits for both metadata and turn history to confirm active and terminal state', async (t) => {
  let turnStatus = 'inProgress';
  const f = fixture(t, {
    handler(message, socket) {
      if (message.method === 'thread/turns/list') {
        socket.reply(message, {
          data: [{ id: 'live-turn', status: turnStatus, items: [] }],
          nextCursor: null,
        });
        return true;
      }
      return false;
    },
  });
  await f.adapter.connect();
  await f.adapter.subscribe('thread-1');
  f.socket.push({
    method: 'turn/started',
    params: { threadId: 'thread-1', turn: { id: 'live-turn', status: 'inProgress', items: [] } },
  });
  for (let n = 0; n < 2; n++) {
    const snapshot = await f.adapter.snapshot('thread-1');
    assert.equal(snapshot.thread.status, 'active');
    assert.equal(snapshot.thread.activeTurnId, 'live-turn');
  }
  f.state.thread.status = { type: 'active', activeFlags: [] };
  await f.adapter.snapshot('thread-1');
  f.socket.push({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: 'live-turn', status: 'completed', items: [] } },
  });
  turnStatus = 'completed';
  for (let n = 0; n < 2; n++) {
    const snapshot = await f.adapter.snapshot('thread-1');
    assert.equal(snapshot.thread.status, 'idle');
    assert.equal(snapshot.thread.activeTurnId, undefined);
  }
  f.state.thread.status = { type: 'idle' };
  await f.adapter.snapshot('thread-1');
});

test('confirmation raises the protected item to fuller persisted content until overlapping reads finish', async (t) => {
  let hold = false;
  const held: { message: Message; socket: FakeSocket }[] = [];
  const f = fixture(t, {
    handler(message, socket) {
      if (hold && message.method === 'thread/items/list') {
        held.push({ message, socket });
        return true;
      }
      return false;
    },
  });
  await f.adapter.connect();
  await f.adapter.subscribe('thread-1');
  f.socket.push({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread-1', turnId: 'turn-0', itemId: 'assistant-0', delta: ' live' },
  });
  hold = true;
  const first = f.adapter.snapshot('thread-1'),
    second = f.adapter.snapshot('thread-1');
  await delay(0);
  held[0].socket.reply(held[0].message, {
    data: [
      {
        turnId: 'turn-0',
        item: {
          id: 'assistant-0',
          type: 'agentMessage',
          text: 'answer live persisted continuation',
        },
      },
    ],
    nextCursor: null,
  });
  assert.equal((await first).items[0].text, 'answer live persisted continuation');
  held[1].socket.reply(held[1].message, {
    data: [
      { turnId: 'turn-0', item: { id: 'assistant-0', type: 'agentMessage', text: 'answer live' } },
    ],
    nextCursor: null,
  });
  assert.equal((await second).items[0].text, 'answer live persisted continuation');
});

test('failed and interrupted turn completion remains visible with explicit outcome', async (t) => {
  const f = fixture(t);
  await f.adapter.connect();
  await f.adapter.subscribe('thread-1');
  f.socket.push({
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: { id: 'turn-0', status: 'failed', items: [], error: { message: 'model unavailable' } },
    },
  });
  assert.ok(
    f.events.some(
      (e) =>
        e.type === 'item.updated' &&
        e.item.type === 'error' &&
        e.item.text.includes('model unavailable'),
    ),
  );
  assert.equal(
    (await f.adapter.snapshot('thread-1')).items.find((i) => i.id === 'outcome:turn-0')?.status,
    'failed',
  );
  f.socket.push({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: 'turn-0', status: 'interrupted', items: [] } },
  });
  assert.ok(
    f.events.some(
      (e) =>
        e.type === 'item.updated' &&
        e.item.status === 'interrupted' &&
        e.item.text === '任务已停止',
    ),
  );
});

test('terminated turns settle only their still-running child items in live events and stale snapshots', async (t) => {
  const f = fixture(t, {
    handler(message, socket) {
      if (message.method === 'thread/items/list') {
        socket.reply(message, { data: [], nextCursor: null });
        return true;
      }
      return false;
    },
  });
  await f.adapter.connect();
  await f.adapter.subscribe('thread-1');
  for (const terminal of ['interrupted', 'failed'] as const) {
    const turnId = `turn-${terminal}`,
      itemId = `command-${terminal}`;
    f.socket.push({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId,
        item: {
          id: itemId,
          type: 'commandExecution',
          command: '/bin/sleep 20',
          aggregatedOutput: 'partial output',
          status: 'inProgress',
        },
      },
    });
    f.socket.push({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId,
        item: {
          id: `done-${terminal}`,
          type: 'commandExecution',
          command: 'pwd',
          status: 'completed',
          exitCode: 0,
        },
      },
    });
    f.socket.push({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: turnId, status: terminal, items: [] } },
    });
    const updated = f.events
      .filter(
        (e): e is Extract<GatewayEvent, { type: 'item.updated' }> =>
          e.type === 'item.updated' && e.item.id === itemId,
      )
      .at(-1)!.item;
    assert.equal(updated.status, terminal);
    assert.match(updated.text, /partial output/);
    // Late item notifications may still carry the backend's stale child status.
    f.socket.push({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId,
        item: {
          id: itemId,
          type: 'commandExecution',
          command: '/bin/sleep 20',
          status: 'inProgress',
        },
      },
    });
    const snapshot = await f.adapter.snapshot('thread-1');
    assert.equal(snapshot.items.find((i) => i.id === itemId)?.status, terminal);
    assert.equal(snapshot.items.find((i) => i.id === `done-${terminal}`)?.status, 'completed');
  }
});

test('fresh historical turn pages settle residual running children for both latest and older terminated turns', async (t) => {
  const f = fixture(t, {
    handler(message, socket) {
      if (message.method === 'thread/items/list') {
        socket.push({
          id: message.id,
          error: { code: -32601, message: 'thread/items/list is not supported yet' },
        });
        return true;
      }
      if (message.method === 'thread/turns/list') {
        const turns = [
          {
            id: 'failed-turn',
            status: 'failed',
            itemsView: 'full',
            items: [
              {
                id: 'failed-child',
                type: 'commandExecution',
                command: 'pwd',
                status: 'inProgress',
              },
            ],
          },
          {
            id: 'stopped-turn',
            status: 'interrupted',
            itemsView: 'full',
            items: [
              {
                id: 'stopped-child',
                type: 'commandExecution',
                command: '/bin/sleep 20',
                status: 'inProgress',
              },
              { id: 'already-done', type: 'commandExecution', command: 'pwd', status: 'completed' },
            ],
          },
        ];
        socket.reply(message, {
          data: message.params.itemsView === 'full' ? turns : turns.slice(0, 1),
          nextCursor: null,
        });
        return true;
      }
      return false;
    },
  });
  await f.adapter.connect();
  const snapshot = await f.adapter.subscribe('thread-1');
  assert.equal(snapshot.items.find((i) => i.id === 'failed-child')?.status, 'failed');
  assert.equal(snapshot.items.find((i) => i.id === 'stopped-child')?.status, 'interrupted');
  assert.equal(snapshot.items.find((i) => i.id === 'already-done')?.status, 'completed');
});

test('a socket connection failure rejects promptly and remains honestly disconnected', async (t) => {
  let socket: FakeSocket;
  const adapter = new CodexAdapter({
    socketPath: '/tmp/existing.sock',
    reconnectDelayMs: 50_000,
    requestTimeoutMs: 50,
    socketFactory() {
      socket = new FakeSocket(() => {});
      queueMicrotask(() => socket.emit('error', new Error('connect EPERM')));
      return socket;
    },
  });
  t.after(() => adapter.close());
  await assert.rejects(adapter.connect(), /EPERM/);
  assert.equal(adapter.connection.connected, false);
  assert.equal(adapter.connection.sharedBackend, true);
  assert.equal(adapter.capabilities.liveControl, false);
});
