export interface ConnectionInput {
  origin: string;
  token: string;
}

function isPrivateHttpHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.local')) return true;
  if (host === '[::1]' || /^\[(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/.test(host)) return true;
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((part: string) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return false;
  const first = Number(parts[0]);
  const second = Number(parts[1]);
  return first === 10 || first === 127 ||
    (first === 192 && second === 168) || (first === 172 && second >= 16 && second <= 31) ||
    (first === 169 && second === 254) || (first === 100 && second >= 64 && second <= 127);
}

/** A gateway is an origin, never a URL containing credentials or an arbitrary path. */
export function normalizeOrigin(input: string): string {
  const value = input.trim().toLowerCase();
  const match = /^(https?):\/\/(\[[0-9a-f:]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([0-9]{1,5}))?\/?$/.exec(value);
  if (!match) throw new Error('请输入完整的 HTTPS 地址或局域网 HTTP 地址，不要包含账号、路径或查询参数。');
  const scheme = match[1];
  const host = match[2];
  const port = match[3] ? Number(match[3]) : undefined;
  if (port !== undefined && (port < 1 || port > 65535)) throw new Error('端口应为 1 至 65535。');
  if (scheme === 'http' && !isPrivateHttpHost(host)) throw new Error('公网访问请使用 HTTPS；HTTP 仅支持局域网、localhost 或 Tailscale 私网地址。');
  const portSuffix = port !== undefined && !((scheme === 'https' && port === 443) || (scheme === 'http' && port === 80)) ? `:${port}` : '';
  return `${scheme}://${host}${portSuffix}`;
}

/** Pairing tokens remain in the local fragment; no token is added to HTTP URLs. */
export function parseConnectionInput(input: string): ConnectionInput {
  const splitAt = input.indexOf('#');
  if (splitAt < 0) return { origin: normalizeOrigin(input), token: '' };
  const origin = normalizeOrigin(input.substring(0, splitAt));
  const fragment = input.substring(splitAt + 1);
  const match = /^pair=([A-Za-z0-9_-]{43})$/.exec(fragment);
  if (!match) throw new Error('配对链接格式不正确，请重新复制电脑生成的链接。');
  return { origin: origin, token: match[1] };
}

export function extractSessionCookie(raw: string): string {
  const match = /(?:^|[\s;,"\[])codex_phone=([A-Za-z0-9_-]{43})(?=$|[\s;,"\]])/.exec(raw);
  return match ? `codex_phone=${match[1]}` : '';
}

export function isSessionCookie(cookie: string): boolean {
  return /^codex_phone=[A-Za-z0-9_-]{43}$/.test(cookie);
}

export function safeImagePath(path: string): boolean {
  return /^\/api\/v1\/(?:targets\/[a-zA-Z0-9_-]+\/)?uploads\/[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9]+)?$/.test(path);
}
