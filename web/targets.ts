import type { Bootstrap, TargetSummary } from '../shared/protocol';
import { api, ApiError } from './api';

export interface TargetDirectory {
  targets: TargetSummary[];
  legacy: boolean;
}

export function targetPath(targetId: string, path: string, legacy = false): string {
  return legacy ? path : `/targets/${encodeURIComponent(targetId)}${path}`;
}

/** A failed directory request must never silently redirect operations to the local machine. */
export async function loadTargetDirectory(request: typeof api = api): Promise<TargetDirectory> {
  try {
    const result = await request<{ data: TargetSummary[] }>('/targets');
    if (!result.data?.some((target) => target.id === 'local'))
      throw new Error('网关返回的机器列表不完整，请刷新或检查网关版本。');
    return { targets: result.data, legacy: false };
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    const boot = await request<Bootstrap>('/bootstrap');
    return {
      legacy: true,
      targets: [
        {
          id: 'local',
          name: '本机',
          kind: 'local',
          connection: boot.connection,
          capabilities: boot.capabilities,
        },
      ],
    };
  }
}

export class StaleTargetRequest extends Error {
  constructor() {
    super('机器已切换，已忽略旧连接的响应。');
  }
}

/** Each mounted workspace owns one scope; invalidation also covers late HTTP errors. */
export class TargetRequestScope {
  private revision = 0;
  private controller = new AbortController();

  constructor(
    readonly targetId: string,
    readonly legacy = false,
    private request: typeof api = api,
  ) {}

  async fetch<T>(path: string, options: RequestInit = {}): Promise<T> {
    const revision = this.revision;
    try {
      const result = await this.request<T>(targetPath(this.targetId, path, this.legacy), {
        ...options,
        signal: this.controller.signal,
      });
      if (revision !== this.revision) throw new StaleTargetRequest();
      return result;
    } catch (error) {
      if (revision !== this.revision) throw new StaleTargetRequest();
      throw error;
    }
  }

  invalidate(): void {
    this.revision++;
    this.controller.abort();
    this.controller = new AbortController();
  }
}

export function readSelectedTarget(): string {
  try {
    return localStorage.getItem('codex-phone:selected-target:v1') || 'local';
  } catch {
    return 'local';
  }
}

export function storeSelectedTarget(targetId: string): void {
  try {
    localStorage.setItem('codex-phone:selected-target:v1', targetId);
  } catch {
    /* Choosing a machine does not require persistent storage. */
  }
}
