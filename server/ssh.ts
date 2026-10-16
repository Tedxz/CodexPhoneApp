import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, chmodSync, lstatSync, rmSync } from 'node:fs';
import { basename, join, posix } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { SshTargetConfig } from './config.js';

export type CommandSpawner = (command: string, args: string[]) => ChildProcess;

// fd 3 is a lifeline, separate from sftp batch stdin. Even SIGKILL of the gateway
// closes this pipe and the supervisor terminates its SSH child. No shell parses args.
const supervisor = `
const { spawn } = require('node:child_process');
const { Socket } = require('node:net');
const child = spawn(process.argv[1], process.argv.slice(2), { stdio: 'inherit' });
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 1500).unref();
}
const life = new Socket({ fd: 3, readable: true, writable: false });
life.on('data', () => {});
life.on('end', stop);
life.on('error', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('error', () => { life.destroy(); process.exit(127); });
child.on('exit', (code) => { life.destroy(); process.exit(code == null ? 1 : code); });
`;
export const spawnManaged: CommandSpawner = (command, args) =>
  spawn(process.execPath, ['-e', supervisor, command, ...args], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

export function sshOptions(): string[] {
  return [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ConnectionAttempts=1',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ForwardX11=no',
    '-o',
    'PermitLocalCommand=no',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
  ];
}

export function sshFailure(stderr: string): { errorCode: string; message: string } {
  if (/host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr))
    return {
      errorCode: 'SSH_HOST_KEY',
      message: 'SSH 主机密钥未信任或已改变，请在 Server 上核对 known_hosts',
    };
  if (/permission denied|authentication failed|no supported authentication/i.test(stderr))
    return {
      errorCode: 'SSH_AUTH',
      message: 'SSH 免交互认证失败，请在 Server 上检查密钥或 ssh-agent',
    };
  if (/resolve hostname|name or service not known|nodename nor servname/i.test(stderr))
    return { errorCode: 'SSH_DNS', message: 'SSH 主机名无法解析，请检查 Server 的 SSH 配置' };
  if (/administratively prohibited|forwarding failed|cannot listen|cannot bind/i.test(stderr))
    return {
      errorCode: 'SSH_FORWARD',
      message: 'SSH 转发被拒绝，请检查目标机的 Unix socket 转发权限',
    };
  if (/subsystem request failed|sftp-server.*not found/i.test(stderr))
    return { errorCode: 'SFTP_UNAVAILABLE', message: '目标机不支持 SFTP，图片上传不可用' };
  return {
    errorCode: 'SSH_UNAVAILABLE',
    message: 'SSH 连接失败，请在 Server 上检查目标的连接和免交互认证',
  };
}

export interface TunnelState {
  ready: boolean;
  stage: 'ssh_connecting' | 'ssh_ready' | 'ssh_error' | 'stopped';
  message: string;
  errorCode?: string;
}
export interface TunnelOptions {
  spawn?: CommandSpawner;
  retryDelayMs?: number;
  connectTimeoutMs?: number;
  pollIntervalMs?: number;
}

export class SshTunnel extends EventEmitter {
  readonly directory: string;
  readonly socketPath: string;
  private child?: ChildProcess;
  private timer?: NodeJS.Timeout;
  private stopped = true;
  private attempt = 0;
  private generation = 0;
  private stateValue: TunnelState = { ready: false, stage: 'stopped', message: 'SSH 尚未连接' };
  constructor(
    readonly target: SshTargetConfig,
    private readonly options: TunnelOptions = {},
  ) {
    super();
    this.directory = mkdtempSync('/tmp/cxp-');
    chmodSync(this.directory, 0o700);
    this.socketPath = join(this.directory, 'c.sock');
  }
  get state(): TunnelState {
    return { ...this.stateValue };
  }
  private update(state: TunnelState): void {
    this.stateValue = state;
    this.emit('state', this.state);
  }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }
  private open(): void {
    if (this.stopped) return;
    const generation = ++this.generation;
    rmSync(this.socketPath, { force: true });
    this.update({ ready: false, stage: 'ssh_connecting', message: '正在建立 SSH 连接' });
    let stderr = '';
    let done = false;
    let timeout: NodeJS.Timeout | undefined;
    const fail = () => {
      if (done) return;
      done = true;
      if (timeout) clearTimeout(timeout);
      if (generation !== this.generation) return;
      this.child = undefined;
      if (this.stopped) return;
      this.update({ ready: false, stage: 'ssh_error', ...sshFailure(stderr) });
      const pause = Math.min((this.options.retryDelayMs ?? 1000) * 2 ** this.attempt++, 30_000);
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.open();
      }, pause);
      this.timer.unref();
    };
    try {
      const args = [
        ...sshOptions(),
        '-N',
        '-T',
        '-o',
        'ExitOnForwardFailure=yes',
        '-o',
        'StreamLocalBindMask=0177',
        '-o',
        'StreamLocalBindUnlink=yes',
        '-L',
        `${this.socketPath}:${this.target.socketPath}`,
        this.target.sshHost,
      ];
      const child = (this.child = (this.options.spawn ?? spawnManaged)('ssh', args));
      child.stdout?.resume();
      child.stderr?.on('data', (data) => {
        stderr = (stderr + String(data)).slice(-8192);
      });
      child.once('error', fail);
      child.once('exit', fail);
      timeout = setTimeout(() => {
        stderr = 'SSH connection timeout';
        child.kill('SIGTERM');
      }, this.options.connectTimeoutMs ?? 15_000);
      void (async () => {
        while (!done && generation === this.generation && !this.stopped) {
          try {
            if (lstatSync(this.socketPath).isSocket()) {
              clearTimeout(timeout);
              this.attempt = 0;
              this.update({
                ready: true,
                stage: 'ssh_ready',
                message: 'SSH 已连接，正在检查 Codex 共享后端',
              });
              return;
            }
          } catch {
            /* Forward socket is not bound yet. */
          }
          await delay(this.options.pollIntervalMs ?? 100);
        }
      })();
    } catch {
      fail();
    }
  }
  async close(): Promise<void> {
    this.stopped = true;
    ++this.generation;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const child = this.child;
    this.child = undefined;
    if (child) await stopChild(child);
    rmSync(this.directory, { force: true, recursive: true });
    this.update({ ready: false, stage: 'stopped', message: 'SSH 连接已关闭' });
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 2500);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

