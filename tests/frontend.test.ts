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
