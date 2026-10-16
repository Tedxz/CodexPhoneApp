import type { ThreadSummary, WorkspaceSummary } from '../shared/protocol';
import { Icon } from './components';
import { workspaceName, type ThreadBrowserMode } from './thread-browser';
import { useEffect, useRef, useState } from 'react';
import {
  isWorkspaceWithin,
  parseWorkspacePins,
  workspacePathLabel,
  workspacePinsKey,
  workspaceBottomKey,
  workspaceBottomRoot,
  workspaceBottomTreesKey,
  workspaceSections,
} from './workspaces';

interface ThreadBrowserProps {
  targetId: string;
  loadWorkspaceThreads: WorkspaceLoader;
  mode: ThreadBrowserMode;
  workspace: string | null;
  workspaces: WorkspaceSummary[];
  threads: ThreadSummary[];
  search: string;
  loading: boolean;
  error: string;
  nextCursor: string | null;
  selectedId: string | null;
  connected: boolean;
  onModeChange: (mode: ThreadBrowserMode) => void;
  onWorkspaceChange: (cwd: string | null) => void;
  onSearchChange: (search: string) => void;
  onChooseThread: (id: string) => void;
  onLoadMore: () => void;
  onRetry: () => void;
}

const timeLabel = (time: number) =>
  time
    ? new Intl.DateTimeFormat('zh-CN', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(time)
    : '';

export function ThreadBrowser({
  targetId,
  loadWorkspaceThreads,
  mode,
  workspace,
  workspaces,
  threads,
  search,
  loading,
  error,
  nextCursor,
  selectedId,
  connected,
  onModeChange,
  onWorkspaceChange,
  onSearchChange,
  onChooseThread,
  onLoadMore,
  onRetry,
}: ThreadBrowserProps) {
  const storageKey = workspacePinsKey(location.origin, targetId);
  const [pins, setPins] = useState<string[]>(() => {
    try {
      return parseWorkspacePins(localStorage.getItem(storageKey) || '[]');
    } catch {
      return [];
    }
  });
  const bottomKey = workspaceBottomKey(location.origin, targetId);
  const [bottom, setBottom] = useState<string[]>(() => {
    try {
      return parseWorkspacePins(localStorage.getItem(bottomKey) || '[]');
    } catch {
      return [];
    }
  });
  const bottomTreesKey = workspaceBottomTreesKey(location.origin, targetId);
  const [bottomTrees, setBottomTrees] = useState<string[]>(() => {
    try {
      return parseWorkspacePins(localStorage.getItem(bottomTreesKey) || '[]');
    } catch {
      return [];
    }
  });
  const saveOrder = (
    nextPins: string[],
    nextBottom: string[],
    nextBottomTrees: string[] = bottomTrees,
  ) => {
    setPins(nextPins);
    setBottom(nextBottom);
    setBottomTrees(nextBottomTrees);
    try {
      localStorage.setItem(storageKey, JSON.stringify(nextPins));
      localStorage.setItem(bottomKey, JSON.stringify(nextBottom));
      localStorage.setItem(bottomTreesKey, JSON.stringify(nextBottomTrees));
      setMessage('');
    } catch {
      setMessage('排序已在本次浏览中生效，但未能保存到设备。');
    }
  };
  const [details, setDetails] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (details !== null) dialog.current?.showModal();
    else dialog.current?.close();
  }, [details]);
  const togglePin = (cwd: string) =>
    saveOrder(
      pins.includes(cwd) ? pins.filter((path) => path !== cwd) : [...pins, cwd],
      bottom.filter((path) => path !== cwd),
    );
  const toggleBottom = (cwd: string) =>
    saveOrder(
      pins.filter((path) => path !== cwd),
      bottom.includes(cwd) ? bottom.filter((path) => path !== cwd) : [...bottom, cwd],
    );
  const toggleBottomTree = (cwd: string) => {
    if (!cwd) return;
    const removing = bottomTrees.includes(cwd);
    saveOrder(
      removing ? pins : pins.filter((path) => !isWorkspaceWithin(path, cwd)),
      bottom,
      removing ? bottomTrees.filter((path) => path !== cwd) : [...bottomTrees, cwd],
    );
  };
  const overview = mode === 'workspaces' && workspace === null;
  const inFolder = mode === 'workspaces' && workspace !== null;
  const sections = workspaceSections(workspaces, pins, search, bottom, bottomTrees);
  const detailsBottomRoot =
    details === null ? undefined : workspaceBottomRoot(details, bottomTrees);
  const visibleWorkspaces = sections.flatMap((section) => section.items);
  const paths = workspaces.map((item) => item.cwd);
  const empty = overview ? visibleWorkspaces.length === 0 : threads.length === 0;
  const searchLabel = overview ? '搜索工作路径' : inFolder ? '搜索此路径下的会话' : '搜索会话';

  return (
    <section className="thread-browser" aria-label="浏览会话">
      <div className="thread-browser-controls">
        <div className="thread-browser-modes" role="group" aria-label="会话查看方式">
          <button
            aria-pressed={mode === 'all'}
            onClick={() => onModeChange('all')}
            className={mode === 'all' ? 'selected' : ''}
          >
            全部会话
          </button>
          <button
            aria-pressed={mode === 'workspaces'}
            onClick={() => onModeChange('workspaces')}
            className={mode === 'workspaces' ? 'selected' : ''}
          >
            工作路径
          </button>
        </div>
        {inFolder && (
          <div className="workspace-location">
            <button className="workspace-back" onClick={() => onWorkspaceChange(null)}>
              <Icon name="back" /> 全部工作路径
            </button>
            <strong>{workspaceName(workspace)}</strong>
            {workspace && <span className="workspace-path">{workspace}</span>}
          </div>
        )}
        <label className="search">
          <span className="sr-only">{searchLabel}</span>
          <input
            type="search"
            maxLength={overview ? undefined : 200}
            placeholder={overview ? '搜索项目名称或完整路径' : searchLabel}
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </label>
        <div className="thread-browser-caption">
          <span>{overview ? '工作路径' : inFolder ? '此路径下的会话' : '你的会话'}</span>
          <span>{overview ? visibleWorkspaces.length : threads.length}</span>
        </div>
      </div>
      <dialog
        ref={dialog}
        className="workspace-dialog"
        onCancel={() => setDetails(null)}
        onClose={() => setDetails(null)}
        aria-labelledby="workspace-dialog-title"
      >
        <h2 id="workspace-dialog-title">完整工作路径</h2>
        <p className="workspace-full-path">{details || '未记录工作路径'}</p>
        {details !== null && detailsBottomRoot !== undefined && (
          <p className="workspace-full-path">
            {detailsBottomRoot === details
              ? pins.includes(details)
                ? '此路径及子路径已设置底规则，此路径已单独置顶'
                : '此路径及子路径已置底'
              : pins.includes(details)
                ? `上级路径置底规则：${detailsBottomRoot}（此路径已单独置顶）`
                : `随上级路径置底：${detailsBottomRoot}`}
          </p>
        )}
        <div className="workspace-dialog-actions">
          {details !== null && (
            <button onClick={() => togglePin(details)}>
              {pins.includes(details) ? '取消置顶' : '置顶路径'}
            </button>
          )}
          {details !== null && (
            <button
              disabled={detailsBottomRoot !== undefined}
              onClick={() => toggleBottom(details)}
            >
              {bottom.includes(details) ? '取消置底' : '置底路径'}
            </button>
          )}
          {details !== null && (
            <button disabled={!details} onClick={() => toggleBottomTree(details)}>
              {bottomTrees.includes(details) ? '取消路径及子路径置底' : '置底路径及子路径'}
            </button>
          )}
          {details !== null &&
            detailsBottomRoot !== undefined &&
            !bottomTrees.includes(details) && (
              <button onClick={() => toggleBottomTree(detailsBottomRoot)}>
                取消上级路径及子路径置底
              </button>
            )}
          <button
            disabled={!details}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(details || '');
                setMessage('已复制完整路径');
              } catch {
                setMessage('复制失败，请选择完整路径后手动复制。');
              }
            }}
          >
            复制路径
          </button>
          <button onClick={() => setDetails(null)}>关闭</button>
        </div>
        <p role="status">{message}</p>
      </dialog>
      <nav
        className="thread-list"
        aria-label={overview ? '工作路径列表' : '会话列表'}
        aria-busy={loading}
      >
        {overview
          ? sections.map((section) => (
              <div className="workspace-section" key={section.id}>
                {(section.id !== 'recent' || pins.length > 0) && (
                  <h3 className="workspace-section-heading">
                    {section.title}
                    <span>{section.items.length}</span>
                  </h3>
                )}
                {section.items.map((item) => (
                  <WorkspaceGroup
                    key={item.cwd}
                    item={item}
                    label={workspacePathLabel(item.cwd, paths)}
                    load={loadWorkspaceThreads}
                    selectedId={selectedId}
                    onChoose={onChooseThread}
                    onDetails={() => {
                      setMessage('');
                      setDetails(item.cwd);
                    }}
                  />
                ))}
              </div>
            ))
          : threads.map((thread) => (
              <ThreadCard
                key={thread.id}
                thread={thread}
                selectedId={selectedId}
                onChoose={onChooseThread}
              />
            ))}
        {error && (
          <div className="thread-browser-feedback" role="alert">
            <p>{error}</p>
            <button className="browser-retry" onClick={onRetry} disabled={loading}>
              <Icon name="refresh" /> 重试
            </button>
          </div>
        )}
        {loading && (
          <p className="thread-browser-loading" role="status">
            {overview ? '正在整理工作路径…' : '正在加载会话…'}
          </p>
        )}
        {empty && !loading && !error && (
          <p className="sidebar-empty">
            {!connected
              ? '连接电脑后，你的会话会出现在这里。'
              : search
                ? overview
                  ? '没有匹配的工作路径'
                  : '没有匹配的会话'
                : overview
                  ? '现有会话的工作路径会出现在这里。'
                  : inFolder
                    ? '此工作路径下还没有会话。'
                    : '还没有会话，从一个新想法开始。'}
          </p>
        )}
        {!overview && nextCursor && (
          <button className="browser-load-more" onClick={onLoadMore} disabled={loading}>
            加载更多会话
          </button>
        )}
      </nav>
    </section>
  );
}

