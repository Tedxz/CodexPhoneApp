import { createServer as httpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { readFileSync, existsSync, statSync, realpathSync, watch } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { Config } from './config.js';
import { AuthError, AuthStore, PairingLimiter, sessionToken, sessionCookie } from './auth.js';
import { MAX_IMAGE_BYTES } from './uploads.js';
import type { CodexAdapter } from './codex.js';
import { TargetManager, type TargetRuntime } from './targets.js';
import type {
  ConversationItem,
  ClientType,
  Device,
  GatewayEvent,
  RequestAnswer,
  SessionSettings,
  ThreadSnapshot,
  TargetSummary,
} from '../shared/protocol.js';

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'BAD_REQUEST',
  ) {
    super(message);
  }
}
function text(value: unknown, name: string, max = 200): string {
  if (typeof value !== 'string' || !value || value.length > max)
    throw new HttpError(400, `${name} 无效`);
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, '无效的请求对象');
  return value as Record<string, unknown>;
}
function settings(value: Record<string, unknown>): SessionSettings {
  if (value.mode !== undefined && !['default', 'plan'].includes(String(value.mode)))
    throw new HttpError(400, '无效的会话模式');
  return {
    ...(value.model !== undefined ? { model: text(value.model, '模型') } : {}),
    ...(value.effort !== undefined ? { effort: text(value.effort, '推理强度', 30) } : {}),
    ...(value.mode !== undefined ? { mode: value.mode as SessionSettings['mode'] } : {}),
  };
}
async function body(req: IncomingMessage, max: number): Promise<Buffer> {
  if (Number(req.headers['content-length'] || 0) > max) throw new HttpError(413, '请求内容过大');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new HttpError(413, '请求内容过大');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

export function createGateway(
  config: Config,
  backend: CodexAdapter | Pick<TargetManager, 'all' | 'get' | 'close'>,
) {
  const targets = 'all' in backend ? backend : new TargetManager(config, backend);
  const auth = new AuthStore(config.dataDir);
  const limiter = new PairingLimiter();
  const origins = new Set(config.allowedOrigins);
  const hosts = new Set(config.allowedOrigins.map((x) => new URL(x).host));
  const secure = config.publicUrl.startsWith('https:') || !!config.tls;
  const cursors = new Map(
    targets.all().map((target) => [target.id, { epoch: randomUUID(), seq: 0 }]),
  );
  const clients = new Map<
    WebSocket,
    {
      token: string;
      device: Device;
      target: TargetRuntime;
      legacy: boolean;
      busy: number;
      alive: boolean;
    }
  >();
  const rpcCache = new Map<
    string,
    { digest: string; promise: Promise<unknown>; createdAt: number }
  >();
  const commandLocks = new Set<string>();
  function validateOrigin(req: IncomingMessage, required = false) {
    if (!hosts.has(req.headers.host || ''))
      throw new HttpError(403, '不允许的访问地址', 'ORIGIN_DENIED');
    const origin = req.headers.origin;
    if ((required && !origin) || (origin && !origins.has(origin)))
      throw new HttpError(403, '请求来源不受信任', 'ORIGIN_DENIED');
  }
  function deviceFor(req: IncomingMessage) {
    const device = auth.touch(sessionToken(req.headers.cookie));
    if (!device) throw new HttpError(401, '请先配对设备', 'UNAUTHORIZED');
    return device;
  }
  function targetSummary(target: TargetRuntime): TargetSummary {
    return {
      id: target.id,
      name: target.name,
      kind: target.kind,
      connection: target.connection,
      capabilities: target.capabilities,
    };
  }
  function targetFor(id: string): TargetRuntime {
    const target = targets.get(id);
    if (!target) throw new HttpError(404, '目标机器不存在', 'TARGET_NOT_FOUND');
    return target;
  }
  function requireBackend(target: TargetRuntime): void {
    const connection = target.connection;
    if (!connection.connected)
      throw new HttpError(503, connection.message, connection.errorCode || 'BACKEND_UNAVAILABLE');
  }
  function imageUrl(target: TargetRuntime, id: string, legacy: boolean): string {
    return legacy
      ? `/api/v1/uploads/${id}`
      : `/api/v1/targets/${encodeURIComponent(target.id)}/uploads/${id}`;
  }
  function itemForBrowser(
    item: ConversationItem,
    target: TargetRuntime,
    legacy: boolean,
  ): ConversationItem {
    return {
      ...item,
      images: item.images?.flatMap((path) => {
        const stored = target.uploads.urlForPath(path);
        const id = stored?.match(/\/uploads\/([a-f0-9-]{36})$/)?.[1];
        return id ? [imageUrl(target, id, legacy)] : [];
      }),
    };
  }
  function snapshotForBrowser(snapshot: ThreadSnapshot, target: TargetRuntime, legacy: boolean) {
    return {
      ...snapshot,
      items: snapshot.items.map((item) => itemForBrowser(item, target, legacy)),
      ...(snapshot.contextUser
        ? { contextUser: itemForBrowser(snapshot.contextUser, target, legacy) }
        : {}),
      eventCursor: { ...cursors.get(target.id)! },
    };
  }
  function send(ws: WebSocket, message: unknown) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 2 * 1024 * 1024) {
      ws.close(1013, 'Client too slow; reconnect');
      return;
    }
    ws.send(JSON.stringify(message));
  }
  function revokeSockets() {
    for (const [ws, client] of clients)
      if (!auth.authenticate(client.token)) ws.close(4001, 'Device revoked or expired');
  }
  const listeners = targets.all().map((target) => {
    const onEvent = (event: GatewayEvent) => {
      const cursor = cursors.get(target.id)!;
      cursor.seq++;
      // Each target is an independent stream. Legacy and scoped clients for local share its cursor.
      for (const [ws, client] of clients) {
        if (client.target.id !== target.id) continue;
        if (!auth.authenticate(client.token)) {
          ws.close(4001);
          continue;
        }
        const safeEvent =
          event.type === 'item.updated'
            ? { ...event, item: itemForBrowser(event.item, target, client.legacy) }
            : event.type === 'connection'
              ? { ...event, connection: target.connection }
              : event;
        send(ws, { type: 'event', ...cursor, event: safeEvent });
      }
    };
    target.codex.on('event', onEvent);
    return { target, onEvent };
  });

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    let selectedTarget: TargetRuntime | undefined;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      validateOrigin(req);
      const url = new URL(req.url || '/', config.publicUrl);
      let path = url.pathname;
      const method = req.method || 'GET';
      if (!['GET', 'HEAD'].includes(method)) {
        validateOrigin(req, true);
        if (req.headers['x-codex-phone'] !== '1') throw new HttpError(403, '缺少请求校验头');
      }
      if (path === '/api/v1/health' && method === 'GET') return json(res, 200, { ok: true });
      if (path === '/api/v1/pair' && method === 'POST') {
        if (!limiter.allow(req.socket.remoteAddress || 'unknown'))
          throw new HttpError(429, '尝试次数过多，请稍后重试');
        if (!req.headers['content-type']?.startsWith('application/json'))
          throw new HttpError(415, '需要 JSON 请求');
        const input = object(JSON.parse((await body(req, 2048)).toString()));
        const result = auth.pair(
          text(input.token, '配对凭据', 100),
          typeof input.name === 'string' ? input.name : '我的手机',
          {
            clientKey: input.clientKey as string | undefined,
            clientType: input.clientType as ClientType | undefined,
            sessionToken: sessionToken(req.headers.cookie),
            origin: req.headers.origin,
          },
        );
        if (!result)
          throw new HttpError(401, '配对凭据无效或已过期，请在电脑重新生成', 'PAIRING_EXPIRED');
        revokeSockets();
        res.setHeader('Set-Cookie', sessionCookie(result.token, secure));
        return json(res, 200, { device: result.device });
      }
      if (path.startsWith('/api/')) {
        const device = deviceFor(req);
        if (path === '/api/v1/devices/current/identify' && method === 'POST') {
          if (!req.headers['content-type']?.startsWith('application/json'))
            throw new HttpError(415, '需要 JSON 请求');
          const input = object(JSON.parse((await body(req, 2048)).toString()));
          const identified = auth.identify(
            sessionToken(req.headers.cookie),
            input.clientKey as string,
            input.clientType as ClientType,
            req.headers.origin,
          );
          if (!identified) throw new HttpError(401, '请先配对客户端', 'UNAUTHORIZED');
          return json(res, 200, { device: identified });
        }
        if (path === '/api/v1/logout' && method === 'POST') {
          auth.revokeSession(sessionToken(req.headers.cookie));
          revokeSockets();
          res.setHeader('Set-Cookie', sessionCookie('', secure, true));
          return json(res, 200, { ok: true });
        }
        if (path === '/api/v1/devices' && method === 'GET')
          return json(res, 200, {
            data: auth.list().map((x) => ({ ...x, current: x.id === device.id })),
          });
        const deviceMatch = /^\/api\/v1\/devices\/([a-f0-9-]{36})$/.exec(path);
        if (deviceMatch && method === 'DELETE') {
          auth.revoke(deviceMatch[1]);
          revokeSockets();
          return json(res, 200, { ok: true });
        }
        if (path === '/api/v1/targets' && method === 'GET')
          return json(res, 200, { data: targets.all().map(targetSummary) });
        const targetMatch = /^\/api\/v1\/targets\/([^/]+)(\/.*)$/.exec(path);
        const legacy = !targetMatch;
        selectedTarget = targetFor(targetMatch ? decodeURIComponent(targetMatch[1]) : 'local');
        const target = selectedTarget;
        const codex = target.codex;
        const uploads = target.uploads;
        if (targetMatch) path = '/api/v1' + targetMatch[2];
        if (path === '/api/v1/bootstrap' && method === 'GET')
          return json(res, 200, {
            device,
            projects: target.projects,
            connection: target.connection,
            capabilities: target.capabilities,
            ...(!legacy ? { target: targetSummary(target) } : {}),
          });
        if (method === 'GET' && /^\/api\/v1\/(workspaces|models|threads(?:\/[^/]+)?)$/.test(path))
          requireBackend(target);
        if (path === '/api/v1/workspaces' && method === 'GET')
          return json(res, 200, { data: await codex.listWorkspaces() });
        if (path === '/api/v1/threads' && method === 'GET')
          return json(
            res,
            200,
            await codex.listThreads({
              cursor: url.searchParams.get('cursor') || undefined,
              search: url.searchParams.get('search')?.slice(0, 200) || undefined,
              cwd: url.searchParams.get('cwd') ?? undefined,
            }),
          );
        const threadMatch = /^\/api\/v1\/threads\/([^/]+)$/.exec(path);
        if (threadMatch && method === 'GET')
          return json(
            res,
            200,
            snapshotForBrowser(
              await codex.snapshot(
                decodeURIComponent(threadMatch[1]),
                url.searchParams.get('cursor') || undefined,
              ),
              target,
              legacy,
            ),
          );
        if (path === '/api/v1/models' && method === 'GET')
          return json(res, 200, { data: await codex.models() });
        if (path === '/api/v1/uploads' && method === 'POST') {
          const bytes = await body(req, MAX_IMAGE_BYTES);
          try {
            const saved = uploads.save(bytes, req.headers['content-type'] || '');
            return json(res, 201, { ...saved, url: imageUrl(target, saved.id, legacy) });
          } catch (e) {
            throw new HttpError(400, (e as Error).message);
          }
        }
        const imageMatch = /^\/api\/v1\/uploads\/([a-f0-9-]{36})$/.exec(path);
        if (imageMatch && method === 'GET') {
          const image = uploads.get(imageMatch[1]);
          if (!image) throw new HttpError(404, '图片不存在');
          res.setHeader('Content-Type', image.mime);
          res.end(readFileSync(image.path));
          return;
        }
        throw new HttpError(404, '接口不存在', 'NOT_FOUND');
      }
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, '不支持此方法');
      const root = resolve('dist');
      const file = resolve(root, '.' + decodeURIComponent(path));
      if (file !== root && !file.startsWith(root + sep)) throw new HttpError(404, '页面不存在');
      const target =
        existsSync(file) && statSync(file).isFile()
          ? file
          : path.includes('.')
            ? null
            : resolve(root, 'index.html');
      if (!target || !existsSync(target))
        throw new HttpError(404, '网页尚未构建，请运行 npm run build');
      if (!realpathSync(target).startsWith(realpathSync(root) + sep))
        throw new HttpError(404, '页面不存在');
      const mime: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.ico': 'image/x-icon',
        '.webmanifest': 'application/manifest+json',
      };
      res.setHeader('Content-Type', mime[extname(target)] || 'application/octet-stream');
      res.end(method === 'HEAD' ? undefined : readFileSync(target));
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const e = error as Error & { code?: string };
      const status =
        error instanceof HttpError || error instanceof AuthError
          ? error.status
          : error instanceof SyntaxError || error instanceof URIError
            ? 400
            : selectedTarget && !selectedTarget.connection.connected
              ? 503
              : 500;
      json(res, status, {
        error: {
          code: e.code || (status === 503 ? 'BACKEND_UNAVAILABLE' : 'REQUEST_FAILED'),
          message: status === 500 ? '请求失败，请查看连接状态后重试' : e.message,
        },
      });
    }
  };
  const server = config.tls
    ? httpsServer(
        { cert: readFileSync(config.tls.cert), key: readFileSync(config.tls.key) },
        handler,
      )
    : httpServer(handler);
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 512 * 1024,
    perMessageDeflate: false,
  });
  server.on('upgrade', (req, socket, head) => {
    try {
      validateOrigin(req, true);
      const device = deviceFor(req);
      const targetMatch = /^\/api\/v1\/targets\/([^/]+)\/ws$/.exec(req.url || '');
      const legacy = req.url === '/api/v1/ws';
      if (!legacy && !targetMatch) throw new HttpError(404, 'Not found');
      const target = targetFor(legacy ? 'local' : decodeURIComponent(targetMatch![1]));
      const token = sessionToken(req.headers.cookie)!;
      if (clients.size >= 12) throw new HttpError(429, '连接数过多');
      wss.handleUpgrade(req, socket, head, (ws) => {
        const client = { device, token, target, legacy, busy: 0, alive: true };
        clients.set(ws, client);
        ws.on('error', () => {});
        ws.on('close', () => clients.delete(ws));
        ws.on('pong', () => {
          client.alive = true;
          try {
            const current = auth.touch(client.token);
            if (current) client.device = current;
            else ws.close(4001, 'Client revoked or expired');
          } catch {
            ws.close(1013, 'Authorization store busy; reconnect');
          }
        });
        send(ws, {
          type: 'event',
          ...cursors.get(target.id)!,
          event: { type: 'connection', connection: target.connection },
        });
        ws.on('message', async (data) => {
          let id = '';
          try {
            const current = auth.touch(token);
            if (!current) {
              ws.close(4001);
              return;
            }
            client.device = current;
            const request = object(JSON.parse(data.toString()));
            id = text(request.id, '请求 ID', 100);
            if (client.busy >= 8) throw new HttpError(429, '操作过于频繁');
            const method = text(request.method, '方法', 50);
            const params = object(request.params);
            const cacheKey = JSON.stringify([current.id, target.id, id]);
            const digest = createHash('sha256')
              .update(JSON.stringify({ method, params }))
              .digest('hex');
            for (const [key, entry] of rpcCache)
              if (Date.now() - entry.createdAt > 3600_000) rpcCache.delete(key);
            let cached = rpcCache.get(cacheKey);
            if (cached && cached.digest !== digest)
              throw new HttpError(409, '请求 ID 已用于其他操作');
            if (!cached) {
              if (rpcCache.size >= 10000) throw new HttpError(429, '请求容量已满，请稍后重试');
              client.busy++;
              const promise = command(target, method, params, () => {
                if (!auth.authenticate(token))
                  throw new HttpError(401, '客户端授权已失效，尚未发送消息', 'UNAUTHORIZED');
              }).finally(() => {
                client.busy--;
              });
              cached = { digest, promise, createdAt: Date.now() };
              rpcCache.set(cacheKey, cached);
            }
            const result = await cached.promise;
            // Cache one canonical result so a retry across legacy/scoped local
            // connections cannot execute a mutation twice or return the wrong URL namespace.
            const response =
              legacy && (method === 'thread.subscribe' || method === 'thread.create')
                ? {
                    ...(result as ThreadSnapshot),
                    items: (result as ThreadSnapshot).items.map((item) => ({
                      ...item,
                      images: item.images?.map((url) =>
                        url.replace('/api/v1/targets/local/uploads/', '/api/v1/uploads/'),
                      ),
                    })),
                    ...((result as ThreadSnapshot).contextUser
                      ? {
                          contextUser: {
                            ...(result as ThreadSnapshot).contextUser!,
                            images: (result as ThreadSnapshot).contextUser!.images?.map((url) =>
                              url.replace('/api/v1/targets/local/uploads/', '/api/v1/uploads/'),
                            ),
                          },
                        }
                      : {}),
                  }
                : result;
            send(ws, { id, result: response });
          } catch (error) {
            const e = error as Error & { code?: string };
            send(ws, {
              id,
              error: { code: e.code || 'REQUEST_FAILED', message: e.message || '操作失败' },
            });
          }
        });
      });
    } catch (error) {
      socket.end(
        `HTTP/1.1 ${error instanceof HttpError ? error.status : 403} Rejected\r\nConnection: close\r\n\r\n`,
      );
    }
  });
  async function command(
    target: TargetRuntime,
    method: string,
    p: Record<string, unknown>,
    assertAuthorized: () => void,
  ): Promise<unknown> {
    requireBackend(target);
    const assertReady = () => {
      assertAuthorized();
      requireBackend(target);
    };
    const codex = target.codex;
    if (method === 'thread.subscribe') {
      if (p.retryWrite !== undefined && typeof p.retryWrite !== 'boolean')
        throw new HttpError(400, 'retryWrite 必须为布尔值');
      return snapshotForBrowser(
        await codex.subscribe(text(p.threadId, '会话 ID'), p.retryWrite === true),
        target,
        false,
      );
    }
    if (method === 'thread.create') {
      const project = target.projects.find((x) => x.id === p.projectId);
      if (!project) throw new HttpError(400, '请选择已配置的项目');
      return snapshotForBrowser(
        await codex.createThread({ cwd: project.path, ...settings(p) }, assertReady),
        target,
        false,
      );
    }
    if (method === 'turn.send') {
      const threadId = text(p.threadId, '会话 ID');
      const message = typeof p.text === 'string' ? p.text.trim() : '';
      if (message.length > 64000) throw new HttpError(400, '消息过长');
      const ids = p.imageIds ?? [];
      if (!Array.isArray(ids) || ids.length > 8 || ids.some((x) => typeof x !== 'string'))
        throw new HttpError(400, '图片列表无效，最多 8 张');
      if (!message && !ids.length) throw new HttpError(400, '请输入消息或添加图片');
      const lockKey = JSON.stringify([target.id, threadId]);
      if (commandLocks.has(lockKey))
        throw new HttpError(409, '会话正在处理另一条发送请求，请同步状态后重试');
      commandLocks.add(lockKey);
      try {
        if (ids.length && !target.capabilities.images)
          throw new HttpError(
            409,
            '该机器的图片传输暂不可用，请检查连接配置',
            'IMAGES_UNAVAILABLE',
          );
        const imagePaths = await target.prepareImages(ids);
        assertReady();
        return await codex.send(
          {
            threadId,
            text: message,
            imagePaths,
            expectedTurnId:
              p.expectedTurnId === undefined ? undefined : text(p.expectedTurnId, '轮次 ID'),
            ...settings(p),
          },
          assertReady,
        );
      } finally {
        commandLocks.delete(lockKey);
      }
    }
    if (method === 'turn.interrupt')
      return codex.interrupt(text(p.threadId, '会话 ID'), text(p.turnId, '轮次 ID'));
    if (method === 'request.respond') {
      const requestId = text(p.requestId, '审批 ID');
      const answer: RequestAnswer = {};
      if (p.decision !== undefined) {
        if (!['accept', 'decline', 'cancel'].includes(String(p.decision)))
          throw new HttpError(400, '无效的审批选项');
        answer.decision = p.decision as RequestAnswer['decision'];
      }
      if (p.answers !== undefined) {
        const values = object(p.answers);
        if (Object.keys(values).length > 30) throw new HttpError(400, '回答数量过多');
        for (const valuesArray of Object.values(values))
          if (
            !Array.isArray(valuesArray) ||
            valuesArray.length > 20 ||
            valuesArray.some((x) => typeof x !== 'string' || x.length > 10000)
          )
            throw new HttpError(400, '回答格式无效');
        answer.answers = values as Record<string, string[]>;
      }
      return codex.respond(requestId, answer);
    }
    throw new HttpError(400, '不支持的操作');
  }
  // Some macOS sandboxes / heavily loaded machines cannot allocate fs watchers.
  // Authentication on every action/event and the heartbeat remain authoritative.
  let authWatcher: ReturnType<typeof watch> | undefined;
  try {
    authWatcher = watch(resolve(config.dataDir, 'devices'), revokeSockets);
    authWatcher.on('error', () => authWatcher?.close());
  } catch {
    /* Fall back to heartbeat checks. */
  }
  const heartbeat = setInterval(() => {
    revokeSockets();
    for (const [ws, client] of clients) {
      if (!client.alive) ws.terminate();
      else {
        client.alive = false;
        ws.ping();
      }
    }
  }, 15_000);
  heartbeat.unref();
  return {
    server,
    auth,
    handler,
    wsServer: wss,
    async close() {
      clearInterval(heartbeat);
      authWatcher?.close();
      for (const { target, onEvent } of listeners) target.codex.off('event', onEvent);
      for (const ws of clients.keys()) ws.terminate();
      wss.close();
      await targets.close();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
