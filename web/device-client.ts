import type { Bootstrap, Device } from '../shared/protocol';
import { api, ApiError } from './api';

const identityStorageKey = 'codex-phone:browser-identity:v1';
const storageNotice =
  '浏览器无法保存客户端身份，重新配对可能新增旧版授权。请允许本站保存数据后刷新。';

export interface BrowserIdentity {
  clientKey?: string;
  notice: string;
}

interface IdentityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** A persisted installation identity is only a deduplication hint, never a login credential. */
export function createBrowserIdentityReader(
  storage: () => IdentityStorage = () => localStorage,
  random: (bytes: Uint8Array) => void = (bytes) => crypto.getRandomValues(bytes),
): () => BrowserIdentity {
  let result: BrowserIdentity | undefined;
  return () => {
    if (result) return result;
    try {
      const saved = storage();
      let clientKey = saved.getItem(identityStorageKey);
      if (!clientKey || !/^[A-Za-z0-9_-]{43}$/.test(clientKey)) {
        const bytes = new Uint8Array(32);
        random(bytes);
        clientKey = btoa(String.fromCharCode(...bytes))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');
        saved.setItem(identityStorageKey, clientKey);
        // Some restricted storage providers silently discard writes.
        if (saved.getItem(identityStorageKey) !== clientKey) throw new Error('Storage unavailable');
      }
      result = { clientKey, notice: '' };
    } catch {
      // Do not issue an ephemeral identity or keep creating random identities on retries.
      result = { notice: storageNotice };
    }
    return result;
  };
}

export const readBrowserIdentity = createBrowserIdentityReader();

export function browserIdentityPayload(identity: BrowserIdentity): {
  clientKey?: string;
  clientType?: 'browser';
} {
  return identity.clientKey ? { clientKey: identity.clientKey, clientType: 'browser' } : {};
}

/** Upgrade an existing cookie before opening the live connection, preserving all session data. */
export async function identifyBrowserSession(
  bootstrap: Bootstrap,
  identity: BrowserIdentity,
  identify: (payload: {
    clientKey: string;
    clientType: 'browser';
  }) => Promise<{ device: Device }> = (payload) =>
    api('/devices/current/identify', { method: 'POST', body: JSON.stringify(payload) }),
): Promise<{ bootstrap: Bootstrap; notice: string }> {
  if (!identity.clientKey) return { bootstrap, notice: identity.notice };
  try {
    const { device } = await identify({ clientKey: identity.clientKey, clientType: 'browser' });
    return { bootstrap: { ...bootstrap, device }, notice: '' };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) throw error;
    return {
      bootstrap,
      notice:
        error instanceof ApiError && error.status === 404
          ? '电脑端尚未支持客户端识别，请更新网关后刷新，重复配对才会归入同一客户端。'
          : '客户端身份暂未同步，当前登录仍可使用。请稍后刷新，或重新打开设置重试。',
    };
  }
}

export function clientTypeLabel(device: Device): string {
  return device.clientType === 'harmony'
    ? 'HarmonyOS App'
    : device.clientType === 'browser'
      ? '浏览器'
      : '旧版授权';
}
