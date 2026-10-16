import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type {
  Capabilities,
  ConnectionState,
  ConversationItem,
  CreateThreadInput,
  GatewayEvent,
  ModelOption,
  PendingRequest,
  RequestAnswer,
  SendInput,
  SessionSettings,
  ThreadSnapshot,
  ThreadSummary,
  WorkspaceSummary,
} from '../shared/protocol.js';

// Wire names/shapes are pinned to codex app-server 0.162.1 generated TypeScript.
// Keep that protocol behind this adapter; the browser never receives raw RPC.
type ObjectValue = Record<string, unknown>;
type RpcId = string | number;
export interface CodexSocket {
  on(event: string, listener: (...args: any[]) => void): unknown;
  send(data: string, callback?: (error?: Error) => void): unknown;
  close(): unknown;
  terminate(): unknown;
}
export interface CodexAdapterOptions {
  socketPath: string;
  /** Injectable only for protocol tests, never configurable over HTTP. */
  socketFactory?: (url: string) => CodexSocket;
  requestTimeoutMs?: number;
  reconnectDelayMs?: number;
}
export class CodexError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CodexError';
  }
}
interface Inflight {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  mutation: boolean;
}
interface Approval {
  wireId: RpcId;
  generation: string;
  request: PendingRequest;
  params: ObjectValue;
  method: string;
  responding: boolean;
}
interface LiveItem {
  item: ConversationItem;
  revision: number;
  confirmedThrough?: number;
}
interface LiveRuntime {
  status: ThreadSummary['status'];
  turnId?: string;
  revision: number;
  confirmedThrough?: number;
}
const record = (v: unknown): ObjectValue =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as ObjectValue) : {};
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const json = (v: unknown): string =>
  typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v, null, 2);
const status = (v: unknown): ThreadSummary['status'] =>
  ['idle', 'active', 'systemError'].includes(str(record(v).type))
    ? (record(v).type as ThreadSummary['status'])
    : 'notLoaded';
const source = (v: unknown): string =>
  typeof v === 'string' ? v : str(record(v).custom, record(v).subAgent ? 'subAgent' : 'unknown');
const rpcKey = (id: RpcId): string => `${typeof id}:${id}`;
const knownEfforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const readCursorPrefix = 'phone-read-v1:';
const emptyCwdCursorPrefix = 'phone-empty-cwd-v1:';

/** Shared-backend client: never launches an app-server or reads rollout files. */
export class CodexAdapter extends EventEmitter {
  private socket?: CodexSocket;
  private stopped = false;
  private connecting?: Promise<void>;
  private generation = '';
  private sequence = 0;
  private inflight = new Map<string, Inflight>();
  private approvals = new Map<string, Approval>();
  private watched = new Set<string>();
  private resumed = new Set<string>();
  private readOnly = new Set<string>();
  private resuming = new Map<string, Promise<ThreadSnapshot>>();
  private threads = new Map<string, ThreadSummary>();
  private settings = new Map<string, SessionSettings>();
  private activeFlags = new Map<string, string[]>();
  private items = new Map<string, ConversationItem>();
  private liveItems = new Map<string, LiveItem>();
  private liveRuntime = new Map<string, LiveRuntime>();
  private terminalTurns = new Map<string, 'interrupted' | 'failed'>();
  private snapshotSequence = 0;
  private snapshotReads = new Set<number>();
  private revision = 0;
  private itemRevisions = new Map<string, number>();
  private threadRevisions = new Map<string, number>();
  private reconnectTimer?: NodeJS.Timeout;
  private retry = 0;
  private modelCache?: { at: number; data: ModelOption[] };
  private workspaceScan?: Promise<WorkspaceSummary[]>;
  private threadScan?: Promise<ThreadSummary[]>;
  private itemsListSupported: boolean | undefined;
  private _connection: ConnectionState = {
    connected: false,
    sharedBackend: true,
    message: '尚未连接电脑 Codex 共享后端',
  };
  private _capabilities: Capabilities = { images: false, planMode: false, liveControl: false };
  constructor(private readonly options: CodexAdapterOptions) {
    super();
  }
  get connection(): ConnectionState {
    return { ...this._connection };
  }
  get capabilities(): Capabilities {
    return { ...this._capabilities };
  }
  private event(event: GatewayEvent): void {
    if (event.type === 'thread.changed') this.threadRevisions.set(event.thread.id, ++this.revision);
    if (event.type === 'item.updated') {
      event = { ...event, item: this.finishItem(event.threadId, event.item) };
      const key = `${event.threadId}:${event.item.id}`;
      this.itemRevisions.set(key, ++this.revision);
      this.items.set(key, { ...event.item });
      this.liveItems.set(key, { item: { ...event.item }, revision: this.revision });
    }
    if (event.type === 'item.delta') {
      const key = `${event.threadId}:${event.itemId}`;
      this.itemRevisions.set(key, ++this.revision);
      const item = this.items.get(key);
      if (item) this.liveItems.set(key, { item: { ...item }, revision: this.revision });
    }
    this.emit('event', event);
  }
  private setConnection(connected: boolean, message: string, serverVersion?: string): void {
    this._connection = {
      connected,
      message,
      sharedBackend: true,
      ...(serverVersion ? { serverVersion } : {}),
    };
    this.event({ type: 'connection', connection: this.connection });
  }

