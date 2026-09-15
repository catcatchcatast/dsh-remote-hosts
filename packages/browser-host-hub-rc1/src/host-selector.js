
const DEFAULT_HOST_INVENTORY_PATH = '/api/browser-host-hub-rc1/host-inventory'
const DEFAULT_ROOT_ID = 'dsh-browser-host-selector'
const LOCAL_HOST_ID = 'local'

/** Authenticated, read-only inventory route consumed by the browser bootstrap. */
export const HOST_INVENTORY_PATH = DEFAULT_HOST_INVENTORY_PATH
/** Stable DOM root id used by the additive selector. */
export const HOST_SELECTOR_ROOT_ID = DEFAULT_ROOT_ID

function normalizePath(value, label) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || value.includes('?') || value.includes('#') || value.includes('..')) {
    throw new TypeError(`${label} must be an absolute path without query or traversal`)
  }
  const result = value.replace(/\/+$/g, '')
  return result || '/'
}

function normalizeRootId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(value)) throw new TypeError('rootId must be a valid DOM id')
  return value
}

function scriptLiteral(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026')
}

function inventorySource(perHost) {
  const source = typeof perHost === 'function' ? perHost() : perHost
  if (source instanceof Map) return [...source.entries()]
  if (source !== null && typeof source === 'object' && !Array.isArray(source)) return Object.entries(source)
  throw new TypeError('perHost carrier map is required')
}

function hostLabel(hostId, value) {
  const metadata = value !== null && typeof value === 'object' ? value : undefined
  const candidate = metadata?.label ?? metadata?.hostLabel ?? metadata?.alias
  if (typeof candidate === 'string' && candidate.trim()) return candidate
  return hostId === LOCAL_HOST_ID ? 'Local' : hostId
}

function hostState(value) {
  let candidate
  try {
    candidate = typeof value?.getState === 'function' ? value.getState() : value?.state ?? value?.phase
  } catch { candidate = undefined }
  const phase = typeof candidate === 'string' ? candidate : candidate?.phase
  return typeof phase === 'string' && phase.trim() ? phase : 'offline'
}

function readInventory(perHost) {
  const seen = new Set()
  const hosts = []
  for (const [rawHostId, value] of inventorySource(perHost)) {
    if (typeof rawHostId !== 'string' || rawHostId.length === 0 || seen.has(rawHostId)) continue
    seen.add(rawHostId)
    hosts.push({ hostId: rawHostId, label: hostLabel(rawHostId, value), state: hostState(value) })
  }
  hosts.sort((left, right) => left.hostId === LOCAL_HOST_ID ? -1 : right.hostId === LOCAL_HOST_ID ? 1 : 0)
  return hosts
}

/** Safe display-only inventory embedded into the authenticated bootstrap. */
export function readBootstrapHostInventory(perHost) {
  return readInventory(perHost).map(({ hostId, label }) => ({ hostId, label }))
}

function writeText(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  response.end(body)
}

function writeJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(body))
  })
  response.end(body)
}

function writeRejection(response, rejection) {
  const status = rejection === 401 || rejection === 403 ? rejection : 503
  writeText(response, status, status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'service unavailable')
}

/**
 * Register one authenticated, read-only Host inventory route.
 *
 * `perHost` may be the injected Map itself or a function returning that Map.
 * Values are never called: a value may optionally carry only `label`,
 * `hostLabel`, or `alias` metadata; the route never starts or stops a Host.
 */
export function registerHostInventory(ctx, perHost, options = {}) {
  if (!ctx?.webServer || typeof ctx.webServer.register !== 'function') throw new TypeError('webServer.register is required')
  if (typeof ctx?.authorizeRequest !== 'function') throw new TypeError('interface authorization port is required')
  const path = normalizePath(options.path ?? DEFAULT_HOST_INVENTORY_PATH, 'inventoryPath')
  const handler = async (request, response) => {
    let rejection
    try { rejection = await ctx.authorizeRequest(request) } catch { rejection = 503 }
    if (rejection !== undefined) {
      writeRejection(response, rejection)
      return
    }
    if (String(request?.method ?? '').toUpperCase() !== 'GET') {
      writeText(response, 405, 'method not allowed')
      return
    }
    try {
      writeJson(response, 200, { hosts: readInventory(perHost) })
    } catch {
      writeJson(response, 500, { error: 'host-inventory-unavailable' })
    }
  }
  const dispose = ctx.webServer.register({ kind: 'exact', path, handler })
  return typeof dispose === 'function' ? dispose : () => {}
}

const SELECTOR_STYLE = `
#dsh-browser-host-selector {
  position: fixed;
  top: 12px;
  right: 16px;
  z-index: 2147483000;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: min(300px, calc(100vw - 32px));
  padding: 6px 9px;
  border: 1px solid var(--dsw-alias-border-l2, #d8d8d8);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, #fff));
  color: var(--dsw-alias-label-primary, #222);
  box-shadow: 0 4px 16px #0002;
  font: 12px/18px system-ui, sans-serif;
}
#dsh-browser-host-selector label {
  color: var(--dsw-alias-label-secondary, #666);
  white-space: nowrap;
}
#dsh-browser-host-selector select {
  min-width: 120px;
  max-width: 220px;
  border: 0;
  outline: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
#dsh-browser-host-selector select:focus-visible {
  outline: 2px solid var(--dsw-alias-button-info-fill, #4b8bf4);
  outline-offset: 2px;
}
#dsh-browser-host-selector option {
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-primary, #222);
}
#dsh-browser-host-selector [data-dsh-host-selector-status] {
  color: var(--dsw-alias-label-tertiary, #888);
  white-space: nowrap;
}
`

