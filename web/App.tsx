import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  Bootstrap,
  Device,
  ModelOption,
  SessionSettings,
  ThreadSnapshot,
  ThreadSummary,
  WorkspaceSummary,
} from '../shared/protocol';
import { api, ApiError, LiveClient } from './api';
import { applyEvent, describeError, readDraft, storeDraft, SnapshotTracker } from './state';
import { Icon, Message, ModelControls, RequestCard } from './components';
import { ThreadBrowser } from './ThreadBrowser';
import { updateVisibleThreads } from './thread-browser';

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
  const authRevision = useRef(0);
  const refreshTask = useRef<Promise<void> | null>(null);
  const refreshAgain = useRef(false);
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
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
  const attachmentDrafts = useRef(new Map<string, Attachment[]>());
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
  const setFailure = (e: unknown) => setError(describeError(e));
  const clearSession = useCallback(() => {
    authRevision.current++;
    refreshTask.current = null;
    refreshAgain.current = false;
    loadListVersion.current++;
    selected.current = null;
    commitSnapshot(null);
    setBoot(null);
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
  }, [commitSnapshot]);

  const syncSnapshot = useCallback(async () => {
    const id = selected.current;
    if (!id || !client.current) return;
    const incoming = await client.current.command<ThreadSnapshot>('thread.subscribe', {
      threadId: id,
    });
    if (selected.current !== id) return;
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
          const result = await api<{ data: WorkspaceSummary[] }>('/workspaces');
          if (version === loadListVersion.current) setWorkspaces(result.data);
        } else {
          const params = new URLSearchParams({ search: query.search.trim().slice(0, 200) });
          if (query.mode === 'workspaces' && query.workspace !== null)
            params.set('cwd', query.workspace);
          if (cursor) params.set('cursor', cursor);
          const result = await api<{ data: ThreadSummary[]; nextCursor: string | null }>(
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
    [clearSession],
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
        const state = await api<Bootstrap>('/bootstrap');
        if (revision !== authRevision.current) return;
        setBoot(state);
        if (state.connection.connected) {
          const results = await Promise.allSettled([
            loadThreads(),
            syncSnapshot(),
            api<{ data: ModelOption[] }>('/models').then((x) => {
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
    [loadThreads, syncSnapshot],
  );
  useEffect(() => {
    let active = true;
    api<Bootstrap>('/bootstrap')
      .then((state) => {
        if (active) setBoot(state);
      })
      .catch((e) => {
        if (active && (!(e instanceof ApiError) || e.status !== 401)) setFailure(e);
      })
      .finally(() => {
        if (active) setChecked(true);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!boot?.device.id) return;
    let workspaceRefresh: ReturnType<typeof setTimeout> | undefined;
    tracker.current.reset();
    const connection = new LiveClient({
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
        if (event.type === 'connection')
          setBoot((current) => (current ? { ...current, connection: event.connection } : current));
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
          current?.eventCursor?.epoch === envelope.epoch && envelope.seq <= current.eventCursor.seq
            ? current
            : applyEvent(current, event),
        );
      },
    });
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
  }, [boot?.device.id, refresh, commitSnapshot, clearSession, loadThreads]);
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
    setDraft(readDraft(id));
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
        body: JSON.stringify({ token: pairToken.trim(), name: deviceName }),
      });
      setPairToken('');
      setBoot(await api<Bootstrap>('/bootstrap'));
      setNotice('');
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
      storeDraft(id, '');
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
        const image = await api<{ id: string; url: string }>('/uploads', {
          method: 'POST',
          headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name) },
          body: file,
        });
        if (revision !== authRevision.current) return;
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
    setOlderBusy(true);
    const before = timeline.current?.scrollHeight || 0;
    const scroll = timeline.current?.scrollTop || 0;
    try {
      const incoming = await api<ThreadSnapshot>(
        `/threads/${encodeURIComponent(id)}?cursor=${encodeURIComponent(cursor)}`,
      );
      if (selected.current === id) {
        commitSnapshot((current) => tracker.current.reconcile(current, incoming, true));
        requestAnimationFrame(() => {
          if (selected.current === id && timeline.current)
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
      const result = await api<{ data: Device[] }>('/devices');
      if (revision === authRevision.current) setDevices(result.data);
    } catch (e) {
      setFailure(e);
    }
  }
  async function revoke(device: Device) {
    if (!confirm(`撤销「${device.name}」的访问权限？`)) return;
    try {
      await api(`/devices/${device.id}`, { method: 'DELETE' });
      setDevices((current) => current.filter((x) => x.id !== device.id));
      if (device.id === boot?.device.id) clearSession();
    } catch (e) {
      setFailure(e);
    }
  }
  async function logout() {
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
              设备名称
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
              {ready ? '电脑已连接' : '等待连接'}
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
            <span>{snapshot?.thread.cwd || '随时接续，保持专注'}</span>
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
              }}
            >
              <Icon name="refresh" />
            </button>
            <button
              className="icon-button"
              aria-label="连接与设备设置"
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
                <Message item={item} key={item.id} />
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
                    await client.current!.command('request.respond', { requestId, ...answer });
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
                    storeDraft(snapshot.thread.id, e.target.value);
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
                <h2 id="modal-title">{modal === 'new' ? '新建会话' : '连接与设备'}</h2>
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
                  电脑上的项目
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
                <p className="notice">{location.origin}</p>
                <h3>已配对的设备</h3>
                {devices.map((device) => (
                  <div className="device-row" key={device.id}>
                    <div>
                      <strong>
                        {device.name}
                        {device.current ? ' · 当前' : ''}
                      </strong>
                      <small>到期：{timeLabel(device.expiresAt)}</small>
                    </div>
                    <button className="secondary" onClick={() => void revoke(device)}>
                      撤销
                    </button>
                  </div>
                ))}
                <p className="notice">
                  要添加另一台设备，请在电脑运行 <code>npm run pair</code>。
                </p>
                <button className="secondary danger" onClick={() => void logout()}>
                  退出当前设备
                </button>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