/** SFTP double quotes protect glob characters; only quotes/backslashes need
 * escaping inside them. Verified against the system OpenSSH SFTP subsystem. */
export function sftpQuote(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error('SFTP 路径不能包含控制字符');
  return '"' + value.replace(/[\\"]/g, '\\$&') + '"';
}

export class SftpTransfer {
  private children = new Set<ChildProcess>();
  private stopped = false;
  constructor(
    private readonly target: SshTargetConfig,
    private readonly spawnCommand: CommandSpawner = spawnManaged,
  ) {}
  async probe(paths: string[] = []): Promise<void> {
    await this.batch(['pwd', ...paths.map((path) => `cd ${sftpQuote(path)}`)]);
  }
  private async batch(lines: string[], signal?: AbortSignal): Promise<void> {
    if (this.stopped) throw new Error('SSH 图片传输已关闭');
    if (signal?.aborted) throw new Error('远端图片准备超时，尚未发送消息');
    await new Promise<void>((resolve, reject) => {
      const child = this.spawnCommand('sftp', [
        ...sshOptions(),
        '-o',
        'ClearAllForwardings=yes',
        '-b',
        '-',
        this.target.sshHost,
      ]);
      this.children.add(child);
      let stderr = '';
      const abort = () => {
        child.kill('SIGTERM');
        reject(new Error('远端图片传输超时，尚未发送消息'));
      };
      const timer = setTimeout(abort, 25_000);
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout?.resume();
      child.stderr?.on('data', (data) => {
        stderr = (stderr + String(data)).slice(-8192);
      });
      child.once('error', () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.children.delete(child);
        reject(new Error('无法运行系统 SFTP'));
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.children.delete(child);
        if (code === 0) resolve();
        else reject(new Error(`远端图片传输失败，尚未发送消息：${sshFailure(stderr).message}`));
      });
      child.stdin?.on('error', () => {});
      child.stdin?.end(lines.join('\n') + '\n');
    });
  }
  async upload(localPath: string, remoteFile: string, signal?: AbortSignal): Promise<void> {
    const root = this.target.uploadDir;
    if (
      !root ||
      posix.dirname(remoteFile) !== root ||
      !/^[a-f0-9-]{36}\.(png|jpg|webp)$/.test(posix.basename(remoteFile))
    )
      throw new Error('远端图片路径必须位于此机器的专用上传目录');
    const part = remoteFile + '.part';
    const directories = root
      .split('/')
      .filter(Boolean)
      .map((_, index, parts) => '/' + parts.slice(0, index + 1).join('/'));
    // Existing ancestors are untouched; only the dedicated leaf is chmodded.
    // Every mkdir error is followed by mandatory chmod/cd before any upload.
    try {
      await this.batch(
        [
          ...directories.map((directory) => `-mkdir ${sftpQuote(directory)}`),
          `chmod 700 ${sftpQuote(root)}`,
          `cd ${sftpQuote(root)}`,
          `put -p ${sftpQuote(localPath)} ${sftpQuote(part)}`,
          `chmod 600 ${sftpQuote(part)}`,
          `rename ${sftpQuote(part)} ${sftpQuote(remoteFile)}`,
        ],
        signal,
      );
    } catch (error) {
      try {
        if (!signal?.aborted) await this.batch([`-rm ${sftpQuote(part)}`], signal);
      } catch {
        /* Retry on the next transfer. */
      }
      throw error;
    }
  }
  async remove(remoteFile: string, signal?: AbortSignal): Promise<void> {
    if (
      !this.target.uploadDir ||
      posix.dirname(remoteFile) !== this.target.uploadDir ||
      !/^[a-f0-9-]{36}\.(png|jpg|webp)$/.test(basename(remoteFile))
    )
      throw new Error('不能清理网关上传目录之外的文件');
    await this.batch(
      [`-rm ${sftpQuote(remoteFile + '.part')}`, `-rm ${sftpQuote(remoteFile)}`],
      signal,
    );
  }
  async close(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.children].map(stopChild));
    this.children.clear();
  }
}
