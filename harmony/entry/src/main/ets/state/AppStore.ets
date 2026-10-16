import { util } from '@kit.ArkTS';
import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { fileIo } from '@kit.CoreFileKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { image } from '@kit.ImageKit';
import { Attachment, Bootstrap, Device, EventEnvelope, ModelOption, Project, QuestionAnswer, SessionSettings, ThreadSnapshot, ThreadSummary, WorkspaceSummary, TargetSummary, ConnectionState, Capabilities } from '../model/Protocol';
import { applyEvent, SnapshotTracker } from '../model/State';
import { GatewayApi, GatewayError } from '../transport/GatewayApi';
import { NativeLiveClient, LiveHandlers } from '../transport/NativeLiveClient';
import { ServerProfile, SessionVault } from '../transport/SessionVault';
import { parseConnectionInput, safeImagePath } from '../transport/Endpoint';

interface ThreadCommand { threadId: string }
interface CreateCommand extends SessionSettings { projectId: string }
interface SendCommand extends SessionSettings {
  threadId: string;
  text: string;
  imageIds: string[];
  expectedTurnId?: string;
}
interface InterruptCommand { threadId: string; turnId: string }
interface AnswerCommand { requestId: string; decision?: string; answers?: Record<string, string[]> }

@Observed
export class TargetEntry implements TargetSummary {
  id: string;
  name: string;
  kind: 'local' | 'ssh';
  connection: ConnectionState;
  capabilities: Capabilities;

  constructor(target: TargetSummary) {
    this.id = target.id;
    this.name = target.name;
    this.kind = target.kind;
    this.connection = target.connection;
    this.capabilities = target.capabilities;
  }

  update(target: TargetSummary): void {
    this.name = target.name;
    this.kind = target.kind;
    this.connection = target.connection;
    this.capabilities = target.capabilities;
  }
}

@Observed
export class ServerEntry {
  profile: ServerProfile;
  targets: TargetEntry[] = [];
  legacy: boolean = false;
  loading: boolean = false;
  error: string = '';
  checkedAt: number = 0;
  constructor(profile: ServerProfile) { this.profile = profile; }

  updateTargets(targets: TargetSummary[]): void {
    this.targets = targets.map((target: TargetSummary): TargetEntry => {
      const existing = this.targets.find((entry: TargetEntry) => entry.id === target.id);
      if (!existing) return new TargetEntry(target);
      existing.update(target);
      return existing;
    });
  }
}

@Observed
export class AppStore {
  servers: ServerEntry[] = [];
  serverName: string = '';
  editingServerId: string = '';
  activeServerId: string = '';
  activeTargetId: string = '';
  endpoint: string = '';
  pairToken: string = '';
  deviceName: string = '我的鸿蒙手机';
  checked: boolean = false;
  boot: Bootstrap | undefined = undefined;
  live: boolean = false;
  error: string = '';
  notice: string = '';
  busy: boolean = false;
  listBusy: boolean = false;
  loading: boolean = false;
  olderBusy: boolean = false;
  sending: boolean = false;
  uploading: boolean = false;
  screen: string = 'servers';
  mode: string = 'workspaces';
  workspace: string | null = null;
  search: string = '';
  threads: ThreadSummary[] = [];
  workspaces: WorkspaceSummary[] = [];
  nextThreads: string = '';
  snapshot: ThreadSnapshot | undefined = undefined;
  draft: string = '';
  attachments: Attachment[] = [];
  models: ModelOption[] = [];
  settings: SessionSettings = {};
  devices: Device[] = [];
  newProject: string = '';
  newSettings: SessionSettings = {};
  imageVersion: number = 0;
  onTimelineChanged: () => void = () => {};
  private selectionVersion: number = 0;
  private overviewTimer: number = -1;
  private overviewTask: Promise<void> | undefined = undefined;
  private catalogVersion: number = 0;
  private formVersion: number = 0;
  private switchVersion: number = 0;
  private foregroundActive: boolean = true;

  private context: common.UIAbilityContext | undefined = undefined;
  private drafts: preferences.Preferences | undefined = undefined;
  private vault: SessionVault = new SessionVault();
  private api: GatewayApi | undefined = undefined;
  private identifiedApi: GatewayApi | undefined = undefined;
  private readonly identityWarning: string = '客户端识别暂未完成，已有登录仍可使用；请稍后重新同步。';
  private client: NativeLiveClient | undefined = undefined;
  private tracker: SnapshotTracker = new SnapshotTracker();
  private selected: string = '';
  private listVersion: number = 0;
  private authVersion: number = 0;
  private searchTimer: number = -1;
  private workspaceTimer: number = -1;
  private draftTimer: number = -1;
  private refreshTask: Promise<void> | undefined = undefined;
  private refreshAgain: boolean = false;
  private attachmentDrafts: Map<string, Attachment[]> = new Map();
  private commandNotices: Map<string, string> = new Map();
  private imageCache: Map<string, string> = new Map();
  private imagePending: Set<string> = new Set();
  private foreground: () => void = () => this.onForeground();
  private background: () => void = () => {
    this.foregroundActive = false;
    clearTimeout(this.overviewTimer);
    void this.flushDraft();
  };

