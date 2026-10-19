import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SnapshotTracker,
  applyEvent,
  EventCursor,
  mergeItems,
  safeImageUrl,
} from '../web/state.js';
import type { EventEnvelope, GatewayEvent, ThreadSnapshot } from '../shared/protocol.js';
import { formatMessageTime } from '../web/message-time.js';
const snapshot = (text = 'abc', seq = 3): ThreadSnapshot => ({
  thread: { id: 't', title: 'Test', preview: '', cwd: '/p', status: 'idle', updatedAt: 1 },
  items: [{ id: 'a', turnId: 'turn', type: 'agentMessage', role: 'assistant', text }],
  nextCursor: null,
  pendingRequests: [],
  eventCursor: { epoch: 'e', seq },
});
const envelope = (seq: number, event: GatewayEvent, epoch = 'e'): EventEnvelope => ({
  type: 'event',
  epoch,
  seq,
  event,
});
const delta = (text: string, id = 'a'): GatewayEvent => ({
  type: 'item.delta',
  threadId: 't',
  itemId: id,
  turnId: 'turn',
  delta: text,
});

test('message timestamps distinguish today, another day and another year without inventing missing times', () => {
  const now = new Date(2026, 9, 19, 16, 30).getTime();
  assert.equal(formatMessageTime(new Date(2026, 9, 19, 9, 5).getTime(), now), '09:05');
  assert.equal(formatMessageTime(new Date(2026, 9, 18, 9, 5).getTime(), now), '10/18 09:05');
  assert.equal(formatMessageTime(new Date(2025, 9, 18, 9, 5).getTime(), now), '2025/10/18 09:05');
  for (const missing of [undefined, 0, -1, Number.NaN, Infinity, 1e20])
    assert.equal(formatMessageTime(missing, now), '时间未知');
});

test('message time survives deltas, timestamp-less updates, refresh and older pages', () => {
  const createdAt = new Date(2026, 9, 19, 9, 5).getTime();
  const original = snapshot();
  original.items[0].createdAt = createdAt;
  let current = applyEvent(original, delta(' more'))!;
  assert.equal(current.items[0].createdAt, createdAt);
  current = applyEvent(current, {
    type: 'item.updated',
    threadId: 't',
    item: snapshot('replacement').items[0],
  })!;
  assert.equal(current.items[0].createdAt, createdAt);
  const tracker = new SnapshotTracker();
  current = tracker.reconcile(current, snapshot('refresh'));
  assert.equal(current.items[0].createdAt, createdAt);
  current = tracker.reconcile(current, snapshot('older'), true);
  assert.equal(current.items[0].createdAt, createdAt);
  assert.equal(
    mergeItems(current.items, [{ ...current.items[0], createdAt: Number.NaN }])[0].createdAt,
    createdAt,
  );
  assert.equal(
    mergeItems(current.items, [{ ...current.items[0], createdAt: createdAt + 1000 }])[0].createdAt,
    createdAt + 1000,
  );
  assert.equal(applyEvent(snapshot(), delta(' delta'))!.items[0].createdAt, undefined);
});

test('sticky context stays with the first merged history page across refresh, pagination and thread switches', () => {
  const tracker = new SnapshotTracker();
  const prompt = (id: string) => ({
    id,
    turnId: id,
    type: 'userMessage',
    role: 'user' as const,
    text: id,
  });
  const current = snapshot();
  current.contextUser = prompt('first-page-prompt');
  const refresh = snapshot();
  refresh.items = [{ ...refresh.items[0], id: 'new-answer' }];
  refresh.contextUser = prompt('newer-page-prompt');
  assert.equal(tracker.reconcile(current, refresh).contextUser?.id, 'first-page-prompt');
  const older = snapshot();
  older.items = [{ ...older.items[0], id: 'old-answer' }];
  older.contextUser = prompt('older-page-prompt');
  const withOlder = tracker.reconcile(current, older, true);
  assert.equal(withOlder.items[0].id, 'old-answer');
  assert.equal(withOlder.contextUser?.id, 'older-page-prompt');
  assert.equal(tracker.reconcile(withOlder, refresh).contextUser?.id, 'older-page-prompt');
  const noContext = { ...older, contextUser: undefined };
  assert.equal(tracker.reconcile(current, noContext, true).contextUser, undefined);
  const emptyPage = { ...older, items: [] };
  assert.equal(tracker.reconcile(current, emptyPage, true).contextUser?.id, 'first-page-prompt');
  assert.equal(
    tracker.reconcile({ ...current, items: [] }, refresh).contextUser?.id,
    'newer-page-prompt',
  );
  assert.equal(tracker.reconcile(null, refresh).contextUser?.id, 'newer-page-prompt');
  const otherThread = {
    ...refresh,
    thread: { ...refresh.thread, id: 'another-thread' },
    contextUser: undefined,
  };
  assert.equal(tracker.reconcile(current, otherThread).contextUser, undefined);
});

