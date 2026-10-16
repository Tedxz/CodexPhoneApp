import type { EventEnvelope, RpcCommand, RpcReply } from '../shared/protocol';
import { EventCursor } from './state';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.method && options.method !== 'GET') headers.set('X-Codex-Phone', '1');
  if (typeof options.body === 'string' && !headers.has('Content-Type'))
    headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    headers,
    credentials: 'same-origin',
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new ApiError(
      body.error?.message || body.message || `请求失败（${response.status}）`,
      response.status,
    );
  return body as T;
}

export class LiveClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private cursor = new EventCursor();

  constructor(
    private handlers: {
      status(connected: boolean): void;
      event(envelope: EventEnvelope): void;
      resync(): void;
      unauthorized(): void;
    },
    private routePrefix = '',
  ) {}

  connect(): void {
    if (this.stopped) return;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    )
      return;
    clearTimeout(this.retry);
    const ws = new WebSocket(
      `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/v1${this.routePrefix}/ws`,
    );
    this.ws = ws;
    ws.onopen = () => {
      if (this.stopped || this.ws !== ws) return;
      this.attempts = 0;
      this.handlers.status(true);
      this.handlers.resync();
    };
    ws.onmessage = ({ data }) => {
      if (this.stopped || this.ws !== ws) return;
      let message: EventEnvelope | RpcReply;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!message || typeof message !== 'object') return;
      if ('type' in message && message.type === 'event') {
        if (
          typeof message.epoch !== 'string' ||
          !Number.isSafeInteger(message.seq) ||
          message.seq < 0 ||
          !message.event ||
          typeof message.event.type !== 'string'
        )
          return;
        const outcome = this.cursor.accept(message);
        if (outcome === 'duplicate') return;
        if (outcome === 'resync') this.handlers.resync();
        this.handlers.event(message);
      } else if ('id' in message) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timeout);
        message.error
          ? pending.reject(new Error(message.error.message))
          : pending.resolve(message.result);
      }
    };
    ws.onclose = (event) => {
      if (this.stopped || this.ws !== ws) return;
      this.handlers.status(false);
      for (const item of this.pending.values()) {
        clearTimeout(item.timeout);
        item.reject(new Error('连接中断，操作结果尚未确认。恢复连接后请核对会话，避免重复发送。'));
      }
      this.pending.clear();
      if (event.code === 4401 || event.code === 4001 || event.code === 1008) {
        this.stopped = true;
        this.handlers.unauthorized();
        return;
      }
      // Browsers conceal a rejected upgrade's HTTP status behind close 1006.
      // Check the authenticated HTTP endpoint so an expired session cannot
      // become an endless opaque WebSocket reconnect loop.
      if (event.code === 1006)
        void api(`${this.routePrefix}/bootstrap`).catch((error) => {
          if (
            this.stopped ||
            this.ws !== ws ||
            !(error instanceof ApiError) ||
            error.status !== 401
          )
            return;
          this.stopped = true;
          clearTimeout(this.retry);
          this.handlers.unauthorized();
        });
      if (!this.stopped)
        this.retry = setTimeout(() => this.connect(), Math.min(1000 * 2 ** this.attempts++, 15000));
    };
    ws.onerror = () => {
      if (!this.stopped && this.ws === ws) ws.close();
    };
  }

  command<T>(method: RpcCommand['method'], params: Record<string, unknown>): Promise<T> {
    const ws = this.ws;
    if (this.stopped || !ws || ws.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('连接尚未恢复，请稍后再试。'));
    const id =
      globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('响应超时，操作结果尚未确认。请核对会话后再试。'));
      }, 45000);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timeout });
      try {
        ws.send(JSON.stringify({ id, method, params } satisfies RpcCommand));
      } catch {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new Error('发送时连接中断，请核对会话确认操作结果。'));
      }
    });
  }

  close(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    for (const item of this.pending.values()) {
      clearTimeout(item.timeout);
      item.reject(new Error('连接已关闭。'));
    }
    this.pending.clear();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
