import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve, relative, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { CodexAdapter, type CodexSocket } from '../server/codex.js';
import { loadConfig } from '../server/config.js';
import type { GatewayEvent, ThreadSnapshot } from '../shared/protocol.js';

type Status = 'passed' | 'failed' | 'blocked' | 'manual';
interface Check {
  name: string;
  status: Status;
  detail: string;
  evidence?: Record<string, string | number | boolean>;
}
class AcceptanceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly blocked = false,
  ) {
    super(message);
  }
}
function failure(error: unknown): { code: string; detail: string; blocked: boolean } {
  if (error instanceof AcceptanceError)
    return { code: error.code, detail: error.message, blocked: error.blocked };
  const raw = error as { code?: unknown; message?: unknown };
  const text = String(raw?.message ?? ''),
    code = String(raw?.code ?? 'UNKNOWN');
  if (/EPERM|EACCES/.test(code + text))
    return {
      code: /EPERM/.test(code + text) ? 'EPERM' : 'EACCES',
      detail: '当前终端进程无权连接已有 Codex socket。',
      blocked: true,
    };
  if (/ENOENT|ECONNREFUSED|DISCONNECTED/.test(code))
    return {
      code: code.replace(/[^A-Z0-9_]/g, ''),
      detail: '已有共享后端不可用；请检查运行状态与 socket 配置。',
      blocked: true,
    };
  // Backend error strings can contain paths or conversation content. Do not persist them.
  return {
    code: /^[A-Z0-9_-]{1,80}$/.test(code) ? code : 'BACKEND_ERROR',
    detail: '真实后端操作未成功；报告不包含后端原始错误内容。',
    blocked: false,
  };
}
const versionOf = (value?: string) =>
  value?.match(/\b\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?/)?.[0] ?? 'unknown';

