import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, basename, join } from 'node:path';
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