  get ready(): boolean { return this.live && this.boot?.connection.connected === true; }
  get hasSavedConnection(): boolean { return !!this.api?.cookie; }
  get projects(): Project[] { return this.boot?.projects || []; }
  get contextTitle(): string {
    const server = this.servers.find((item: ServerEntry) => item.profile.id === this.activeServerId);
    const target = server?.targets.find((item: TargetSummary) => item.id === this.activeTargetId);
    return `${server?.profile.name || this.api?.origin || ''} · ${target?.name || this.activeTargetId || '本机'}`;
  }

  async initialize(context: common.UIAbilityContext): Promise<void> {
    if (this.context) return;
    this.context = context;
    context.eventHub.on('codex:foreground', this.foreground);
    context.eventHub.on('codex:background', this.background);
    try {
      this.drafts = await preferences.getPreferences(context, 'codex_phone_drafts');
      this.servers = (await this.vault.list()).map((profile: ServerProfile) => new ServerEntry(profile));
      this.screen = this.servers.length > 0 ? 'servers' : 'pair';
      this.checked = true;
      await this.refreshOverview();
    } catch (caught) { await this.fail(caught as Error); }
    finally { this.checked = true; }
  }

  dispose(): void {
    void this.flushDraft();
    this.context?.eventHub.off('codex:foreground', this.foreground);
    this.context?.eventHub.off('codex:background', this.background);
    this.client?.close();
    this.foregroundActive = false;
    this.catalogVersion++;
    clearTimeout(this.overviewTimer);
    clearTimeout(this.searchTimer);
    clearTimeout(this.workspaceTimer);
    this.listVersion++;
    this.authVersion++;
  }

  onForeground(): void {
    this.foregroundActive = true;
    if (this.checked) void this.refreshOverview();
    this.client?.connect();
    void this.refresh();
  }

  editServer(id: string = ''): void {
    clearTimeout(this.overviewTimer);
    this.formVersion++;
    const profile = this.servers.find((item: ServerEntry) => item.profile.id === id)?.profile;
    this.editingServerId = id;
    this.serverName = profile?.name || '';
    this.endpoint = profile?.origin || '';
    this.deviceName = profile?.deviceName || this.deviceName;
    this.pairToken = '';
    this.error = '';
    this.screen = 'pair';
  }

  async saveServer(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const form = this.formVersion;
    try {
      const origin = parseConnectionInput(this.endpoint).origin;
      const previous = this.servers.find((entry: ServerEntry) => entry.profile.id === this.editingServerId)?.profile;
      if (this.servers.some((entry: ServerEntry) => entry.profile.origin === origin && entry.profile.id !== this.editingServerId)) {
        throw new Error('这个 Server 地址已经保存，请编辑已有连接。');
      }
      const sameOrigin = previous?.origin === origin;
      if (previous && !sameOrigin) throw new Error('更换地址请填写新地址的配对凭据，并点击“配对并保存”；配对成功前保留原连接。');
      const profile = new ServerProfile(sameOrigin ? previous!.id : util.generateRandomUUID(true), origin,
        sameOrigin ? previous!.cookie : '', this.deviceName, this.serverName, sameOrigin ? previous!.lastTargetId : 'local');
      await this.vault.saveProfile(profile);
      if (form !== this.formVersion) return;
      await this.replaceProfile(profile, previous);
      await this.showServers();
    } catch (caught) { if (form === this.formVersion) this.error = (caught as Error).message; }
    finally { if (form === this.formVersion) this.busy = false; }
  }

  private async replaceProfile(profile: ServerProfile, previous?: ServerProfile): Promise<void> {
    if (previous && previous.id !== profile.id) await this.vault.remove(previous.id);
    this.catalogVersion++;
    const existing = this.servers.find((entry: ServerEntry) => entry.profile.id === profile.id);
    if (existing) {
      existing.profile = profile;
      existing.error = '';
      this.servers = this.servers.slice();
    } else {
      this.servers = this.servers.filter((entry: ServerEntry) => entry.profile.id !== previous?.id).concat([new ServerEntry(profile)]);
    }
  }

