import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {patchProjectOrder} from '../packages/ui-workspace-menu-compat-rc1/src/patch-project-order.mjs';
import test from 'node:test';

test('project and expanded session ordering against the official rc.1 bundle', { skip: !process.env.RC1_BASELINE }, () => {
  const source=readFileSync(process.env.RC1_BASELINE,'utf8');
  const fixed=patchProjectOrder(source);
  const code=fixed.slice(fixed.indexOf('function orderProjects('),fixed.indexOf('function SessionTree('));
  const workspaces=[{workspaceId:'local',sessionIds:['a','b']},{workspaceId:'remote',sessionIds:['c']},{workspaceId:'empty',sessionIds:[]},{workspaceId:'missing',sessionIds:['unknown']}];
  const byId={a:{updatedAt:10},b:{updatedAt:20},c:{updatedAt:30}};
  const run=(archived=[])=>vm.runInNewContext(code+'orderProjects(workspaces,byId,archived).map(w=>w.workspaceId).join(",")',{workspaces,byId,archived});
  assert.equal(run(),'remote,local,empty,missing');
  byId.a.updatedAt=40;assert.equal(run(),'local,remote,empty,missing');
  assert.equal(run(['a']),'remote,local,empty,missing');
  byId.a.updatedAt=30;assert.equal(run(),'local,remote,empty,missing');
  assert.equal(workspaces[0].sessionIds.join(','),'a,b');
  assert.equal(workspaces.map(w=>w.workspaceId).join(','),'local,remote,empty,missing');
  const fixedSessionTree = fixed.slice(fixed.indexOf('function SessionTree('), fixed.indexOf('function FlatList('));
  const fixedFlatList = fixed.slice(fixed.indexOf('function FlatList('));
  assert.ok(fixedSessionTree.includes('sortByRecency: orderBy === "updated"'));
  assert.ok(!fixedSessionTree.includes('sortByRecency: orderBy === "updated" && (previousOrder === void 0 || switchedToUpdated)'));
  assert.ok(fixedFlatList.includes('sortByRecency: orderBy === "updated" && (previousOrder === void 0 || switchedToUpdated)'));
  assert.ok(fixed.includes('[sessionOrderByAccount, workspaces, list, archivedSessionIds]'));
  assert.throws(()=>patchProjectOrder(fixed));
  assert.equal(fixed.slice(fixed.indexOf('function FlatList(')),source.slice(source.indexOf('function FlatList(')));
  console.log('PASS project max timestamp, live update, archive exclusion, stable ties, empty/missing, no mutation, reverted inner sorting, reactive dependencies, flat isolation, hash guard');

  const orderSource = fixed.slice(fixed.indexOf('function reconciledSessionOrder('), fixed.indexOf('function ViewOptionsMenu('));
  const sessionTree = fixed.slice(fixed.indexOf('function SessionTree('), fixed.indexOf('function FlatList('));
  const sortPolicy = sessionTree.match(/sortByRecency: ([^\n]+)/)?.[1];
  assert.ok(sortPolicy, 'SessionTree must expose its account sorting policy');
  const sessionIds = ['oldest', 'middle', 'newest', 'older', 'old'];
  const sessionById = {
    oldest: { updatedAt: 10 },
    middle: { updatedAt: 30 },
    newest: { updatedAt: 50 },
    older: { updatedAt: 20 },
    old: { updatedAt: 40 },
  };
  const observedRows = vm.runInNewContext(
    `${orderSource}\nconst result = nextSessionOrderAccount({
      sessionIds,
      previousOrder: sessionIds,
      previousUpdatedAt: { oldest: 10, middle: 30, newest: 50, older: 20, old: 40 },
      list: { byId: sessionById },
      orderBy: 'updated',
      switchedToUpdated: false,
      sortByRecency: (${sortPolicy}),
    });
    ({ collapsed: result.order.slice(0, 5), expanded: result.order });`,
    { sessionIds, sessionById, previousOrder: sessionIds, orderBy: 'updated', switchedToUpdated: false },
  );
  const collapsedRows = [...observedRows.collapsed];
  const expandedRows = [...observedRows.expanded];
  assert.deepEqual(collapsedRows, ['newest', 'old', 'middle', 'older', 'oldest']);
  assert.deepEqual(expandedRows, ['newest', 'old', 'middle', 'older', 'oldest']);
  assert.deepEqual(expandedRows.slice(0, 5), collapsedRows);
  console.log('PASS project session collapsed/expanded sequence remains newest-first with persisted order');
});
