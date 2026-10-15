import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { deviceInfo } from '@kit.BasicServicesKit';
import {
  Bootstrap, ClientType, Device, DevicePage, ErrorReply, ModelPage, PairReply,
  ThreadPage, ThreadSnapshot, UploadResult, WorkspacePage
} from '../model/Protocol';
import { extractSessionCookie, isSessionCookie, normalizeOrigin, safeImagePath } from './Endpoint';

interface ClientIdentityInput {
  clientKey: string;
  clientType: ClientType;
}

interface PairInput extends ClientIdentityInput {
  token: string;
  name: string;
}

interface GatewayHeaders {
  Accept: string;
  Origin: string;
  Cookie: string;
  'X-Codex-Phone': string;
  'Content-Type': string;
}

export class GatewayError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** One origin-bound cookie jar; never uses a system/global WebView cookie store. */
export class GatewayApi {
  readonly origin: string;
  cookie: string;

  constructor(serverUrl: string, cookie: string = '') {
    this.origin = normalizeOrigin(serverUrl);
    if (cookie && !isSessionCookie(cookie)) throw new GatewayError('登录凭据格式无效，请重新配对。', 401);
    this.cookie = cookie;
  }

  async pair(token: string, name: string, clientKey: string): Promise<Device> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token.trim())) throw new GatewayError('请填写电脑生成的有效配对凭据。', 400);
    if (!/^[A-Za-z0-9_-]{43}$/.test(clientKey)) throw new GatewayError('客户端身份无效，请重试。', 400);
    const body: PairInput = { token: token.trim(), name: name.trim().slice(0, 80) || 'HarmonyOS 手机', clientKey: clientKey, clientType: 'harmony' };
    const response = await this.request('/api/v1/pair', http.RequestMethod.POST, JSON.stringify(body));
    const cookie = extractSessionCookie(response.cookies || '') || extractSessionCookie(JSON.stringify(response.header));
    if (!cookie) throw new GatewayError('配对响应缺少登录凭据，请重新生成配对码后再试。', 502);
    const result = this.parse(this.responseText(response)) as PairReply;
    if (!result.device || !result.device.id) throw new GatewayError('配对响应格式无效，请重试。', 502);
    this.cookie = cookie;
    return result.device;
  }

  async bootstrap(): Promise<Bootstrap> {
    return this.parse(await this.json('/bootstrap')) as Bootstrap;
  }

  async identify(clientKey: string): Promise<Device> {
    if (!this.cookie) throw new GatewayError('请先登录，再识别当前客户端。', 401);
    if (!/^[A-Za-z0-9_-]{43}$/.test(clientKey)) throw new GatewayError('客户端身份无效，请重试。', 400);
    const body: ClientIdentityInput = { clientKey: clientKey, clientType: 'harmony' };
    const result = this.parse(await this.json('/devices/current/identify', http.RequestMethod.POST, JSON.stringify(body))) as PairReply;
    if (!result.device || !result.device.id) throw new GatewayError('客户端识别响应格式无效，请重试。', 502);
    return result.device;
  }

  async threads(search: string = '', cwd?: string, cursor?: string): Promise<ThreadPage> {
    let path = `/threads?search=${encodeURIComponent(search)}`;
    if (cwd !== undefined) path += `&cwd=${encodeURIComponent(cwd)}`;
    if (cursor) path += `&cursor=${encodeURIComponent(cursor)}`;
    return this.parse(await this.json(path)) as ThreadPage;
  }

  async workspaces(): Promise<WorkspacePage> {
    return this.parse(await this.json('/workspaces')) as WorkspacePage;
  }

  async snapshot(id: string, cursor?: string): Promise<ThreadSnapshot> {
    const path = `/threads/${encodeURIComponent(id)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
    return this.parse(await this.json(path)) as ThreadSnapshot;
  }

  async models(): Promise<ModelPage> {
    return this.parse(await this.json('/models')) as ModelPage;
  }

  async devices(): Promise<DevicePage> {
    return this.parse(await this.json('/devices')) as DevicePage;
  }

  async revoke(id: string): Promise<void> {
    await this.json(`/devices/${encodeURIComponent(id)}`, http.RequestMethod.DELETE);
  }

  async logout(): Promise<void> {
    await this.json('/logout', http.RequestMethod.POST, '{}');
    this.cookie = '';
  }

  async upload(bytes: ArrayBuffer, mime: string): Promise<UploadResult> {
    if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/webp') throw new GatewayError('请选择 PNG、JPEG 或 WebP 图片。', 400);
    if (bytes.byteLength === 0 || bytes.byteLength > 10 * 1024 * 1024) throw new GatewayError('单张图片不能超过 10 MiB。', 413);
    const response = await this.request('/api/v1/uploads', http.RequestMethod.POST, bytes, mime);
    return this.parse(this.responseText(response)) as UploadResult;
  }

  async image(path: string): Promise<ArrayBuffer> {
    if (!safeImagePath(path)) throw new GatewayError('图片地址不属于当前网关。', 400);
    const response = await this.request(path, http.RequestMethod.GET, undefined, '', true);
    if (!(response.result instanceof ArrayBuffer)) throw new GatewayError('图片响应格式无效。', 502);
    if (response.result.byteLength > 10 * 1024 * 1024) throw new GatewayError('图片超过大小限制。', 413);
    return response.result;
  }

  private async json(path: string, method: http.RequestMethod = http.RequestMethod.GET, body?: string): Promise<string> {
    return this.responseText(await this.request(`/api/v1${path}`, method, body));
  }

  private async request(path: string, method: http.RequestMethod, body?: string | ArrayBuffer, contentType: string = 'application/json', binary: boolean = false): Promise<http.HttpResponse> {
    const task = http.createHttp();
    let redirectBlocked = false;
    // Gateways serve these endpoints directly. On older systems, cancel when
    // a redirect header is observed; API 23+ also disables redirects natively.
    task.on('headersReceive', (headers: Object) => {
      if (/"location"\s*:/i.test(JSON.stringify(headers))) {
        redirectBlocked = true;
        task.destroy();
      }
    });
    const headers: GatewayHeaders = {
      Accept: binary ? 'image/png,image/jpeg,image/webp' : 'application/json',
      Origin: this.origin,
      Cookie: this.cookie,
      'X-Codex-Phone': '1',
      'Content-Type': contentType
    };
    const options: http.HttpRequestOptions = {
      method: method,
      header: headers,
      extraData: body,
      expectDataType: binary ? http.HttpDataType.ARRAY_BUFFER : http.HttpDataType.STRING,
      usingCache: false,
      connectTimeout: 15000,
      readTimeout: 60000,
      maxLimit: binary ? 10 * 1024 * 1024 : 5 * 1024 * 1024
    };
    if (deviceInfo.sdkApiVersion >= 23) options.maxRedirects = 0;
    try {
      const response = await task.request(`${this.origin}${path}`, options);
      if (redirectBlocked || (response.responseCode >= 300 && response.responseCode < 400)) {
        throw new GatewayError('网关地址发生跳转，请直接填写最终访问地址后重新配对。', 502);
      }
      if (response.responseCode < 200 || response.responseCode >= 300) {
        let message = `请求失败（${response.responseCode}）。`;
        try {
          const failure = JSON.parse(this.responseText(response)) as ErrorReply;
          message = failure.error?.message || failure.message || message;
        } catch { /* Keep the status if a reverse proxy returns HTML. */ }
        throw new GatewayError(message, response.responseCode);
      }
      return response;
    } catch (caught) {
      if (caught instanceof GatewayError) throw caught;
      if (redirectBlocked) throw new GatewayError('网关地址发生跳转，请填写最终地址。', 502);
      throw new GatewayError('无法连接电脑，请检查网关地址、局域网或 Tailscale 连接。', 0);
    } finally {
      task.destroy();
    }
  }

  private parse(text: string): Object {
    try {
      const parsed = JSON.parse(text) as Object;
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('invalid');
      return parsed;
    } catch {
      throw new GatewayError('网关响应格式无效，请检查访问地址后重试。', 502);
    }
  }

  private responseText(response: http.HttpResponse): string {
    if (typeof response.result === 'string') return response.result;
    if (response.result instanceof ArrayBuffer) return util.TextDecoder.create('utf-8').decodeToString(new Uint8Array(response.result));
    return JSON.stringify(response.result);
  }
}