/** Diagnostic opt-in: no request params, notifications or successful payloads. */
function errorTracingSocket(client: 'primary' | 'peer'): (url: string) => CodexSocket {
  return (url) => {
    const ws = new WebSocket(url, { handshakeTimeout: 8_000, maxPayload: 32 * 1024 * 1024 });
    const methods = new Map<string, string>();
    ws.on('message', (bytes) => {
      try {
        const message = JSON.parse(String(bytes));
        if (!message || message.method || message.id === undefined) return;
        const method = methods.get(String(message.id));
        methods.delete(String(message.id));
        if (!method || !message.error) return;
        const detail = String(message.error.message ?? '')
          .slice(0, 4000)
          .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
          .replace(
            /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
            '$1[REDACTED]',
          );
        console.log(
          '[RPC_ERROR] ' +
            JSON.stringify({ client, method, code: message.error.code, message: detail }),
        );
      } catch {
        /* Unparseable frames are handled by the adapter. */
      }
    });
    ws.on('close', () => methods.clear());
    return {
      on: (event, listener) => ws.on(event, listener),
      close: () => ws.close(),
      terminate: () => ws.terminate(),
      send(data, callback) {
        try {
          const message = JSON.parse(data);
          if (message.method && message.id !== undefined)
            methods.set(String(message.id), String(message.method));
        } catch {
          /* Only diagnostics. */
        }
        ws.send(data, callback);
      },
    };
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (
    !args.includes('--run') ||
    args.some((arg) => !['--run', '--trace-rpc-errors'].includes(arg))
  ) {
    console.log(
      '真实共享后端验收（默认只显示说明，不创建会话）\n\n运行：npm run test:live -- --run\n诊断：npm run test:live -- --run --trace-rpc-errors（只输出失败 RPC 的方法、代码和错误描述）\n\n连接成功后会创建一个独立测试会话，发送测试文字，运行一次 /bin/sleep 20，追加指令并停止该轮次。\n仅连接配置中已有的共享 socket；不启动后端、不接触已有会话、不修改权限或全局配置。\n报告写入 tmp/live-acceptance/report-*.json。审批、Desktop/CLI 同步与真机访问仍需人工验证。',
    );
    if (args.some((arg) => !['--run', '--trace-rpc-errors', '--help', '-h'].includes(arg)))
      process.exitCode = 2;
    return;
  }

  const started = Date.now(),
    deadline = started + 120_000;
  const runId =
    new Date(started).toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(3).toString('hex');
  const output = resolve('tmp/live-acceptance'),
    workdir = join(output, runId),
    reportPath = join(output, `report-${runId}.json`);
  const checks: Check[] = [];
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    startedAt: new Date(started).toISOString(),
    runId,
    result: 'blocked',
    fullAcceptance: 'manual_pending',
    sharedBackendOnly: true,
    versions: { node: process.version, adapterProtocol: '0.162.1' },
    checks,
  };
  let primary: CodexAdapter | undefined, peer: CodexAdapter | undefined;
  let ownThreadId: string | undefined,
    stopping = false,
    workdirCreated = false,
    currentStage = 'connect_shared_backend';
  let automatedPassed = false;
  const ownTurns = new Set<string>(),
    generatedInputs = new Set<string>();
  const peerDeltaCounts = new Map<string, number>(),
    peerUserText = new Map<string, string>();
  const peerSleepTurns = new Set<string>(),
    peerTerminalTurns = new Set<string>();
  const signal = () => {
    stopping = true;
  };
  process.once('SIGINT', signal);
  process.once('SIGTERM', signal);
  function active(): void {
    if (stopping || Date.now() >= deadline)
      throw new AcceptanceError('DEADLINE', '验收被中断或达到 120 秒总时限。');
  }
  function observe(event: GatewayEvent, fromPeer: boolean): void {
    if (
      event.type === 'thread.changed' &&
      workdirCreated &&
      event.thread.cwd === workdir &&
      !ownThreadId
    )
      ownThreadId = event.thread.id;
    if (!ownThreadId) return;
    if (event.type === 'item.updated' && event.threadId === ownThreadId) {
      if (
        event.item.role === 'user' &&
        [...generatedInputs].some((marker) => event.item.text.includes(marker))
      )
        ownTurns.add(event.item.turnId);
      if (fromPeer && event.item.role === 'user')
        peerUserText.set(
          event.item.turnId,
          (peerUserText.get(event.item.turnId) ?? '') + '\n' + event.item.text,
        );
      if (
        fromPeer &&
        event.item.type === 'commandExecution' &&
        event.item.status === 'inProgress' &&
        /(?:\/bin\/)?sleep\s+20\b/.test(event.item.text)
      )
        peerSleepTurns.add(event.item.turnId);
      if (fromPeer && event.item.status === 'interrupted') peerTerminalTurns.add(event.item.turnId);
    }
    if (fromPeer && event.type === 'item.delta' && event.threadId === ownThreadId)
      peerDeltaCounts.set(event.turnId, (peerDeltaCounts.get(event.turnId) ?? 0) + 1);
  }
  async function stage(
    name: string,
    work: () => Promise<Record<string, string | number | boolean> | void>,
  ): Promise<void> {
    active();
    currentStage = name;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const evidence = await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              stopping = true;
              reject(new AcceptanceError('STAGE_TIMEOUT', `${name} 未在阶段或总时限内通过。`));
            },
            Math.min(45_000, Math.max(1, deadline - Date.now())),
          );
        }),
      ]);
      active();
      checks.push({
        name,
        status: 'passed',
        detail: '已通过真实后端验证。',
        ...(evidence ? { evidence } : {}),
      });
      console.log(`[PASS] ${name}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async function snapshot(reader = peer): Promise<ThreadSnapshot> {
    active();
    if (!reader || !ownThreadId)
      throw new AcceptanceError('NO_TEST_THREAD', '尚未建立独立测试会话。');
    const value = await reader.snapshot(ownThreadId);
    active();
    if (value.thread.id !== ownThreadId || value.thread.cwd !== workdir)
      throw new AcceptanceError('THREAD_MISMATCH', '后端返回的会话不属于本次独立测试，已停止。');
    if (value.pendingRequests.length || value.warning)
      throw new AcceptanceError(
        'MANUAL_REQUEST',
        '测试会话正在等待电脑端审批或用户回答；未自动处理。',
        true,
      );
    return value;
  }
  async function until(
    check: (value: ThreadSnapshot) => boolean,
    maxMs = 40_000,
    reader = peer,
  ): Promise<ThreadSnapshot> {
    const end = Math.min(deadline, Date.now() + maxMs);
    do {
      const value = await snapshot(reader);
      if (check(value)) return value;
      await sleep(450);
      active();
    } while (Date.now() < end);
    throw new AcceptanceError('OBSERVATION_TIMEOUT', '未在时限内从真实会话观察到所需状态。');
  }
  async function send(text: string, expectedTurnId?: string): Promise<string> {
    active();
    if (!primary || !ownThreadId)
      throw new AcceptanceError('NO_TEST_THREAD', '尚未建立独立测试会话。');
    const response = (await primary.send({
      threadId: ownThreadId,
      text,
      ...(expectedTurnId ? { expectedTurnId } : {}),
    })) as { turnId?: string };
    active();
    if (!response.turnId) throw new AcceptanceError('NO_TURN_ID', '真实后端没有返回轮次标识。');
    ownTurns.add(response.turnId);
    return response.turnId;
  }

  try {
    const config = loadConfig();
    const trace = args.includes('--trace-rpc-errors');
    primary = new CodexAdapter({
      socketPath: config.socketPath,
      requestTimeoutMs: 8_000,
      reconnectDelayMs: 60_000,
      ...(trace ? { socketFactory: errorTracingSocket('primary') } : {}),
    });
    peer = new CodexAdapter({
      socketPath: config.socketPath,
      requestTimeoutMs: 8_000,
      reconnectDelayMs: 60_000,
      ...(trace ? { socketFactory: errorTracingSocket('peer') } : {}),
    });
    primary.on('event', (event) => observe(event, false));
    peer.on('event', (event) => observe(event, true));
    await stage('connect_shared_backend', async () => {
      // Both connections must initialize before creating a directory or thread.
      await Promise.all([primary!.connect(), peer!.connect()]);
      active();
      if (!primary!.connection.connected || !peer!.connection.connected)
        throw new AcceptanceError('DISCONNECTED', '两个共享连接未同时就绪。', true);
      report.versions = {
        node: process.version,
        adapterProtocol: '0.162.1',
        primaryBackend: versionOf(primary!.connection.serverVersion),
        peerBackend: versionOf(peer!.connection.serverVersion),
      };
      return { independentConnections: 2 };
    });
    await stage('create_isolated_thread', async () => {
      await mkdir(workdir, { recursive: true, mode: 0o700 });
      workdirCreated = true;
      active();
      const created = await primary!.createThread({ cwd: workdir });
      active();
      if (
        created.thread.cwd !== workdir ||
        !created.thread.id ||
        (ownThreadId && ownThreadId !== created.thread.id)
      )
        throw new AcceptanceError('THREAD_MISMATCH', '创建结果与隔离目录不一致；不会操作该会话。');
      ownThreadId = created.thread.id;
      report.threadId = ownThreadId;
      report.workspace = relative(process.cwd(), workdir);
      return { createdThreads: 1 };
    });
    const warmupMarker = `CODEX_PHONE_WARMUP_${randomBytes(8).toString('hex').toUpperCase()}`;
    generatedInputs.add(warmupMarker);
    await stage('primary_warmup_persistence', async () => {
      // An empty new thread has no rollout and cannot be resumed by a second
      // client yet. Materialize only this test thread with one real first turn.
      // This stage deliberately makes no claim about peer streaming.
      const turnId = await send(
        `Isolated connectivity warmup. Do not use tools or change files. Reply exactly ${warmupMarker} and nothing else.`,
      );
      const observed = await until(
        (value) =>
          value.thread.status !== 'active' &&
          value.items.some(
            (item) =>
              item.turnId === turnId &&
              item.role === 'assistant' &&
              item.text.trim() === warmupMarker,
          ),
        40_000,
        primary,
      );
      return { exactMarkerInPrimaryHistory: true, terminalState: observed.thread.status };
    });
    await stage('peer_subscribe', async () => {
      const joined = await peer!.subscribe(ownThreadId!);
      active();
      if (joined.thread.id !== ownThreadId || joined.thread.cwd !== workdir)
        throw new AcceptanceError('PEER_MISMATCH', '第二连接未读取到相同独立会话。');
      return { sameThread: true };
    });
    const marker = `CODEX_PHONE_TEXT_${randomBytes(8).toString('hex').toUpperCase()}`;
    generatedInputs.add(marker);
    await stage('text_stream_and_history', async () => {
      const turnId = await send(
        `Isolated Codex Phone connectivity acceptance. Do not use tools or change files. Reply with exactly this marker and nothing else: ${marker}`,
      );
      const observed = await until(
        (value) =>
          value.thread.status !== 'active' &&
          value.items.some(
            (item) =>
              item.turnId === turnId && item.role === 'assistant' && item.text.trim() === marker,
          ),
      );
      const deltaCount = peerDeltaCounts.get(turnId) ?? 0;
      if (!deltaCount)
        throw new AcceptanceError(
          'NO_PEER_STREAM',
          '第二连接读到了回复，但没有观察到实时增量，不能判定流式同步成功。',
        );
      return {
        peerDeltas: deltaCount,
        exactMarkerInPeerHistory: true,
        terminalState: observed.thread.status,
      };
    });
    const sleepMarker = `CODEX_PHONE_SLEEP_${randomBytes(8).toString('hex').toUpperCase()}`;
    const steerMarker = `CODEX_PHONE_STEER_${randomBytes(8).toString('hex').toUpperCase()}`;
    generatedInputs.add(sleepMarker);
    generatedInputs.add(steerMarker);
    let controlTurn = '';
    await stage('active_bounded_sleep', async () => {
      controlTurn = await send(
        `Isolated connectivity test ${sleepMarker}. Use the shell tool to execute exactly /bin/sleep 20 once in the current directory. Do not read, create or edit files, access the network, or run any other command. After the sleep returns, reply exactly SLEEP_FINISHED. The test controller will send another instruction while the sleep is running.`,
      );
      await until(
        (value) =>
          value.thread.status === 'active' &&
          value.thread.activeTurnId === controlTurn &&
          peerSleepTurns.has(controlTurn),
      );
      return { peerObservedSleepCommandRunning: true, requestedSleepSeconds: 20 };
    });
    await stage('steer_active_turn', async () => {
      const steeredTurn = await send(
        `Steering acceptance marker ${steerMarker}. Continue the existing sleep; do not start another command. After it returns, reply exactly ${steerMarker} instead of the previous requested reply.`,
        controlTurn,
      );
      if (steeredTurn !== controlTurn)
        throw new AcceptanceError(
          'STEER_NEW_TURN',
          '追加指令返回了不同轮次，不能认定为真实 steer。',
        );
      await until(
        (value) =>
          value.thread.status === 'active' &&
          value.thread.activeTurnId === controlTurn &&
          (value.items.some(
            (item) =>
              item.role === 'user' &&
              item.turnId === controlTurn &&
              item.text.includes(steerMarker),
          ) ||
            (peerUserText.get(controlTurn) ?? '').includes(steerMarker)),
        6_000,
      );
      return { sameActiveTurn: true, peerObservedSteeringInput: true };
    });
    await stage('interrupt_own_turn', async () => {
      active();
      await primary!.interrupt(ownThreadId!, controlTurn);
      active();
      const terminal = await until(
        (value) =>
          value.thread.status !== 'active' &&
          value.items.some((item) => item.turnId === controlTurn && item.status === 'interrupted'),
        10_000,
      );
      if (!peerTerminalTurns.has(controlTurn))
        throw new AcceptanceError(
          'NO_PEER_INTERRUPT_EVENT',
          '历史显示停止，但第二连接没有观察到停止事件。',
        );
      return { peerObservedInterruptedEvent: true, terminalState: terminal.thread.status };
    });
    automatedPassed = true;
    report.result = 'passed';
  } catch (error) {
    stopping = true;
    const problem = failure(error);
    report.result = problem.blocked ? 'blocked' : 'failed';
    checks.push({
      name: currentStage,
      status: problem.blocked ? 'blocked' : 'failed',
      detail: problem.detail,
      evidence: { code: problem.code },
    });
    console.log(`[${problem.blocked ? 'BLOCKED' : 'FAIL'}] ${currentStage}: ${problem.code}`);
  } finally {
    stopping = true;
    // Cleanup may inspect only our unique directory/thread. It never lists or
    // resumes pre-existing sessions and never interrupts an unrecognized turn.
    if (ownThreadId && primary?.connection.connected) {
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            const value = await primary!.snapshot(ownThreadId!);
            for (const item of value.items)
              if (
                item.role === 'user' &&
                [...generatedInputs].some((marker) => item.text.includes(marker))
              )
                ownTurns.add(item.turnId);
            const activeTurn = value.thread.activeTurnId;
            if (value.thread.cwd !== workdir)
              throw new AcceptanceError(
                'CLEANUP_THREAD_MISMATCH',
                '停止清理：会话目录与本次测试不一致。',
              );
            if (value.thread.status === 'active') {
              if (!activeTurn || !ownTurns.has(activeTurn))
                throw new AcceptanceError(
                  'CLEANUP_UNKNOWN_TURN',
                  '无法确认活动轮次属于本次测试，未发送停止请求。',
                );
              await primary!.interrupt(ownThreadId!, activeTurn);
              const end = Date.now() + 8_000;
              let stopped = false;
              do {
                const after = await primary!.snapshot(ownThreadId!);
                if (after.thread.status !== 'active') {
                  stopped = true;
                  break;
                }
                await sleep(300);
              } while (Date.now() < end);
              if (!stopped)
                throw new AcceptanceError(
                  'CLEANUP_UNCONFIRMED',
                  '已发送停止请求，但未确认独立测试轮次结束。',
                );
            }
          })(),
          new Promise<never>((_, reject) => {
            cleanupTimer = setTimeout(
              () =>
                reject(
                  new AcceptanceError(
                    'CLEANUP_TIMEOUT',
                    '清理达到 12 秒上限，无法确认独立测试轮次停止。',
                  ),
                ),
              12_000,
            );
          }),
        ]);
        checks.push({
          name: 'cleanup',
          status: 'passed',
          detail: '已确认独立测试会话没有活动轮次。',
        });
      } catch (error) {
        checks.push({ name: 'cleanup', status: 'blocked', detail: failure(error).detail });
        report.result = 'blocked';
        automatedPassed = false;
      } finally {
        if (cleanupTimer) clearTimeout(cleanupTimer);
      }
    } else if (ownThreadId) {
      checks.push({
        name: 'cleanup',
        status: 'blocked',
        detail: '共享后端已断开，无法确认独立测试轮次停止；请在电脑检查该测试会话。',
      });
      report.result = 'blocked';
      automatedPassed = false;
    }
    primary?.close();
    peer?.close();
    if (ownThreadId) report.threadId = ownThreadId;
    report.createdThreads = ownThreadId ? 1 : 0;
    for (const name of [
      'connect_shared_backend',
      'create_isolated_thread',
      'primary_warmup_persistence',
      'peer_subscribe',
      'text_stream_and_history',
      'active_bounded_sleep',
      'steer_active_turn',
      'interrupt_own_turn',
    ]) {
      if (!checks.some((check) => check.name === name))
        checks.push({ name, status: 'blocked', detail: '前置检查未通过，未执行此项。' });
    }
    checks.push(
      {
        name: 'approval_routing',
        status: 'manual',
        detail: '没有修改全局或会话权限来强制产生审批；需人工验证真实审批、另一端处理及过期请求。',
      },
      {
        name: 'desktop_cli_process_sharing',
        status: 'manual',
        detail:
          '两个共享 socket 客户端不能证明 Desktop 和 CLI 进程操作完全同步，需在电脑查看本次测试会话。',
      },
      {
        name: 'phone_lan_funnel',
        status: 'manual',
        detail: '需真实手机分别验证局域网与 Funnel 登录、流式回复、锁屏及网络切换。',
      },
    );
    report.finishedAt = new Date().toISOString();
    report.elapsedMs = Date.now() - started;
    await mkdir(output, { recursive: true, mode: 0o700 });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    console.log(`报告：${relative(process.cwd(), reportPath)}`);
    console.log(
      automatedPassed
        ? '自动化真实后端检查通过；完整验收仍包含报告中的人工项目。'
        : '真实后端自动化检查未通过；未将阻塞或人工项目记为成功。',
    );
    process.removeListener('SIGINT', signal);
    process.removeListener('SIGTERM', signal);
    process.exitCode = automatedPassed ? 0 : 1;
  }
}

main().catch(() => {
  console.error('验收脚本未能完成或写入报告。');
  process.exitCode = 1;
});
