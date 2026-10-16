import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, basename, join, posix } from 'node:path';
import { createHash } from 'node:crypto';
import type { Project } from '../shared/protocol.js';

export interface Config {
  host: string;
  port: number;
  publicUrl: string;
  allowedOrigins: string[];
  projects: Project[];
  socketPath: string;
  dataDir: string;
  tls?: { cert: string; key: string };
  sshTargets?: SshTargetConfig[];
}
export interface SshTargetConfig {
  id: string;
  name: string;
  sshHost: string;
  socketPath: string;
  projects: Project[];
  /** A dedicated remote directory. Omit to disable remote image uploads. */
  uploadDir?: string;
}
export function remotePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\0\r\n]/.test(value))
    throw new Error(`${label}必须为无控制字符的远端绝对路径`);
  return posix.normalize(value);
}
function sshTargets(value: unknown): SshTargetConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('sshTargets 必须为数组');
  const ids = new Set(['local']);
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('SSH 机器配置必须为对象');
    const target = entry as Record<string, unknown>;
    const id = target.id;
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) || ids.has(id))
      throw new Error('SSH 机器 ID 必须唯一、不能为 local，且仅包含小写字母、数字、短横线和下划线');
    ids.add(id);
    if (typeof target.name !== 'string' || !target.name.trim() || target.name.length > 80)
      throw new Error(`SSH 机器 ${id} 需要 80 字以内的名称`);
    if (
      typeof target.sshHost !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(target.sshHost)
    )
      throw new Error(`SSH 机器 ${id} 需要有效的 SSH Host 别名`);
    const socketPath = remotePath(target.socketPath, `${id} socketPath`);
    if (socketPath.includes(':')) throw new Error('SSH socketPath 不能包含冒号');
    if (!Array.isArray(target.projects)) throw new Error(`SSH 机器 ${id} 的 projects 必须为数组`);
    const projects = target.projects.map((raw: unknown) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('远端项目必须为对象');
      const entry = raw as Record<string, unknown>;
      const path = remotePath(entry.path, '远端项目路径');
      if (entry.name !== undefined && (typeof entry.name !== 'string' || !entry.name.trim()))
        throw new Error('远端项目名称必须为非空字符串');
      return {
        id: createHash('sha256').update(path).digest('hex').slice(0, 16),
        name: typeof entry.name === 'string' ? entry.name.trim() : posix.basename(path) || '/',
        path,
      };
    });
    const uploadDir =
      target.uploadDir === undefined ? undefined : remotePath(target.uploadDir, '远端图片目录');
    if (uploadDir === '/') throw new Error('远端图片目录必须为专用目录，不能为根目录');
    return {
      id,
      name: target.name.trim(),
      sshHost: target.sshHost,
      socketPath,
      projects,
      uploadDir,
    };
  });
}
function origin(value: string): string {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('访问地址必须是无路径、无凭据的 http(s) URL');
  return url.origin;
}
export function loadConfig(
  file = process.env.CODEX_PHONE_CONFIG || resolve('config.local.json'),
): Config {
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const host = raw.host ?? '127.0.0.1';
  const port = raw.port ?? 8787;
  if (typeof host !== 'string' || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('无效的 host 或 port');
  const publicUrl = origin(raw.publicUrl ?? `http://127.0.0.1:${port}`);
  const allowedOrigins = [
    ...new Set([
      publicUrl,
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      ...(raw.allowedOrigins ?? []).map(origin),
    ]),
  ];
  const projects: Project[] = (raw.projects ?? [{ path: process.cwd() }]).map(
    (entry: { path: string; name?: string }) => {
      const path = realpathSync(resolve(entry.path));
      if (!statSync(path).isDirectory()) throw new Error('项目路径必须是目录');
      return {
        id: createHash('sha256').update(path).digest('hex').slice(0, 16),
        name: entry.name || basename(path),
        path,
      };
    },
  );
  if (!projects.length) throw new Error('至少配置一个项目');
  return {
    host,
    port,
    publicUrl,
    allowedOrigins,
    projects,
    sshTargets: sshTargets(raw.sshTargets),
    socketPath: resolve(
      raw.socketPath ??
        join(
          process.env.CODEX_HOME || join(homedir(), '.codex'),
          'app-server-control/app-server-control.sock',
        ),
    ),
    dataDir: resolve(raw.dataDir ?? '.codex-phone'),
    tls: raw.tls ? { cert: resolve(raw.tls.cert), key: resolve(raw.tls.key) } : undefined,
  };
}