/**
 * Create a self-contained classic script for an additive Host selector.
 * Root can contribute the returned text as a `webserver/index-inject` script
 * row. The authenticated bootstrap supplies inventory through `getHosts`, so
 * the selector does not create a second inventory request.
 */
export function hostSelectorBootstrap(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options must be an object')
  normalizePath(options.inventoryPath ?? DEFAULT_HOST_INVENTORY_PATH, 'inventoryPath')
  const rootId = normalizeRootId(options.rootId ?? DEFAULT_ROOT_ID)
  const styleId = `${rootId}-style`
  const style = SELECTOR_STYLE.replaceAll('#dsh-browser-host-selector', `#${rootId}`)
  return `(function(){
  'use strict';
  const ROOT_ID=${scriptLiteral(rootId)};
  const STYLE_ID=${scriptLiteral(styleId)};
  const LOCAL_HOST_ID=${scriptLiteral(LOCAL_HOST_ID)};
  const STYLE_TEXT=${scriptLiteral(style)};
  const localRow={hostId:LOCAL_HOST_ID,label:'Local'};
  const bridge=()=>globalThis.__DSH_BROWSER_HOST_HUB__;
  const validHost=item=>item && typeof item.hostId==='string' && item.hostId.length>0 && typeof item.label==='string' && item.label.length>0;
  const normalizeHosts=value=>{
    const source=Array.isArray(value) ? value : value && Array.isArray(value.hosts) ? value.hosts : [];
    const seen=new Set(), rows=[];
    for(const item of source){
      if(!validHost(item) || seen.has(item.hostId)) continue;
      seen.add(item.hostId);
      rows.push({hostId:item.hostId,label:item.label});
    }
    if(!seen.has(LOCAL_HOST_ID)) rows.unshift(localRow);
    rows.sort((left,right)=>left.hostId===LOCAL_HOST_ID?-1:right.hostId===LOCAL_HOST_ID?1:0);
    return rows;
  };
  const addStyle=()=>{
    if(document.getElementById(STYLE_ID)) return;
    const style=document.createElement('style');
    style.id=STYLE_ID;
    style.setAttribute('data-dsh-host-selector-style','');
    style.textContent=STYLE_TEXT;
    (document.head || document.documentElement).appendChild(style);
  };
  const setSelection=(hostId,select,status)=>{
    const current=bridge();
    if(!current || typeof current.setSelectedHost!=='function'){
      status.textContent='Host bridge unavailable';
      return false;
    }
    try{
      current.setSelectedHost(hostId);
      select.value=hostId;
      status.textContent=hostId===LOCAL_HOST_ID?'Local':hostId;
      return true;
    }catch(error){
      status.textContent='Host unavailable';
      return false;
    }
  };
  const renderRows=(select,rows)=>{
    while(select.firstChild) select.removeChild(select.firstChild);
    const known=new Set();
    for(const row of rows){
      if(known.has(row.hostId)) continue;
      known.add(row.hostId);
      const option=document.createElement('option');
      option.value=row.hostId;
      option.textContent=row.label;
      select.appendChild(option);
    }
    return known;
  };
  const mount=()=>{
    if(!globalThis.document || typeof document.createElement!=='function') return;
    const parent=document.body || document.documentElement;
    if(!parent) return;
    addStyle();
    const existing=document.getElementById(ROOT_ID);
    if(existing) return existing;
    const root=document.createElement('section');
    root.id=ROOT_ID;
    root.setAttribute('data-dsh-host-selector','');
    root.setAttribute('aria-label','Target Host for new projects and operations without a resource ID');
    root.setAttribute('title','Target for new projects and operations without a resource ID');
    const label=document.createElement('label');
    const select=document.createElement('select');
    const status=document.createElement('span');
    const selectId=ROOT_ID+'-select';
    label.htmlFor=selectId;
    label.textContent='Target Host';
    select.id=selectId;
    select.setAttribute('aria-label','Target Host');
    status.setAttribute('data-dsh-host-selector-status','');
    status.setAttribute('aria-live','polite');
    status.textContent='Loading';
    renderRows(select,[localRow]);
    root.appendChild(label);
    root.appendChild(select);
    root.appendChild(status);
    parent.appendChild(root);
    let selected=LOCAL_HOST_ID;
    let hasBridgeSelection=false;
    const current=bridge();
    if(current && typeof current.getSelectedHost==='function'){
      try{
        const value=current.getSelectedHost();
        if(typeof value==='string' && value.length>0){selected=value;hasBridgeSelection=true;}
      }catch{}
    }
    select.value=hasBridgeSelection && selected!==LOCAL_HOST_ID ? '' : selected;
    select.addEventListener('change',()=>{
      const option=select.options ? [...select.options].find(item=>item.value===select.value) : undefined;
      if(option) setSelection(option.value,select,status);
    });
    let attempts=0;
    const connect=()=>{
      if(hasBridgeSelection || setSelection(selected,select,status)) { hasBridgeSelection=true; return; }
      if(attempts++ >= 40) return;
      globalThis.setTimeout(connect,50);
    };
    connect();
    try{
        const rows=normalizeHosts(current && typeof current.getHosts==='function' ? current.getHosts() : []);
        const known=renderRows(select,rows);
        const next=known.has(selected) ? selected : LOCAL_HOST_ID;
        const changed=next!==selected;
        selected=next;
        select.value=next;
        if(changed || !hasBridgeSelection) {
          if(setSelection(next,select,status)) hasBridgeSelection=true;
        } else status.textContent=next===LOCAL_HOST_ID?'Local':next;
      }catch{
        status.textContent='Host inventory unavailable';
      }
    return root;
  };
  if(!globalThis.document) return;
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',mount,{once:true});
  else mount();
})();\n`
}
