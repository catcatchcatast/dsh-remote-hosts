
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FORMAL_RC1_CLIENT_SHA256 = '53c40660195c42cde709b802e239f473dd721f45bc329684af31c01fdb73282a'
export const SESSION_MENU_EVENT = 'dsh:session-menu-v1'

const openAnchor = 'onClick: (e) => {\n\t\t\t\t\t\t\t\t\t\te.stopPropagation();\n\t\t\t\t\t\t\t\t\t\tsetMenuOpen((v) => !v);\n\t\t\t\t\t\t\t\t\t},'
const openReplacement = `onClick: (e) => {
\t\t\t\t\t\t\t\t\t\te.stopPropagation();
\t\t\t\t\t\t\t\t\t\tconst menuEvent = new CustomEvent(${JSON.stringify(SESSION_MENU_EVENT)}, {
\t\t\t\t\t\t\t\t\t\t\tcancelable: true,
\t\t\t\t\t\t\t\t\t\t\tdetail: { kind: "open", sessionId: node.id, title: row.title, anchor: e.currentTarget },
\t\t\t\t\t\t\t\t\t\t});
\t\t\t\t\t\t\t\t\t\twindow.dispatchEvent(menuEvent);
\t\t\t\t\t\t\t\t\t\tif (menuEvent.defaultPrevented) return;
\t\t\t\t\t\t\t\t\t\tsetMenuOpen((v) => !v);
\t\t\t\t\t\t\t\t\t},`

const archiveAnchor = `\t\t\tconst onSessionArchive = (sessionId) => {
\t\t\t\tarchiveSession(sessionId).catch((reason) => {
\t\t\t\t\tconsole.warn("session archive rejected:", reason);
\t\t\t\t});
\t\t\t};`
const archiveReplacement = `${archiveAnchor}
\t\t\t(0, react.useEffect)(() => {
\t\t\t\tconst onSessionMenu = (event) => {
\t\t\t\t\tconst detail = event && event.detail;
\t\t\t\t\tif (!detail || detail.kind !== "action" || typeof detail.sessionId !== "string" || detail.sessionId === ""
\t\t\t\t\t\t|| typeof detail.title !== "string" || !["rename", "fork", "archive"].includes(detail.action)) return;
\t\t\t\t\tevent.preventDefault();
\t\t\t\t\tif (detail.action === "rename") onSessionRename(detail.sessionId, detail.title);
\t\t\t\t\telse if (detail.action === "fork") detail.result = forkSession(detail.sessionId);
\t\t\t\t\telse {
\t\t\t\t\t\tconst result = archiveSession(detail.sessionId);
\t\t\t\t\t\tdetail.result = result;
\t\t\t\t\t\tvoid result.catch((reason) => console.warn("session archive rejected:", reason));
\t\t\t\t\t}
\t\t\t\t};
\t\t\t\twindow.addEventListener(${JSON.stringify(SESSION_MENU_EVENT)}, onSessionMenu);
\t\t\t\treturn () => window.removeEventListener(${JSON.stringify(SESSION_MENU_EVENT)}, onSessionMenu);
\t\t\t}, [archiveSession, forkSession, onSessionRename]);`

const forkAnchor = `\t\t\t\tforkSession: (sessionId) => {
\t\t\t\t\tsessions.fork({
\t\t\t\t\t\tsessionId,
\t\t\t\t\t\tincreaseTitle: true
\t\t\t\t\t}).then((childId) => {
\t\t\t\t\t\tsessions.open(childId);
\t\t\t\t\t}).catch(() => {});
\t\t\t\t},`
const forkReplacement = `\t\t\t\tforkSession: (sessionId) => {
\t\t\t\t\tconst result = sessions.fork({
\t\t\t\t\t\tsessionId,
\t\t\t\t\t\tincreaseTitle: true
\t\t\t\t\t}).then((childId) => {
\t\t\t\t\t\tsessions.open(childId);
\t\t\t\t\t});
\t\t\t\t\tvoid result.catch((reason) => console.warn("session fork rejected:", reason));
\t\t\t\t\treturn result;
\t\t\t\t},`

function sha256(source) {
  return createHash('sha256').update(source).digest('hex')
}

function replaceOnce(source, anchor, replacement, label) {
  const count = source.split(anchor).length - 1
  if (count !== 1) throw new Error(`rc1 workspace bundle anchor ${label} matched ${count} times`)
  return source.replace(anchor, replacement)
}

export function patchFormalRc1Client(source) {
  if (sha256(source) !== FORMAL_RC1_CLIENT_SHA256) {
    throw new Error('rc1 workspace bundle SHA-256 does not match the pinned formal baseline')
  }
  let patched = replaceOnce(source, openAnchor, openReplacement, 'session-menu-open')
  patched = replaceOnce(patched, archiveAnchor, archiveReplacement, 'session-menu-actions')
  patched = replaceOnce(patched, forkAnchor, forkReplacement, 'session-menu-fork-result')
  return patched
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const [input, output = input] = process.argv.slice(2)
  if (!input) throw new Error('usage: node patch-client.mjs <input> [output]')
  const source = await readFile(input, 'utf8')
  await writeFile(output, patchFormalRc1Client(source))
}
