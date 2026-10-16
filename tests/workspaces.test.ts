import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { WorkspaceSummary } from '../shared/protocol';
import * as web from '../web/workspaces';

// Run identical user scenarios against both clients' actual grouping code.
const native: Record<string, unknown> = {};
new Function(
  'exports',
  ts.transpileModule(readFileSync('harmony/entry/src/main/ets/model/Workspaces.ets', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText,
)(native);

const workspace = (cwd: string, updatedAt = 1, activeCount = 0): WorkspaceSummary => ({
  cwd,
  updatedAt,
  activeCount,
  threadCount: 2,
});

for (const [client, helpers] of [
  ['web', web],
  ['Harmony', native as typeof web],
] as const) {
  test(`${client}: pins are unique, ordered, and do not hide active or historical paths`, () => {
    const items = Array.from({ length: 20 }, (_, index) => workspace(`/repo/${index}`, 20 - index));
    items.push(workspace('/old/running', 0, 1));
    const groups = helpers.workspaceSections(
      items,
      ['/repo/15', '/repo/2', '/repo/15', '/missing'],
      '',
    );
    assert.deepEqual(
      groups.map((group) => [group.id, group.items.length]),
      [
        ['pinned', 2],
        ['recent', 19],
      ],
    );
    assert.deepEqual(
      groups[0].items.map((item) => item.cwd),
      ['/repo/15', '/repo/2'],
    );
    assert.equal(groups[1].items[0].cwd, '/old/running');
    assert.equal(
      new Set(groups.flatMap((group) => group.items.map((item) => item.cwd))).size,
      items.length,
    );
    assert.equal(items[0].cwd, '/repo/0'); // The API input is never mutated.
  });

  test(`${client}: all path headings remain visible and search includes bottom paths`, () => {
    const items = Array.from({ length: 12 }, (_, index) => workspace(`/repo/${index}`, index, 1));
    items.push(workspace('/archive/中文 项目', 0), workspace('', 0));
    const groups = helpers.workspaceSections(items, [], '', ['/archive/中文 项目', '']);
    assert.equal(groups[0].items.length, 12);
    assert.equal(groups[1].id, 'bottom');
    assert.equal(groups[1].items.length, 2);
    assert.deepEqual(
      helpers
        .workspaceSections(items, [], ' 中文 ', ['/archive/中文 项目'])[0]
        .items.map((item) => item.cwd),
      ['/archive/中文 项目'],
    );
    assert.equal(helpers.workspaceSections(items, [], '未记录')[0].items[0].cwd, '');
    assert.equal(helpers.workspaceSections(items, [], 'missing')[0].items.length, 0);
    assert.deepEqual(helpers.workspaceSections([], [], ''), []);
  });

  test(`${client}: abbreviated paths distinguish names without changing exact identities`, () => {
    const paths = ['/work/team/api', '/personal/team/api', '/work/team/api/child'];
    assert.equal(helpers.workspacePathLabel(paths[0], paths), '/work/team/api');
    assert.equal(helpers.workspacePathLabel(paths[1], paths), '/personal/team/api');
    assert.equal(helpers.workspacePathLabel(paths[2], paths), '…/api/child');
    assert.equal(helpers.workspacePathLabel('/work/only/project', []), '…/only/project');
    assert.equal(helpers.workspacePathLabel('', []), '未记录工作路径');
    assert.equal(helpers.workspacePathLabel('/', []), '/');
    assert.equal(helpers.workspacePathLabel('C:\\', []), 'C:\\');
    assert.equal(helpers.workspacePathLabel('/work/team/api/', [paths[0]]), '/work/team/api/');
    assert.equal(helpers.workspacePathLabel('C:\\work\\api', ['D:\\work\\api']), 'C:\\work\\api');
    const grouped = helpers.workspaceSections(
      paths.map((path) => workspace(path)),
      [],
      '',
    );
    assert.equal(grouped[0].items.length, 3);
  });

  test(`${client}: bottom placement includes active paths, preserves exact identities and avoids duplicate pins`, () => {
    const items = [workspace('/a', 1, 2), workspace('/b', 3), workspace('/c', 2)];
    const groups = helpers.workspaceSections(items, ['/c'], '', ['/a', '/c']);
    assert.deepEqual(
      groups.map((g) => [g.id, g.items.map((w) => w.cwd)]),
      [
        ['pinned', ['/c']],
        ['recent', ['/b']],
        ['bottom', ['/a']],
      ],
    );
    assert.notEqual(
      helpers.workspaceBottomKey('a', 'local'),
      helpers.workspacePinsKey('a', 'local'),
    );
  });

  test(`${client}: malformed preferences are tolerated and machine scopes cannot collide`, () => {
    assert.deepEqual(helpers.parseWorkspacePins('not json'), []);
    assert.deepEqual(helpers.parseWorkspacePins('null'), []);
    assert.deepEqual(helpers.parseWorkspacePins('{}'), []);
    assert.deepEqual(helpers.parseWorkspacePins('["/repo",null,1,"/repo",""]'), ['/repo', '']);
    assert.notEqual(helpers.workspacePinsKey('a', 'b:c'), helpers.workspacePinsKey('a:b', 'c'));
    assert.notEqual(helpers.workspacePinsKey('a', 'local'), helpers.workspacePinsKey('b', 'local'));
  });

  test(`${client}: subtree rules match directory boundaries, roots and case-sensitive POSIX paths`, () => {
    for (const cwd of ['/repo', '/repo/', '/repo/child', '/repo/child/deeper']) {
      assert.equal(helpers.isWorkspaceWithin(cwd, '/repo'), true, cwd);
      assert.equal(helpers.isWorkspaceWithin(cwd, '/repo///'), true, cwd);
    }
    for (const cwd of ['/repo-old', '/repository/child', '/Repo/child', 'repo/child', '']) {
      assert.equal(helpers.isWorkspaceWithin(cwd, '/repo'), false, cwd);
    }
    assert.equal(helpers.isWorkspaceWithin('/repo/child', ''), false);
    assert.equal(helpers.isWorkspaceWithin('', ''), false);
    assert.equal(helpers.isWorkspaceWithin('/', '/'), true);
    assert.equal(helpers.isWorkspaceWithin('/repo/child', '/'), true);
    assert.equal(helpers.isWorkspaceWithin('repo/child', '/'), false);
    assert.equal(helpers.isWorkspaceWithin('C:\\repo', '/'), false);
    assert.equal(helpers.isWorkspaceWithin('\\\\server\\share', '/'), false);
    // A backslash is a legal POSIX filename character, not a directory separator.
    assert.equal(helpers.isWorkspaceWithin('/repo\\child', '/repo'), false);
    assert.equal(helpers.isWorkspaceWithin('/repo\\child/sub', '/repo\\child'), true);
  });

  test(`${client}: Windows subtree matching accepts mixed separators, drive roots and UNC paths`, () => {
    assert.equal(helpers.isWorkspaceWithin('C:\\Work\\Repo\\child', 'c:/work/repo/'), true);
    assert.equal(helpers.isWorkspaceWithin('c:/work/repo', 'C:\\Work\\Repo'), true);
    assert.equal(helpers.isWorkspaceWithin('C:\\work\\repo-old', 'C:\\work\\repo'), false);
    assert.equal(helpers.isWorkspaceWithin('D:\\work\\repo', 'C:\\'), false);
    assert.equal(helpers.isWorkspaceWithin('c:/work/repo', 'C:\\'), true);
    assert.equal(helpers.isWorkspaceWithin('C:\\', 'c:/'), true);
    assert.equal(helpers.isWorkspaceWithin('C:relative', 'C:\\'), false);
    assert.equal(helpers.isWorkspaceWithin('\\\\Server\\Share\\Child', '//server/share/'), true);
    assert.equal(helpers.isWorkspaceWithin('\\\\server\\share-backup', '\\\\server\\share'), false);
  });

  test(`${client}: the most specific matching subtree rule retains its original identity`, () => {
    const roots = ['/repo/////', '/repo/child/', '/repo/other', ''];
    assert.equal(helpers.workspaceBottomRoot('/repo/child/deeper', roots), '/repo/child/');
    assert.equal(helpers.workspaceBottomRoot('/repo/new', roots), '/repo/////');
    assert.equal(helpers.workspaceBottomRoot('/repository', roots), undefined);
    assert.equal(helpers.workspaceBottomRoot('', roots), undefined);
    assert.equal(
      helpers.workspaceBottomRoot('c:/work/repo/child', ['C:\\', 'C:\\Work\\Repo\\']),
      'C:\\Work\\Repo\\',
    );
    assert.deepEqual(roots, ['/repo/////', '/repo/child/', '/repo/other', '']);
  });

  test(`${client}: subtree rules include future children, respect pins and keep search complete`, () => {
    const items = [
      workspace('/repo', 4),
      workspace('/repo/child', 3, 1),
      workspace('/repo/child/pinned', 2),
      workspace('/repo-other', 1),
      workspace('/legacy', 0),
    ];
    const before = structuredClone(items);
    const pins = ['/repo/child/pinned'];
    const bottom = ['/legacy'];
    const trees = ['/repo/'];
    const groups = helpers.workspaceSections(items, pins, '', bottom, trees);
    assert.deepEqual(
      groups.map((group) => [group.id, group.items.map((item) => item.cwd)]),
      [
        ['pinned', ['/repo/child/pinned']],
        ['recent', ['/repo-other']],
        ['bottom', ['/repo', '/repo/child', '/legacy']],
      ],
    );
    const future = workspace('/repo/new/future', 5);
    assert.equal(
      helpers
        .workspaceSections([...items, future], pins, '', bottom, trees)
        .find((group) => group.id === 'bottom')?.items[0],
      future,
    );
    assert.deepEqual(
      helpers
        .workspaceSections(items, pins, ' CHILD ', bottom, trees)[0]
        .items.map((item) => item.cwd),
      ['/repo/child', '/repo/child/pinned'],
    );
    assert.deepEqual(items, before);
    assert.deepEqual(pins, ['/repo/child/pinned']);
    assert.deepEqual(bottom, ['/legacy']);
    assert.deepEqual(trees, ['/repo/']);
    assert.equal(groups.find((group) => group.id === 'bottom')?.items[0], items[0]);
  });

  test(`${client}: old exact placement stays exact and subtree preferences have a separate machine scope`, () => {
    const items = [workspace('/repo', 2), workspace('/repo/child', 1)];
    assert.deepEqual(
      helpers
        .workspaceSections(items, [], '', ['/repo'])
        .map((group) => [group.id, group.items.map((item) => item.cwd)]),
      [
        ['recent', ['/repo/child']],
        ['bottom', ['/repo']],
      ],
    );
    assert.equal(
      helpers.workspaceBottomKey('a', 'local'),
      'codex-phone:workspace-bottom:v1:["a","local"]',
    );
    assert.notEqual(
      helpers.workspaceBottomTreesKey('a', 'local'),
      helpers.workspaceBottomKey('a', 'local'),
    );
    assert.notEqual(
      helpers.workspaceBottomTreesKey('a', 'local'),
      helpers.workspacePinsKey('a', 'local'),
    );
    assert.notEqual(
      helpers.workspaceBottomTreesKey('a', 'b:c'),
      helpers.workspaceBottomTreesKey('a:b', 'c'),
    );
    assert.notEqual(
      helpers.workspaceBottomTreesKey('a', 'local'),
      helpers.workspaceBottomTreesKey('b', 'local'),
    );
    assert.notEqual(
      helpers.workspaceBottomTreesKey('a', 'local'),
      helpers.workspaceBottomTreesKey('a', 'remote'),
    );
  });
}
