import type { ThreadSummary, WorkspaceSummary } from '../shared/protocol';
import { Icon } from './components';
import { workspaceName, type ThreadBrowserMode } from './thread-browser';

interface ThreadBrowserProps {
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
  const overview = mode === 'workspaces' && workspace === null;
  const inFolder = mode === 'workspaces' && workspace !== null;
  const query = search.trim().toLocaleLowerCase();
  const visibleWorkspaces = workspaces
    .filter(
      (item) =>
        !query ||
        item.cwd.toLocaleLowerCase().includes(query) ||
        workspaceName(item.cwd).toLocaleLowerCase().includes(query),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt || a.cwd.localeCompare(b.cwd));
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
          <span>{overview ? '按工作路径分组' : inFolder ? '此路径下的会话' : '你的会话'}</span>
          <span>{overview ? visibleWorkspaces.length : threads.length}</span>
        </div>
      </div>
      <nav
        className="thread-list"
        aria-label={overview ? '工作路径列表' : '会话列表'}
        aria-busy={loading}
      >
        {overview
          ? visibleWorkspaces.map((item) => (
              <button
                className="workspace-button"
                key={item.cwd}
                onClick={() => onWorkspaceChange(item.cwd)}
              >
                <span className="workspace-title">
                  <svg
                    width="19"
                    height="19"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M3 7V5a1 1 0 0 1 1-1h5l3 3h8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" />
                  </svg>
                  <strong>{workspaceName(item.cwd)}</strong>
                  <Icon name="arrow" />
                </span>
                {item.cwd && <span className="workspace-path">{item.cwd}</span>}
                <span className="workspace-meta">
                  <span>{item.threadCount} 个会话</span>
                  {item.activeCount > 0 && (
                    <span className="workspace-active">
                      <span className="connection-dot" /> {item.activeCount} 个进行中
                    </span>
                  )}
                </span>
              </button>
            ))
          : threads.map((thread) => (
              <button
                className={`thread-button ${selectedId === thread.id ? 'selected' : ''}`}
                key={thread.id}
                onClick={() => onChooseThread(thread.id)}
                aria-current={selectedId === thread.id ? 'page' : undefined}
              >
                <span className="thread-title">
                  {thread.status === 'active' && (
                    <>
                      <span className="connection-dot" />
                      <span className="sr-only">运行中：</span>
                    </>
                  )}
                  {thread.title}
                </span>
                <span className="thread-preview">
                  {thread.preview || workspaceName(thread.cwd)}
                </span>
                <span className="thread-meta">
                  <span title={thread.cwd}>{workspaceName(thread.cwd)}</span>
                  <time
                    dateTime={
                      thread.updatedAt ? new Date(thread.updatedAt).toISOString() : undefined
                    }
                  >
                    {timeLabel(thread.updatedAt)}
                  </time>
                </span>
              </button>
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
