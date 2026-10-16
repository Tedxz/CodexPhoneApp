import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  Bootstrap,
  Device,
  ModelOption,
  SessionSettings,
  TargetSummary,
  ThreadSnapshot,
  ThreadSummary,
  WorkspaceSummary,
} from '../shared/protocol';
import { api, ApiError, LiveClient } from './api';
import {
  applyEvent,
  describeError,
  readDraft,
  storeDraft,
  SnapshotTracker,
  safeImageUrl,
} from './state';
import {
  loadTargetDirectory,
  readSelectedTarget,
  storeSelectedTarget,
  StaleTargetRequest,
  TargetRequestScope,
  targetPath,
  type TargetDirectory,
} from './targets';
import { Icon, Message, ModelControls, RequestCard } from './components';
import { ThreadBrowser } from './ThreadBrowser';
import { updateVisibleThreads } from './thread-browser';
import {
  browserIdentityPayload,
  clientTypeLabel,
  identifyBrowserSession,
  readBrowserIdentity,
} from './device-client';

const pairingFromUrl = new URLSearchParams(location.hash.slice(1)).get('pair') || '';
if (pairingFromUrl) history.replaceState(null, '', location.pathname + location.search);
interface Attachment {
  id: string;
  url: string;
  name: string;
}
interface BrowserQuery {
  mode: 'all' | 'workspaces';
  workspace: string | null;
  search: string;
}
const initialBrowserQuery: BrowserQuery = { mode: 'all', workspace: null, search: '' };
const timeLabel = (time: number) =>
  time
    ? new Intl.DateTimeFormat('zh-CN', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(time)
    : '';
const statusLabel = (thread: ThreadSummary) =>
  ({ active: '运行中', idle: '就绪', notLoaded: '历史会话', systemError: '需要关注' })[
    thread.status
  ];

export function App() {
  const [directory, setDirectory] = useState<TargetDirectory | null>(null);
  const [targetId, setTargetId] = useState(readSelectedTarget);
  const [directoryError, setDirectoryError] = useState('');
  const requestVersion = useRef(0);
  const attachmentStore = useRef(new Map<string, Map<string, Attachment[]>>());
  const refreshDirectory = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const next = await loadTargetDirectory();
      if (version !== requestVersion.current) return;
      setDirectory(next);
      setDirectoryError('');
    } catch (error) {
      if (version !== requestVersion.current) return;
      if (error instanceof ApiError && error.status === 401) {
        // No machine request is made before login. Discovery runs again after pairing.
        setDirectory((current) => current || { targets: [], legacy: true });
      } else setDirectoryError(describeError(error));
    }
  }, []);
  useEffect(() => {
    void refreshDirectory();
    const visible = () => {
      if (document.visibilityState === 'visible') void refreshDirectory();
    };
    const timer = setInterval(visible, 10000);
    document.addEventListener('visibilitychange', visible);
    return () => {
      requestVersion.current++;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refreshDirectory]);
  const chooseTarget = (id: string) => {
    storeSelectedTarget(id);
    setTargetId(id);
  };
  const selectedTarget = directory?.targets.find((target) => target.id === targetId);
  if (!directory || (directory.targets.length > 0 && !selectedTarget))
    return (
      <main className="pair-shell">
        <section className="pair-card">
          <h2>{directory ? '机器配置已变更' : '连接你的机器'}</h2>
          <p role="status">
            {directoryError ||
              (directory
                ? '上次使用的机器已不在当前网关配置中，请选择另一台机器。'
                : '正在读取机器列表…')}
          </p>
          {directory && (
            <TargetPicker targets={directory.targets} targetId="" onChange={chooseTarget} />
          )}
          <button className="secondary" onClick={() => void refreshDirectory()}>
            重新读取机器列表
          </button>
        </section>
      </main>
    );
  const currentId = directory.targets.length ? targetId : 'local';
  if (!attachmentStore.current.has(currentId)) attachmentStore.current.set(currentId, new Map());
  return (
    <TargetWorkspace
      key={`${directory.legacy ? 'legacy' : 'targets'}:${currentId}`}
      targetId={currentId}
      legacy={directory.legacy}
      targets={directory.targets}
      directoryError={directoryError}
      onChooseTarget={chooseTarget}
      onRefreshTargets={refreshDirectory}
      attachmentsByThread={attachmentStore.current.get(currentId)!}
    />
  );
}

function TargetPicker({
  targets,
  targetId,
  onChange,
}: {
  targets: TargetSummary[];
  targetId: string;
  onChange(id: string): void;
}) {
  const target = targets.find((item) => item.id === targetId);
  return (
    <label className="target-picker">
      <span>Codex 机器</span>
      <select
        aria-label="选择 Codex 机器"
        value={targetId}
        onChange={(event) => onChange(event.target.value)}
      >
        {!targetId && (
          <option value="" disabled>
            选择一台机器
          </option>
        )}
        {targets.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name} · {item.kind === 'ssh' ? 'SSH' : '本机'} ·{' '}
            {item.connection.connected ? '已连接' : item.connection.message}
          </option>
        ))}
      </select>
      {target && (
        <small title={target.connection.message}>
          <span
            className={`connection-dot ${target.connection.connected ? 'connected' : 'offline'}`}
          />{' '}
          {target.connection.message}
        </small>
      )}
    </label>
  );
}

