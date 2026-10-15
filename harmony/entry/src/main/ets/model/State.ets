import { ConversationItem, EventEnvelope, GatewayEvent, ThreadSnapshot, ThreadSummary } from './Protocol';

function copyItem(item: ConversationItem, text: string, status: string | undefined): ConversationItem {
  return {
    id: item.id,
    turnId: item.turnId,
    type: item.type,
    role: item.role,
    text: text,
    status: status,
    images: item.images
  };
}

function copySnapshot(snapshot: ThreadSnapshot): ThreadSnapshot {
  return {
    thread: snapshot.thread,
    items: snapshot.items,
    nextCursor: snapshot.nextCursor,
    pendingRequests: snapshot.pendingRequests,
    settings: snapshot.settings,
    warning: snapshot.warning,
    eventCursor: snapshot.eventCursor
  };
}

export function mergeItems(previous: ConversationItem[], incoming: ConversationItem[], prepend: boolean = false): ConversationItem[] {
  const entries = new Map<string, ConversationItem>();
  previous.forEach((item: ConversationItem) => entries.set(item.id, item));
  incoming.forEach((item: ConversationItem) => entries.set(item.id, item));
  const outcomes = new Map<string, string>();
  entries.forEach((item: ConversationItem) => {
    if (item.id === `outcome:${item.turnId}` && (item.status === 'interrupted' || item.status === 'failed')) {
      outcomes.set(item.turnId, item.status);
    }
  });
  const ordered = prepend ? incoming.concat(previous) : previous.concat(incoming);
  const visited = new Set<string>();
  const result: ConversationItem[] = [];
  ordered.forEach((candidate: ConversationItem) => {
    if (visited.has(candidate.id)) return;
    visited.add(candidate.id);
    const item = entries.get(candidate.id);
    if (!item) return;
    const outcome = outcomes.get(item.turnId);
    result.push(outcome && item.status === 'inProgress' ? copyItem(item, item.text, outcome) : item);
  });
  return result;
}

export function updateThreadList(threads: ThreadSummary[], thread: ThreadSummary): ThreadSummary[] {
  return [thread].concat(threads.filter((item: ThreadSummary) => item.id !== thread.id))
    .sort((left: ThreadSummary, right: ThreadSummary) => right.updatedAt - left.updatedAt);
}

export function applyEvent(snapshot: ThreadSnapshot | undefined, event: GatewayEvent): ThreadSnapshot | undefined {
  if (!snapshot) return undefined;
  const result = copySnapshot(snapshot);
  if (event.type === 'thread.changed' && event.thread && event.thread.id === snapshot.thread.id) {
    result.thread = event.thread;
    return result;
  }
  if (event.type === 'request.pending' && event.request && event.request.threadId === snapshot.thread.id) {
    const pending = event.request;
    result.warning = undefined;
    result.pendingRequests = snapshot.pendingRequests.filter((item) => item.id !== pending.id).concat([pending]);
    return result;
  }
  if (event.threadId !== snapshot.thread.id) return snapshot;
  if (event.type === 'item.updated' && event.item) {
    result.items = mergeItems(snapshot.items, [event.item]);
    return result;
  }
  if (event.type === 'item.delta' && event.itemId && event.turnId && typeof event.delta === 'string') {
    const previous = snapshot.items.find((item: ConversationItem) => item.id === event.itemId);
    const item: ConversationItem = previous ? copyItem(previous, previous.text + event.delta, previous.status) : {
      id: event.itemId,
      turnId: event.turnId,
      type: 'agentMessage',
      role: 'assistant',
      text: event.delta
    };
    result.items = mergeItems(snapshot.items, [item]);
    return result;
  }
  if (event.type === 'request.resolved' && event.requestId) {
    result.pendingRequests = snapshot.pendingRequests.filter((item) => item.id !== event.requestId);
    return result;
  }
  return snapshot;
}

// Snapshot replies can arrive behind live deltas. Reapply only events newer
// than that reply's cursor, without appending deltas twice to older pages.
export class SnapshotTracker {
  private events: EventEnvelope[] = [];
  private epoch: string = '';
  private lastSeq: number = -1;
  private droppedThrough: number = -1;

  record(envelope: EventEnvelope): void {
    if (this.epoch !== envelope.epoch) {
      this.reset();
      this.epoch = envelope.epoch;
    }
    if (envelope.seq <= this.lastSeq) return;
    this.lastSeq = envelope.seq;
    this.events.push(envelope);
    if (this.events.length > 5000) {
      const dropped = this.events.shift();
      if (dropped) this.droppedThrough = dropped.seq;
    }
  }

  reconcile(current: ThreadSnapshot | undefined, incoming: ThreadSnapshot, prepend: boolean = false): ThreadSnapshot {
    const cursor = incoming.eventCursor;
    if (cursor && this.epoch && cursor.epoch !== this.epoch) {
      throw new Error('连接已更新，请重新同步会话。');
    }
    if (cursor && cursor.seq < this.droppedThrough) {
      throw new Error('实时事件已超过缓冲区，请重新同步会话。');
    }
    const sameThread = current && current.thread.id === incoming.thread.id ? current : undefined;
    const incomingIds = new Set<string>(incoming.items.map((item: ConversationItem) => item.id));
    const preservedIds = new Set<string>();
    if (sameThread) {
      sameThread.items.forEach((item: ConversationItem) => {
        if (!incomingIds.has(item.id)) preservedIds.add(item.id);
      });
    }
    let result = copySnapshot(incoming);
    result.items = mergeItems(sameThread ? sameThread.items : [], incoming.items, prepend);
    if (!cursor) return result;
    this.events.forEach((envelope: EventEnvelope) => {
      if (envelope.epoch !== cursor.epoch || envelope.seq <= cursor.seq) return;
      const event = envelope.event;
      if (event.type === 'item.delta' && event.itemId && preservedIds.has(event.itemId)) return;
      if (event.type === 'item.updated' && event.item && preservedIds.has(event.item.id)) return;
      const updated = applyEvent(result, event);
      if (updated) result = updated;
    });
    return result;
  }

  reset(): void {
    this.events = [];
    this.epoch = '';
    this.lastSeq = -1;
    this.droppedThrough = -1;
  }
}

export class EventCursor {
  private epoch: string = '';
  private seq: number = 0;

  accept(envelope: EventEnvelope): 'apply' | 'duplicate' | 'resync' {
    if (this.epoch !== envelope.epoch) {
      const initial = this.epoch.length === 0;
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
