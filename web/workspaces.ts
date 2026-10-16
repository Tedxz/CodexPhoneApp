import type { WorkspaceSummary } from '../shared/protocol';

export interface WorkspaceSection {
  id: string;
  title: string;
  items: WorkspaceSummary[];
}

function isWindowsWorkspacePath(path: string): boolean {
  return /^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\') || path.startsWith('//');
}

/** Comparison only: preserve the original cwd for API requests and preferences. */
function workspaceComparisonPath(path: string): string {
  let comparable = isWindowsWorkspacePath(path) ? path.replace(/\\/g, '/').toLowerCase() : path;
  while (comparable.length > 1 && comparable.endsWith('/') && !/^[a-z]:\/$/.test(comparable)) {
    comparable = comparable.slice(0, -1);
  }
  return comparable;
}

/** A directory itself and its descendants, with a separator boundary. */
export function isWorkspaceWithin(cwd: string, root: string): boolean {
  if (!cwd || !root) return false;
  if (isWindowsWorkspacePath(cwd) !== isWindowsWorkspacePath(root)) return false;
  const path = workspaceComparisonPath(cwd);
  const parent = workspaceComparisonPath(root);
  return path === parent || path.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
}

/** Return the original, most specific matching rule, without rewriting its path. */
export function workspaceBottomRoot(cwd: string, roots: string[]): string | undefined {
  let match: string | undefined;
  let longest = -1;
  for (const root of roots) {
    if (isWorkspaceWithin(cwd, root)) {
      const length = workspaceComparisonPath(root).length;
      if (length > longest) {
        match = root;
        longest = length;
      }
    }
  }
  return match;
}

/** Display groups never change the exact cwd used by the API. */
export function workspaceSections(
  workspaces: WorkspaceSummary[],
  pins: string[],
  search: string,
  bottom: string[] = [],
  bottomTrees: string[] = [],
): WorkspaceSection[] {
  const query = search.trim().toLocaleLowerCase();
  const sorted = workspaces
    .slice()
    .sort(
      (a: WorkspaceSummary, b: WorkspaceSummary) =>
        b.updatedAt - a.updatedAt || a.cwd.localeCompare(b.cwd),
    );
  if (query)
    return [
      {
        id: 'search',
        title: '搜索结果',
        items: sorted.filter(
          (item: WorkspaceSummary) =>
            item.cwd.toLocaleLowerCase().includes(query) ||
            (!item.cwd && '未记录工作路径'.includes(query)),
        ),
      },
    ];
  const pinned: WorkspaceSummary[] = [];
  for (const cwd of pins) {
    const item = sorted.find((entry: WorkspaceSummary) => entry.cwd === cwd);
    if (item && !pinned.includes(item)) pinned.push(item);
  }
  const remaining = sorted.filter(
    (item: WorkspaceSummary) =>
      !pins.includes(item.cwd) &&
      !bottom.includes(item.cwd) &&
      workspaceBottomRoot(item.cwd, bottomTrees) === undefined,
  );
  const active = remaining.filter((item: WorkspaceSummary) => item.activeCount > 0);
  const idle = remaining.filter((item: WorkspaceSummary) => item.activeCount === 0);
  const sections: WorkspaceSection[] = [
    { id: 'pinned', title: '置顶', items: pinned },
    { id: 'recent', title: '其他路径', items: active.concat(idle) },
    {
      id: 'bottom',
      title: '已置底',
      items: sorted.filter(
        (item: WorkspaceSummary) =>
          !pins.includes(item.cwd) &&
          (bottom.includes(item.cwd) || workspaceBottomRoot(item.cwd, bottomTrees) !== undefined),
      ),
    },
  ];
  return sections.filter((section: WorkspaceSection) => section.items.length > 0);
}

/** The shortest unambiguous suffix, with at least the parent and leaf. */
export function workspacePathLabel(cwd: string, paths: string[]): string {
  if (!cwd) return '未记录工作路径';
  const parts = cwd.split(/[\\/]/).filter((part: string) => !!part);
  if (parts.length <= 2) return cwd;
  for (let count = 2; count < parts.length; count++) {
    const suffix = parts.slice(-count).join('/');
    const ambiguous = paths.some(
      (path: string) =>
        path !== cwd &&
        path
          .split(/[\\/]/)
          .filter((part: string) => !!part)
          .slice(-count)
          .join('/') === suffix,
    );
    if (!ambiguous) return `…/${suffix}`;
  }
  return cwd;
}

export function parseWorkspacePins(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as string[];
    if (!Array.isArray(value)) return [];
    return Array.from(new Set(value.filter((item: string) => typeof item === 'string')));
  } catch {
    return [];
  }
}

export function workspacePinsKey(server: string, target: string): string {
  return `codex-phone:workspace-pins:v1:${JSON.stringify([server, target])}`;
}

export function workspaceBottomKey(server: string, target: string): string {
  return `codex-phone:workspace-bottom:v1:${JSON.stringify([server, target])}`;
}

export function workspaceBottomTreesKey(server: string, target: string): string {
  return `codex-phone:workspace-bottom-trees:v1:${JSON.stringify([server, target])}`;
}