test('refreshing the same first item can recover unresolved context and enrich its timestamp', () => {
  const tracker = new SnapshotTracker();
  const unresolved = snapshot();
  const resolved = snapshot();
  resolved.contextUser = {
    id: 'context-user',
    turnId: 'turn',
    type: 'userMessage',
    role: 'user',
    text: 'Prompt found after a later scan',
  };
  const recovered = tracker.reconcile(unresolved, resolved);
  assert.equal(recovered.contextUser?.id, 'context-user');
  const createdAt = new Date(2026, 9, 19, 9, 5).getTime();
  const enriched = { ...resolved, contextUser: { ...resolved.contextUser, createdAt } };
  assert.equal(tracker.reconcile(recovered, enriched).contextUser?.createdAt, createdAt);
});

test('a temporarily omitted context preserves known context only when the first item stays the same', () => {
  const tracker = new SnapshotTracker();
  const current = snapshot();
  current.contextUser = {
    id: 'known-prompt',
    turnId: 'turn',
    type: 'userMessage',
    role: 'user',
    text: 'Already resolved prompt',
    createdAt: new Date(2026, 9, 19, 9, 5).getTime(),
  };
  const omitted = snapshot('refreshed message');
  assert.deepEqual(tracker.reconcile(current, omitted).contextUser, current.contextUser);
  assert.deepEqual(tracker.reconcile(current, omitted, true).contextUser, current.contextUser);
  const older = { ...omitted, items: [{ ...omitted.items[0], id: 'older-first-item' }] };
  assert.equal(tracker.reconcile(current, older, true).contextUser, undefined);
});

test('watermark reconciliation replays only events newer than authoritative incoming snapshot', () => {
  const tracker = new SnapshotTracker();
  let current = snapshot('a', 1);
  for (const [seq, text] of [
    [2, 'b'],
    [3, 'c'],
    [4, 'd'],
  ] as const) {
    const event = envelope(seq, delta(text));
    current = applyEvent(current, event.event)!;
    tracker.record(event);
  }
  const result = tracker.reconcile(current, snapshot('abc', 3));
  assert.equal(result.items[0].text, 'abcd');
  // A corrected server prefix is authoritative; keeping current would lose it.
  assert.equal(tracker.reconcile(current, snapshot('ABC', 3)).items[0].text, 'ABCd');
});

test('first subscription retains events that arrive before its response when current is null', () => {
  const tracker = new SnapshotTracker();
  tracker.record(envelope(4, delta('d')));
  tracker.record(
    envelope(5, {
      type: 'item.updated',
      threadId: 't',
      item: { id: 'new', turnId: 'turn', type: 'plan', text: 'new item' },
    }),
  );
  const result = tracker.reconcile(null, snapshot());
  assert.equal(result.items[0].text, 'abcd');
  assert.equal(result.items[1].text, 'new item');
});

test('pagination preserves current off-page items without double-appending their applied deltas', () => {
  const tracker = new SnapshotTracker();
  const event = envelope(4, delta('d'));
  const current = applyEvent(snapshot(), event.event)!;
  tracker.record(event);
  const older = snapshot();
  older.items = [{ id: 'old', turnId: 'older', type: 'userMessage', role: 'user', text: 'old' }];
  older.nextCursor = 'more';
  const result = tracker.reconcile(current, older, true);
  assert.deepEqual(
    result.items.map((i) => i.id),
    ['old', 'a'],
  );
  assert.equal(result.items[1].text, 'abcd');
  assert.equal(result.nextCursor, 'more');
});

test('history pagination preserves access while a fresh subscription can restore editing', () => {
  const tracker = new SnapshotTracker();
  const current = { ...snapshot(), readOnly: true };
  const older = snapshot();
  older.items = [{ id: 'old', turnId: 'older', type: 'userMessage', text: 'old' }];
  assert.equal(tracker.reconcile(current, older, true).readOnly, true);
  const writable = tracker.reconcile(current, snapshot());
  assert.equal(writable.readOnly, undefined);
  // An in-flight older page must not undo the explicit successful retry either.
  assert.equal(tracker.reconcile(writable, { ...older, readOnly: true }, true).readOnly, undefined);
  assert.equal(tracker.reconcile(writable, current).readOnly, true);
});