  async removeServer(id: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.vault.remove(id);
      this.catalogVersion++;
      this.servers = this.servers.filter((entry: ServerEntry) => entry.profile.id !== id);
      if (this.activeServerId === id) await this.leaveContext();
      this.screen = 'servers';
      this.notice = '已从手机移除 Server。网关上的客户端授权可在对应 Server 中撤销。';
    } catch (caught) { this.error = (caught as Error).message; }
    finally { this.busy = false; }
  }

  async pair(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = '';
    this.notice = '';
    const form = this.formVersion;
    try {
      const input = parseConnectionInput(this.pairToken.trim().startsWith('http') ? this.pairToken.trim() : this.endpoint);
      const token = input.token || this.pairToken.trim();
      const name = this.serverName;
      const deviceName = this.deviceName;
      const previous = this.servers.find((entry: ServerEntry) => entry.profile.id === this.editingServerId)?.profile;
      const duplicate = this.servers.find((entry: ServerEntry) => entry.profile.origin === input.origin && entry.profile.id !== previous?.id);
      if (duplicate && previous) throw new Error('这个 Server 地址已经保存，请编辑已有连接。');
      const saved = await this.vault.loadOrigin(input.origin);
      const api = new GatewayApi(input.origin, saved?.cookie || '');
      const clientKey = await this.vault.clientKey();
      if (form !== this.formVersion) return;
      const device = await api.pair(token, deviceName, clientKey);
      if (form !== this.formVersion) return;
      const existing = previous?.origin === input.origin ? previous : duplicate?.profile;
      const profile = new ServerProfile(existing?.id || util.generateRandomUUID(true), api.origin, api.cookie,
        device.name, name || existing?.name || api.origin, existing?.lastTargetId || 'local');
      await this.vault.saveProfile(profile);
      if (form !== this.formVersion) return;
      this.endpoint = api.origin;
      this.pairToken = '';
      await this.replaceProfile(profile, previous);
      await this.showServers();
    } catch (caught) { if (form === this.formVersion) this.error = (caught as Error).message; }
    finally { if (form === this.formVersion) this.busy = false; }
  }

  async refreshOverview(): Promise<void> {
    if (!this.foregroundActive || this.screen !== 'servers') return;
    if (this.overviewTask) return this.overviewTask;
    clearTimeout(this.overviewTimer);
    const version = this.catalogVersion;
    const entries = this.servers.slice();
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < entries.length && this.foregroundActive && this.screen === 'servers' && version === this.catalogVersion) {
        const entry = entries[next++];
        await this.probeServer(entry, version);
      }
    };
    const task = Promise.all([worker(), worker(), worker(), worker()]).then(() => {});
    this.overviewTask = task;
    try { await task; }
    finally {
      if (this.overviewTask === task) {
        this.overviewTask = undefined;
        if (this.foregroundActive && this.screen === 'servers') this.overviewTimer = setTimeout(() => { void this.refreshOverview(); }, version === this.catalogVersion ? 10000 : 0);
      }
    }
  }

  private async probeServer(entry: ServerEntry, version: number): Promise<void> {
    if (!entry.profile.cookie) { entry.error = '需要配对'; this.servers = this.servers.slice(); return; }
    entry.loading = true;
    this.servers = this.servers.slice();
    const api = new GatewayApi(entry.profile.origin, entry.profile.cookie);
    try {
      let targets: TargetSummary[];
      let legacy = false;
      try { targets = (await api.targets()).data; }
      catch (caught) {
        if (!(caught instanceof GatewayError) || caught.status !== 404) throw caught as Error;
        const boot = await api.bootstrap(5000);
        targets = [{ id: 'local', name: '本机', kind: 'local', connection: boot.connection, capabilities: boot.capabilities }];
        legacy = true;
      }
      if (!Array.isArray(targets)) throw new Error('Server 机器列表格式无效。');
      if (version !== this.catalogVersion || !this.servers.includes(entry)) return;
      entry.updateTargets(targets);
      entry.legacy = legacy;
      entry.error = '';
      entry.checkedAt = Date.now();
    } catch (caught) {
      if (version !== this.catalogVersion || !this.servers.includes(entry)) return;
      entry.error = (caught as Error).message;
      if (caught instanceof GatewayError && caught.status === 401) {
        const profile = entry.profile;
        try { await this.vault.clear(profile.origin, api.cookie); }
        catch (failure) { entry.error = (failure as Error).message; return; }
        if (version !== this.catalogVersion || !this.servers.includes(entry)) return;
        entry.profile = new ServerProfile(profile.id, profile.origin, '', profile.deviceName, profile.name, profile.lastTargetId, profile.updatedAt);
        entry.error = '登录已失效，请重新配对';
      }
    } finally {
      if (version === this.catalogVersion && this.servers.includes(entry)) { entry.loading = false; this.servers = this.servers.slice(); }
    }
  }

  async chooseTarget(serverId: string, targetId: string): Promise<void> {
    const switching = ++this.switchVersion;
    clearTimeout(this.overviewTimer);
    const entry = this.servers.find((item: ServerEntry) => item.profile.id === serverId);
    if (!entry || !entry.targets.some((target: TargetSummary) => target.id === targetId)) return;
    if (!entry.profile.cookie) { this.editServer(serverId); return; }
    await this.leaveContext();
    if (switching !== this.switchVersion || !this.servers.includes(entry)) return;
    this.activeServerId = serverId;
    this.activeTargetId = targetId;
    this.endpoint = entry.profile.origin;
    this.screen = 'threads';
    const api = new GatewayApi(entry.profile.origin, entry.profile.cookie, targetId, entry.legacy);
    const revision = this.authVersion;
    try {
      await this.activate(api);
      if (this.api === api && switching === this.switchVersion) {
        const profile = entry.profile;
        const updated = new ServerProfile(profile.id, profile.origin, profile.cookie, profile.deviceName, profile.name, targetId);
        try { await this.vault.saveProfile(updated); }
        catch (caught) { if (this.api === api) this.notice = (caught as Error).message; }
        if (this.api === api && this.servers.includes(entry)) entry.profile = updated;
      }
    }
    catch (caught) { if (this.api === api && revision + 1 === this.authVersion) await this.fail(caught as Error); }
  }

  async showServers(): Promise<void> {
    const switching = ++this.switchVersion;
    this.formVersion++;
    await this.leaveContext();
    if (switching !== this.switchVersion) return;
    this.screen = 'servers';
    this.busy = false;
    void this.refreshOverview();
  }

  back(): void {
    if (this.screen === 'servers') return;
    if (this.screen === 'pair' || (this.screen === 'threads' && this.workspace === null)) { void this.showServers(); return; }
    if (this.screen === 'threads') { this.selectWorkspace(null); return; }
    this.backToThreads();
  }

  private async activate(api: GatewayApi): Promise<void> {
    this.authVersion++;
    this.client?.close();
    this.api = api;
    const revision = this.authVersion;
    const boot = await api.bootstrap();
    if (revision !== this.authVersion) return;
    await this.identifyClient(api, boot, revision);
    if (revision !== this.authVersion) return;
    this.boot = boot;
    this.deviceName = boot.device.name;
    this.newProject = boot.projects[0]?.id || '';
    this.screen = 'threads';
    this.tracker.reset();
    this.connectLive(api, revision);
    if (boot.connection.connected) await this.refresh();
  }

  private async identifyClient(api: GatewayApi, boot: Bootstrap, revision: number): Promise<void> {
    if (this.identifiedApi === api) return;
    try {
      const clientKey = await this.vault.clientKey();
      if (revision !== this.authVersion) return;
      const device = await api.identify(clientKey);
      if (revision !== this.authVersion) return;
      boot.device = device;
      this.identifiedApi = api;
      this.notice = this.notice.replace(this.identityWarning, '').trim();
    } catch (caught) {
      if (revision !== this.authVersion) return;
      if (caught instanceof GatewayError && caught.status === 404) {
        this.identifiedApi = api;
        return;
      }
      // Bootstrap has already authenticated this cookie. An identity migration
      // error must not erase it or turn a working legacy login into a logout.
      if (!this.notice.includes(this.identityWarning)) {
        this.notice = [this.notice, this.identityWarning].filter((value: string) => !!value).join('\n');
      }
    }
  }

  private connectLive(api: GatewayApi, revision: number): void {
    const handlers: LiveHandlers = {
      status: (connected: boolean) => { if (revision === this.authVersion) this.live = connected; },
      event: (envelope: EventEnvelope) => { if (revision === this.authVersion) this.receive(envelope); },
      resync: () => { if (revision === this.authVersion) void this.refresh(); },
      unauthorized: () => { if (revision === this.authVersion) void this.expired(); }
    };
    this.client = new NativeLiveClient(api, handlers);
    this.client.connect();
  }

  async refresh(): Promise<void> {
    if (!this.api || this.screen === 'servers') { await this.refreshOverview(); return; }
    if (this.refreshTask) { this.refreshAgain = true; return this.refreshTask; }
    const revision = this.authVersion;
    const task = this.refreshNow(revision);
    this.refreshTask = task;
    try { await task; }
    finally {
      if (this.refreshTask === task) {
        this.refreshTask = undefined;
        if (this.refreshAgain && revision === this.authVersion) {
          this.refreshAgain = false;
          void this.refresh();
        }
      }
    }
  }

  private async refreshNow(revision: number): Promise<void> {
    const api = this.api;
    if (!api) return;
    try {
      const boot = await api.bootstrap();
      if (revision !== this.authVersion) return;
      await this.identifyClient(api, boot, revision);
      if (revision !== this.authVersion) return;
      this.boot = boot;
      if (!boot.connection.connected) { this.listBusy = false; return; }
      await this.loadList();
      const models = await api.models();
      if (revision !== this.authVersion) return;
      this.models = models.data;
      if (this.selected && this.live) await this.syncSnapshot();
      if (!this.client) this.connectLive(api, revision);
    } catch (caught) { if (revision === this.authVersion) await this.fail(caught as Error); }
  }

  private receive(envelope: EventEnvelope): void {
    this.tracker.record(envelope);
    const event = envelope.event;
    if (event.type === 'connection' && event.connection && this.boot) {
      this.boot = { device: this.boot.device, projects: this.boot.projects, capabilities: this.boot.capabilities, connection: event.connection };
      if (!event.connection.connected) { this.listVersion++; this.listBusy = false; }
      else void this.refresh();
    }
    if (event.type === 'thread.changed' && event.thread) {
      const thread = event.thread;
      this.threads = [thread, ...this.threads.filter((item: ThreadSummary) => item.id !== thread.id)]
        .filter((item: ThreadSummary) => this.matches(item)).sort((a: ThreadSummary, b: ThreadSummary) => b.updatedAt - a.updatedAt);
      if (this.mode === 'workspaces' && this.workspace === null && this.workspaceTimer < 0) {
        this.workspaceTimer = setTimeout(() => {
          this.workspaceTimer = -1;
          if (this.mode === 'workspaces' && this.workspace === null) void this.loadList();
        }, 1500);
      }
    }
    if (event.type === 'resync') { void this.refresh(); return; }
    const cursor = this.snapshot?.eventCursor;
    if (!cursor || cursor.epoch !== envelope.epoch || envelope.seq > cursor.seq) {
      this.snapshot = applyEvent(this.snapshot, event);
      this.onTimelineChanged();
      if (event.type === 'item.updated') void this.cacheImages();
    }
  }

  private matches(thread: ThreadSummary): boolean {
    if (this.mode === 'workspaces' && this.workspace !== null && thread.cwd !== this.workspace) return false;
    if (this.mode === 'workspaces' && this.workspace === null) return true;
    return thread.title.toLowerCase().includes(this.search.trim().slice(0, 200).toLowerCase());
  }

  setMode(mode: string): void {
    this.mode = mode === 'all' ? 'all' : 'workspaces';
    this.workspace = null;
    this.search = '';
    this.invalidateList();
  }
  selectWorkspace(cwd: string | null): void {
    this.mode = 'workspaces';
    this.workspace = cwd;
    this.search = '';
    this.invalidateList();
  }
  setSearch(value: string): void {
    this.search = value;
    if (this.mode === 'workspaces' && this.workspace === null) return;
    this.invalidateList();
  }
  private invalidateList(): void {
    this.listVersion++;
    this.threads = [];
    this.nextThreads = '';
    this.error = '';
    clearTimeout(this.searchTimer);
    if (!this.boot?.connection.connected) { this.listBusy = false; return; }
    this.listBusy = true;
    this.searchTimer = setTimeout(() => { void this.loadList(); }, 250);
  }
  async loadMore(): Promise<void> {
    if (this.nextThreads && !this.listBusy) await this.loadList(this.nextThreads);
  }
  private async loadList(cursor?: string): Promise<void> {
    const api = this.api;
    if (!api || !this.boot?.connection.connected) { this.listBusy = false; return; }
    const version = ++this.listVersion;
    this.listBusy = true;
    try {
      if (this.mode === 'workspaces' && this.workspace === null) {
        const result = await api.workspaces();
        if (version === this.listVersion) this.workspaces = result.data;
      } else {
        const cwd = this.mode === 'workspaces' && this.workspace !== null ? this.workspace : undefined;
        const result = await api.threads(this.search.trim().slice(0, 200), cwd, cursor);
        if (version !== this.listVersion) return;
        this.threads = cursor ? [...this.threads, ...result.data.filter((item: ThreadSummary) => !this.threads.some((old: ThreadSummary) => old.id === item.id))] : result.data;
        this.nextThreads = result.nextCursor || '';
      }
    } catch (caught) { if (version === this.listVersion) await this.fail(caught as Error); }
    finally { if (version === this.listVersion) this.listBusy = false; }
  }

  async chooseThread(id: string): Promise<void> {
    const selection = ++this.selectionVersion;
    const revision = this.authVersion;
    await this.flushDraft();
    if (selection !== this.selectionVersion || revision !== this.authVersion) return;
    if (this.selected) this.attachmentDrafts.set(this.draftKey(this.selected), this.attachments);
    this.selected = id;
    this.snapshot = undefined;
    this.loading = true;
    this.screen = 'chat';
    this.error = '';
    this.notice = this.commandNotices.get(this.draftKey(id)) || '';
    this.draft = '';
    this.attachments = this.attachmentDrafts.get(this.draftKey(id)) || [];
    try {
      let draft = await this.drafts?.get(this.draftKey(id), '');
      if (!draft && this.activeTargetId === 'local') {
        const legacyKey = `${this.api?.origin || ''}|${id}`;
        draft = await this.drafts?.get(legacyKey, '');
        if (draft && selection === this.selectionVersion && revision === this.authVersion) {
          await this.drafts?.put(this.draftKey(id), draft);
          await this.drafts?.delete(legacyKey);
          await this.drafts?.flush();
        }
      }
      if (this.selected !== id || selection !== this.selectionVersion || revision !== this.authVersion) return;
      this.draft = typeof draft === 'string' ? draft : '';
      await this.syncSnapshot();
      const loaded = this.snapshot as ThreadSnapshot | undefined;
      if (this.selected === id && selection === this.selectionVersion && revision === this.authVersion) this.settings = loaded?.settings || {};
    } catch (caught) { if (selection === this.selectionVersion && revision === this.authVersion) await this.fail(caught as Error); }
    finally { if (selection === this.selectionVersion && revision === this.authVersion) this.loading = false; }
  }
  backToThreads(): void { this.screen = 'threads'; }
  private async syncSnapshot(cursor?: string): Promise<void> {
    const id = this.selected;
    if (!id || !this.client) return;
    const revision = this.authVersion;
    const selection = this.selectionVersion;
    const incoming = cursor ? await this.api!.snapshot(id, cursor) : await this.subscribeSnapshot(id, revision, selection);
    if (!incoming) return;
    if (this.selected !== id || revision !== this.authVersion || selection !== this.selectionVersion) return;
    this.snapshot = this.tracker.reconcile(this.snapshot, incoming, cursor !== undefined);
    if (!cursor) this.onTimelineChanged();
    void this.cacheImages();
  }

  private async subscribeSnapshot(id: string, revision: number, selection: number): Promise<ThreadSnapshot | undefined> {
    const client = this.client;
    if (!client) return undefined;
    const params: ThreadCommand = { threadId: id };
    for (let attempt = 0; attempt < 3; attempt++) {
      if (revision !== this.authVersion || selection !== this.selectionVersion || id !== this.selected || client !== this.client) return undefined;
      try {
        return JSON.parse(await client.command('thread.subscribe', JSON.stringify(params))) as ThreadSnapshot;
      } catch (caught) {
        if (revision !== this.authVersion || selection !== this.selectionVersion || id !== this.selected || client !== this.client) return undefined;
        const error = caught as Error;
        // A fresh Codex rollout can exist before its first metadata record is
        // flushed. Retry this read only; never replay a turn/send operation.
        const freshRollout = /^failed to read thread: thread-store internal error: failed to read session metadata [^\r\n]+: rollout at [^\r\n]+ is empty$/.test(error.message);
        if (!freshRollout) throw error;
        if (attempt === 2) throw new Error('会话历史暂未准备好，请稍后重新同步。');
        await new Promise<void>((resolve) => { setTimeout(() => resolve(), (attempt + 1) * 500); });
      }
    }
    return undefined;
  }
  async loadOlder(): Promise<void> {
    const cursor = this.snapshot?.nextCursor;
    if (!cursor || this.olderBusy) return;
    const revision = this.authVersion;
    this.olderBusy = true;
    try { await this.syncSnapshot(cursor); }
    catch (caught) { if (revision === this.authVersion) await this.fail(caught as Error); }
    finally { if (revision === this.authVersion) this.olderBusy = false; }
  }

  setDraft(value: string): void {
    this.draft = value;
    clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => { void this.flushDraft(); }, 400);
  }
  private draftKey(id: string): string { return `${this.activeServerId || this.api?.origin || ''}|${this.activeTargetId || 'local'}|${id}`; }
  private async flushDraft(): Promise<void> {
    clearTimeout(this.draftTimer);
    const id = this.selected;
    if (!id || !this.drafts) return;
    const key = this.draftKey(id);
    const text = this.draft;
    const revision = this.authVersion;
    try {
      await this.drafts.put(key, text);
      await this.drafts.flush();
    } catch { if (revision === this.authVersion) this.notice = '草稿暂未保存到手机，请保持当前页面。'; }
  }

  setModel(value: string): void {
    this.settings = { model: value || undefined, effort: undefined, mode: this.settings.mode };
  }
  setEffort(value: string): void {
    this.settings = { model: this.settings.model, effort: value || undefined, mode: this.settings.mode };
  }
  setSessionMode(value: string): void {
    this.settings = { model: this.settings.model, effort: this.settings.effort, mode: value === 'plan' ? 'plan' : 'default' };
  }

  async createThread(projectId: string): Promise<void> {
    if (!this.client || !this.ready || this.busy) return;
    this.busy = true;
    this.notice = '';
    this.error = '';
    const revision = this.authVersion;
    try {
      const command: CreateCommand = { projectId: projectId, model: this.newSettings.model, effort: this.newSettings.effort, mode: this.newSettings.mode };
      const incoming = JSON.parse(await this.client.command('thread.create', JSON.stringify(command))) as ThreadSnapshot;
      if (revision !== this.authVersion) return;
      await this.flushDraft();
      if (revision !== this.authVersion) return;
      if (this.selected) this.attachmentDrafts.set(this.draftKey(this.selected), this.attachments);
      this.selected = incoming.thread.id;
      this.snapshot = this.tracker.reconcile(undefined, incoming);
      this.draft = '';
      this.attachments = [];
      this.settings = incoming.settings || this.newSettings;
      this.search = '';
      if (this.mode === 'workspaces') this.workspace = incoming.thread.cwd;
      this.invalidateList();
      this.threads = [incoming.thread];
      this.screen = 'chat';
    } catch (caught) { if (revision === this.authVersion) await this.fail(caught as Error); }
    finally { if (revision === this.authVersion) this.busy = false; }
  }

  async send(): Promise<void> {
    const current = this.snapshot;
    if (!current || !this.client || !this.ready || this.sending || this.uploading) return;
    if (!this.draft.trim() && this.attachments.length === 0) return;
    const id = current.thread.id;
    const revision = this.authVersion;
    const draftKey = this.draftKey(id);
    const active = current.thread.status === 'active';
    const params: SendCommand = {
      threadId: id, text: this.draft, imageIds: this.attachments.map((attachment: Attachment) => attachment.id),
      expectedTurnId: active ? current.thread.activeTurnId : undefined,
      model: active ? undefined : this.settings.model,
      effort: active ? undefined : this.settings.effort,
      mode: active ? undefined : this.settings.mode
    };
    this.sending = true;
    this.error = '';
    let acknowledged = false;
    this.commandNotices.set(draftKey, '上次发送的结果尚未确认，请先同步会话，避免重复发送。');
    try {
      await this.client.command('turn.send', JSON.stringify(params));
      acknowledged = true;
      this.commandNotices.delete(draftKey);
      if (revision !== this.authVersion) {
        const saved = await this.drafts?.get(draftKey, '');
        if (saved === params.text) { await this.drafts?.delete(draftKey); await this.drafts?.flush(); }
        this.attachmentDrafts.delete(draftKey);
        return;
      }
      this.attachmentDrafts.delete(this.draftKey(id));
      if (this.selected === id) {
        if (this.draft === params.text) this.draft = '';
        this.attachments = this.attachments.filter((item: Attachment) => !params.imageIds.includes(item.id));
        await this.flushDraft();
        if (revision !== this.authVersion || this.selected !== id) return;
        this.notice = active ? '已追加到当前任务' : '消息已发送';
        await this.syncSnapshot();
      } else {
        const saved = await this.drafts?.get(this.draftKey(id), '');
        if (saved === params.text) {
          await this.drafts?.delete(this.draftKey(id));
          await this.drafts?.flush();
        }
      }
    } catch (caught) {
      if (revision !== this.authVersion) return;
      if (acknowledged) {
        this.error = '';
        this.notice = '消息已发送，会话暂未同步完成。请重新同步查看结果，不要重复发送。';
      } else await this.fail(caught as Error);
    }
    finally { if (revision === this.authVersion) this.sending = false; }
  }

  async interrupt(): Promise<void> {
    const thread = this.snapshot?.thread;
    const client = this.client;
    if (!thread?.activeTurnId || !client || !this.ready || this.busy) return;
    const revision = this.authVersion;
    this.busy = true;
    try {
      const params: InterruptCommand = { threadId: thread.id, turnId: thread.activeTurnId };
      await client.command('turn.interrupt', JSON.stringify(params));
      if (revision === this.authVersion && this.selected === thread.id) await this.syncSnapshot();
    } catch (caught) { if (revision === this.authVersion) await this.fail(caught as Error); }
    finally { if (revision === this.authVersion) this.busy = false; }
  }

  async answerRequest(id: string, decision: string, answers: QuestionAnswer[]): Promise<void> {
    const client = this.client;
    if (!client || !this.ready || this.busy) return;
    const revision = this.authVersion;
    const threadId = this.selected;
    this.busy = true;
    try {
      const values: Record<string, string[]> = {};
      answers.forEach((answer: QuestionAnswer) => { values[answer.id] = answer.answers; });
      const params: AnswerCommand = { requestId: id, decision: decision || undefined, answers: answers.length > 0 ? values : undefined };
      await client.command('request.respond', JSON.stringify(params));
      if (revision === this.authVersion && this.selected === threadId) await this.syncSnapshot();
    } catch (caught) { if (revision === this.authVersion) await this.fail(caught as Error); }
    finally { if (revision === this.authVersion) this.busy = false; }
  }

  async pickImages(): Promise<void> {
    const api = this.api;
    const id = this.selected;
    const revision = this.authVersion;
    if (!api || !id || this.uploading || !this.ready) return;
    if (this.attachments.length >= 8) { this.error = '每条消息最多添加 8 张图片。'; return; }
    this.uploading = true;
    try {
      const picker = new photoAccessHelper.PhotoViewPicker();
      const selection = await picker.select({ MIMEType: photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE, maxSelectNumber: 8 - this.attachments.length });
      let attachments = this.attachments.slice();
      for (const uri of selection.photoUris) {
        if (this.selected !== id || revision !== this.authVersion) break;
        const file = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY);
        let bytes = new ArrayBuffer(0);
        try {
          const size = fileIo.statSync(file.fd).size;
          if (size <= 0 || size > 10 * 1024 * 1024) throw new Error('请选择 10 MiB 以内的图片。');
          bytes = new ArrayBuffer(size);
          const read = fileIo.readSync(file.fd, bytes);
          if (read !== size) throw new Error('图片未读取完整，请重新选择。');
        } finally { fileIo.closeSync(file); }
        const header = new Uint8Array(bytes);
        let mime = header[0] === 0x89 && header[1] === 0x50 ? 'image/png' : header[0] === 0xff && header[1] === 0xd8 ? 'image/jpeg' : header[0] === 0x52 && header[8] === 0x57 ? 'image/webp' : '';
        if (!mime) {
          const source = image.createImageSource(bytes);
          const packer = image.createImagePacker();
          try { bytes = await packer.packToData(source, { format: 'image/jpeg', quality: 90 }); mime = 'image/jpeg'; }
          finally { await packer.release(); await source.release(); }
        }
        const uploaded = await api.upload(bytes, mime);
        if (this.selected !== id || revision !== this.authVersion) break;
        const attachment: Attachment = { id: uploaded.id, url: uploaded.url, name: `图片 ${attachments.length + 1}`, localUri: uri };
        attachments = [...attachments, attachment];
        this.attachments = attachments;
      }
    } catch (caught) { if (revision === this.authVersion) await this.fail(caught as Error); }
    finally { if (revision === this.authVersion) this.uploading = false; }
  }
  removeAttachment(id: string): void { this.attachments = this.attachments.filter((item: Attachment) => item.id !== id); }
  imageUrl(path: string): string { return this.imageCache.get(this.draftKey(path)) || ''; }
  imageHeaders(): Record<string, string> { return {}; }
  private async cacheImages(): Promise<void> {
    const api = this.api;
    const context = this.context;
    if (!api || !context) return;
    const revision = this.authVersion;
    for (const item of this.snapshot?.items || []) {
      for (const path of item.images || []) {
        const key = this.draftKey(path);
        const pendingKey = `${revision}|${key}`;
        if (!safeImagePath(path) || this.imageCache.has(key) || this.imagePending.has(pendingKey)) continue;
        this.imagePending.add(pendingKey);
        try {
          const bytes = await api.image(path);
          if (revision !== this.authVersion) return;
          const filePath = `${context.cacheDir}/codex-image-${util.generateRandomUUID(true)}`;
          const file = fileIo.openSync(filePath, fileIo.OpenMode.CREATE | fileIo.OpenMode.WRITE_ONLY | fileIo.OpenMode.TRUNC);
          try { fileIo.writeSync(file.fd, bytes); } finally { fileIo.closeSync(file); }
          this.imageCache.set(key, `file://${filePath}`);
          this.imageVersion++;
        } catch { /* The message remains readable if an image cannot be retrieved. */ }
        finally { this.imagePending.delete(pendingKey); }
      }
    }
  }

  async loadDevices(): Promise<void> {
    const api = this.api;
    if (!api) return;
    const revision = this.authVersion;
    try {
      const result = await api.devices();
      if (revision === this.authVersion) this.devices = result.data;
    } catch (caught) { if (revision === this.authVersion) await this.fail(caught as Error); }
  }
  async revokeDevice(id: string): Promise<void> {
    const api = this.api;
    if (!api || this.busy) return;
    const revision = this.authVersion;
    this.busy = true;
    try {
      await api.revoke(id);
      if (revision !== this.authVersion) return;
      if (id === this.boot?.device.id) await this.forget();
      else await this.loadDevices();
    } catch (caught) { if (revision === this.authVersion) await this.fail(caught as Error); }
    finally { if (revision === this.authVersion) this.busy = false; }
  }
  async logout(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = '';
    this.client?.close();
    this.live = false;
    let warning = '';
    const revision = this.authVersion;
    try { await this.api?.logout(); }
    catch { warning = '已清除本机登录。网关暂不可达，请在电脑上核对客户端是否已撤销。'; }
    if (revision !== this.authVersion) return;
    try { await this.forget(); this.notice = warning || '已退出登录。'; }
    catch (caught) { this.error = (caught as Error).message; }
    finally { this.busy = false; }
  }
  private async expired(): Promise<void> {
    const expected = this.authVersion + 1;
    try { await this.forget(); if (this.authVersion === expected) this.error = '客户端登录已失效，请重新配对。'; }
    catch (caught) { if (this.authVersion === expected) this.error = (caught as Error).message; }
  }
  private async forget(): Promise<void> {
    this.switchVersion++;
    const origin = this.api?.origin;
    const cookie = this.api?.cookie;
    await this.leaveContext();
    const revision = this.authVersion;
    if (origin) {
      await this.vault.clear(origin, cookie);
      this.servers = this.servers.map((entry: ServerEntry) => {
        if (entry.profile.origin !== origin || entry.profile.cookie !== cookie) return entry;
        const profile = entry.profile;
        entry.profile = new ServerProfile(profile.id, profile.origin, '', profile.deviceName, profile.name, profile.lastTargetId, profile.updatedAt);
        entry.error = '需要配对';
        return entry;
      });
    }
    if (revision === this.authVersion) this.screen = 'servers';
  }

  private async leaveContext(): Promise<void> {
    const draftSaved = this.flushDraft();
    if (this.selected) this.attachmentDrafts.set(this.draftKey(this.selected), this.attachments);
    this.authVersion++;
    this.listVersion++;
    this.selectionVersion++;
    this.client?.close();
    this.client = undefined;
    this.api = undefined;
    this.identifiedApi = undefined;
    this.boot = undefined;
    this.live = false;
    this.selected = '';
    this.snapshot = undefined;
    this.threads = [];
    this.workspaces = [];
    this.devices = [];
    this.nextThreads = '';
    this.draft = '';
    this.attachments = [];

    this.mode = 'workspaces';
    this.workspace = null;
    this.search = '';
    this.screen = 'servers';
    this.activeServerId = '';
    this.activeTargetId = '';
    this.models = [];
    this.settings = {};
    this.newSettings = {};
    this.error = '';
    this.notice = '';
    this.listBusy = false;
    this.loading = false;
    this.busy = false;
    this.olderBusy = false;
    this.sending = false;
    this.uploading = false;
    this.refreshTask = undefined;
    this.refreshAgain = false;
    this.tracker.reset();
    clearTimeout(this.searchTimer);
    clearTimeout(this.workspaceTimer);
    clearTimeout(this.draftTimer);
    this.workspaceTimer = -1;
    for (const uri of this.imageCache.values()) {
      try { fileIo.unlinkSync(uri.slice('file://'.length)); } catch { /* Cache may already have expired. */ }
    }
    this.imageCache.clear();
    this.imagePending.clear();
    this.imageVersion++;
    await draftSaved;
  }
  private async fail(error: Error): Promise<void> {
    if (error instanceof GatewayError && error.status === 401 && this.api?.cookie) { await this.expired(); return; }
    this.error = error.message || '操作失败，请重试。';
  }
}
