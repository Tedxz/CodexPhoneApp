import test from 'node:test';
import assert from 'node:assert/strict';
import type { ThreadSummary } from '../shared/protocol';
import { updateVisibleThreads, workspaceName } from '../web/thread-browser';

const thread = (id: string, cwd: string, title = '会话', updatedAt = 1): ThreadSummary => ({
  id,
  cwd,
  title,
  updatedAt,
  preview: '',
  status: 'idle',
});

test('workspace labels preserve root and distinguish missing paths without changing path identity', () => {
  assert.equal(workspaceName('/Users/alice/project/'), 'project');
  assert.equal(workspaceName('/'), '/');
  assert.equal(workspaceName(''), '未记录工作路径');
  assert.equal(workspaceName('C:\\Users\\alice\\project\\'), 'project');
  assert.equal(workspaceName('C:\\'), 'C:\\');
});

test('folder live updates use the complete cwd and cannot leak same-name projects or descendants', () => {
  const scope = { mode: 'workspaces' as const, workspace: '/work/project', search: '' };
  const current = [thread('a', '/work/project')];
  assert.deepEqual(updateVisibleThreads(current, thread('b', '/other/project'), scope), current);
  assert.deepEqual(
    updateVisibleThreads(current, thread('c', '/work/project/subdir'), scope),
    current,
  );
  assert.deepEqual(updateVisibleThreads(current, thread('a', '/other/project'), scope), []);
  assert.deepEqual(
    updateVisibleThreads(current, thread('b', '/work/project', 'new', 2), scope).map(
      (item) => item.id,
    ),
    ['b', 'a'],
  );
});

test('unknown cwd is a real folder filter rather than an unfiltered list', () => {
  const scope = { mode: 'workspaces' as const, workspace: '', search: '' };
  const current = [thread('unknown', '')];
  assert.deepEqual(updateVisibleThreads(current, thread('known', '/work'), scope), current);
  assert.deepEqual(updateVisibleThreads(current, thread('unknown', '/work'), scope), []);
});

test('live title changes respect search and preserve uniqueness and recency', () => {
  const scope = { mode: 'all' as const, workspace: null, search: ' Fix ' };
  const current = [thread('a', '/work', 'FIX bug', 1), thread('b', '/work', 'fix tests', 2)];
  assert.deepEqual(
    updateVisibleThreads(current, thread('a', '/work', 'fix race', 3), scope).map(
      (item) => item.id,
    ),
    ['a', 'b'],
  );
  assert.deepEqual(
    updateVisibleThreads(current, thread('a', '/work', 'renamed', 3), scope).map((item) => item.id),
    ['b'],
  );
  assert.deepEqual(
    updateVisibleThreads(current, thread('c', '/work', 'unrelated', 4), scope).map(
      (item) => item.id,
    ),
    ['b', 'a'],
  );
});

test('workspace overview search never applies its path query to thread titles', () => {
  const scope = { mode: 'workspaces' as const, workspace: null, search: '/work' };
  assert.equal(updateVisibleThreads([], thread('a', '/work', 'Fix bug'), scope).length, 1);
});
