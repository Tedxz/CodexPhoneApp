import { execFile } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { loadConfig } from '../server/config.js';
import { SftpTransfer, SshTunnel } from '../server/ssh.js';

const execFileAsync = promisify(execFile);
let failures = 0;
function report(kind: 'OK' | 'WARN' | 'FAIL', name: string, message: string) {
  if (kind === 'FAIL') failures++;
  console.log(`[${kind}] ${name}: ${message}`);
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN';
}

/** This probe never starts/resumes a thread or handles an approval. */
async function probe(socketPath: string) {
  const ws = new WebSocket(`ws+unix://${socketPath}:/`, {
    handshakeTimeout: 5_000,
    maxPayload: 8 * 1024 * 1024,
  });
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  function rejectAll(error: Error) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }
  ws.on('error', rejectAll);
  ws.on('close', () => rejectAll(new Error('CONNECTION_CLOSED')));
  ws.on('message', (data) => {
    let message: { id?: number; result?: unknown; error?: { code?: number } };
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(`RPC_${message.error.code ?? 'ERROR'}`));
    else request.resolve(message.result);
  });
  const request = (method: string, params?: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('RPC_TIMEOUT'));
      }, 5_000);
      pending.set(id, { resolve, reject, timer });
      ws.send(
        JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }),
        (error) => {
          if (!error) return;
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        },
      );
    });
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    report('OK', '共享 socket', 'WebSocket Upgrade 成功');
    await request('initialize', {
      clientInfo: { name: 'codex_phone_doctor', title: 'Codex Phone Doctor', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    ws.send(JSON.stringify({ method: 'initialized' }));
    report('OK', 'initialize', '协议握手成功');
    const probes = [
      ['thread/loaded/list', {}],
      ['thread/list', { limit: 1, useStateDbOnly: true }],
    ] as const;
    for (const [method, params] of probes) {
      try {
        const value = (await request(method, params)) as { data?: unknown[] };
        report(
          'OK',
          method,
          `只读查询成功${Array.isArray(value?.data) ? `，返回 ${value.data.length} 条` : ''}`,
        );
      } catch (error) {
        report('FAIL', method, error instanceof Error ? error.message : 'RPC_ERROR');
      }
    }
  } finally {
    rejectAll(new Error('DOCTOR_FINISHED'));
    ws.terminate();
  }
}

async function main() {
  console.log('Codex Phone 只读诊断（不启动后端、不恢复会话、不修改系统配置）');
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  report(major > 22 || (major === 22 && minor >= 13) ? 'OK' : 'FAIL', 'Node.js', process.version);
  const config = await loadConfig();
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--target'))
    throw new Error('用法：npm run doctor -- [--target local|机器ID]');
  const targetId = args[1];
  if (
    targetId &&
    targetId !== 'local' &&
    !config.sshTargets?.some((target) => target.id === targetId)
  )
    throw new Error(`未配置机器：${targetId}`);
  report('OK', '配置', `${config.host}:${config.port}；入口 ${config.publicUrl}`);
  try {
    await access(path.resolve('dist/index.html'));
    report('OK', '网页构建', 'dist/index.html 存在');
  } catch {
    report('FAIL', '网页构建', '请先运行 npm run build');
  }
  for (const project of !targetId || targetId === 'local' ? config.projects : []) {
    try {
      report((await stat(project.path)).isDirectory() ? 'OK' : 'FAIL', '项目目录', project.path);
    } catch {
      report('FAIL', '项目目录', `不存在或不可读：${project.path}`);
    }
  }
  if (config.tls) {
    for (const [name, file] of Object.entries(config.tls)) {
      try {
        await access(file);
        report('OK', `TLS ${name}`, '文件可读');
      } catch {
        report('FAIL', `TLS ${name}`, '文件不存在或不可读');
      }
    }
  }
  if (!targetId || targetId === 'local')
    try {
      const version = await execFileAsync('codex', ['--version'], {
        timeout: 5_000,
        maxBuffer: 16_384,
      });
      report('OK', 'Codex CLI', version.stdout.trim().split('\n')[0] || '可执行');
    } catch {
      report('WARN', 'Codex CLI', 'PATH 中不可执行；共享后端连接仍会独立检测');
    }
  if (!targetId || targetId === 'local')
    try {
      const socket = await stat(config.socketPath);
      if (!socket.isSocket()) {
        report('FAIL', '共享 socket', '配置路径不是 Unix socket');
        throw new Error('NOT_A_SOCKET');
      }
      report('OK', 'socket 文件', config.socketPath);
      await probe(config.socketPath);
    } catch (error) {
      const code = errorCode(error);
      const reason =
        code === 'EPERM' || code === 'EACCES'
          ? '当前进程无权访问共享 socket；请在运行 Codex 的同一用户终端执行诊断'
          : code === 'ENOENT'
            ? '未找到已有 control socket；确认电脑端 Codex 正在运行及 socketPath 配置'
            : code === 'ECONNREFUSED'
              ? 'socket 存在但没有监听进程'
              : error instanceof Error && /^(RPC_|CONNECTION_)/.test(error.message)
                ? error.message
                : '连接或协议探测失败';
      report('FAIL', '共享后端', `${code}：${reason}`);
    }
  for (const target of config.sshTargets ?? []) {
    if (targetId && targetId !== target.id) continue;
    console.log(`\n机器 ${target.name} (${target.id})：仅检查已有 SSH 与 Codex，不创建远端文件`);
    const tunnel = new SshTunnel(target);
    const transfer = new SftpTransfer(target);
    try {
      await new Promise<void>((resolve, reject) => {
        tunnel.on('state', (state) => {
          if (state.ready) resolve();
          else if (state.stage === 'ssh_error') reject(new Error(state.message));
        });
        tunnel.start();
      });
      report('OK', `${target.id} SSH`, '本地私有转发已建立；继续验证远端共享后端');
      await probe(tunnel.socketPath);
      for (const project of target.projects) {
        try {
          await transfer.probe([project.path]);
          report('OK', `${target.id} 项目目录`, project.path);
        } catch {
          report('FAIL', `${target.id} 项目目录`, `SFTP 不可用或远端目录不可进入：${project.path}`);
        }
      }
      if (target.uploadDir) {
        try {
          await transfer.probe();
          report(
            'OK',
            `${target.id} 图片传输`,
            'SFTP 可用；目录写入权限在上传时验证，诊断未创建目录或上传文件',
          );
        } catch {
          report('WARN', `${target.id} 图片传输`, 'SFTP 不可用，文字访问仍可独立工作');
        }
      } else report('WARN', `${target.id} 图片传输`, '未配置 uploadDir，远端图片上传已禁用');
    } catch (error) {
      report('FAIL', `${target.id} 共享后端`, error instanceof Error ? error.message : '连接失败');
    } finally {
      await Promise.all([tunnel.close(), transfer.close()]);
    }
  }
  console.log(
    '诊断通过仅证明握手和只读列表可用；实时追加、停止、审批同步及真机网络仍须按 docs/ACCEPTANCE.md 验证。',
  );
}

main()
  .catch((error: unknown) => {
    report('FAIL', '诊断', error instanceof Error ? error.message : '未知错误');
  })
  .finally(() => {
    process.exitCode = failures ? 1 : 0;
  });
