import { webSocket } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import { ErrorDetail, EventEnvelope } from '../model/Protocol';
import { EventCursor } from '../model/State';
import { GatewayApi, GatewayError } from './GatewayApi';

export interface LiveHandlers {
  status: (connected: boolean) => void;
  event: (envelope: EventEnvelope) => void;
  resync: () => void;
  unauthorized: () => void;
}

interface FrameHeader {
  type?: string;
  id?: string;
}

interface RpcReply {
  id: string;
  result?: Object;
  error?: ErrorDetail;
}

interface SocketHeaders {
  Cookie: string;
}

class PendingCommand {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timeout: number;

  constructor(resolve: (value: string) => void, reject: (error: Error) => void, timeout: number) {
    this.resolve = resolve;
    this.reject = reject;
    this.timeout = timeout;
  }
}

export class NativeLiveClient {
  private api: GatewayApi;
  private handlers: LiveHandlers;
  private ws: webSocket.WebSocket | undefined;
  private open: boolean = false;
  private stopped: boolean = false;
  private retry: number = -1;
  private attempts: number = 0;
  private pending: Map<string, PendingCommand> = new Map();
  private cursor: EventCursor = new EventCursor();

  constructor(api: GatewayApi, handlers: LiveHandlers) {
    this.api = api;
    this.handlers = handlers;
  }

  connect(): void {
    if (this.stopped || this.ws) return;
    clearTimeout(this.retry);
    const socket = webSocket.createWebSocket();
    this.ws = socket;
    socket.on('open', (_error: BusinessError, _value: Object) => {
      if (this.stopped || this.ws !== socket) return;
      this.open = true;
      this.attempts = 0;
      this.handlers.status(true);
      this.handlers.resync();
    });
    socket.on('message', (_error: BusinessError, value: string | ArrayBuffer) => {
      if (this.stopped || this.ws !== socket || typeof value !== 'string') return;
      this.receive(value);
    });
    socket.on('close', (_error: BusinessError, value: webSocket.CloseResult) => {
      this.disconnected(socket, value.code);
    });
    socket.on('error', (_error: BusinessError) => {
      this.disconnected(socket, 1006);
    });
    // NetworkKit/libwebsockets synthesizes Origin from the connection URL.
    // Adding Origin as a custom header produces TWO values and fails the
    // gateway's exact-origin validation. API 26 adds non-default port support.
    const headers: SocketHeaders = { Cookie: this.api.cookie };
    const options: webSocket.WebSocketRequestOptions = { header: headers, supportOriginPort: true };
    const endpoint = this.api.origin.replace(/^http/, 'ws') + this.api.targetPrefix + '/ws';
    socket.connect(endpoint, options).catch(() => this.disconnected(socket, 1006));
  }

  command(method: string, params: string): Promise<string> {
    const socket = this.ws;
    if (this.stopped || !socket || !this.open) return Promise.reject(new Error('连接尚未恢复，请稍后再试。'));
    if (['thread.subscribe', 'thread.create', 'turn.send', 'turn.interrupt', 'request.respond'].indexOf(method) < 0) {
      return Promise.reject(new Error('不支持此操作。'));
    }
    try {
      const parsed = JSON.parse(params) as Object;
      if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('invalid');
    } catch {
      return Promise.reject(new Error('操作参数格式无效。'));
    }
    const id = util.generateRandomUUID(true);
    const payload = `{"id":${JSON.stringify(id)},"method":${JSON.stringify(method)},"params":${params}}`;
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('响应超时，操作结果尚未确认。请核对会话后再试。'));
      }, 45000);
      this.pending.set(id, new PendingCommand(resolve, reject, timeout));
      socket.send(payload).catch(() => {
        const command = this.pending.get(id);
        if (!command) return;
        clearTimeout(command.timeout);
        this.pending.delete(id);
        command.reject(new Error('发送时连接中断，请核对会话确认操作结果。'));
      });
    });
  }

  close(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.rejectPending('连接已关闭。');
    const socket = this.ws;
    this.ws = undefined;
    this.open = false;
    this.release(socket);
  }

  private receive(text: string): void {
    let header: FrameHeader;
    try {
      header = JSON.parse(text) as FrameHeader;
    } catch {
      return;
    }
    if (!header || typeof header !== 'object') return;
    if (header.type === 'event') {
      const envelope = JSON.parse(text) as EventEnvelope;
      if (typeof envelope.epoch !== 'string' || !Number.isSafeInteger(envelope.seq) || envelope.seq < 0 || !envelope.event || typeof envelope.event.type !== 'string') return;
      const outcome = this.cursor.accept(envelope);
      if (outcome === 'duplicate') return;
      if (outcome === 'resync') this.handlers.resync();
      this.handlers.event(envelope);
      return;
    }
    if (!header.id) return;
    const command = this.pending.get(header.id);
    if (!command) return;
    this.pending.delete(header.id);
    clearTimeout(command.timeout);
    const reply = JSON.parse(text) as RpcReply;
    if (reply.error) command.reject(new Error(reply.error.message || '操作失败，请重新同步。'));
    else command.resolve(JSON.stringify(reply.result === undefined ? null : reply.result));
  }

  private disconnected(socket: webSocket.WebSocket, code: number): void {
    if (this.stopped || this.ws !== socket) return;
    this.ws = undefined;
    this.open = false;
    this.handlers.status(false);
    this.rejectPending('连接中断，操作结果尚未确认。恢复连接后请核对会话，避免重复发送。');
    this.release(socket);
    if (code === 4401 || code === 4001 || code === 1008) {
      this.stopped = true;
      this.handlers.unauthorized();
      return;
    }
    // Failed upgrades can conceal HTTP 401; an authenticated probe avoids an
    // endless reconnect loop after a device is revoked or its cookie expires.
    this.api.bootstrap().catch((error: Error) => {
      if (this.stopped || !(error instanceof GatewayError) || error.status !== 401) return;
      this.close();
      this.handlers.unauthorized();
    });
    this.retry = setTimeout(() => this.connect(), Math.min(1000 * Math.pow(2, this.attempts++), 15000));
  }

  private rejectPending(message: string): void {
    this.pending.forEach((command: PendingCommand) => {
      clearTimeout(command.timeout);
      command.reject(new Error(message));
    });
    this.pending.clear();
  }

  private release(socket: webSocket.WebSocket | undefined): void {
    if (!socket) return;
    socket.off('open');
    socket.off('message');
    socket.off('close');
    socket.off('error');
    socket.close().catch(() => {});
  }
}
