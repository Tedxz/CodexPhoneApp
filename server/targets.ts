import { basename, join, posix } from 'node:path';
import type { Capabilities, ConnectionState, GatewayEvent, Project } from '../shared/protocol.js';
import type { Config, SshTargetConfig } from './config.js';
import { CodexAdapter, CodexError } from './codex.js';
import { UploadStore } from './uploads.js';
import { SftpTransfer, SshTunnel, type TunnelState } from './ssh.js';

export interface TargetRuntime {
  id: string;
  name: string;
  kind: 'local' | 'ssh';
  projects: Project[];
  codex: CodexAdapter;
  uploads: UploadStore;
  readonly connection: ConnectionState;
  readonly capabilities: Capabilities;
  prepareImages(ids: string[]): Promise<string[]>;
}
export interface TargetManagerOptions {
  codexFactory?: (socketPath: string) => CodexAdapter;
  tunnelFactory?: (target: SshTargetConfig) => SshTunnel;
  transferFactory?: (target: SshTargetConfig) => SftpTransfer;
  /** Test-only deadline injection; no HTTP/config control. */
  imagePreparationTimeoutMs?: number;
}

class RemoteTarget implements TargetRuntime {
  readonly kind = 'ssh' as const;
  readonly id: string;
  readonly name: string;
  readonly projects: Project[];
  readonly codex: CodexAdapter;
  readonly uploads: UploadStore;
  private readonly tunnel: SshTunnel;
  private readonly transfer: SftpTransfer;
  private imageReady = false;
  private stopped = false;
  private generation = 0;
  private imageTimer?: NodeJS.Timeout;
  private backendTimer?: NodeJS.Timeout;
  private backendGeneration = 0;
  private backendReady = false;
  private backendFailed = false;
  private imageFailed = false;
  private preparing = new Map<string, Promise<void>>();
  private readonly imagePreparationTimeoutMs: number;
  constructor(
    private readonly config: SshTargetConfig,
    dataDir: string,
    options: TargetManagerOptions,
  ) {
    this.id = config.id;
    this.imagePreparationTimeoutMs = options.imagePreparationTimeoutMs ?? 30_000;
    this.name = config.name;
    this.projects = config.projects;
    this.tunnel = options.tunnelFactory?.(config) ?? new SshTunnel(config);
    this.transfer = options.transferFactory?.(config) ?? new SftpTransfer(config);
    this.codex =
      options.codexFactory?.(this.tunnel.socketPath) ??
      new CodexAdapter({ socketPath: this.tunnel.socketPath });
    this.uploads = new UploadStore(
      join(dataDir, 'targets', this.id),
      `/api/v1/targets/${this.id}/uploads`,
    );
    this.tunnel.on('state', this.onTunnelState);
    this.codex.on('event', this.onCodexEvent);
  }
  get connection(): ConnectionState {
    const state = this.tunnel.state;
    if (!state.ready)
      return {
        connected: false,
        sharedBackend: true,
        stage: state.stage,
        message: state.message,
        ...(state.errorCode ? { errorCode: state.errorCode } : {}),
      };
    const backend = this.codex.connection;
    return {
      ...backend,
      connected: backend.connected && this.backendReady,
      stage: backend.connected
        ? this.backendReady
          ? 'ready'
          : 'codex_checking'
        : 'codex_connecting',
      ...(backend.connected && !this.backendReady
        ? {
            message: this.backendFailed
              ? 'Codex 共享后端只读列表验证失败，请检查目标版本和权限'
              : 'Codex 已握手，正在验证共享会话列表',
            ...(this.backendFailed ? { errorCode: 'CODEX_PROTOCOL' } : {}),
          }
        : {}),
      ...(!backend.connected ? { errorCode: 'CODEX_UNAVAILABLE' } : {}),
      ...(backend.connected && this.backendReady && this.imageFailed
        ? {
            message: `${backend.message}；SFTP 图片传输暂不可用，正在重试`,
            errorCode: 'SFTP_UNAVAILABLE',
          }
        : {}),
    };
  }
  get capabilities(): Capabilities {
    return {
      ...this.codex.capabilities,
      images: this.connection.connected && this.codex.capabilities.images && this.imageReady,
      liveControl: this.connection.connected && this.codex.capabilities.liveControl,
    };
  }
  private changed(): void {
    this.codex.emit('event', { type: 'connection', connection: this.connection });
  }
  private readonly onCodexEvent = (event: GatewayEvent) => {
    // Runtime-generated status events have a stage and must not restart probes.
    if (event.type !== 'connection' || event.connection.stage !== undefined) return;
    const generation = ++this.backendGeneration;
    this.backendReady = false;
    this.backendFailed = false;
    if (this.backendTimer) clearTimeout(this.backendTimer);
    this.backendTimer = undefined;
    if (event.connection.connected && !this.stopped) void this.checkBackend(generation);
  };
  private async checkBackend(generation: number): Promise<void> {
    try {
      await this.codex.listThreads();
      if (this.stopped || generation !== this.backendGeneration) return;
      this.backendReady = true;
      this.backendFailed = false;
      this.changed();
    } catch {
      if (this.stopped || generation !== this.backendGeneration) return;
      this.backendFailed = true;
      this.changed();
      this.backendTimer = setTimeout(() => {
        this.backendTimer = undefined;
        void this.checkBackend(generation);
      }, 30_000);
      this.backendTimer.unref();
    }
  }
  private readonly onTunnelState = (state: TunnelState) => {
    const generation = ++this.generation;
    this.imageReady = false;
    this.imageFailed = false;
    if (this.imageTimer) clearTimeout(this.imageTimer);
    this.imageTimer = undefined;
    if (state.ready && !this.stopped) {
      void this.codex.connect().catch(() => {});
      if (this.config.uploadDir) void this.checkImages(generation);
    } else this.codex.close();
    this.changed();
  };
  private async checkImages(generation: number): Promise<void> {
    try {
      await this.transfer.probe();
      if (this.stopped || generation !== this.generation) return;
      // Only known, unreferenced uploads are eligible; never read arbitrary
      // remote history files or scan/remove other files in the directory.
      const cleanup = new AbortController();
      const cleanupTimer = setTimeout(() => cleanup.abort(), 5000);
      try {
        for (const entry of this.uploads.expiredRemoteUploads().slice(0, 4)) {
          if (cleanup.signal.aborted || this.stopped || generation !== this.generation) break;
          try {
            await this.transfer.remove(
              entry.remotePath ?? entry.remotePendingPath!,
              cleanup.signal,
            );
            this.uploads.remove(entry.id);
          } catch {
            /* Leave metadata for a later retry. */
          }
        }
      } finally {
        clearTimeout(cleanupTimer);
      }
      if (this.stopped || generation !== this.generation) return;
      this.imageReady = true;
      this.imageFailed = false;
      this.changed();
    } catch {
      if (this.stopped || generation !== this.generation) return;
      this.imageReady = false;
      this.imageFailed = true;
      this.changed();
      this.imageTimer = setTimeout(() => {
        this.imageTimer = undefined;
        void this.checkImages(generation);
      }, 30_000);
      this.imageTimer.unref();
    }
  }
  start(): void {
    this.tunnel.start();
  }
  async prepareImages(ids: string[]): Promise<string[]> {
    if (!ids.length) return [];
    if (!this.connection.connected)
      throw new CodexError('BACKEND_UNAVAILABLE', '该机器的 Codex 尚未连接');
    if (!this.config.uploadDir || !this.imageReady)
      throw new CodexError(
        'IMAGES_UNAVAILABLE',
        '该机器的 SFTP 图片传输尚不可用，请检查 uploadDir 和 SFTP 配置',
      );
    const entries = this.uploads.entries(ids);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.imagePreparationTimeoutMs);
    try {
      for (const entry of entries) {
        if (controller.signal.aborted)
          throw new CodexError('IMAGE_TRANSFER_TIMEOUT', '远端图片准备超时，尚未发送消息');
        if (entry.remotePath) continue;
        let pending = this.preparing.get(entry.id);
        if (!pending) {
          const remoteFile = posix.join(this.config.uploadDir, basename(entry.path));
          this.uploads.recordRemotePendingPath(entry.id, remoteFile);
          pending = this.transfer
            .upload(entry.path, remoteFile, controller.signal)
            .then(() => {
              this.uploads.recordRemotePath(entry.id, remoteFile);
            })
            .finally(() => {
              this.preparing.delete(entry.id);
            });
          this.preparing.set(entry.id, pending);
        }
        await pending;
      }
      if (controller.signal.aborted)
        throw new CodexError('IMAGE_TRANSFER_TIMEOUT', '远端图片准备超时，尚未发送消息');
      return this.uploads.attachRemote(ids);
    } catch (error) {
      this.imageReady = false;
      this.imageFailed = true;
      this.changed();
      if (!this.imageTimer && !this.stopped) {
        const generation = this.generation;
        this.imageTimer = setTimeout(() => {
          this.imageTimer = undefined;
          void this.checkImages(generation);
        }, 30_000);
        this.imageTimer.unref();
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async close(): Promise<void> {
    this.stopped = true;
    ++this.generation;
    if (this.imageTimer) clearTimeout(this.imageTimer);
    if (this.backendTimer) clearTimeout(this.backendTimer);
    this.tunnel.off('state', this.onTunnelState);
    this.codex.off('event', this.onCodexEvent);
    this.codex.close();
    await Promise.all([this.tunnel.close(), this.transfer.close()]);
  }
}

export class TargetManager {
  private readonly targets = new Map<string, TargetRuntime>();
  private readonly remotes: RemoteTarget[] = [];
  private started = false;
  constructor(config: Config, localAdapter?: CodexAdapter, options: TargetManagerOptions = {}) {
    const codex =
      localAdapter ??
      options.codexFactory?.(config.socketPath) ??
      new CodexAdapter({ socketPath: config.socketPath });
    const uploads = new UploadStore(config.dataDir);
    this.targets.set('local', {
      id: 'local',
      name: '本机',
      kind: 'local',
      projects: config.projects,
      codex,
      uploads,
      get connection() {
        return codex.connection;
      },
      get capabilities() {
        return codex.capabilities;
      },
      async prepareImages(ids) {
        return uploads.attach(ids);
      },
    });
    for (const target of config.sshTargets ?? []) {
      const runtime = new RemoteTarget(target, config.dataDir, options);
      this.remotes.push(runtime);
      this.targets.set(runtime.id, runtime);
    }
  }
  all(): TargetRuntime[] {
    return [...this.targets.values()];
  }
  get(id: string): TargetRuntime | undefined {
    return this.targets.get(id);
  }
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.targets
      .get('local')!
      .codex.connect()
      .catch(() => {});
    for (const target of this.remotes) target.start();
  }
  async close(): Promise<void> {
    this.targets.get('local')!.codex.close();
    await Promise.all(this.remotes.map((target) => target.close()));
  }
}