function TargetWorkspace({
  targetId,
  legacy,
  targets,
  directoryError,
  onChooseTarget,
  onRefreshTargets,
  attachmentsByThread,
}: {
  targetId: string;
  legacy: boolean;
  targets: TargetSummary[];
  directoryError: string;
  onChooseTarget(id: string): void;
  onRefreshTargets(): Promise<void>;
  attachmentsByThread: Map<string, Attachment[]>;
}) {
  const [targetScope] = useState(() => new TargetRequestScope(targetId, legacy));
  const targetApi = useCallback(
    <T,>(path: string, options?: RequestInit) => targetScope.fetch<T>(path, options),
    [targetScope],
  );
  const loadWorkspaceThreads = useCallback(
    (cwd: string, cursor?: string) => {
      const params = new URLSearchParams({ cwd });
      if (cursor) params.set('cursor', cursor);
      return targetApi<{ data: ThreadSummary[]; nextCursor: string | null }>(`/threads?${params}`);
    },
    [targetApi],
  );
  const targetName = targets.find((target) => target.id === targetId)?.name || '本机';
  const authRevision = useRef(0);
  const refreshTask = useRef<Promise<void> | null>(null);
  const refreshAgain = useRef(false);
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [checked, setChecked] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [browserIdentity] = useState(readBrowserIdentity);
  const [identityNotice, setIdentityNotice] = useState(browserIdentity.notice);
  const [live, setLive] = useState(false);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [nextThreads, setNextThreads] = useState<string | null>(null);
  const [browserQuery, setBrowserQuery] = useState<BrowserQuery>(initialBrowserQuery);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [listBusy, setListBusy] = useState(false);
  const [listError, setListError] = useState('');
  const [snapshot, setSnapshot] = useState<ThreadSnapshot | null>(null);
  const [mobileChat, setMobileChat] = useState(false);
  const [loading, setLoading] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [settings, setSettings] = useState<SessionSettings>({});
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const attachmentDrafts = useRef(attachmentsByThread);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [olderBusy, setOlderBusy] = useState(false);
  const [modal, setModal] = useState<'new' | 'settings' | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [newProject, setNewProject] = useState('');
  const [newSettings, setNewSettings] = useState<SessionSettings>({});
  const [creating, setCreating] = useState(false);
  const [pairToken, setPairToken] = useState(pairingFromUrl);
  const [deviceName, setDeviceName] = useState(
    /iPhone|iPad/.test(navigator.userAgent)
      ? '我的 iPhone'
      : /Android/.test(navigator.userAgent)
        ? '我的 Android'
        : '我的浏览器',
  );
  const [pairing, setPairing] = useState(false);
  const snapshotRef = useRef<ThreadSnapshot | null>(null);
  const commitSnapshot = useCallback(
    (
      update: ThreadSnapshot | null | ((current: ThreadSnapshot | null) => ThreadSnapshot | null),
    ) => {
      const next = typeof update === 'function' ? update(snapshotRef.current) : update;
      snapshotRef.current = next;
      setSnapshot(next);
    },
    [],
  );
  const client = useRef<LiveClient | null>(null);
  const selected = useRef<string | null>(null);
  const tracker = useRef(new SnapshotTracker());
  const browserQueryRef = useRef(browserQuery);
  const loadListVersion = useRef(0);
  const timeline = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const ready = live && !!boot?.connection.connected;
  const setFailure = (e: unknown) => {
    if (!(e instanceof StaleTargetRequest)) setError(describeError(e));
  };
  const invalidateWorkspace = useCallback(() => {
    authRevision.current++;
    loadListVersion.current++;
    targetScope.invalidate();
    client.current?.close();
    client.current = null;
  }, [targetScope]);
  useEffect(() => () => invalidateWorkspace(), [invalidateWorkspace]);
  const chooseTarget = (id: string) => {
    if (id === targetId) return;
    if (selected.current) {
      storeDraft(selected.current, draft, targetId);
      attachmentDrafts.current.set(selected.current, attachments);
    }
    invalidateWorkspace();
    onChooseTarget(id);
  };
  const clearSession = useCallback(() => {
    invalidateWorkspace();
    refreshTask.current = null;
    refreshAgain.current = false;
    loadListVersion.current++;
    selected.current = null;
    commitSnapshot(null);
    setBoot(null);
    setAuthRequired(true);
    setLive(false);
    setThreads([]);
    setNextThreads(null);
    setWorkspaces([]);
    browserQueryRef.current = initialBrowserQuery;
    setBrowserQuery(initialBrowserQuery);
    setListBusy(false);
    setListError('');
    setAttachments([]);
    attachmentDrafts.current.clear();
    setDraft('');
    setModal(null);
    setLoading(false);
    setSending(false);
    setUploading(false);
    setOlderBusy(false);
    setCreating(false);
  }, [commitSnapshot, invalidateWorkspace]);

  const syncSnapshot = useCallback(async () => {
    const id = selected.current;
    const revision = authRevision.current;
    if (!id || !client.current) return;
    const incoming = await client.current.command<ThreadSnapshot>('thread.subscribe', {
      threadId: id,
    });
    if (selected.current !== id || revision !== authRevision.current) return;
    commitSnapshot((current) => tracker.current.reconcile(current, incoming));
  }, [commitSnapshot]);
  const loadThreads = useCallback(
    async (cursor?: string) => {
      const version = ++loadListVersion.current;
      const query = browserQueryRef.current;
      setListBusy(true);
      setListError('');
      try {
        if (query.mode === 'workspaces' && query.workspace === null) {
          const result = await targetApi<{ data: WorkspaceSummary[] }>('/workspaces');
          if (version === loadListVersion.current) setWorkspaces(result.data);
        } else {
          const params = new URLSearchParams({ search: query.search.trim().slice(0, 200) });
          if (query.mode === 'workspaces' && query.workspace !== null)
            params.set('cwd', query.workspace);
          if (cursor) params.set('cursor', cursor);
          const result = await targetApi<{ data: ThreadSummary[]; nextCursor: string | null }>(
            `/threads?${params}`,
          );
          if (version !== loadListVersion.current) return;
          setThreads((previous) =>
            cursor
              ? [...previous, ...result.data.filter((x) => !previous.some((y) => y.id === x.id))]
              : result.data,
          );
          setNextThreads(result.nextCursor);
        }
      } catch (e) {
        if (version !== loadListVersion.current) return;
        if (e instanceof ApiError && e.status === 401) clearSession();
        else setListError(describeError(e));
      } finally {
        if (version === loadListVersion.current) setListBusy(false);
      }
    },
    [clearSession, targetApi],
  );
  const changeBrowser = (next: BrowserQuery) => {
    const previous = browserQueryRef.current;
    if (
      previous.mode === next.mode &&
      previous.workspace === next.workspace &&
      previous.search === next.search
    )
      return;
    browserQueryRef.current = next;
    setBrowserQuery(next);
    // Folder search is local; all other changes invalidate old responses now,
    // before the debounce timer can start the next request.
    if (
      previous.mode === next.mode &&
      next.mode === 'workspaces' &&
      previous.workspace === null &&
      next.workspace === null
    )
      return;
    loadListVersion.current++;
    setThreads([]);
    setNextThreads(null);
    setListError('');
    setListBusy(!!boot?.connection.connected);
  };
  const refresh = useCallback(
    function runRefresh(): Promise<void> {
      if (refreshTask.current) {
        refreshAgain.current = true;
        return refreshTask.current;
      }
      const revision = authRevision.current;
      const pending = (async () => {
        const state = await targetApi<Bootstrap>('/bootstrap');
        if (revision !== authRevision.current) return;
        setBoot(state);
        if (state.connection.connected) {
          const results = await Promise.allSettled([
            loadThreads(),
            syncSnapshot(),
            targetApi<{ data: ModelOption[] }>('/models').then((x) => {
              if (revision === authRevision.current) setModels(x.data);
            }),
          ]);
          if (revision !== authRevision.current) return;
          const failed = results.find((x) => x.status === 'rejected');
          if (failed?.status === 'rejected') throw failed.reason;
        }
      })();
      refreshTask.current = pending;
      void pending
        .finally(() => {
          if (refreshTask.current === pending) {
            refreshTask.current = null;
            if (refreshAgain.current && revision === authRevision.current) {
              refreshAgain.current = false;
              void runRefresh().catch(setFailure);
            }
          }
        })
        .catch(() => {});
      return pending;
    },
    [loadThreads, syncSnapshot, targetApi],
  );
  useEffect(() => {
    let active = true;
    targetApi<Bootstrap>('/bootstrap')
      .then((state) => identifyBrowserSession(state, browserIdentity))
      .then((result) => {
        if (!active) return;
        setBoot(result.bootstrap);
        setIdentityNotice(result.notice);
      })
      .catch((e) => {
        if (!active) return;
        if (e instanceof ApiError && e.status === 401) setAuthRequired(true);
        else setFailure(e);
      })
      .finally(() => {
        if (active) setChecked(true);
      });
    return () => {
      active = false;
    };
  }, [browserIdentity, targetApi]);
  useEffect(() => {
    if (!boot?.device.id) return;
    let workspaceRefresh: ReturnType<typeof setTimeout> | undefined;
    tracker.current.reset();
    const connection = new LiveClient(
      {
        status: (connected) => setLive(connected),
        unauthorized: () => {
          clearSession();
          setNotice('设备登录已失效，请重新配对。');
        },
        resync: () => {
          void refresh().catch((e) => {
            if (e instanceof ApiError && e.status === 401) clearSession();
            else setFailure(e);
          });
        },
        event: (envelope) => {
          tracker.current.record(envelope);
          const event = envelope.event;
          if (event.type === 'connection') {
            setBoot((current) =>
              current ? { ...current, connection: event.connection } : current,
            );
            if (event.connection.connected) void refresh().catch(setFailure);
          }
          if (event.type === 'thread.changed') {
            setThreads((current) =>
              updateVisibleThreads(current, event.thread, browserQueryRef.current),
            );
            const query = browserQueryRef.current;
            if (query.mode === 'workspaces' && query.workspace === null && !workspaceRefresh) {
              workspaceRefresh = setTimeout(() => {
                workspaceRefresh = undefined;
                const latest = browserQueryRef.current;
                if (latest.mode === 'workspaces' && latest.workspace === null) void loadThreads();
              }, 1500);
            }
          }
          if (event.type === 'resync') {
            void refresh().catch(setFailure);
            return;
          }
          commitSnapshot((current) =>
            current?.eventCursor?.epoch === envelope.epoch &&
            envelope.seq <= current.eventCursor.seq
              ? current
              : applyEvent(current, event),
          );
        },
      },
      targetPath(targetId, '', legacy),
    );
    client.current = connection;
    connection.connect();
    const visible = () => {
      if (document.visibilityState === 'visible') void refresh().catch(setFailure);
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearTimeout(workspaceRefresh);
      connection.close();
      if (client.current === connection) client.current = null;
      document.removeEventListener('visibilitychange', visible);
    };
  }, [boot?.device.id, refresh, commitSnapshot, clearSession, loadThreads, targetId, legacy]);
  const threadSearch =
    browserQuery.mode === 'workspaces' && browserQuery.workspace === null
      ? ''
      : browserQuery.search;
  useEffect(() => {
    if (!boot?.connection.connected) {
      loadListVersion.current++;
      setListBusy(false);
      return;
    }
    const timer = setTimeout(() => {
      void loadThreads().catch(setFailure);
    }, 250);
    return () => clearTimeout(timer);
  }, [
    threadSearch,
    browserQuery.mode,
    browserQuery.workspace,
    boot?.connection.connected,
    loadThreads,
  ]);
  useEffect(() => {
    setSettings(snapshot?.settings || {});
  }, [
    snapshot?.thread.id,
    snapshot?.settings?.model,
    snapshot?.settings?.effort,
    snapshot?.settings?.mode,
  ]);
  useEffect(() => {
    if (nearBottom.current && timeline.current)
      timeline.current.scrollTop = timeline.current.scrollHeight;
  }, [snapshot?.items, snapshot?.pendingRequests]);

  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() =>
      document.querySelector<HTMLElement>('.modal input, .modal select, .modal button')?.focus(),
    );
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !creating) setModal(null);
      if (event.key !== 'Tab') return;
      const controls = [
        ...document.querySelectorAll<HTMLElement>(
          '.modal button:not([disabled]), .modal input:not([disabled]), .modal select:not([disabled])',
        ),
      ];
      const first = controls[0],
        last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', keydown);
      previous?.focus();
    };
  }, [modal, creating]);

  async function chooseThread(id: string) {
    if (selected.current) attachmentDrafts.current.set(selected.current, attachments);
    selected.current = id;
    commitSnapshot(null);
    setLoading(true);
    setMobileChat(true);
    setError('');
    setNotice('');
    setDraft(readDraft(id, targetId));
    setAttachments(attachmentDrafts.current.get(id) || []);
    nearBottom.current = true;
    try {
      await syncSnapshot();
    } catch (e) {
      setFailure(e);
    } finally {
      if (selected.current === id) setLoading(false);
    }
  }
  async function pair(event: FormEvent) {
    event.preventDefault();
    authRevision.current++;
    setPairing(true);
    setError('');
    try {
      await api('/pair', {
        method: 'POST',
        body: JSON.stringify({
          token: pairToken.trim(),
          name: deviceName,
          ...browserIdentityPayload(browserIdentity),
        }),
      });
      setPairToken('');
      const result = await identifyBrowserSession(
        await targetApi<Bootstrap>('/bootstrap'),
        browserIdentity,
      );
      setBoot(result.bootstrap);
      setIdentityNotice(result.notice);
      setNotice('');
      await onRefreshTargets();
    } catch (e) {
      setFailure(e);
    } finally {
      setPairing(false);
    }
  }
  async function createThread(event: FormEvent) {
    event.preventDefault();
    if (!client.current) return;
    const revision = authRevision.current;
    setCreating(true);
    setError('');
    try {
      const incoming = await client.current.command<ThreadSnapshot>('thread.create', {
        projectId: newProject || boot?.projects[0]?.id,
        ...newSettings,
      });
      if (revision !== authRevision.current) return;
      if (selected.current) attachmentDrafts.current.set(selected.current, attachments);
      selected.current = incoming.thread.id;
      commitSnapshot(tracker.current.reconcile(null, incoming));
      setDraft('');
      setAttachments([]);
      const query = browserQueryRef.current;
      if (query.mode === 'workspaces')
        changeBrowser({ mode: 'workspaces', workspace: incoming.thread.cwd, search: '' });
      else if (query.search) changeBrowser({ ...query, search: '' });
      setThreads((current) =>
        updateVisibleThreads(current, incoming.thread, browserQueryRef.current),
      );
      setModal(null);
      setMobileChat(true);
      nearBottom.current = true;
    } catch (e) {
      setFailure(e);
    } finally {
      setCreating(false);
    }
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!snapshot || !client.current || sending || uploading) return;
    const id = snapshot.thread.id;
    const revision = authRevision.current;
    const text = draft;
    const images = attachments;
    setSending(true);
    setError('');
    setNotice('');
    try {
      await client.current.command('turn.send', {
        threadId: id,
        text,
        imageIds: images.map((x) => x.id),
        ...(snapshot.thread.status === 'active'
          ? { expectedTurnId: snapshot.thread.activeTurnId }
          : settings),
      });
      if (revision !== authRevision.current) return;
      storeDraft(id, '', targetId);
      attachmentDrafts.current.delete(id);
      if (selected.current === id) {
        setDraft('');
        setAttachments([]);
        nearBottom.current = true;
        setNotice('消息已发送');
      }
      await syncSnapshot();
    } catch (e) {
      setFailure(e);
    } finally {
      setSending(false);
    }
  }
  async function upload(files: FileList | null) {
    if (!files?.length || !selected.current) return;
    const revision = authRevision.current;
    const id = selected.current;
    const existing = [...attachments];
    setUploading(true);
    setError('');
    try {
      if (existing.length + files.length > 8) throw new Error('每条消息最多添加 8 张图片。');
      for (const file of files) {
        if (
          !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
          file.size > 10 * 1024 * 1024
        )
          throw new Error('请选择 10 MB 以内的 PNG、JPEG 或 WebP 图片。');
        const image = await targetApi<{ id: string; url: string }>('/uploads', {
          method: 'POST',
          headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name) },
          body: file,
        });
        if (revision !== authRevision.current) return;
        if (!safeImageUrl(image.url, targetId)) throw new Error('网关返回了不属于当前机器的图片。');
        existing.push({ ...image, name: file.name });
        attachmentDrafts.current.set(id, [...existing]);
        if (selected.current === id) setAttachments([...existing]);
      }
    } catch (e) {
      setFailure(e);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }
  async function older() {
    if (!snapshot?.nextCursor) return;
    const id = snapshot.thread.id;
    const cursor = snapshot.nextCursor;
    const revision = authRevision.current;
    setOlderBusy(true);
    const before = timeline.current?.scrollHeight || 0;
    const scroll = timeline.current?.scrollTop || 0;
    try {
      const incoming = await targetApi<ThreadSnapshot>(
        `/threads/${encodeURIComponent(id)}?cursor=${encodeURIComponent(cursor)}`,
      );
      if (revision === authRevision.current && selected.current === id) {
        commitSnapshot((current) => tracker.current.reconcile(current, incoming, true));
        requestAnimationFrame(() => {
          if (revision === authRevision.current && selected.current === id && timeline.current)
            timeline.current.scrollTop = scroll + timeline.current.scrollHeight - before;
        });
      }
    } catch (e) {
      setFailure(e);
    } finally {
      setOlderBusy(false);
    }
  }
  async function openSettings() {
    const revision = authRevision.current;
    setModal('settings');
    try {
      if (boot && identityNotice && browserIdentity.clientKey) {
        const identified = await identifyBrowserSession(boot, browserIdentity);
        if (revision !== authRevision.current) return;
        setBoot(identified.bootstrap);
        setIdentityNotice(identified.notice);
      }
      const result = await api<{ data: Device[] }>('/devices');
      if (revision === authRevision.current) setDevices(result.data);
    } catch (e) {
      if (revision !== authRevision.current) return;
      if (e instanceof ApiError && e.status === 401) clearSession();
      else setFailure(e);
    }
  }
  async function revoke(device: Device) {
    if (!confirm(`撤销「${device.name}」的所有访问权限？该客户端的所有入口都需要重新配对。`))
      return;
    try {
      await api(`/devices/${device.id}`, { method: 'DELETE' });
      setDevices((current) => current.filter((x) => x.id !== device.id));
      if (device.id === boot?.device.id) clearSession();
    } catch (e) {
      setFailure(e);
    }
  }
  async function logout() {
    if (
      (boot?.device.authorizationCount || 0) > 1 &&
      !confirm('退出当前客户端？该客户端的所有入口授权都会失效，需要重新配对。')
    )
      return;
    try {
      await api('/logout', { method: 'POST' });
      clearSession();
    } catch (e) {
      setFailure(e);
    }
  }

  if (!checked)
    return (
      <main className="pair-shell">
        <div className="pair-card">
          <div className="spinner" />
          <p>正在连接你的工作空间…</p>
        </div>
      </main>
    );
  if (!boot && !authRequired)
    return (
      <main className="pair-shell">
        <section className="pair-card">
          <h2>暂时无法连接{targetName}</h2>
          <p className="error-banner" role="alert">
            {error || '正在恢复连接，请稍后重试。'}
          </p>
          <TargetPicker targets={targets} targetId={targetId} onChange={chooseTarget} />
          <button
            className="secondary"
            onClick={() => {
              void refresh().catch((error) => {
                if (error instanceof ApiError && error.status === 401) clearSession();
                else setFailure(error);
              });
              void onRefreshTargets();
            }}
          >
            重新连接
          </button>
        </section>
      </main>
    );
  if (!boot)
    return (
      <main className="pair-shell">
        <section className="pair-intro">
          <div className="brand">
            <span className="brand-mark">c/</span> Codex <span>随行</span>
          </div>
          <p className="eyebrow">YOUR WORK, WITH YOU</p>
          <h1>
            想法继续，
            <br />
            不必守在电脑前。
          </h1>
          <p className="subtitle">
            在手机上接续你的 Codex 会话。
            <br />
            任务留在电脑，进展随时可见。
          </p>
          <div className="pair-badge">
            <span className="connection-dot" /> 你的电脑 · 你的会话
          </div>
        </section>
        <section className="pair-card">
          <div className="pair-logo">
            <Icon name="arrow" />
          </div>
          <h2>连接你的电脑</h2>
          <p>扫描电脑生成的二维码，或输入一次性配对凭据。</p>
          <form onSubmit={pair}>
            <label className="form-field">
              客户端名称
              <input
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                maxLength={80}
                required
                autoComplete="off"
              />
            </label>
            <label className="form-field">
              配对凭据
              <input
                type="password"
                value={pairToken}
                onChange={(e) => setPairToken(e.target.value)}
                required
                autoComplete="off"
                spellCheck={false}
                placeholder="粘贴电脑上显示的配对凭据"
              />
            </label>
            {error && (
              <p className="error-banner" role="alert">
                {error}
              </p>
            )}
            {notice && <p className="notice">{notice}</p>}
            {identityNotice && (
              <p className="notice" role="status">
                {identityNotice}
              </p>
            )}
            <button className="primary" disabled={pairing || !pairToken.trim()}>
              {pairing ? '正在配对…' : '配对并进入'}
              <Icon name="arrow" />
            </button>
          </form>
          <div className="pair-footer">
            在电脑项目目录运行 <code>npm run pair</code>
            <br />
            凭据 5 分钟内有效，仅可使用一次。
          </div>
        </section>
      </main>
    );

  return (
    <div className={`app-shell ${mobileChat ? 'chat-open' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="brand">
            <span className="brand-mark">c/</span> Codex <span>随行</span>
          </div>
          <TargetPicker
            targets={targets.map((target) =>
              target.id === targetId ? { ...target, connection: boot.connection } : target,
            )}
            targetId={targetId}
            onChange={chooseTarget}
          />
          {directoryError && (
            <p className="target-directory-error" role="status">
              {directoryError}
            </p>
          )}
          <button
            className="new-thread"
            disabled={!ready}
            onClick={() => {
              setNewProject(
                boot.projects.find((project) => project.path === browserQuery.workspace)?.id ||
                  boot.projects[0]?.id ||
                  '',
              );
              setNewSettings({});
              setModal('new');
            }}
          >
            <Icon name="plus" /> 新建会话
          </button>
        </div>
        <ThreadBrowser
          targetId={targetId}
          loadWorkspaceThreads={loadWorkspaceThreads}
          mode={browserQuery.mode}
          workspace={browserQuery.workspace}
          workspaces={workspaces}
          threads={threads}
          search={browserQuery.search}
          loading={listBusy}
          error={listError}
          nextCursor={nextThreads}
          selectedId={selected.current}
          connected={boot.connection.connected}
          onModeChange={(mode) => changeBrowser({ mode, workspace: null, search: '' })}
          onWorkspaceChange={(workspace) =>
            changeBrowser({ mode: 'workspaces', workspace, search: '' })
          }
          onSearchChange={(search) => changeBrowser({ ...browserQueryRef.current, search })}
          onChooseThread={(id) => void chooseThread(id)}
          onLoadMore={() => {
            if (nextThreads && !listBusy) void loadThreads(nextThreads);
          }}
          onRetry={() => void loadThreads()}
        />
        <footer className="sidebar-foot">
          <button onClick={() => void openSettings()}>
            <span className={`connection-dot ${ready ? '' : 'offline'}`} />
            <span>
              {targetName} · {ready ? '已连接' : '等待连接'}
              <small>{boot.device.name}</small>
            </span>
            <Icon name="settings" />
          </button>
        </footer>
      </aside>
      <main className="main-panel">
        <header className="conversation-header">
          <button
            className="icon-button mobile-only"
            aria-label="返回会话列表"
            onClick={() => setMobileChat(false)}
          >
            <Icon name="back" />
          </button>
          <div className="header-title">
            <strong>{snapshot?.thread.title || '你的工作空间'}</strong>
            <span title={snapshot?.thread.cwd}>
              {targetName} · {snapshot?.thread.cwd || '随时接续，保持专注'}
            </span>
          </div>
          <div className="header-actions">
            <span className="connection-pill">
              <span className={`connection-dot ${ready ? '' : 'offline'}`} />
              {snapshot ? statusLabel(snapshot.thread) : ready ? '已连接' : '离线'}
            </span>
            <button
              className="icon-button"
              aria-label="刷新状态"
              onClick={() => {
                setError('');
                void refresh().catch(setFailure);
                void onRefreshTargets();
              }}
            >
              <Icon name="refresh" />
            </button>
            <button
              className="icon-button"
              aria-label="连接与客户端设置"
              onClick={() => void openSettings()}
            >
              <Icon name="settings" />
            </button>
          </div>
        </header>
        {!boot.connection.connected && (
          <div className="notice connecting" role="status">
            {boot.connection.message}。网关将自动重连。
          </div>
        )}
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button className="icon-button" aria-label="关闭错误提示" onClick={() => setError('')}>
              <Icon name="close" />
            </button>
          </div>
        )}
        {loading ? (
          <div className="empty-state">
            <div className="spinner" />
            <p>正在同步会话…</p>
          </div>
        ) : !snapshot ? (
          <div className="empty-state">
            <div className="hero-mark">c/</div>
            <p className="eyebrow">A LITTLE SPACE TO KEEP GOING</p>
            <h1>把下一步，带在身边。</h1>
            <p className="subtitle">
              打开一个会话，看看进展。
              <br />
              或者让一个新想法开始发生。
            </p>
            <button className="primary" disabled={!ready} onClick={() => setModal('new')}>
              <Icon name="plus" /> 新建会话
            </button>
          </div>
        ) : (
          <>
            <div
              className="timeline"
              ref={timeline}
              onScroll={() => {
                const el = timeline.current;
                if (el) nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
              }}
            >
              {snapshot.nextCursor && (
                <button
                  className="secondary history-button"
                  disabled={olderBusy}
                  onClick={() => void older()}
                >
                  {olderBusy ? '正在加载…' : '查看更早的消息'}
                </button>
              )}
              {snapshot.items.map((item) => (
                <Message item={item} targetId={targetId} key={item.id} />
              ))}
              {!snapshot.items.length && (
                <div className="empty-state compact">
                  <h2>一切从你的想法开始</h2>
                  <p>描述任务，或附上一张截图。</p>
                </div>
              )}
              {snapshot.warning && <p className="notice">{snapshot.warning}</p>}
              {snapshot.pendingRequests.map((request) => (
                <RequestCard
                  key={request.id}
                  request={request}
                  connected={ready}
                  answer={async (requestId, answer) => {
                    const revision = authRevision.current;
                    await client.current!.command('request.respond', { requestId, ...answer });
                    if (revision !== authRevision.current) return;
                    setNotice('回答已发送，等待电脑更新执行状态');
                    await syncSnapshot();
                  }}
                />
              ))}
              {snapshot.thread.status === 'active' && (
                <div className="working-indicator" role="status">
                  <span className="connection-dot" /> Codex 正在处理
                </div>
              )}
            </div>
            <form className="composer" onSubmit={send}>
              <ModelControls
                models={models}
                value={settings}
                onChange={setSettings}
                disabled={!ready || snapshot.thread.status === 'active' || sending}
                planAvailable={boot.capabilities.planMode}
              />
              {!!attachments.length && (
                <div className="attachment-list">
                  {attachments.map((image) => (
                    <div className="attachment" key={image.id}>
                      <img src={image.url} alt={image.name} />
                      <span>{image.name}</span>
                      <button
                        type="button"
                        aria-label={`移除 ${image.name}`}
                        disabled={sending || uploading}
                        onClick={() => {
                          const updated = attachments.filter((x) => x.id !== image.id);
                          setAttachments(updated);
                          attachmentDrafts.current.set(snapshot.thread.id, updated);
                        }}
                      >
                        <Icon name="close" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="composer-row">
                <textarea
                  aria-label="发送给 Codex 的消息"
                  value={draft}
                  placeholder={
                    snapshot.thread.status === 'active' ? '追加一条指令…' : '描述你想做的事…'
                  }
                  maxLength={64000}
                  rows={3}
                  disabled={sending}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    storeDraft(snapshot.thread.id, e.target.value, targetId);
                  }}
                  onKeyDown={(e) => {
                    if (
                      e.key === 'Enter' &&
                      (e.metaKey || e.ctrlKey) &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      e.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
                <div className="composer-tools">
                  <input
                    ref={fileInput}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    multiple
                    hidden
                    onChange={(e) => void upload(e.target.files)}
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="添加图片"
                    disabled={
                      !ready ||
                      !boot.capabilities.images ||
                      uploading ||
                      sending ||
                      attachments.length >= 8
                    }
                    onClick={() => fileInput.current?.click()}
                  >
                    <Icon name="image" />
                  </button>
                  <small>
                    {uploading
                      ? '正在上传…'
                      : snapshot.thread.status === 'active'
                        ? '追加到当前任务'
                        : '文字与图片'}
                  </small>
                  <div className="input-actions">
                    {snapshot.thread.activeTurnId && (
                      <button
                        type="button"
                        className="secondary"
                        disabled={!ready}
                        onClick={() => {
                          void client.current
                            ?.command('turn.interrupt', {
                              threadId: snapshot.thread.id,
                              turnId: snapshot.thread.activeTurnId,
                            })
                            .then(() => setNotice('停止请求已发送'))
                            .catch(setFailure);
                        }}
                      >
                        <Icon name="stop" /> 停止
                      </button>
                    )}
                    <button
                      className="send-button primary"
                      aria-label="发送消息"
                      disabled={
                        !ready ||
                        sending ||
                        uploading ||
                        (!draft.trim() && !attachments.length) ||
                        snapshot.thread.canAcceptDirectInput === false
                      }
                    >
                      {sending ? <span className="spinner" /> : <Icon name="send" />}
                    </button>
                  </div>
                </div>
              </div>
              <div className="composer-caption" role="status">
                {snapshot.thread.canAcceptDirectInput === false
                  ? '此会话暂不接受远程输入，请在电脑处理。'
                  : notice || '任务在你的电脑上运行。关闭页面不会停止任务。'}
              </div>
            </form>
          </>
        )}
      </main>
      {modal && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget && !creating) setModal(null);
          }}
        >
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
            <div className="modal-head">
              <div>
                <p className="eyebrow">{modal === 'new' ? 'START SOMETHING' : 'YOUR CONNECTION'}</p>
                <h2 id="modal-title">{modal === 'new' ? '新建会话' : '连接与客户端'}</h2>
              </div>
              <button
                className="icon-button"
                aria-label="关闭对话框"
                disabled={creating}
                onClick={() => setModal(null)}
              >
                <Icon name="close" />
              </button>
            </div>
            {modal === 'new' ? (
              <form onSubmit={createThread}>
                <label className="form-field">
                  {targetName}上的项目
                  <select
                    value={newProject || boot.projects[0]?.id || ''}
                    onChange={(e) => setNewProject(e.target.value)}
                  >
                    {boot.projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name} · {project.path}
                      </option>
                    ))}
                  </select>
                </label>
                <ModelControls
                  models={models}
                  value={newSettings}
                  onChange={setNewSettings}
                  planAvailable={boot.capabilities.planMode}
                  disabled={creating}
                />
                <p className="notice">在所选项目中开始新会话，权限沿用电脑设置。</p>
                {error && <p className="error-banner">{error}</p>}
                <div className="modal-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={creating}
                    onClick={() => setModal(null)}
                  >
                    取消
                  </button>
                  <button
                    className="primary"
                    disabled={creating || !ready || !boot.projects.length}
                  >
                    {creating ? '正在创建…' : '创建会话'}
                    <Icon name="arrow" />
                  </button>
                </div>
              </form>
            ) : (
              <div className="settings-panel">
                <div className="connection-pill">
                  <span className={`connection-dot ${ready ? '' : 'offline'}`} />
                  {boot.connection.message}
                </div>
                <p className="notice">
                  {location.origin} · {targetName}
                </p>
                <h3>已授权客户端</h3>
                {identityNotice && (
                  <p className="notice" role="status">
                    {identityNotice}
                  </p>
                )}
                {devices.map((device) => (
                  <div className="device-row" key={device.id}>
                    <div>
                      <strong>
                        {device.name}
                        {device.current ? ' · 当前客户端' : ''}
                      </strong>
                      <small>
                        {clientTypeLabel(device)}
                        {(device.authorizationCount || 0) > 1
                          ? ` · ${device.authorizationCount} 个入口授权`
                          : ''}
                      </small>
                      <small>
                        最近使用：{device.lastSeenAt ? timeLabel(device.lastSeenAt) : '暂无记录'}
                      </small>
                      <small>首次配对：{timeLabel(device.createdAt)}</small>
                      <small>到期：{timeLabel(device.expiresAt)}</small>
                    </div>
                    <button className="secondary" onClick={() => void revoke(device)}>
                      撤销
                    </button>
                  </div>
                ))}
                <p className="notice">
                  同一 App 重复配对会更新原记录。浏览器受存储范围限制，局域网地址与 Funnel
                  地址分别识别；App 与浏览器也分别显示。
                  旧版授权无法仅凭名称自动合并，可撤销不再使用的记录。
                </p>
                <p className="notice">
                  要添加客户端，请在电脑运行 <code>npm run pair</code>。
                </p>
                <p className="notice">撤销或退出会使该客户端的所有入口授权同时失效。</p>
                <button className="secondary danger" onClick={() => void logout()}>
                  退出当前客户端
                </button>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