test('later approvals, resolutions and turn updates override snapshot state exactly once', () => {
  const tracker = new SnapshotTracker();
  const incoming = snapshot();
  incoming.pendingRequests = [
    { id: 'expired', threadId: 't', kind: 'command', title: '', detail: '' },
  ];
  tracker.record(envelope(4, { type: 'request.resolved', threadId: 't', requestId: 'expired' }));
  tracker.record(
    envelope(5, {
      type: 'request.pending',
      request: { id: 'new', threadId: 't', kind: 'userInput', title: '', detail: '' },
    }),
  );
  tracker.record(
    envelope(6, {
      type: 'thread.changed',
      thread: { ...incoming.thread, status: 'active', activeTurnId: 'running' },
    }),
  );
  const result = tracker.reconcile(null, incoming);
  assert.deepEqual(
    result.pendingRequests.map((p) => p.id),
    ['new'],
  );
  assert.equal(result.thread.activeTurnId, 'running');
});

test('epoch changes and buffer overflow require a fresh snapshot instead of silently losing events', () => {
  const tracker = new SnapshotTracker();
  tracker.record(envelope(1, delta('x'), 'new-epoch'));
  assert.throws(() => tracker.reconcile(snapshot(), snapshot()), /连接已更新/);
  tracker.reset();
  for (let seq = 0; seq <= 5001; seq++) tracker.record(envelope(seq, { type: 'resync' }));
  assert.throws(() => tracker.reconcile(snapshot(), snapshot('abc', 0)), /缓冲区/);
  assert.equal(tracker.reconcile(null, snapshot('fresh', 5001)).items[0].text, 'fresh');
});

test('event cursor handles reconnect epochs, duplicates and lost events', () => {
  const cursor = new EventCursor();
  assert.equal(cursor.accept(envelope(1, delta('a'))), 'apply');
  assert.equal(cursor.accept(envelope(1, delta('a'))), 'duplicate');
  assert.equal(cursor.accept(envelope(3, delta('c'))), 'resync');
  assert.equal(cursor.accept(envelope(0, delta('x'), 'next')), 'resync');
});

test('history merge deduplicates item ids and image URLs cannot escape authenticated uploads', () => {
  const a = snapshot().items[0];
  assert.equal(mergeItems([a], [{ ...a, text: 'new' }]).length, 1);
  assert.equal(safeImageUrl('/api/v1/uploads/uuid'), '/api/v1/uploads/uuid');
  assert.equal(safeImageUrl('file:///etc/passwd'), undefined);
  assert.equal(safeImageUrl('https://tracker.example/a.png'), undefined);
});

test('terminal turn outcomes settle cached tools omitted after gateway restart without changing completed or other-turn items', () => {
  for (const status of ['interrupted', 'failed']) {
    const current = snapshot();
    current.items = [
      {
        id: 'running',
        turnId: 'turn',
        type: 'commandExecution',
        status: 'inProgress',
        text: 'sleep 20',
      },
      { id: 'done', turnId: 'turn', type: 'commandExecution', status: 'completed', text: 'output' },
      {
        id: 'other',
        turnId: 'another',
        type: 'commandExecution',
        status: 'inProgress',
        text: 'other task',
      },
    ];
    const incoming = snapshot();
    incoming.eventCursor = { epoch: 'restarted', seq: 2 };
    incoming.items = [
      {
        id: 'outcome:turn',
        turnId: 'turn',
        type: status === 'failed' ? 'error' : 'turnStatus',
        status,
        text: 'terminal outcome',
      },
    ];
    const tracker = new SnapshotTracker();
    const result = tracker.reconcile(current, incoming);
    assert.equal(result.items.find((i) => i.id === 'running')!.status, status);
    assert.equal(result.items.find((i) => i.id === 'running')!.text, 'sleep 20');
    assert.equal(result.items.find((i) => i.id === 'done')!.status, 'completed');
    assert.equal(result.items.find((i) => i.id === 'other')!.status, 'inProgress');
    const late = applyEvent(result, {
      type: 'item.updated',
      threadId: 't',
      item: current.items[0],
    })!;
    assert.equal(late.items.find((i) => i.id === 'running')!.status, status);
    const live = applyEvent(current, {
      type: 'item.updated',
      threadId: 't',
      item: incoming.items[0],
    })!;
    assert.equal(live.items.find((i) => i.id === 'running')!.status, status);
  }
});
