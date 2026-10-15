import type {
  ConversationItem,
  EventEnvelope,
  GatewayEvent,
  ThreadSnapshot,
  ThreadSummary,
} from '../shared/protocol';

export function mergeItems(
  old: ConversationItem[],
  incoming: ConversationItem[],
  prepend = false,
): ConversationItem[] {
  const entries = new Map(old.map((item) => [item.id, item]));
  for (const item of incoming) entries.set(item.id, item);
  const order = prepend ? [...incoming, ...old] : [...old, ...incoming];
  // A gateway restart can lose an unpersisted tool item while the browser
  // retains it. Its parent turn outcome still settles that cached item.
  const outcomes = new Map<string, string>();
  for (const item of entries.values()) {
    if (
      item.id === `outcome:${item.turnId}` &&
      (item.status === 'interrupted' || item.status === 'failed')
    )
      outcomes.set(item.turnId, item.status);
  }
  return [...new Set(order.map((item) => item.id))].map((id) => {
    const item = entries.get(id)!;
    const outcome = outcomes.get(item.turnId);
    return outcome && item.status === 'inProgress' ? { ...item, status: outcome } : item;
  });
}

export function updateThreadList(threads: ThreadSummary[], thread: ThreadSummary): ThreadSummary[] {
  return [thread, ...threads.filter((item) => item.id !== thread.id)].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
}

export function applyEvent(
  snapshot: ThreadSnapshot | null,
  event: GatewayEvent,
): ThreadSnapshot | null {
  if (!snapshot) return snapshot;
  if (event.type === 'thread.changed' && event.thread.id === snapshot.thread.id)
    return { ...snapshot, thread: event.thread };
  if (event.type === 'request.pending' && event.request.threadId === snapshot.thread.id) {
    return {
      ...snapshot,
      warning: undefined,
      pendingRequests: [
        ...snapshot.pendingRequests.filter((item) => item.id !== event.request.id),
        event.request,
      ],
    };
  }
  if (!('threadId' in event) || event.threadId !== snapshot.thread.id) return snapshot;
  if (event.type === 'item.updated')
    return { ...snapshot, items: mergeItems(snapshot.items, [event.item]) };
  if (event.type === 'item.delta') {
    const previous = snapshot.items.find((item) => item.id === event.itemId);
    const item: ConversationItem = previous
      ? { ...previous, text: previous.text + event.delta }
      : {
          id: event.itemId,
          turnId: event.turnId,
          type: 'agentMessage',
          role: 'assistant',
          text: event.delta,
        };
    return { ...snapshot, items: mergeItems(snapshot.items, [item]) };
  }
  if (event.type === 'request.resolved')
    return {
      ...snapshot,
      pendingRequests: snapshot.pendingRequests.filter((item) => item.id !== event.requestId),
    };
  return snapshot;
}

/** Reconcile an HTTP/RPC snapshot with events delivered ahead of its response. */
export class SnapshotTracker {
  private events: EventEnvelope[] = [];
  private epoch: string | null = null;
  private lastSeq = -1;
  private droppedThrough = -1;
  record(envelope: EventEnvelope): void {
    if (this.epoch !== envelope.epoch) {
      this.reset();
      this.epoch = envelope.epoch;
    }
    if (envelope.seq <= this.lastSeq) return;
    this.lastSeq = envelope.seq;
    this.events.push(envelope);
    if (this.events.length > 5000) this.droppedThrough = this.events.shift()!.seq;
  }
  reconcile(
    current: ThreadSnapshot | null,
    incoming: ThreadSnapshot,
    prepend = false,
  ): ThreadSnapshot {
    const cursor = incoming.eventCursor;
    if (cursor && this.epoch && cursor.epoch !== this.epoch)
      throw new Error('连接已更新，请重新同步会话');
    if (cursor && cursor.seq < this.droppedThrough)
      throw new Error('实时事件已超过缓冲区，请重新同步会话');
    const sameThread = current?.thread.id === incoming.thread.id ? current : null;
    const incomingIds = new Set(incoming.items.map((item) => item.id));
    const preservedIds = new Set(
      sameThread?.items.filter((item) => !incomingIds.has(item.id)).map((item) => item.id),
    );
    let result: ThreadSnapshot = {
      ...incoming,
      items: mergeItems(sameThread?.items ?? [], incoming.items, prepend),
    };
    if (!cursor) return result;
    for (const envelope of this.events) {
      if (envelope.epoch !== cursor.epoch || envelope.seq <= cursor.seq) continue;
      const event = envelope.event;
      // Items outside this page already hold these events in current. Replaying
      // their deltas would append twice; items on this page start from incoming.
      if (event.type === 'item.delta' && preservedIds.has(event.itemId)) continue;
      if (event.type === 'item.updated' && preservedIds.has(event.item.id)) continue;
      result = applyEvent(result, event)!;
    }
    return result;
  }
  reset(): void {
    this.events = [];
    this.epoch = null;
    this.lastSeq = -1;
    this.droppedThrough = -1;
  }
}

export class EventCursor {
  private epoch: string | null = null;
  private seq = 0;
  accept(envelope: EventEnvelope): 'apply' | 'duplicate' | 'resync' {
    if (this.epoch !== envelope.epoch) {
      const initial = this.epoch === null;
      this.epoch = envelope.epoch;
      this.seq = envelope.seq;
      return initial ? 'apply' : 'resync';
    }
    if (envelope.seq <= this.seq) return 'duplicate';
    const gap = envelope.seq !== this.seq + 1;
    this.seq = envelope.seq;
    return gap ? 'resync' : 'apply';
  }
}

export function safeImageUrl(value: string): string | undefined {
  return /^\/api\/v1\/uploads\/[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9]+)?$/.test(value) ? value : undefined;
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请重试。';
}

export function readDraft(threadId: string): string {
  try {
    return sessionStorage.getItem(`codex-phone:draft:${threadId}`) || '';
  } catch {
    return '';
  }
}

export function storeDraft(threadId: string, draft: string): void {
  try {
    draft
      ? sessionStorage.setItem(`codex-phone:draft:${threadId}`, draft)
      : sessionStorage.removeItem(`codex-phone:draft:${threadId}`);
  } catch {
    /* Storage is optional. */
  }
}
