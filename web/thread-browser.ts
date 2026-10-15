import type { ThreadSummary } from '../shared/protocol';

export type ThreadBrowserMode = 'all' | 'workspaces';

export interface ThreadBrowserScope {
  mode: ThreadBrowserMode;
  workspace: string | null;
  search: string;
}

/** The label is only for display; folder identity always uses the complete cwd. */
export function workspaceName(cwd: string): string {
  if (!cwd) return '未记录工作路径';
  if (/^[\\/]+$/.test(cwd)) return cwd;
  if (/^[A-Za-z]:[\\/]+$/.test(cwd)) return cwd.slice(0, 3);
  const path = cwd.replace(/[\\/]+$/, '');
  return path.split(/[\\/]/).at(-1) || cwd;
}

/** Keep live notifications within the same scope as the visible API result. */
export function updateVisibleThreads(
  threads: ThreadSummary[],
  thread: ThreadSummary,
  scope: ThreadBrowserScope,
): ThreadSummary[] {
  const inFolder = scope.mode === 'workspaces' && scope.workspace !== null;
  const search =
    scope.mode === 'workspaces' && scope.workspace === null
      ? ''
      : scope.search.trim().slice(0, 200).toLocaleLowerCase();
  const matches = (item: ThreadSummary) =>
    (!inFolder || item.cwd === scope.workspace) &&
    (!search || item.title.toLocaleLowerCase().includes(search));
  return [thread, ...threads.filter((item) => item.id !== thread.id)]
    .filter(matches)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
