import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
export function orderProjects(workspaces, byId, archivedIds) {
  const archived = new Set(archivedIds);
  return workspaces.map((workspace, index) => {
    let updated = -Infinity;
    for (const id of workspace.sessionIds) {
      const session = byId[id];
      if (session && !archived.has(id) && Number.isFinite(session.updatedAt)) updated = Math.max(updated, session.updatedAt);
    }
    return {workspace,index,updated};
  }).sort((a,b) => a.updated === b.updated ? a.index-b.index : a.updated > b.updated ? -1 : 1).map(row=>row.workspace);
}
function once(source, anchor, value) {
  if(source.split(anchor).length!==2)throw new Error('Formal project anchor mismatch');
  return source.replace(anchor,value);
}
function onceInSection(source, startAnchor, endAnchor, anchor, value) {
  const start = source.indexOf(startAnchor);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  if (start < 0 || end < 0) throw new Error('Formal project section mismatch');
  const section = source.slice(start, end);
  if (section.split(anchor).length !== 2) throw new Error('Formal project session anchor mismatch');
  return source.slice(0, start) + section.replace(anchor, value) + source.slice(end);
}
export function patchProjectOrder(source) {
  const hash=createHash('sha256').update(source).digest('hex');
  if (hash === 'e3a836eb9c4a2503a6e6b0dac4c161dc67ebe4c456f514130cc9c17b57551294') {
    source = onceInSection(
      source,
      'function SessionTree(',
      'function FlatList(',
      'sortByRecency: orderBy === "updated" && (previousOrder === void 0 || switchedToUpdated)',
      'sortByRecency: orderBy === "updated"',
    );
  }
  if(createHash('sha256').update(source).digest('hex')!=='2bef39a610f22313238af6734439d4ca80852b608b0d698078f7345d56e5b5b4')throw new Error('Formal rc.1 baseline mismatch');
  source=once(source,'function SessionTree(',orderProjects.toString()+'\n\t\tfunction SessionTree(');
  source=once(source,'return workspaces.map((workspace) => {','return orderProjects(workspaces, list.byId, archivedSessionIds).map((workspace) => {');
  return once(source,'}, [sessionOrderByAccount, workspaces]);','}, [sessionOrderByAccount, workspaces, list, archivedSessionIds]);');
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)writeFileSync(process.argv[3],patchProjectOrder(readFileSync(process.argv[2],'utf8')));