  connect(): Promise<void> {
    if (this._connection.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.stopped = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.connecting = this.open().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }
  private async open(): Promise<void> {
    const generation = (this.generation = randomUUID());
    let socket: CodexSocket;
    try {
      if (!this.options.socketPath.startsWith('/') || this.options.socketPath.includes(':'))
        throw new Error('控制 socket 必须为不含冒号的绝对路径');
      const url = `ws+unix://${this.options.socketPath}:/`;
      socket = this.socket = this.options.socketFactory
        ? this.options.socketFactory(url)
        : new WebSocket(url, { handshakeTimeout: this.timeout, maxPayload: 32 * 1024 * 1024 });
      await new Promise<void>((resolve, reject) => {
        let opened = false;
        const timer = setTimeout(() => {
          reject(new Error('共享后端握手超时'));
          socket.terminate();
        }, this.timeout);
        socket.on('open', () => {
          opened = true;
          clearTimeout(timer);
          resolve();
        });
        socket.on('message', (data: unknown) => {
          if (generation === this.generation) this.receive(String(data));
        });
        socket.on('error', (error: Error) => {
          if (!opened) {
            clearTimeout(timer);
            reject(error);
          } else this.disconnect(generation, error.message);
        });
        socket.on('close', () => {
          clearTimeout(timer);
          if (!opened) reject(new Error('共享后端在握手时断开'));
          this.disconnect(generation, '与电脑 Codex 的连接已断开');
        });
      });
      if (generation !== this.generation || this.stopped)
        throw new CodexError('DISCONNECTED', this._connection.message);
      const result = record(
        await this.rpc(
          'initialize',
          {
            clientInfo: { name: 'codex_phone', title: 'Codex Phone', version: '0.1.0' },
            capabilities: { experimentalApi: true, requestAttestation: false },
          },
          false,
          true,
        ),
      );
      this.write({ method: 'initialized' });
      if (generation !== this.generation || this.stopped) throw new Error('连接已关闭');
      this.retry = 0;
      this._capabilities = { images: true, planMode: false, liveControl: true };
      this.setConnection(true, '已连接电脑 Codex 共享后端', str(result.userAgent));
      // Capability negotiation may fail on older builds; basic access remains usable.
      try {
        const modes = record(await this.rpc('collaborationMode/list', {}));
        this._capabilities.planMode = array(modes.data).some((m) => record(m).mode === 'plan');
      } catch {
        /* Older shared servers may not expose collaboration presets. */
      }
      if (generation !== this.generation || this.stopped)
        throw new CodexError('DISCONNECTED', '共享后端连接已断开');
      for (const id of this.watched) {
        if (this.stopped || generation !== this.generation) break;
        try {
          await this.subscribe(id);
        } catch {
          /* A deleted/unavailable thread is reported by its next snapshot request. */
        }
      }
      this.event({ type: 'resync' });
    } catch (error) {
      this.disconnect(
        generation,
        `无法连接电脑 Codex 共享后端：${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }
  private get timeout(): number {
    return this.options.requestTimeoutMs ?? 15_000;
  }
  private disconnect(generation: string, message: string): void {
    if (generation !== this.generation) return;
    this.generation = randomUUID();
    const socket = this.socket;
    this.socket = undefined;
    socket?.terminate();
    this.resumed.clear();
    this.resuming.clear();
    this.modelCache = undefined;
    this.itemsListSupported = undefined;
    // Live overlays belong to this socket generation. A reconnected subscriber
    // rebuilds them from fresh notifications and authoritative history.
    this.liveItems.clear();
    this.liveRuntime.clear();
    this.terminalTurns.clear();
    this.items.clear();
    this.itemRevisions.clear();
    this.threadRevisions.clear();
    for (const pending of this.inflight.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new CodexError(
          pending.mutation ? 'OUTCOME_UNKNOWN' : 'DISCONNECTED',
          pending.mutation
            ? '连接中断，操作结果未知。请同步会话确认结果后再操作，系统不会自动重发。'
            : message,
        ),
      );
    }
    this.inflight.clear();
    for (const { request } of this.approvals.values())
      this.event({ type: 'request.resolved', requestId: request.id, threadId: request.threadId });
    this.approvals.clear();
    this._capabilities = { images: false, planMode: false, liveControl: false };
    this.setConnection(false, message);
    this.event({ type: 'resync' });
    if (!this.stopped && !this.reconnectTimer) {
      const delay = Math.min((this.options.reconnectDelayMs ?? 1_000) * 2 ** this.retry++, 30_000);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        void this.connect().catch(() => {});
      }, delay);
      this.reconnectTimer.unref();
    }
  }
  close(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.disconnect(this.generation, '网关已停止连接');
    this.watched.clear();
  }
  private write(message: unknown, callback?: (error?: Error) => void): void {
    if (!this.socket) throw new CodexError('DISCONNECTED', '电脑 Codex 未连接');
    this.socket.send(JSON.stringify(message), callback);
  }
  private rpc(
    method: string,
    params: unknown,
    mutation = false,
    initializing = false,
  ): Promise<any> {
    if (!this.socket || (!initializing && !this._connection.connected))
      return Promise.reject(new CodexError('DISCONNECTED', '电脑 Codex 未连接'));
    const generation = this.generation,
      id = `${generation}:${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.inflight.delete(rpcKey(id));
        reject(
          new CodexError(
            mutation ? 'OUTCOME_UNKNOWN' : 'TIMEOUT',
            mutation
              ? '操作等待超时，结果未知。请同步会话确认结果；系统不会自动重发。'
              : `${method} 请求超时`,
          ),
        );
      }, this.timeout);
      this.inflight.set(rpcKey(id), { resolve, reject, timer, mutation });
      try {
        this.write({ id, method, params }, (error) => {
          if (error) this.disconnect(generation, error.message);
        });
      } catch (error) {
        clearTimeout(timer);
        this.inflight.delete(rpcKey(id));
        reject(error);
      }
    });
  }
  private receive(raw: string): void {
    let msg: ObjectValue;
    try {
      msg = record(JSON.parse(raw));
    } catch {
      return;
    }
    const id = msg.id;
    if ((typeof id === 'string' || typeof id === 'number') && !msg.method) {
      const pending = this.inflight.get(rpcKey(id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.inflight.delete(rpcKey(id));
      if (msg.error) {
        const err = record(msg.error);
        pending.reject(
          new CodexError(
            `CODEX_${String(err.code ?? 'ERROR')}`,
            str(err.message, 'Codex 请求失败'),
          ),
        );
      } else pending.resolve(msg.result);
    } else if (typeof msg.method === 'string') {
      if (typeof id === 'string' || typeof id === 'number')
        this.receiveRequest(id, msg.method, record(msg.params));
      else this.notification(msg.method, record(msg.params));
    }
  }
  private remember(raw: unknown, readRevision = Number.POSITIVE_INFINITY): ThreadSummary {
    const thread = record(raw),
      id = str(thread.id),
      before = this.threads.get(id);
    if (before && (this.threadRevisions.get(id) ?? 0) > readRevision) return before;
    const turns = array(thread.turns).map(record),
      active = turns.find((t) => t.status === 'inProgress');
    const live = this.liveRuntime.get(id),
      nextStatus = live?.status ?? status(thread.status);
    const summary: ThreadSummary = {
      id,
      title: str(thread.name) || str(thread.preview).slice(0, 100) || '新会话',
      preview: str(thread.preview),
      cwd: str(thread.cwd),
      updatedAt: Number(thread.updatedAt ?? 0) * 1000,
      status: nextStatus,
      ...(str(thread.model) ? { model: str(thread.model) } : {}),
      source: source(thread.source),
      ...(typeof thread.canAcceptDirectInput === 'boolean'
        ? { canAcceptDirectInput: thread.canAcceptDirectInput }
        : {}),
      ...(nextStatus === 'active' && (live?.turnId || active || before?.activeTurnId)
        ? { activeTurnId: live?.turnId ?? (active ? str(active.id) : before!.activeTurnId) }
        : {}),
    };
    this.threads.set(id, summary);
    this.activeFlags.set(
      id,
      array(record(thread.status).activeFlags).map((v) => str(v)),
    );
    this.settings.set(id, {
      ...this.settings.get(id),
      ...(str(thread.model) ? { model: str(thread.model) } : {}),
      ...(str(thread.reasoningEffort) ? { effort: str(thread.reasoningEffort) } : {}),
    });
    return summary;
  }
  private rememberSettings(id: string, raw: unknown): void {
    const s = record(raw),
      mode = record(s.collaborationMode);
    this.settings.set(id, {
      ...this.settings.get(id),
      ...(str(s.model) ? { model: str(s.model) } : {}),
      ...(str(s.reasoningEffort ?? s.effort) ? { effort: str(s.reasoningEffort ?? s.effort) } : {}),
      ...(mode.mode === 'plan' || mode.mode === 'default' ? { mode: mode.mode } : {}),
    });
  }
  private async threadPage(
    options: { cursor?: string; search?: string; cwd?: string },
    limit = 40,
  ): Promise<ObjectValue> {
    return record(
      await this.rpc('thread/list', {
        limit,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        modelProviders: [],
        sourceKinds: ['cli', 'vscode', 'appServer', 'exec', 'unknown'],
        ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
        ...(options.search ? { searchTerm: options.search } : {}),
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      }),
    );
  }
  async listThreads(
    options: { cursor?: string; search?: string; cwd?: string } = {},
  ): Promise<{ data: ThreadSummary[]; nextCursor: string | null }> {
    if (options.cwd === '') return this.listEmptyCwdThreads(options);
    if (options.cursor?.startsWith(emptyCwdCursorPrefix))
      throw new CodexError('INVALID_CURSOR', '工作路径已改变，请重新加载会话列表');
    const revision = this.revision;
    const r = await this.threadPage(options);
    return {
      data: array(r.data)
        .map((t) => this.remember(t, revision))
        .filter((t) => options.cwd === undefined || t.cwd === options.cwd),
      nextCursor: typeof r.nextCursor === 'string' ? r.nextCursor : null,
    };
  }
  private async listEmptyCwdThreads(options: { cursor?: string; search?: string }): Promise<{
    data: ThreadSummary[];
    nextCursor: string | null;
  }> {
    const search = options.search ?? '';
    let before: { id: string; updatedAt: number } | undefined;
    if (options.cursor) {
      try {
        if (!options.cursor.startsWith(emptyCwdCursorPrefix)) throw new Error();
        const encoded = options.cursor.slice(emptyCwdCursorPrefix.length);
        const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
        if (Buffer.from(decoded).toString('base64url') !== encoded) throw new Error();
        const value = record(JSON.parse(decoded));
        if (
          value.search !== search ||
          typeof value.id !== 'string' ||
          !value.id ||
          typeof value.updatedAt !== 'number' ||
          !Number.isFinite(value.updatedAt)
        )
          throw new Error();
        before = { id: value.id, updatedAt: value.updatedAt };
      } catch {
        throw new CodexError('INVALID_CURSOR', '工作路径或搜索条件已改变，请重新加载会话列表');
      }
    }
    // The shared server resolves cwd:'' to the user's home directory. Select
    // genuinely missing paths ourselves rather than exposing those home threads.
    const threads = (await this.allThreads())
      .filter(
        (thread) =>
          thread.cwd === '' &&
          thread.title.toLowerCase().includes(search.toLowerCase()) &&
          (!before ||
            thread.updatedAt < before.updatedAt ||
            (thread.updatedAt === before.updatedAt && thread.id > before.id)),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const data = threads.slice(0, 40),
      last = data.at(-1);
    return {
      data,
      nextCursor:
        threads.length > data.length && last
          ? emptyCwdCursorPrefix +
            Buffer.from(
              JSON.stringify({ search, id: last.id, updatedAt: last.updatedAt }),
            ).toString('base64url')
          : null,
    };
  }
  listWorkspaces(): Promise<WorkspaceSummary[]> {
    this.workspaceScan ??= this.scanWorkspaces().finally(() => {
      this.workspaceScan = undefined;
    });
    return this.workspaceScan;
  }
  private async scanWorkspaces(): Promise<WorkspaceSummary[]> {
    const workspaces = new Map<string, WorkspaceSummary>();
    for (const thread of await this.allThreads()) {
      const workspace = workspaces.get(thread.cwd) ?? {
        cwd: thread.cwd,
        threadCount: 0,
        activeCount: 0,
        updatedAt: 0,
      };
      workspace.threadCount++;
      if (thread.status === 'active') workspace.activeCount++;
      workspace.updatedAt = Math.max(workspace.updatedAt, thread.updatedAt);
      workspaces.set(thread.cwd, workspace);
    }
    return [...workspaces.values()].sort(
      (a, b) => b.updatedAt - a.updatedAt || (a.cwd < b.cwd ? -1 : a.cwd > b.cwd ? 1 : 0),
    );
  }
  private allThreads(): Promise<ThreadSummary[]> {
    this.threadScan ??= this.scanThreads().finally(() => {
      this.threadScan = undefined;
    });
    return this.threadScan;
  }
  private async scanThreads(): Promise<ThreadSummary[]> {
    const revision = this.revision;
    const threads = new Map<string, ObjectValue>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      // Retain thread/list's metadata repair so older sessions missing from the
      // state index are included, without reading Codex's files ourselves.
      const page = await this.threadPage({ cursor }, 200);
      for (const raw of array(page.data)) {
        const thread = record(raw),
          id = str(thread.id),
          before = threads.get(id);
        if (!before || Number(thread.updatedAt ?? 0) >= Number(before.updatedAt ?? 0))
          threads.set(id, thread);
      }
      cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
      if (cursor !== undefined) {
        if (cursors.has(cursor))
          throw new CodexError(
            'INVALID_PAGINATION',
            'Codex 会话列表返回重复分页游标，无法完整读取工作路径',
          );
        cursors.add(cursor);
      }
    } while (cursor !== undefined);
    // Apply notifications received during the scan before calculating counts.
    return [...threads.values()].map((raw) => this.remember(raw, revision));
  }
  async snapshot(threadId: string, cursor?: string): Promise<ThreadSnapshot> {
    const readId = ++this.snapshotSequence;
    this.snapshotReads.add(readId);
    try {
      return await this.readSnapshot(threadId, cursor);
    } finally {
      this.snapshotReads.delete(readId);
      // Every read already in flight when history catches up may still return
      // stale data, regardless of request order. Keep its overlay until all
      // those reads finish; later reads need not delay release.
      const oldest = this.snapshotReads.size ? Math.min(...this.snapshotReads) : Infinity;
      for (const [key, live] of this.liveItems)
        if (live.confirmedThrough !== undefined && live.confirmedThrough < oldest)
          this.liveItems.delete(key);
      for (const [key, live] of this.liveRuntime)
        if (live.confirmedThrough !== undefined && live.confirmedThrough < oldest)
          this.liveRuntime.delete(key);
    }
  }
  private async readSnapshot(
    threadId: string,
    cursor: string | undefined,
  ): Promise<ThreadSnapshot> {
    const revision = this.revision;
    let readResult: PromiseSettledResult<unknown>,
      pageResult: PromiseSettledResult<unknown>,
      runtimeResult: PromiseSettledResult<unknown>;
    if (cursor?.startsWith(readCursorPrefix)) {
      const read = record(await this.rpc('thread/read', { threadId, includeTurns: true }));
      const turns = this.fullTurns(read.thread);
      readResult = { status: 'fulfilled', value: read };
      pageResult = { status: 'fulfilled', value: this.fullHistoryPage(turns, cursor) };
      runtimeResult = { status: 'fulfilled', value: { data: turns.slice(-1) } };
    } else {
      [readResult, pageResult, runtimeResult] = await Promise.allSettled([
        this.rpc('thread/read', { threadId, includeTurns: false }),
        this.historyPage(threadId, cursor),
        this.rpc('thread/turns/list', {
          threadId,
          limit: 1,
          sortDirection: 'desc',
          itemsView: 'summary',
        }),
      ]);
      if (
        readResult.status === 'fulfilled' &&
        [pageResult, runtimeResult].some(
          (r) => r.status === 'rejected' && this.isTurnListUnavailable(r.reason),
        )
      ) {
        // The shared server can briefly reject list_turns while persisting a
        // newly started turn. Read actual full history for this snapshot only;
        // the next snapshot tries native pagination again.
        const read = record(await this.rpc('thread/read', { threadId, includeTurns: true }));
        const turns = this.fullTurns(read.thread);
        readResult = { status: 'fulfilled', value: read };
        if (pageResult.status === 'rejected' && this.isTurnListUnavailable(pageResult.reason))
          pageResult = { status: 'fulfilled', value: this.fullHistoryPage(turns, cursor) };
        if (runtimeResult.status === 'rejected' && this.isTurnListUnavailable(runtimeResult.reason))
          runtimeResult = { status: 'fulfilled', value: { data: turns.slice(-1) } };
      }
    }
    if (readResult.status === 'rejected') throw readResult.reason;
    const thread = this.remember(record(readResult.value).thread, revision);
    const historyResult = (result: PromiseSettledResult<unknown>): ObjectValue => {
      if (result.status === 'fulfilled') return record(result.value);
      // A new live thread has no persisted history until its first message.
      // Require both the exact backend condition and fresh idle metadata.
      if (!cursor && thread.status === 'idle' && this.isUnmaterialized(threadId, result.reason))
        return { data: [], nextCursor: null };
      throw result.reason;
    };
    const page = historyResult(pageResult),
      runtime = historyResult(runtimeResult);
    const latest = array(record(runtime).data).map(record)[0];
    if (latest) this.rememberTerminalTurn(threadId, str(latest.id), latest.status);
    const liveRuntime = this.liveRuntime.get(threadId);
    if (liveRuntime) {
      const sameTurn = !liveRuntime.turnId || liveRuntime.turnId === latest?.id;
      const caughtUp =
        liveRuntime.status === 'active'
          ? latest?.status === 'inProgress'
          : liveRuntime.status === 'idle'
            ? latest && ['completed', 'interrupted', 'failed'].includes(str(latest.status))
            : status(record(record(readResult.value).thread).status) === liveRuntime.status;
      // Metadata and turn pages are separate backend reads. Both must catch
      // up before dropping state protection; either may still lag the other.
      const metadataCaughtUp =
        status(record(record(readResult.value).thread).status) === liveRuntime.status;
      if (sameTurn && caughtUp && metadataCaughtUp && liveRuntime.revision <= revision)
        liveRuntime.confirmedThrough ??= this.snapshotSequence;
      thread.status = liveRuntime.status;
      if (liveRuntime.status === 'active' && liveRuntime.turnId)
        thread.activeTurnId = liveRuntime.turnId;
      else if (liveRuntime.status !== 'active') delete thread.activeTurnId;
    } else if (
      latest?.status === 'inProgress' &&
      thread.status === 'active' &&
      (this.threadRevisions.get(threadId) ?? 0) <= revision
    )
      thread.activeTurnId = str(latest.id);
    const items = array(record(page).data)
      .map((entry) => {
        const e = record(entry);
        this.rememberTerminalTurn(threadId, str(e.turnId), e.turnStatus);
        const item = this.finishItem(threadId, this.item(record(e.item), str(e.turnId))),
          key = `${threadId}:${item.id}`;
        const live = this.liveItems.get(key);
        if (live) {
          if (live.revision <= revision && this.historyCoversLive(item, live.item)) {
            // A persisted item may be even further ahead than the last event.
            // Raise the protected value, including its confirmation boundary,
            // so another in-flight response cannot shorten it again.
            if (!this.historyCoversLive(live.item, item) || live.confirmedThrough === undefined)
              live.confirmedThrough = this.snapshotSequence;
            live.item = { ...item };
          } else return { ...live.item };
        }
        // A read issued before a live delta must not roll back that delta.
        if ((this.itemRevisions.get(key) ?? 0) > revision) return { ...this.items.get(key)! };
        this.items.set(key, item);
        return item;
      })
      .reverse();
    if (!cursor) {
      if (latest?.status === 'failed' || latest?.status === 'interrupted') {
        const outcome = this.turnOutcome(latest),
          key = `${threadId}:${outcome.id}`;
        const live = this.liveItems.get(key);
        if (live && live.revision <= revision && this.historyCoversLive(outcome, live.item))
          live.confirmedThrough ??= this.snapshotSequence;
        items.push(
          live && (live.revision > revision || !this.historyCoversLive(outcome, live.item))
            ? { ...live.item }
            : outcome,
        );
      }
      const visibleTurns = new Set(items.map((i) => i.turnId));
      const ids = new Set(items.map((i) => i.id));
      // Only notifications create this overlay; cached older history pages
      // must never leak into the newest page. Keep missing live items only in
      // this page's turns (or when the backend has no older hidden page).
      for (const [key, live] of this.liveItems)
        if (
          key.startsWith(`${threadId}:`) &&
          !ids.has(live.item.id) &&
          (page.nextCursor == null ||
            visibleTurns.has(live.item.turnId) ||
            live.item.turnId === thread.activeTurnId ||
            live.item.turnId === latest?.id)
        ) {
          items.push({ ...live.item });
          ids.add(live.item.id);
        }
      for (const [key, item] of this.items)
        if (
          key.startsWith(`${threadId}:`) &&
          !ids.has(item.id) &&
          ((this.itemRevisions.get(key) ?? 0) > revision ||
            (item.id.startsWith('outcome:') && visibleTurns.has(item.turnId)))
        ) {
          items.push({ ...item });
          ids.add(item.id);
        }
    }
    const readOnly = this.readOnly.has(threadId);
    const pendingRequests = readOnly
      ? []
      : [...this.approvals.values()]
          .filter((a) => a.request.threadId === threadId)
          .map((a) => a.request);
    const waiting = this.activeFlags.get(threadId)?.length;
    return {
      thread: this.threads.get(threadId)!,
      items: items.map((item) => this.finishItem(threadId, item)),
      nextCursor:
        typeof record(page).nextCursor === 'string' ? (record(page).nextCursor as string) : null,
      pendingRequests,
      settings: this.settings.get(threadId),
      ...(readOnly ? { readOnly: true } : {}),
      ...(!readOnly && waiting && !pendingRequests.length
        ? {
            warning:
              '电脑会话正在等待审批或用户回答，但共享后端尚未向此连接转发请求。请在电脑端处理；网关不会推测或自动批准。',
          }
        : {}),
    };
  }
  private historyCoversLive(history: ConversationItem, live: ConversationItem): boolean {
    const statusCaughtUp =
      history.status === live.status ||
      (live.status === 'inProgress' &&
        ['completed', 'failed', 'declined', 'interrupted'].includes(history.status ?? ''));
    return (
      history.id === live.id &&
      history.turnId === live.turnId &&
      history.type === live.type &&
      history.role === live.role &&
      statusCaughtUp &&
      history.text.startsWith(live.text) &&
      JSON.stringify(history.images) === JSON.stringify(live.images)
    );
  }
  private noteRuntime(threadId: string, state: ThreadSummary['status'], turnId?: string): void {
    this.liveRuntime.set(threadId, {
      status: state,
      ...(turnId ? { turnId } : {}),
      revision: ++this.revision,
    });
  }
  private rememberTerminalTurn(threadId: string, turnId: string, turnStatus: unknown): void {
    if (turnStatus === 'interrupted' || turnStatus === 'failed')
      this.terminalTurns.set(`${threadId}:${turnId}`, turnStatus);
  }
  private finishItem(threadId: string, item: ConversationItem): ConversationItem {
    const terminal = this.terminalTurns.get(`${threadId}:${item.turnId}`);
    // A terminated parent cannot still have a running child. Preserve items
    // that already report their own completed/failed result and all output.
    return terminal && item.status === 'inProgress' ? { ...item, status: terminal } : item;
  }
  private isUnmaterialized(threadId: string, error: unknown): boolean {
    return (
      error instanceof CodexError &&
      error.code === 'CODEX_-32600' &&
      error.message ===
        `thread ${threadId} is not materialized yet; thread/turns/list is unavailable before first user message`
    );
  }
  private isTurnListUnavailable(error: unknown): boolean {
    return (
      error instanceof CodexError &&
      error.code === 'CODEX_-32601' &&
      error.message === 'list_turns is not supported yet'
    );
  }
  private isActiveWriter(threadId: string, error: unknown): boolean {
    return (
      error instanceof CodexError &&
      error.code === 'CODEX_-32600' &&
      error.message === `thread ${threadId} already has an active writer`
    );
  }
  private assertWritable(threadId: string): void {
    if (this.readOnly.has(threadId))
      throw new CodexError(
        'THREAD_READ_ONLY',
        '此会话正在被其他 Codex 实例占用，当前为只读。请在原实例操作，或释放会话后重试连接。',
      );
  }
  private fullTurns(raw: unknown): ObjectValue[] {
    const thread = record(raw);
    if (!Array.isArray(thread.turns))
      throw new CodexError('INCOMPLETE_HISTORY', '后端没有提供完整轮次内容，无法可靠显示历史');
    return thread.turns.map((value) => {
      const turn = record(value);
      if (!Array.isArray(turn.items) || (turn.itemsView !== undefined && turn.itemsView !== 'full'))
        throw new CodexError('INCOMPLETE_HISTORY', '后端没有提供完整轮次内容，无法可靠显示历史');
      return turn;
    });
  }
  private fullHistoryPage(turns: ObjectValue[], cursor?: string): ObjectValue {
    const entries = turns.flatMap((turn) =>
      array(turn.items).map((item) => ({ turnId: str(turn.id), turnStatus: turn.status, item })),
    );
    let end = entries.length;
    if (cursor) {
      if (!cursor.startsWith(readCursorPrefix))
        throw new CodexError(
          'HISTORY_CURSOR_CHANGED',
          '后端历史分页能力已变化，请刷新会话后重新加载历史',
        );
      let anchor: ObjectValue;
      try {
        const encoded = cursor.slice(readCursorPrefix.length);
        if (!/^[A-Za-z0-9_-]{1,12000}$/.test(encoded)) throw new Error();
        const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
        if (Buffer.from(decoded).toString('base64url') !== encoded) throw new Error();
        anchor = record(JSON.parse(decoded));
        if (!str(anchor.turnId) || !str(anchor.itemId)) throw new Error();
      } catch {
        throw new CodexError('INVALID_CURSOR', '历史游标无效，请刷新会话');
      }
      end = entries.findIndex(
        (entry) => entry.turnId === anchor.turnId && record(entry.item).id === anchor.itemId,
      );
      if (end < 0)
        throw new CodexError(
          'HISTORY_CURSOR_CHANGED',
          '历史分页位置已变化，请刷新会话后重新加载历史',
        );
    }
    const start = Math.max(0, end - 60),
      page = entries.slice(start, end),
      first = page[0];
    return {
      data: page.reverse(),
      nextCursor:
        start > 0 && first
          ? readCursorPrefix +
            Buffer.from(
              JSON.stringify({ turnId: first.turnId, itemId: str(record(first.item).id) }),
            ).toString('base64url')
          : null,
    };
  }
  private async historyPage(threadId: string, cursor?: string): Promise<ObjectValue> {
    const prefix = 'phone-turns-v1:';
    const turnCursor = cursor?.startsWith(prefix);
    if (this.itemsListSupported !== false && !turnCursor) {
      try {
        const page = record(
          await this.rpc('thread/items/list', {
            threadId,
            limit: 60,
            sortDirection: 'desc',
            ...(cursor ? { cursor } : {}),
          }),
        );
        this.itemsListSupported = true;
        return page;
      } catch (error) {
        // 0.162.1 advertises this schema but its live control server can still
        // explicitly say "thread/items/list is not supported yet". Do not
        // conceal permission, unloaded-thread, timeout or malformed-data errors.
        if (!(error instanceof CodexError) || error.code !== 'CODEX_-32601') throw error;
        this.itemsListSupported = false;
      }
    }
    if (cursor && !turnCursor)
      throw new CodexError(
        'HISTORY_CURSOR_CHANGED',
        '后端历史分页能力已变化，请刷新会话后重新加载历史',
      );
    let nativeCursor: string | undefined;
    if (turnCursor) {
      const encoded = cursor!.slice(prefix.length);
      if (!/^[A-Za-z0-9_-]{1,12000}$/.test(encoded))
        throw new CodexError('INVALID_CURSOR', '历史游标无效，请刷新会话');
      nativeCursor = Buffer.from(encoded, 'base64url').toString('utf8');
      if (!nativeCursor || Buffer.from(nativeCursor).toString('base64url') !== encoded)
        throw new CodexError('INVALID_CURSOR', '历史游标无效，请刷新会话');
    }
    const turns = record(
      await this.rpc('thread/turns/list', {
        threadId,
        limit: 10,
        sortDirection: 'desc',
        itemsView: 'full',
        ...(nativeCursor ? { cursor: nativeCursor } : {}),
      }),
    );
    const data = array(turns.data).flatMap((value) => {
      const turn = record(value);
      if (turn.itemsView !== undefined && turn.itemsView !== 'full')
        throw new CodexError('INCOMPLETE_HISTORY', '后端没有提供完整轮次内容，无法可靠显示历史');
      // Turns arrive newest-first; items within each turn are chronological.
      // Produce the same descending item order as the native item endpoint.
      return array(turn.items)
        .map((item) => ({ turnId: str(turn.id), turnStatus: turn.status, item }))
        .reverse();
    });
    return {
      data,
      nextCursor:
        typeof turns.nextCursor === 'string'
          ? prefix + Buffer.from(turns.nextCursor).toString('base64url')
          : null,
    };
  }
  async subscribe(threadId: string, retryWrite = false): Promise<ThreadSnapshot> {
    this.watched.add(threadId);
    if (this.readOnly.has(threadId) && !retryWrite) return this.snapshot(threadId);
    return this.resumed.has(threadId) ? this.snapshot(threadId) : this.resume(threadId);
  }
  private resume(threadId: string): Promise<ThreadSnapshot> {
    const existing = this.resuming.get(threadId);
    if (existing) return existing;
    const pending = (async () => {
      const revision = this.revision;
      // Do not pass cwd/model/sandbox/approval overrides while simply observing.
      let r: ObjectValue;
      try {
        r = record(
          await this.rpc('thread/resume', {
            threadId,
            excludeTurns: true,
            initialTurnsPage: { limit: 1, sortDirection: 'desc', itemsView: 'summary' },
          }).catch((error: unknown) => {
            if (!this.isUnmaterialized(threadId, error) && !this.isTurnListUnavailable(error))
              throw error;
            // Joining an empty live thread is valid; requesting an initial
            // history page is not. Retry only that passive join.
            return this.rpc('thread/resume', { threadId, excludeTurns: true });
          }),
        );
      } catch (error) {
        if (!this.isActiveWriter(threadId, error)) throw error;
        // Observing persisted history does not need the other process's writer.
        // Keep this restriction across reconnects until an explicit retry.
        this.readOnly.add(threadId);
        return this.snapshot(threadId);
      }
      this.readOnly.delete(threadId);
      const thread = this.remember(r.thread, revision);
      this.rememberSettings(threadId, r);
      const active = array(record(r.initialTurnsPage).data)
        .map(record)
        .find((t) => t.status === 'inProgress');
      if (active && (this.threadRevisions.get(threadId) ?? 0) <= revision)
        thread.activeTurnId = str(active.id);
      this.resumed.add(threadId);
      return this.snapshot(threadId);
    })().finally(() => {
      if (this.resuming.get(threadId) === pending) this.resuming.delete(threadId);
    });
    this.resuming.set(threadId, pending);
    return pending;
  }
  private async refreshTurn(threadId: string): Promise<void> {
    const revision = this.revision;
    let r: ObjectValue;
    try {
      r = record(
        await this.rpc('thread/turns/list', {
          threadId,
          limit: 1,
          sortDirection: 'desc',
          itemsView: 'summary',
        }),
      );
    } catch (error) {
      if (!this.isTurnListUnavailable(error)) throw error;
      const read = record(await this.rpc('thread/read', { threadId, includeTurns: true }));
      r = { data: this.fullTurns(read.thread).slice(-1) };
    }
    const active = array(r.data)
      .map(record)
      .find((t) => t.status === 'inProgress');
    const thread = this.threads.get(threadId);
    const live = this.liveRuntime.get(threadId);
    if (thread && (this.threadRevisions.get(threadId) ?? 0) <= revision) {
      if (live?.status === 'active' && live.turnId) thread.activeTurnId = live.turnId;
      else if (active && live?.status !== 'idle') thread.activeTurnId = str(active.id);
      else delete thread.activeTurnId;
    }
  }
  async createThread(
    input: CreateThreadInput,
    assertAuthorized?: () => void,
  ): Promise<ThreadSnapshot> {
    await this.validateSettings(input);
    assertAuthorized?.();
    const r = record(
      await this.rpc(
        'thread/start',
        { cwd: input.cwd, ...(input.model ? { model: input.model } : {}) },
        true,
      ),
    );
    const thread = this.remember(r.thread);
    this.rememberSettings(thread.id, r);
    this.watched.add(thread.id);
    this.resumed.add(thread.id);
    if (input.effort || input.mode) {
      const overrides = await this.settingOverrides(thread.id, input);
      assertAuthorized?.();
      const updated = record(
        await this.rpc('thread/settings/update', { threadId: thread.id, ...overrides }, true),
      );
      this.rememberSettings(thread.id, updated.threadSettings ?? updated);
      this.settings.set(thread.id, {
        ...this.settings.get(thread.id),
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
      });
    }
    return this.snapshot(thread.id);
  }
  async send(input: SendInput, assertAuthorized?: () => void): Promise<unknown> {
    this.assertWritable(input.threadId);
    if (!input.text.trim() && !input.imagePaths?.length)
      throw new CodexError('INVALID_INPUT', '请输入消息或选择图片');
    if (!this.resumed.has(input.threadId)) await this.subscribe(input.threadId);
    this.assertWritable(input.threadId);
    const revision = this.revision;
    const r = record(
      await this.rpc('thread/read', { threadId: input.threadId, includeTurns: false }),
    );
    const thread = this.remember(r.thread, revision);
    if (thread.canAcceptDirectInput === false)
      throw new CodexError('INPUT_UNAVAILABLE', '此会话的当前执行器不接受远程输入，请在电脑端操作');
    if (thread.status === 'active') await this.refreshTurn(input.threadId);
    const content: ObjectValue[] = [];
    if (input.text.trim()) content.push({ type: 'text', text: input.text, text_elements: [] });
    for (const path of input.imagePaths ?? []) content.push({ type: 'localImage', path });
    const params = { threadId: input.threadId, clientUserMessageId: randomUUID(), input: content };
    if (input.expectedTurnId || thread.status === 'active') {
      const expectedTurnId = input.expectedTurnId ?? thread.activeTurnId;
      if (!expectedTurnId)
        throw new CodexError('TURN_UNAVAILABLE', '无法确认正在运行的任务，请刷新会话后重试');
      const settings = this.settings.get(input.threadId);
      for (const key of ['model', 'effort', 'mode'] as const)
        if (input[key] && input[key] !== settings?.[key])
          throw new CodexError(
            'TURN_ACTIVE',
            '运行中的任务只能追加指令，模型、推理强度与模式请在任务结束后调整',
          );
      assertAuthorized?.();
      this.assertWritable(input.threadId);
      const result = record(await this.rpc('turn/steer', { ...params, expectedTurnId }, true));
      return { turnId: str(result.turnId, expectedTurnId) };
    }
    const overrides = await this.settingOverrides(input.threadId, input);
    assertAuthorized?.();
    this.assertWritable(input.threadId);
    const result = await this.rpc('turn/start', { ...params, ...overrides }, true);
    this.settings.set(input.threadId, {
      ...this.settings.get(input.threadId),
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
    });
    const turn = record(record(result).turn);
    return { turnId: str(turn.id), status: str(turn.status) };
  }
  async interrupt(threadId: string, turnId: string): Promise<unknown> {
    this.assertWritable(threadId);
    return this.rpc('turn/interrupt', { threadId, turnId }, true);
  }
  async models(): Promise<ModelOption[]> {
    if (this.modelCache && Date.now() - this.modelCache.at < 60_000) return this.modelCache.data;
    const models: ModelOption[] = [],
      seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const r = record(
        await this.rpc('model/list', {
          limit: 100,
          includeHidden: false,
          ...(cursor ? { cursor } : {}),
        }),
      );
      for (const raw of array(r.data)) {
        const m = record(raw);
        models.push({
          id: str(m.model, str(m.id)),
          label: str(m.displayName, str(m.model)),
          efforts: array(m.supportedReasoningEfforts).map((e) => str(record(e).reasoningEffort)),
          defaultEffort: str(m.defaultReasoningEffort) || undefined,
          isDefault: m.isDefault === true,
        });
      }
      cursor = typeof r.nextCursor === 'string' ? r.nextCursor : undefined;
      if (cursor && seen.has(cursor))
        throw new CodexError('PROTOCOL_ERROR', '模型目录分页游标重复');
      if (cursor) seen.add(cursor);
    } while (cursor && seen.size < 20);
    this.modelCache = { at: Date.now(), data: models };
    return models;
  }
  private async validateSettings(input: SessionSettings, inheritedModel?: string): Promise<void> {
    if (input.effort && !knownEfforts.has(input.effort))
      throw new CodexError('INVALID_EFFORT', '推理强度无效');
    if (input.mode && !['default', 'plan'].includes(input.mode))
      throw new CodexError('INVALID_MODE', '模式无效');
    if (input.mode === 'plan' && !this._capabilities.planMode)
      throw new CodexError('PLAN_UNAVAILABLE', '此共享后端未提供 Plan 模式');
    if (input.model || input.effort) {
      const models = await this.models();
      const chosen =
        models.find((m) => m.id === (input.model ?? inheritedModel)) ??
        (!input.model && !inheritedModel ? models.find((m) => m.isDefault) : undefined);
      if (input.model && !chosen)
        throw new CodexError('INVALID_MODEL', '模型不在电脑当前可用列表中');
      if (input.effort && (!chosen || !chosen.efforts.includes(input.effort)))
        throw new CodexError('INVALID_EFFORT', '该模型不支持所选推理强度');
    }
  }
  private async settingOverrides(threadId: string, input: SessionSettings): Promise<ObjectValue> {
    const saved = this.settings.get(threadId);
    await this.validateSettings(input, saved?.model);
    const result: ObjectValue = {
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
    };
    if (input.mode) {
      const model = input.model ?? saved?.model;
      if (!model) throw new CodexError('MODEL_UNAVAILABLE', '无法确认当前模型，请先选择模型');
      let effort = input.effort ?? saved?.effort ?? null;
      if (input.model && input.model !== saved?.model && !input.effort)
        effort = (await this.models()).find((m) => m.id === model)?.defaultEffort ?? null;
      result.collaborationMode = {
        mode: input.mode,
        settings: { model, reasoning_effort: effort, developer_instructions: null },
      };
    }
    return result;
  }

  private receiveRequest(wireId: RpcId, method: string, params: ObjectValue): void {
    if (method === 'currentTime/read') {
      this.write({ id: wireId, result: { currentTimeAt: Math.floor(Date.now() / 1000) } });
      return;
    }
    const threadId = str(params.threadId);
    // Authentication, attestation and unknown plugin calls belong to the desktop
    // host. Do not answer them (or leak them to a paired device) on its behalf.
    if (!threadId) return;
    const id = `${this.generation}:${rpcKey(wireId)}`;
    if (this.approvals.has(id)) return;
    let request: PendingRequest;
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const available = params.availableDecisions;
        const decisions =
          available == null
            ? ['accept', 'decline', 'cancel']
            : array(available).filter(
                (d): d is string =>
                  typeof d === 'string' && ['accept', 'decline', 'cancel'].includes(d),
              );
        request = {
          id,
          threadId,
          kind: 'command',
          title: '命令执行审批',
          detail: [
            str(params.reason),
            str(params.command),
            str(params.cwd) && `目录：${params.cwd}`,
            params.additionalPermissions && `附加权限：${json(params.additionalPermissions)}`,
            params.networkApprovalContext && `网络请求：${json(params.networkApprovalContext)}`,
          ]
            .filter(Boolean)
            .join('\n\n'),
          decisions,
        };
        break;
      }
      case 'item/fileChange/requestApproval':
        request = {
          id,
          threadId,
          kind: 'fileChange',
          title: '文件修改审批',
          detail: [
            str(params.reason),
            params.grantRoot && `授权目录：${params.grantRoot}`,
            this.items.get(`${threadId}:${str(params.itemId)}`)?.text,
          ]
            .filter(Boolean)
            .join('\n\n'),
          decisions: ['accept', 'decline', 'cancel'],
        };
        break;
      case 'item/permissions/requestApproval':
        request = {
          id,
          threadId,
          kind: 'permissions',
          title: '本轮权限审批',
          detail: [str(params.reason), `目录：${str(params.cwd)}`, json(params.permissions)].join(
            '\n\n',
          ),
          decisions: ['accept', 'decline'],
        };
        break;
      case 'item/tool/requestUserInput':
        request = {
          id,
          threadId,
          kind: 'userInput',
          title: 'Codex 需要你的回答',
          detail: '',
          questions: array(params.questions).map((raw) => {
            const q = record(raw);
            return {
              id: str(q.id),
              header: str(q.header),
              question: str(q.question),
              isSecret: q.isSecret === true,
              ...(Array.isArray(q.options)
                ? {
                    options: q.options.map((raw) => {
                      const o = record(raw);
                      return { label: str(o.label), description: str(o.description) };
                    }),
                  }
                : {}),
            };
          }),
        };
        break;
      default:
        request = {
          id,
          threadId,
          kind: 'unsupported',
          title: '请在电脑端处理',
          detail: `此请求尚不支持手机处理：${method}`,
          decisions: [],
        };
    }
    this.approvals.set(id, {
      wireId,
      generation: this.generation,
      request,
      params,
      method,
      responding: false,
    });
    // Resume can replay approvals before its response promise settles. Retain
    // them for a successful explicit retry, but never expose read-only controls.
    if (!this.readOnly.has(threadId)) this.event({ type: 'request.pending', request });
  }
  async respond(requestId: string, answer: RequestAnswer): Promise<unknown> {
    const approval = this.approvals.get(requestId);
    if (!approval || approval.generation !== this.generation || approval.responding)
      throw new CodexError('REQUEST_EXPIRED', '该请求已过期或已在另一端处理，请刷新会话');
    const { request, params } = approval;
    this.assertWritable(request.threadId);
    let result: ObjectValue;
    if (request.kind === 'userInput') {
      const answers: Record<string, { answers: string[] }> = {};
      const questions = request.questions ?? [];
      if (Object.keys(answer.answers ?? {}).some((id) => !questions.some((q) => q.id === id)))
        throw new CodexError('INVALID_ANSWER', '回答包含未知问题');
      for (const q of questions) {
        const values = answer.answers?.[q.id];
        if (
          !values?.length ||
          values.some(
            (value) => typeof value !== 'string' || !value.trim() || value.length > 20_000,
          )
        )
          throw new CodexError('INVALID_ANSWER', '请回答所有问题');
        answers[q.id] = { answers: values };
      }
      result = { answers };
    } else if (request.kind === 'unsupported')
      throw new CodexError('UNSUPPORTED_REQUEST', '请在电脑端处理此请求');
    else {
      if (!answer.decision || !request.decisions?.includes(answer.decision))
        throw new CodexError('INVALID_DECISION', '该审批不支持此操作');
      if (request.kind === 'permissions') {
        const requested = record(params.permissions),
          permissions: ObjectValue = {};
        if (answer.decision === 'accept') {
          if (requested.network != null) permissions.network = requested.network;
          if (requested.fileSystem != null) permissions.fileSystem = requested.fileSystem;
        }
        result = { permissions, scope: 'turn' };
      } else result = { decision: answer.decision };
    }
    // Lock synchronously before send: two phones cannot answer one request twice.
    approval.responding = true;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new CodexError(
              'OUTCOME_UNKNOWN',
              '审批响应已发送，等待确认超时。请刷新状态，系统不会重发。',
            ),
          ),
        this.timeout,
      );
      try {
        this.write({ id: approval.wireId, result }, (error) => {
          clearTimeout(timer);
          if (error || approval.generation !== this.generation) {
            reject(new CodexError('OUTCOME_UNKNOWN', '连接中断，审批结果未知，请刷新会话确认'));
            return;
          }
          if (this.approvals.delete(requestId))
            this.event({ type: 'request.resolved', requestId, threadId: request.threadId });
          // JSON-RPC responses have no acknowledgement. This means sent, not
          // executed; the authoritative outcome arrives in subsequent events.
          resolve({ sent: true });
        });
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  private item(raw: ObjectValue, turnId: string): ConversationItem {
    const type = str(raw.type, 'unknown');
    let text = '',
      role: ConversationItem['role'],
      images: string[] | undefined;
    switch (type) {
      case 'userMessage': {
        role = 'user';
        const content = array(raw.content).map(record);
        text = content
          .map((c) =>
            c.type === 'text'
              ? str(c.text)
              : c.type === 'localImage' || c.type === 'image'
                ? '[图片]'
                : c.type === 'mention' || c.type === 'skill'
                  ? `@${str(c.name)}`
                  : `[${str(c.type)}]`,
          )
          .join('\n');
        images = content
          .filter((c) => c.type === 'localImage')
          .map((c) => str(c.path))
          .filter(Boolean);
        break;
      }
      case 'agentMessage':
        role = 'assistant';
        text = str(raw.text);
        break;
      case 'plan':
        text = str(raw.text);
        break;
      case 'reasoning':
        text = [...array(raw.summary), ...array(raw.content)]
          .map((v) => str(v))
          .filter(Boolean)
          .join('\n\n');
        break;
      case 'commandExecution':
        text = `$ ${str(raw.command)}${str(raw.aggregatedOutput) ? `\n\n${raw.aggregatedOutput}` : ''}${raw.exitCode != null ? `\n\n退出码：${raw.exitCode}` : ''}`;
        break;
      case 'fileChange':
        text = array(raw.changes)
          .map((c) => {
            const change = record(c);
            return `${str(change.path)}\n${str(change.diff)}`;
          })
          .join('\n\n');
        break;
      case 'mcpToolCall':
        text = `${str(raw.server)} / ${str(raw.tool)}\n${json(raw.arguments)}${raw.result ? `\n\n${json(raw.result)}` : ''}${raw.error ? `\n\n${json(raw.error)}` : ''}`;
        break;
      case 'dynamicToolCall':
        text = `${str(raw.tool)}\n${json(raw.arguments)}${raw.contentItems ? `\n\n${json(raw.contentItems)}` : ''}`;
        break;
      case 'functionCallOutput':
        text = `${str(raw.name)}\n${json(raw.output)}`;
        break;
      case 'collabAgentToolCall':
        text = `${str(raw.tool)}\n${str(raw.prompt)}\n${json(raw.agentsStates)}`;
        break;
      case 'imageView':
        text = `查看图片：${str(raw.path)}`;
        break;
      case 'webSearch':
        text = json(raw.action ?? raw);
        break;
      case 'enteredReviewMode':
      case 'exitedReviewMode':
        text = str(raw.review);
        break;
      case 'contextCompaction':
        text = '上下文已压缩';
        break;
      default:
        text = json(raw);
    }
    return {
      id: str(raw.id),
      turnId,
      type,
      text,
      ...(role ? { role } : {}),
      ...(str(raw.status) ? { status: str(raw.status) } : {}),
      ...(images?.length ? { images } : {}),
    };
  }
  private turnOutcome(turn: ObjectValue): ConversationItem {
    return {
      id: `outcome:${str(turn.id)}`,
      turnId: str(turn.id),
      type: turn.status === 'failed' ? 'error' : 'turnStatus',
      status: str(turn.status),
      text:
        turn.status === 'failed'
          ? `任务失败：${str(record(turn.error).message, '电脑后端未提供错误详情')}`
          : '任务已停止',
    };
  }
  private notification(method: string, params: ObjectValue): void {
    const threadId = str(params.threadId),
      thread = this.threads.get(threadId),
      turnId = str(params.turnId);
    switch (method) {
      case 'thread/started':
        this.event({ type: 'thread.changed', thread: this.remember(params.thread) });
        return;
      case 'thread/status/changed':
        this.activeFlags.set(
          threadId,
          array(record(params.status).activeFlags).map((v) => str(v)),
        );
        this.noteRuntime(
          threadId,
          status(params.status),
          thread?.activeTurnId ??
            (status(params.status) === 'idle' || this.liveRuntime.get(threadId)?.status === 'active'
              ? this.liveRuntime.get(threadId)?.turnId
              : undefined),
        );
        if (thread) {
          thread.status = status(params.status);
          if (thread.status !== 'active') delete thread.activeTurnId;
          this.event({ type: 'thread.changed', thread: { ...thread } });
        }
        return;
      case 'thread/name/updated':
        if (thread) {
          thread.title = str(params.threadName, thread.title);
          this.event({ type: 'thread.changed', thread: { ...thread } });
        }
        return;
      case 'thread/settings/updated':
        this.threadRevisions.set(threadId, ++this.revision);
        this.rememberSettings(threadId, params.threadSettings);
        this.event({ type: 'resync', threadId });
        return;
      case 'turn/started':
      case 'turn/completed': {
        const turn = record(params.turn);
        if (method === 'turn/completed')
          this.rememberTerminalTurn(threadId, str(turn.id), turn.status);
        if (method === 'turn/started' || !thread?.activeTurnId || thread.activeTurnId === turn.id)
          this.noteRuntime(threadId, method === 'turn/started' ? 'active' : 'idle', str(turn.id));
        if (thread) {
          if (method === 'turn/started' || !thread.activeTurnId || thread.activeTurnId === turn.id)
            thread.status = method === 'turn/started' ? 'active' : 'idle';
          thread.updatedAt = Date.now();
          if (method === 'turn/started') thread.activeTurnId = str(turn.id);
          else if (!thread.activeTurnId || thread.activeTurnId === turn.id)
            delete thread.activeTurnId;
          this.event({ type: 'thread.changed', thread: { ...thread } });
        }
        for (const raw of array(turn.items)) {
          const item = this.item(record(raw), str(turn.id));
          this.items.set(`${threadId}:${item.id}`, item);
          this.event({ type: 'item.updated', threadId, item });
        }
        if (method === 'turn/completed') {
          for (const [key, cached] of this.items)
            if (
              key.startsWith(`${threadId}:`) &&
              cached.turnId === turn.id &&
              cached.status === 'inProgress'
            ) {
              const item = this.finishItem(threadId, cached);
              if (item !== cached) this.event({ type: 'item.updated', threadId, item });
            }
          if (turn.status === 'failed' || turn.status === 'interrupted')
            this.event({ type: 'item.updated', threadId, item: this.turnOutcome(turn) });
          this.event({ type: 'resync', threadId });
        }
        return;
      }
      case 'item/started':
      case 'item/completed': {
        const item = this.item(record(params.item), turnId);
        this.items.set(`${threadId}:${item.id}`, item);
        this.event({ type: 'item.updated', threadId, item });
        return;
      }
      case 'item/agentMessage/delta':
      case 'item/plan/delta':
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta':
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const itemId = str(params.itemId),
          delta = str(params.delta),
          key = `${threadId}:${itemId}`;
        if (!this.items.has(key)) {
          const type = method.split('/')[1] ?? 'unknown';
          const item: ConversationItem = {
            id: itemId,
            turnId,
            type,
            text: '',
            ...(type === 'agentMessage' ? { role: 'assistant' } : {}),
          };
          this.items.set(key, item);
          this.event({ type: 'item.updated', threadId, item: { ...item } });
        }
        this.items.get(key)!.text += delta;
        this.event({ type: 'item.delta', threadId, itemId, turnId, delta });
        return;
      }
      case 'item/fileChange/patchUpdated': {
        const item = this.item(
          { id: params.itemId, type: 'fileChange', changes: params.changes },
          turnId,
        );
        this.items.set(`${threadId}:${item.id}`, item);
        this.event({ type: 'item.updated', threadId, item });
        return;
      }
      case 'turn/diff/updated':
        this.event({
          type: 'item.updated',
          threadId,
          item: { id: `diff:${turnId}`, turnId, type: 'diff', text: str(params.diff) },
        });
        return;
      case 'turn/plan/updated':
        this.event({
          type: 'item.updated',
          threadId,
          item: {
            id: `plan:${turnId}`,
            turnId,
            type: 'plan',
            text: [
              str(params.explanation),
              ...array(params.plan).map((s) => {
                const step = record(s);
                return `${step.status === 'completed' ? '✓' : step.status === 'inProgress' ? '→' : '○'} ${str(step.step)}`;
              }),
            ]
              .filter(Boolean)
              .join('\n'),
          },
        });
        return;
      case 'serverRequest/resolved': {
        const id = `${this.generation}:${rpcKey(params.requestId as RpcId)}`;
        if (this.approvals.delete(id))
          this.event({ type: 'request.resolved', threadId, requestId: id });
        return;
      }
      case 'thread/closed':
      case 'thread/deleted':
      case 'thread/archived':
        this.resumed.delete(threadId);
        this.event({ type: 'resync', threadId });
        return;
      case 'error':
        if (threadId)
          this.event({
            type: 'item.updated',
            threadId,
            item: {
              id: `error:${turnId}:${Date.now()}`,
              turnId,
              type: 'error',
              text: str(record(params.error).message, 'Codex 执行错误'),
            },
          });
        return;
    }
  }
}
