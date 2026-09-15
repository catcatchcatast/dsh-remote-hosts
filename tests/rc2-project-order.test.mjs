import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {buildRc2WorkspaceCandidate} from '../tools/build-rc2-workspace-candidate.mjs';
import {FORMAL_RC2_CLIENT_SHA256,patchProjectOrder} from '../packages/ui-workspace-menu-compat-rc1/src/patch-project-order.mjs';

import test from 'node:test';

test('project ordering against the official rc2 bundle', { skip: !(process.env.RC2_BASELINE ?? process.env.DSH_OFFICIAL_RC2_WORKSPACE_CLIENT) }, () => {
  const baselinePath=process.env.RC2_BASELINE ?? process.env.DSH_OFFICIAL_RC2_WORKSPACE_CLIENT;
  assert.ok(baselinePath,'set RC2_BASELINE to the formal rc2 @deepseek-ai/dsh-client-ui-workspace/lib/client.js');
  const source=readFileSync(baselinePath,'utf8');
  assert.equal(createHash('sha256').update(source).digest('hex'),FORMAL_RC2_CLIENT_SHA256);
  const fixed=patchProjectOrder(source);
  const code=fixed.slice(fixed.indexOf('function orderProjects('),fixed.indexOf('function SessionTree('));
  const workspaces=[{workspaceId:'local',sessionIds:['local.same','local.archived']},{workspaceId:'tie-first',sessionIds:['tie-first.same']},{workspaceId:'remote',sessionIds:['remote.same']},{workspaceId:'empty',sessionIds:[]}];
  const byId={'local.same':{updatedAt:10},'local.archived':{updatedAt:100},'tie-first.same':{updatedAt:30},'remote.same':{updatedAt:30}};
  const ordered=vm.runInNewContext(`${code}\norderProjects(workspaces,byId,['local.archived']).map(w=>w.workspaceId)`,{workspaces,byId});
  assert.deepEqual(ordered,['tie-first','remote','local','empty']);
  assert.equal(workspaces.map(w=>w.workspaceId).join(','),'local,tie-first,remote,empty');
  assert.ok(fixed.includes('return orderProjects(workspaces, list.byId, archivedSessionIds).map((workspace) => {'));
  assert.ok(fixed.includes('}, [sessionOrderByAccount, workspaces, list, archivedSessionIds]);'));
  assert.throws(()=>patchProjectOrder(fixed),/Formal project anchor mismatch|Formal rc.1 baseline mismatch/);
  
  const staging=mkdtempSync(join(tmpdir(),'dsh-rc2-workspace-candidate-'));
  try {
    const outputPath=join(staging,'client.js');
    const manifestPath=join(staging,'client.manifest.json');
    const result=buildRc2WorkspaceCandidate({sourcePath:baselinePath,outputPath,manifestPath});
    assert.equal(result.sourceSha256,FORMAL_RC2_CLIENT_SHA256);
    assert.equal(result.outputSha256,createHash('sha256').update(readFileSync(outputPath)).digest('hex'));
    assert.equal(JSON.parse(readFileSync(manifestPath,'utf8')).outputSha256,result.outputSha256);
    assert.equal(readFileSync(baselinePath,'utf8'),source);
    assert.throws(()=>buildRc2WorkspaceCandidate({sourcePath:baselinePath,outputPath:baselinePath}),/OFFICIAL_WORKSPACE_REPLACEMENT_REFUSED/);
  } finally { rmSync(staging,{recursive:true,force:true}); }
  
  console.log('PASS rc2 project max updatedAt, archive exclusion, stable ties, host-scoped ids, view dependency refresh, source protection, candidate manifest');
});