type WorkspaceLoader = (
  cwd: string,
  cursor?: string,
) => Promise<{ data: ThreadSummary[]; nextCursor: string | null }>;

function ThreadCard({
  thread,
  selectedId,
  onChoose,
}: {
  thread: ThreadSummary;
  selectedId: string | null;
  onChoose: (id: string) => void;
}) {
  return (
    <button
      className={`thread-button ${selectedId === thread.id ? 'selected' : ''}`}
      onClick={() => onChoose(thread.id)}
      aria-current={selectedId === thread.id ? 'page' : undefined}
    >
      <span className="thread-card-heading">
        <span className="thread-title">
          {thread.status === 'active' && (
            <>
              <span className="connection-dot" />
              <span className="sr-only">运行中：</span>
            </>
          )}
          {thread.title || '新会话'}
        </span>

        <time
          className="thread-time"
          dateTime={thread.updatedAt ? new Date(thread.updatedAt).toISOString() : undefined}
        >
          {timeLabel(thread.updatedAt)}
        </time>
      </span>
      {thread.preview && <span className="thread-preview">{thread.preview}</span>}
    </button>
  );
}

function WorkspaceGroup({
  item,
  label,
  load,
  selectedId,
  onChoose,
  onDetails,
}: {
  item: WorkspaceSummary;
  label: string;
  load: WorkspaceLoader;
  selectedId: string | null;
  onChoose: (id: string) => void;
  onDetails: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const version = ++generation.current;
    if (!expanded) return;
    setBusy(true);
    setError('');
    setThreads([]);
    setCursor(null);
    void load(item.cwd)
      .then((page) => {
        if (version !== generation.current) return;
        setThreads(page.data);
        setCursor(page.nextCursor);
      })
      .catch((e: unknown) => {
        if (version === generation.current) setError(e instanceof Error ? e.message : '加载失败');
      })
      .finally(() => {
        if (version === generation.current) setBusy(false);
      });
    return () => {
      generation.current++;
    };
  }, [expanded, item.cwd, item.updatedAt, item.threadCount, item.activeCount, load, retry]);
  const more = async () => {
    if (!cursor || busy) return;
    const version = generation.current;
    setBusy(true);
    setError('');
    try {
      const page = await load(item.cwd, cursor);
      if (version !== generation.current) return;
      setThreads((previous) => [
        ...previous,
        ...page.data.filter((t) => !previous.some((p) => p.id === t.id)),
      ]);
      setCursor(page.nextCursor);
    } catch (e) {
      if (version === generation.current) setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      if (version === generation.current) setBusy(false);
    }
  };
  return (
    <div className="workspace-group">
      <div className="workspace-row">
        <button
          className="workspace-button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <span className="workspace-title">
            <span className="workspace-chevron" aria-hidden="true">
              {expanded ? '⌄' : '›'}
            </span>
            <strong>{workspaceName(item.cwd)}</strong>
            <span className="workspace-count">{item.threadCount}</span>
            {item.activeCount > 0 && (
              <span className="workspace-active">● {item.activeCount} 进行中</span>
            )}
          </span>
          <span className="workspace-summary">
            <span className="workspace-short-path">{label}</span>
          </span>
        </button>
        <button
          className="workspace-more"
          aria-label={`${workspaceName(item.cwd)}：路径排序与完整路径`}
          onClick={onDetails}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M4 7h7m4 0h5M4 17h3m4 0h9" />
            <circle cx="13" cy="7" r="2" />
            <circle cx="9" cy="17" r="2" />
          </svg>
        </button>
      </div>
      {expanded && (
        <div
          className="workspace-threads"
          aria-label={`${workspaceName(item.cwd)}的会话`}
          aria-busy={busy}
        >
          {threads.map((thread) => (
            <ThreadCard
              key={thread.id}
              thread={thread}
              selectedId={selectedId}
              onChoose={onChoose}
            />
          ))}
          {busy && <p role="status">正在加载会话…</p>}
          {error && (
            <div role="alert">
              <p>{error}</p>
              <button
                className="browser-retry"
                onClick={() => (cursor ? void more() : setRetry(retry + 1))}
              >
                重试
              </button>
            </div>
          )}
          {!busy && !error && !threads.length && <p>此工作路径下还没有会话。</p>}
          {cursor && !error && (
            <button className="browser-load-more" disabled={busy} onClick={() => void more()}>
              加载更多会话
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                aria-hidden="true"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
