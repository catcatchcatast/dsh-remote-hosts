// Public change history: docs/PUBLIC-CHANGES.md
export function createSidebarViews() {
// Public change history: docs/PUBLIC-CHANGES.md
		const module = { exports: {} };
		const exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const css = `
.dsx2-host{order:-1;flex:none;display:flex;flex-direction:column;gap:7px;padding:2px 0 8px;min-width:0}
.dsx2-time-root>.dsx2-host{flex:1 1 0;min-height:0}
.dsx2-time-root > :not(.dsx2-host){display:none!important}
.dsx2-bar{display:flex;align-items:center;gap:6px;flex:none}
.dsx2-tabs{display:flex;flex:1;min-width:0;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.08));border:1px solid var(--dsw-alias-border-l1,transparent);border-radius:9px;padding:2px;gap:2px}
.dsx2-tab{flex:1;display:flex;align-items:center;justify-content:center;height:26px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:12px/16px inherit;padding:0 7px;white-space:nowrap}
.dsx2-tab:hover{color:var(--dsw-alias-label-primary)}
.dsx2-tab-active{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.18));color:var(--dsw-alias-label-primary);font-weight:600}
.dsx2-plus{width:28px;height:28px;flex:none;display:inline-flex;align-items:center;justify-content:center;border:none;background:transparent;border-radius:50%;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0}
.dsx2-plus:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.15));color:var(--dsw-alias-label-primary)}
.dsx2-search{display:none;align-items:center;gap:6px;height:30px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1,transparent);border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.06));color:var(--dsw-alias-label-tertiary);flex:none}
.dsx2-time-root .dsx2-search{display:flex}
.dsx2-search-input{flex:1;min-width:0;border:none;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font:12px/16px inherit}
.dsx2-search-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dsx2-pinned{flex:none;display:flex;flex-direction:column;min-height:0}
.dsx2-pinned-head{display:flex;align-items:center;gap:6px;height:30px;padding:0 7px;border-radius:8px;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:650;user-select:none;flex:none}
.dsx2-pinned-head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary)}
.dsx2-pin-icon,.dsx2-row-pin{flex:none;display:inline-flex;align-items:center;color:var(--dsw-alias-brand-primary,#7c83ff)}
.dsx2-chevron{flex:none;font-size:10px;line-height:1;color:var(--dsw-alias-label-tertiary);transition:transform .15s ease}
.dsx2-chevron-closed{transform:rotate(-90deg)}
.dsx2-pinned-count{flex:none;color:var(--dsw-alias-label-tertiary);font-weight:400;font-size:11px}
.dsx2-pinned-rows{display:flex;flex-direction:column;max-height:260px;overflow-y:auto;padding-bottom:3px}
.dsx2-pinned-closed .dsx2-pinned-rows{display:none}
.dsx2-list{display:none;flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:0 0 14px}
.dsx2-time-root .dsx2-list{display:block}
.dsx2-time-section{display:flex;flex-direction:column;gap:2px;padding-bottom:10px}
.dsx2-time-heading{height:29px;display:flex;align-items:flex-end;padding:0 8px 5px;color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:650;user-select:none}
.dsx2-row{display:flex;align-items:center;gap:7px;min-height:48px;padding:5px 8px;border-radius:10px;cursor:pointer;color:var(--dsw-alias-label-primary);font-size:13px;user-select:none;box-sizing:border-box}
.dsx2-row:hover{background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.10))}
.dsx2-row-current{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.18))}
.dsx2-row-current:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.22))}
.dsx2-row-dead{opacity:.42;cursor:default}
.dsx2-row-host-offline{opacity:.58}
.dsx2-row-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.dsx2-row-titleline{min-width:0;display:flex;align-items:center;gap:5px}
.dsx2-row-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:18px}
.dsx2-row-meta-line{min-width:0;display:flex;align-items:center;gap:4px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px}
.dsx2-folder{display:inline-flex;flex:none;opacity:.8}
.dsx2-row-meta{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsx2-session-status{display:inline-flex;align-items:center;flex:none}
.dsx2-row-pending{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsx2-row-actions{display:flex;align-items:center;gap:6px;flex:none}
.dsx2-more{display:none;flex:none;width:22px;height:22px;align-items:center;justify-content:center;border:none;background:transparent;border-radius:6px;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:15px;line-height:1;padding:0}
.dsx2-row:hover .dsx2-more,.dsx2-more:focus-visible{display:inline-flex}
.dsx2-more:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.18));color:var(--dsw-alias-label-primary)}
.dsx2-host-state{width:7px;height:7px;border-radius:50%;flex:none}
.dsx2-host-state-online{background:var(--dsw-alias-state-success-primary,#22c55e)}
.dsx2-host-state-reconnecting{background:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsx2-host-state-offline{background:var(--dsw-alias-label-tertiary,#777)}
.dsx2-workspace-host{margin-left:auto;display:inline-flex;align-items:center;gap:7px;min-width:0;padding-left:8px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px;white-space:nowrap;pointer-events:none}
.dsx2-workspace-host-label{max-width:112px;overflow:hidden;text-overflow:ellipsis}
.dsx2-workspace-host-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary,#777)}
.dsx2-workspace-host[data-state="online"] .dsx2-workspace-host-dot{background:var(--dsw-alias-state-success-primary,#22c55e)}
.dsx2-workspace-host[data-state="reconnecting"] .dsx2-workspace-host-dot{background:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsx2-empty{color:var(--dsw-alias-label-tertiary);padding:16px 10px;font-size:12px}
.dsx2-menu{position:fixed;z-index:9999;min-width:170px;background:var(--dsw-alias-bg-layer-1,#202020);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));border-radius:10px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,.28);display:flex;flex-direction:column}
.dsx2-menu-item{display:flex;align-items:center;gap:8px;height:32px;padding:0 10px;border:none;background:transparent;border-radius:7px;color:var(--dsw-alias-label-primary);cursor:pointer;font:13px/18px inherit;text-align:left;white-space:nowrap}
.dsx2-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}
`;

		const cssTagId = "dsh-plugin-sidebar-views/sidebar.css";
		if (typeof document !== "undefined" && !document.querySelector(`style[data-plugin-css="${cssTagId}"]`)) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-plugin-sidebar-views";
			tag.dataset.pluginCss = cssTagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		const PLUS_SVG = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
		const SEARCH_SVG = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.2" stroke="currentColor" stroke-width="1.2"/><path d="m10.2 10.2 3 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
		const PIN_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/></svg>';
		const FOLDER_SVG = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.75 4.4c0-.72.58-1.3 1.3-1.3h3.02l1.2 1.35h5.68c.72 0 1.3.58 1.3 1.3v5.2c0 .72-.58 1.3-1.3 1.3h-9.9c-.72 0-1.3-.58-1.3-1.3V4.4Z" stroke="currentColor" stroke-width="1.1"/></svg>';
		const SESSION_MENU_EVENT = "dsh:session-menu-v1";
// Public change history: docs/PUBLIC-CHANGES.md
		const inject = ["sessions", "workspaces", "timer", "sidebarHostsInterface", "workspaceRowsInterface", "sessionNavigationInterface", "sessionPresentationInterface", "sessionMenuInterface", "sessionIndicatorsInterface"];
		const HOST_INVENTORY_PATH = "/api/browser-host-hub-rc1/host-inventory";

		let sessions;
		let workspaces;
		let workspaceRowsInterface;
		let sessionNavigationInterface;
		let sessionPresentationInterface;
		let sessionIndicatorsInterface;
		let sessionMenuInterface;
		let connection;
		let hostRegistry;
		let hostRuntimes = [];
		let hostInventoryInFlight = false;
		let sList;
		let wList;
		let disposed = false;
		let mode = "workspaces";
		let filter = "";
		let railHidden = false;
		let hostDiv = null;
		let hostRoot = null;
		let tabW = null;
		let tabT = null;
		let searchInput = null;
		let listDiv = null;
		let pinnedSection = null;
		let pinnedRows = null;
		let pinnedCount = null;
		let keepAlive = null;
		let timeTicker = null;
		let titleRefreshTimer = null;
		let titleRefreshInFlight = false;
		let titleRefreshAttempts = 0;
		let staleTitles = new Map();
		let previousSessionSnapshot;
		let titleHydrationQueue = [];
		let titleHydrationQueued = new Set();
		let titleHydrationAttempted = new Set();
		let titleHydrationActive = false;
		let titleHydrationTimer = null;
		let unsubSessions = null;
		let unsubNavigation = null;
		let unsubPresentation = null;
		let stopProjectMenus = null;
		let unsubWorkspaces = null;
		let unsubHostRegistry = null;
		let unsubBaselineReady = null;
		let baselineRefreshCoordinator = null;
		let resizer = null;
		let menuEl = null;
		let sessionMenuListener = null;

		function byRecency(a, b) {
			if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
			return a.id < b.id ? -1 : 1;
		}

		function decodeBase64Url(value) {
			try {
				const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
				const binary = globalThis.atob(padded);
				return new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)));
			} catch (error) {
				return undefined;
			}
		}

		function compositeHostId(value) {
			if (typeof value !== "string") return undefined;
			const parts = value.split(".");
			if (parts.length !== 3 || parts[0] !== "rh1") return undefined;
			return decodeBase64Url(parts[1]);
		}

		function normalizeHostInventory(payload) {
			const source = payload && Array.isArray(payload.hosts) ? payload.hosts : [];
			const seen = new Set();
			const states = new Set(["offline", "connecting", "connected", "online", "reconnecting", "ready", "starting"]);
			return source.filter(item => {
				if (!item || typeof item.hostId !== "string" || item.hostId === "" || seen.has(item.hostId)) return false;
				if (typeof item.label !== "string" || item.label === "") return false;
				seen.add(item.hostId);
				return true;
			}).map(item => {
				const candidate = typeof item.state === "string" ? item.state : item.phase;
// Public change history: docs/PUBLIC-CHANGES.md
				return { hostId: item.hostId, label: item.label, local: item.hostId === "local", state: states.has(candidate) ? candidate : "offline" };
			});
		}

		function humanizeHostId(hostId) {
			return hostId.split(/[-_]+/u).filter(Boolean)
				.map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
		}
// Public change history: docs/PUBLIC-CHANGES.md
		function buildWorkspaceHostDecorations(workspaces, hosts, sessionList) {
			const hostById = new Map((hosts || []).map(host => [host.hostId, host]));
			let items = workspaces && Array.isArray(workspaces.items) ? workspaces.items : [];
			if (sessionList && sessionList.byId && typeof sessionList.byId === "object") {
				const archived = new Set(workspaces && Array.isArray(workspaces.archivedSessionIds) ? workspaces.archivedSessionIds : []);
				items = items.map((workspace, index) => {
					let updated = Number.NEGATIVE_INFINITY;
					for (const id of Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []) {
						const session = sessionList.byId[id];
						if (session && !archived.has(id) && Number.isFinite(session.updatedAt)) updated = Math.max(updated, session.updatedAt);
					}
					return { workspace, index, updated };
				}).sort((a, b) => a.updated === b.updated ? a.index - b.index : a.updated > b.updated ? -1 : 1).map(row => row.workspace);
			}
			return items.map(workspace => {
				const workspaceId = String(workspace.workspaceId || "");
				const title = String(workspace.title || "");
				const hostId = compositeHostId(workspaceId);
				const host = hostId === undefined ? undefined : hostById.get(hostId);
				const local = host ? host.local === true : hostId === undefined || hostId === "local";
				if (local) return { workspaceId, title };
				return {
					workspaceId,
					title,
					hostLabel: String((host && host.label) || humanizeHostId(hostId)),
					hostState: host && host.state,
				};
			});
		}

		function timeBucket(timestamp, now) {
			const date = new Date(Number.isFinite(timestamp) ? timestamp : 0);
			const current = new Date(now);
			const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
			const currentDay = new Date(current.getFullYear(), current.getMonth(), current.getDate());
			const dayDiff = Math.round((currentDay.getTime() - day.getTime()) / 86400000);
			const key = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
			if (dayDiff <= 0) return { key, label: "今天" };
			if (dayDiff === 1) return { key, label: "昨天" };
			if (dayDiff < 7) return { key, label: ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][date.getDay()] };
			if (date.getFullYear() === current.getFullYear()) return { key, label: `${date.getMonth() + 1}月${date.getDate()}日` };
			return { key, label: `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日` };
		}

		function buildTimeProjection({ list, currentId, workspaces, pins, hosts, now, filter }) {
			const byId = list && list.byId ? list.byId : {};
			const archived = new Set(workspaces && Array.isArray(workspaces.archivedSessionIds) ? workspaces.archivedSessionIds : []);
			const pinnedIds = new Set((pins || []).map(pin => pin.id));
			const workspaceTitleBySession = new Map();
			for (const workspace of workspaces && Array.isArray(workspaces.items) ? workspaces.items : []) {
				for (const sessionId of Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []) {
					if (!workspaceTitleBySession.has(sessionId)) workspaceTitleBySession.set(sessionId, String(workspace.title || "未分组"));
				}
			}
			const hostById = new Map((hosts || []).map(host => [host.hostId, host]));
			const projectRow = (session, fallback) => {
				const id = session ? session.id : fallback.id;
				const hostId = compositeHostId(id);
				const host = hostId === undefined ? undefined : hostById.get(hostId);
				const hostIsLocal = host ? host.local === true : hostId === undefined || hostId === "local";
				const hostLabel = hostIsLocal ? undefined : String((host && host.label) || humanizeHostId(hostId));
				const workspaceTitle = workspaceTitleBySession.get(id) || "未分组";
				return {
					id,
					title: session ? (session.blank === true ? "新会话" : String(session.displayTitle || id)) : String(fallback.title || id),
					meta: hostLabel === undefined ? workspaceTitle : `${workspaceTitle} · ${hostLabel}`,
					hostId,
					hostLabel,
					hostState: host && host.state,
					updatedAt: session && Number.isFinite(session.updatedAt) ? session.updatedAt : 0,
					current: currentId === id,
					dead: session === undefined,
					session,
				};
			};
			const pinned = (pins || []).filter(pin => !archived.has(pin.id)).map(pin => projectRow(byId[pin.id], pin));
			const query = String(filter || "").trim().toLowerCase();
			const rows = [];
			for (const id of list && Array.isArray(list.ids) ? list.ids : []) {
				const session = byId[id];
				if (session === undefined || session.origin === "subagent" || archived.has(id) || pinnedIds.has(id)) continue;
				if (session.blank === true && id !== currentId) continue;
				const row = projectRow(session, { id });
				if (query !== "" && !`${row.title}\n${row.meta}\n${row.id}`.toLowerCase().includes(query)) continue;
				rows.push(row);
			}
			rows.sort(byRecency);
			const sections = [];
			const sectionByKey = new Map();
			for (const row of rows) {
				const bucket = timeBucket(row.updatedAt, now);
				let section = sectionByKey.get(bucket.key);
				if (section === undefined) {
					section = { key: bucket.key, label: bucket.label, rows: [] };
					sectionByKey.set(bucket.key, section);
					sections.push(section);
				}
				section.rows.push(row);
			}
			return { pinned, sections };
		}

		function needsTitleRefresh(previous, current) {
			if (!previous || !current || !Array.isArray(current.ids)) return false;
			const previousById = previous.byId || {};
			const currentById = current.byId || {};
			return current.ids.some(id => previousById[id] && currentById[id]
				&& previousById[id].running === true && currentById[id].running === false);
		}

		function sessionsNeedingTitleHydration(list, hosts, now, limit = 40) {
			if (!list || !Array.isArray(list.ids) || !list.byId) return [];
			const hostById = new Map((hosts || []).map(host => [host.hostId, host]));
			const cutoff = now - 14 * 86400000;
			return list.ids.map(id => list.byId[id]).filter(session => {
				if (!session || session.origin === "subagent" || session.blank === true || session.running === true) return false;
				if (session.title !== undefined || !Number.isFinite(session.updatedAt) || session.updatedAt < cutoff) return false;
				const hostId = compositeHostId(session.id);
				if (hostId === undefined || hostId === "local") return true;
				const host = hostById.get(hostId);
				return host === undefined || hostStateKind(host.state) !== "offline";
			}).sort(byRecency).slice(0, Math.max(0, limit)).map(session => session.id);
		}

		function safeSnap(source) {
			try { return source.getSnapshot(); } catch (error) { return undefined; }
		}

		// Registry presence (`online`) only means that a transport was registered.
		// Baseline RPCs are safe after the transport handshake reports connected.
		function readyHostFingerprint(hosts) {
			return (hosts || []).filter(host => {
				const state = String(host && host.state || "").toLowerCase();
				return state === "connected" || state === "ready";
			}).map(host => `${host.hostId}:${Number.isFinite(host.generation) ? host.generation : 0}`)
				.sort().join("|");
		}
// Public change history: docs/PUBLIC-CHANGES.md
		function createBaselineRefreshCoordinator({
			refreshSessions,
			refreshWorkspaces,
			canRefresh = () => true,
			refreshInitial = () => true,
			schedule = (callback, delay) => window.setTimeout(callback, delay),
			cancel = handle => window.clearTimeout(handle),
			onSettled = () => {},
			delay = 120,
		}) {
			let fingerprint = "";
			let observed = false;
			let timer = null;
			let inFlight = false;
			let queued = false;
			let stopped = false;
			let hostRefreshPending = false;

			const request = (initial = false) => {
				if (!initial) hostRefreshPending = true;
				if (stopped || (!hostRefreshPending && !refreshInitial()) || !canRefresh()) return;
				if (inFlight) { queued = true; return; }
				if (timer !== null) return;
				timer = schedule(async () => {
					timer = null;
					if (stopped || (!hostRefreshPending && !refreshInitial()) || !canRefresh()) return;
					hostRefreshPending = false;
					inFlight = true;
					try {
						await Promise.allSettled([
							Promise.resolve().then(refreshSessions),
							Promise.resolve().then(refreshWorkspaces),
						]);
					} finally {
						inFlight = false;
						if (!stopped) onSettled();
						if (queued && !stopped) { queued = false; request(true); }
					}
				}, delay);
			};

			return {
				prime() {
					request(true);
				},
				observe(hosts) {
					const next = readyHostFingerprint(hosts);
					const initial = !observed;
					const changed = initial || next !== fingerprint;
					observed = true;
					fingerprint = next;
					if (changed && next !== "") request(initial);
				},
				dispose() {
					stopped = true;
					queued = false;
					hostRefreshPending = false;
					if (timer !== null) { cancel(timer); timer = null; }
				},
			};
		}

		function refreshHostRuntimes() {
			try {
				hostRuntimes = hostRegistry && typeof hostRegistry.snapshot === "function" ? hostRegistry.snapshot() : [];
			} catch (error) {
				hostRuntimes = [];
			}
		}

		async function refreshHostInventory() {
			if (disposed || hostRegistry !== undefined || hostInventoryInFlight || typeof fetch !== "function") return;
			hostInventoryInFlight = true;
			try {
				const response = await fetch(HOST_INVENTORY_PATH, {
					method: "GET",
					headers: { Accept: "application/json" },
					credentials: "same-origin",
				});
				if (!response.ok) return;
				const next = normalizeHostInventory(await response.json());
				if (disposed) return;
				hostRuntimes = next;
				if (baselineRefreshCoordinator !== null) baselineRefreshCoordinator.observe(hostRuntimes);
				renderAll();
				scheduleTitleHydration();
			} catch (error) {
				// Inventory is an optional compatibility route; retain the last snapshot on failure.
			} finally {
				hostInventoryInFlight = false;
			}
		}

		function loadPins() {
			try {
				const raw = JSON.parse(window.localStorage.getItem("dsx2-pins") || "[]");
				return Array.isArray(raw) ? raw.filter(pin => pin && typeof pin.id === "string") : [];
			} catch (error) { return []; }
		}

		function savePins(pins) {
			try { window.localStorage.setItem("dsx2-pins", JSON.stringify(pins)); } catch (error) {}
		}

		function isPinned(id) {
			return mergePins(loadPins(), sessionMenuInterface ? sessionMenuInterface.pinned() : []).some(pin => pin.id === id);
		}

		function legacyPost(action, id) {
			try {
				fetch(`/pin-session/${action}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ id }),
				}).catch(() => {});
			} catch (error) {}
		}

		function pinSession(id, title) {
			const pins = loadPins();
			const old = pins.find(pin => pin.id === id);
			const next = pins.filter(pin => pin.id !== id);
			next.push({ id, title, pinnedAt: old && Number.isFinite(old.pinnedAt) ? old.pinnedAt : Date.now() });
			savePins(next);
			legacyPost("pin", id);
			renderAll();
		}

		function unpinSession(id) {
			savePins(loadPins().filter(pin => pin.id !== id));
			legacyPost("unpin", id);
			renderAll();
		}

		function mergePins(local, remote) {
			const byId = new Map();
			for (const pin of local) byId.set(pin.id, pin);
			for (const row of remote) {
				if (row && typeof row.id === "string" && !byId.has(row.id)) {
					byId.set(row.id, {
						id: row.id,
						title: typeof row.title === "string" ? row.title : undefined,
						pinnedAt: Number.isFinite(row.pinnedAt) ? row.pinnedAt : 0,
					});
				}
			}
			return Array.from(byId.values()).sort((a, b) => a.pinnedAt - b.pinnedAt);
		}

		function migratePins() {
			try {
				fetch("/pin-session/pins").then(response => response.ok ? response.json() : null).then(body => {
					if (disposed || body === null || typeof body !== "object") return;
					const remote = Array.isArray(body) ? body : (Array.isArray(body.pins) ? body.pins : []);
					if (remote.length === 0) return;
					savePins(mergePins(loadPins(), remote));
					renderAll();
				}).catch(() => {});
			} catch (error) {}
		}

		function copyText(text) {
			if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
			else fallbackCopy(text);
		}

		function fallbackCopy(text) {
			const textarea = document.createElement("textarea");
			textarea.value = text;
			textarea.style.position = "fixed";
			textarea.style.opacity = "0";
			document.body.appendChild(textarea);
			textarea.select();
			try { document.execCommand("copy"); } catch (error) {}
			textarea.remove();
		}

		function closeMenu() {
			if (menuEl !== null) { menuEl.remove(); menuEl = null; }
		}

		function requestWorkspaceAction(action, id, title) {
			return sessionMenuInterface.run(action, id, title, isPinned(id));
		}

		function sessionActionDetail(action, id, title) {
			return { kind: "action", action, sessionId: id, title };
		}

		function createSessionMenuListener(open) {
			return event => {
				const detail = event && event.detail;
				if (!detail || detail.kind !== "open" || typeof detail.sessionId !== "string" || detail.sessionId === ""
					|| typeof detail.title !== "string" || !detail.anchor || typeof detail.anchor.getBoundingClientRect !== "function") return;
				event.preventDefault();
				const rect = detail.anchor.getBoundingClientRect();
				open(rect.left, rect.bottom + 4, detail.sessionId, detail.title);
			};
		}

		function menuItemsFor(id, title) {
			const items = {
				rename: { label: "重命名", action: () => requestWorkspaceAction("rename", id, title) },
				fork: { label: "分叉会话", action: () => requestWorkspaceAction("fork", id, title) },
				archive: { label: "归档会话", action: () => requestWorkspaceAction("archive", id, title) },
				unarchive: { label: "恢复归档", action: () => requestWorkspaceAction("unarchive", id, title) },
				pin: { label: "置顶会话", action: () => requestWorkspaceAction("pin", id, title) },
				unpin: { label: "取消置顶", action: () => { requestWorkspaceAction("unpin", id, title); unpinSession(id); } },
				copy: { label: "复制 Session ID", action: () => copyText(id) },
				openWorkspace: { label: "打开会话工作区", action: async () => {
					try { return await requestWorkspaceAction("openWorkspace", id, title); }
					catch (error) { window.alert("无法打开会话工作区，请检查目录或重新打开菜单后重试。"); throw error; }
				} },
			};
			return sessionMenuInterface.items(id, isPinned(id)).map(kind => items[kind]);
		}

		function openMenu(x, y, items) {
			closeMenu();
			menuEl = document.createElement("div");
			menuEl.className = "dsx2-menu";
			for (const item of items) {
				const button = document.createElement("button");
				button.type = "button";
				button.className = "dsx2-menu-item";
				button.textContent = item.label;
				button.addEventListener("click", event => {
					event.stopPropagation();
					closeMenu();
					try {
						const result = item.action();
						if (result && typeof result.catch === "function") result.catch(reason => {
							console.error("[sidebar-views] session menu action failed:", reason);
						});
					} catch (error) {
						console.error("[sidebar-views] session menu action failed:", error);
					}
				});
				menuEl.appendChild(button);
			}
			document.body.appendChild(menuEl);
			const rect = menuEl.getBoundingClientRect();
			const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
			const top = y + rect.height > window.innerHeight - 8 ? y - rect.height : y;
			menuEl.style.left = `${left}px`;
			menuEl.style.top = `${Math.max(8, top)}px`;
			window.setTimeout(() => document.addEventListener("click", closeMenu, { once: true }), 0);
		}

		function attachMore(parent, id, title) {
			const more = document.createElement("button");
			more.type = "button";
			more.className = "dsx2-more";
			more.title = "更多操作";
			more.setAttribute("aria-label", `${title}的更多操作`);
			more.textContent = "⋯";
			more.addEventListener("click", event => {
				event.stopPropagation();
				const rect = more.getBoundingClientRect();
				openMenu(rect.left, rect.bottom + 4, menuItemsFor(id, title));
			});
			parent.appendChild(more);
		}

		function pinMark() {
			const pin = document.createElement("span");
			pin.className = "dsx2-row-pin";
			pin.title = "已置顶";
			pin.innerHTML = PIN_SVG;
			return pin;
		}

		function statusDot(presentation, id) {
			if (!presentation || presentation.state === "idle") return null;
			const dot = document.createElement("span");
			dot.className = "dsx2-session-status";
			dot.dataset.sessionIndicator = id;
			dot.dataset.state = presentation.state;
			dot.title = [presentation.label, presentation.childLabel].filter(Boolean).join(" · ");
			dot.setAttribute("aria-label", dot.title);
			return dot;
		}

		function hostStateKind(state) {
			const normalized = String(state || "").toLowerCase();
			if (["connected", "online", "ready"].includes(normalized)) return "online";
			if (["connecting", "reconnecting", "starting"].includes(normalized)) return "reconnecting";
			return "offline";
		}

		function hostStateDot(row) {
			if (row.hostLabel === undefined || row.hostState === undefined) return null;
			const kind = hostStateKind(row.hostState);
			const dot = document.createElement("span");
			dot.className = `dsx2-host-state dsx2-host-state-${kind}`;
			dot.title = `${row.hostLabel}：${row.hostState}`;
			return dot;
		}

		function rowElement(row, pinned) {
			const hostOffline = row.hostLabel !== undefined && row.hostState !== undefined && hostStateKind(row.hostState) === "offline";
			const element = document.createElement("div");
			element.className = "dsx2-row" + (row.current ? " dsx2-row-current" : "")
				+ (row.dead ? " dsx2-row-dead" : "") + (hostOffline ? " dsx2-row-host-offline" : "");
			const body = document.createElement("div");
			body.className = "dsx2-row-body";
			const titleLine = document.createElement("div");
			titleLine.className = "dsx2-row-titleline";
			const title = document.createElement("span");
			title.className = "dsx2-row-title";
			title.textContent = row.title;
			titleLine.appendChild(title);
			const metaLine = document.createElement("div");
			metaLine.className = "dsx2-row-meta-line";
			const folder = document.createElement("span");
			folder.className = "dsx2-folder";
			folder.innerHTML = FOLDER_SVG;
			metaLine.appendChild(folder);
			const hostDot = hostStateDot(row);
			if (hostDot !== null) metaLine.appendChild(hostDot);
			const meta = document.createElement("span");
			meta.className = "dsx2-row-meta";
			meta.textContent = row.meta;
			metaLine.appendChild(meta);
			body.appendChild(titleLine);
			body.appendChild(metaLine);
			element.appendChild(body);
			const actions = document.createElement("div");
			actions.className = "dsx2-row-actions";
			const presentation = sessionPresentationInterface?.get(row.id);
			const activity = statusDot(presentation, row.id);
			if (presentation?.trailingLabel) {
				const pending = document.createElement("span");
				pending.className = "dsx2-row-pending";
				pending.textContent = presentation.trailingLabel;
				actions.appendChild(pending);
			}
			if (activity !== null) actions.appendChild(activity);
			if (pinned) actions.appendChild(pinMark());
			attachMore(actions, row.id, row.title);
			element.addEventListener("contextmenu", event => {
				event.preventDefault(); event.stopPropagation();
				openMenu(event.clientX, event.clientY, menuItemsFor(row.id, row.title));
			});
			element.appendChild(actions);
			if (!row.dead) element.addEventListener("click", () => {
				void sessionNavigationInterface.open(row.id).catch(() => console.warn("[sidebar-views] session navigation unavailable"));
			});
			return element;
		}

		function emptyNote(text) {
			const element = document.createElement("div");
			element.className = "dsx2-empty";
			element.textContent = text;
			return element;
		}

		function currentProjection(pins) {
			const list = sList !== undefined ? safeSnap(sList) : undefined;
			const workspaceList = wList !== undefined ? safeSnap(wList) : undefined;
			if (list === undefined || workspaceList === undefined || !Array.isArray(list.ids)) return undefined;
			return buildTimeProjection({ list, currentId: sessionNavigationInterface.getCurrentId(), workspaces: workspaceList, pins, hosts: hostRuntimes, now: Date.now(), filter });
		}

		// Compare complete rendered fields; menu capabilities stay live at open/run.
		// Never retain raw session/projection objects as a freshness authority.
		let listSignature;
		let pinnedSignature;
		function rowSignature(row) {
			const presentation = sessionPresentationInterface?.get(row.id);
			return [row.id, row.title, row.meta, row.hostId, row.hostLabel, row.hostState,
				row.current, row.dead, presentation?.state, presentation?.label,
				presentation?.childLabel, presentation?.trailingLabel];
		}

		function renderList(projection) {
			if (disposed || listDiv === null) return;
			const note = projection === undefined ? "数据加载中…" : projection.sections.length === 0
				? (filter.trim() !== "" ? "无匹配会话" : "暂无会话") : undefined;
			const signature = JSON.stringify([note, projection?.sections.map(section =>
				[section.key, section.label, section.rows.map(rowSignature)])]);
			if (signature === listSignature) return;
			const keepScroll = listDiv.scrollTop;
			listDiv.textContent = "";
			if (note !== undefined) listDiv.appendChild(emptyNote(note));
			else for (const section of projection.sections) {
				const sectionElement = document.createElement("section");
				sectionElement.className = "dsx2-time-section";
				sectionElement.dataset.timeBucket = section.key;
				const heading = document.createElement("div");
				heading.className = "dsx2-time-heading";
				heading.textContent = section.label;
				sectionElement.appendChild(heading);
				for (const row of section.rows) sectionElement.appendChild(rowElement(row, false));
				listDiv.appendChild(sectionElement);
			}
			listDiv.scrollTop = keepScroll;
			listSignature = signature;
		}

		function renderPinned(projection) {
			if (disposed || pinnedRows === null || pinnedSection === null) return;
			const rows = projection ? projection.pinned : [];
			const signature = JSON.stringify(rows.map(rowSignature));
			if (signature === pinnedSignature) return;
			if (pinnedCount !== null && pinnedCount.textContent !== String(rows.length)) pinnedCount.textContent = String(rows.length);
			pinnedRows.textContent = "";
			pinnedSection.style.display = rows.length === 0 ? "none" : "";
			for (const row of rows) pinnedRows.appendChild(rowElement(row, true));
			pinnedSignature = signature;
		}

		function syncIndicators() {
			if (hostDiv === null) return;
			sessionIndicatorsInterface.render(Array.from(hostDiv.querySelectorAll("[data-session-indicator]"), element => ({ id: element.dataset.sessionIndicator, element })));
		}

		function renderAll() {
			if (disposed || hostDiv === null) return;
			const pins = mergePins(loadPins(), sessionMenuInterface.pinned());
			const projection = mode === "time" || pins.length > 0 ? currentProjection(pins) : undefined;
			renderPinned(projection);
			if (mode === "time") renderList(projection);
			// The helper's roster publication also refreshes live presentation data
			// on retained nodes; DOM equality must not suppress this notification.
			syncIndicators();
			decorateWorkspaceRows();
		}

		// Catalog, selection and status can notify synchronously for one change.
		// Reconcile their latest snapshots once after the batch, before the next task.
		let renderQueued = false;
		function scheduleRenderAll() {
			if (disposed || renderQueued) return;
			renderQueued = true;
			Promise.resolve().then(() => {
				renderQueued = false;
				if (!disposed) renderAll();
			});
		}

		function decorateWorkspaceHostRows(root, api, hosts) {
			const remaining = new Set(root.querySelectorAll(".dsx2-workspace-host"));
			const byWorkspace = new Map();
			for (const suffix of remaining) {
				const key = suffix.dataset.workspaceId;
				if (!byWorkspace.has(key)) byWorkspace.set(key, []);
				byWorkspace.get(key).push(suffix);
			}
			api.decorate(root, workspace => {
				const decoration = buildWorkspaceHostDecorations({ items: [workspace] }, hosts)[0];
				if (decoration.hostLabel === undefined) return null;
				let suffix = byWorkspace.get(decoration.workspaceId)?.shift();
				if (suffix === undefined) {
					suffix = document.createElement("span");
					suffix.className = "dsx2-workspace-host";
					suffix.dataset.workspaceId = decoration.workspaceId;
					const label = document.createElement("span");
					label.className = "dsx2-workspace-host-label";
					const dot = document.createElement("span");
					dot.className = "dsx2-workspace-host-dot";
					dot.setAttribute("aria-hidden", "true");
					suffix.appendChild(label);
					suffix.appendChild(dot);
				}
				remaining.delete(suffix);
				const state = hostStateKind(decoration.hostState);
				const title = `${decoration.hostLabel} — ${decoration.hostState || "offline"}`;
				if (suffix.dataset.state !== state) suffix.dataset.state = state;
				if (suffix.title !== title) suffix.title = title;
				const label = suffix.querySelector(".dsx2-workspace-host-label");
				if (label.textContent !== decoration.hostLabel) label.textContent = decoration.hostLabel;
				return suffix;
			});
			for (const stale of remaining) stale.remove();
		}

		function decorateWorkspaceRows() {
			if (disposed || hostRoot === null || mode !== "workspaces") return;
			decorateWorkspaceHostRows(hostRoot, workspaceRowsInterface, hostRuntimes);
		}

		function applyModeClass() {
			if (hostRoot !== null) hostRoot.classList.toggle("dsx2-time-root", mode === "time" && !railHidden);
		}

		function syncTabs() {
			if (tabW === null || tabT === null) return;
			tabW.classList.toggle("dsx2-tab-active", mode === "workspaces");
			tabT.classList.toggle("dsx2-tab-active", mode === "time");
		}

		function setMode(next) {
			mode = next;
			syncTabs();
			applyModeClass();
			renderAll();
		}

		function build() {
			hostDiv = document.createElement("div");
			hostDiv.className = "dsx2-host";
			const bar = document.createElement("div");
			bar.className = "dsx2-bar";
			const tabs = document.createElement("div");
			tabs.className = "dsx2-tabs";
			tabW = document.createElement("button");
			tabW.type = "button";
			tabW.className = "dsx2-tab";
			tabW.textContent = "按项目";
			tabW.addEventListener("click", () => setMode("workspaces"));
			tabT = document.createElement("button");
			tabT.type = "button";
			tabT.className = "dsx2-tab";
			tabT.textContent = "按时间";
			tabT.addEventListener("click", () => setMode("time"));
			tabs.appendChild(tabW);
			tabs.appendChild(tabT);
			bar.appendChild(tabs);
			if (workspaces !== undefined) {
				const plus = document.createElement("button");
				plus.type = "button";
				plus.className = "dsx2-plus";
				plus.title = "新会话";
				plus.setAttribute("aria-label", "新会话");
				plus.innerHTML = PLUS_SVG;
				plus.addEventListener("click", () => { try { workspaces.startSession(); } catch (error) {} });
				bar.appendChild(plus);
			}
			pinnedSection = document.createElement("section");
			pinnedSection.className = "dsx2-pinned";
			const pinnedHead = document.createElement("div");
			pinnedHead.className = "dsx2-pinned-head";
			const pinIcon = document.createElement("span");
			pinIcon.className = "dsx2-pin-icon";
			pinIcon.innerHTML = PIN_SVG;
			const label = document.createElement("span");
			label.textContent = "优先级";
			pinnedCount = document.createElement("span");
			pinnedCount.className = "dsx2-pinned-count";
			pinnedCount.textContent = "0";
			const chevron = document.createElement("span");
			chevron.className = "dsx2-chevron";
			chevron.textContent = "▾";
			pinnedHead.appendChild(pinIcon);
			pinnedHead.appendChild(label);
			pinnedHead.appendChild(pinnedCount);
			pinnedHead.appendChild(chevron);
			let collapsed = window.localStorage.getItem("dsx2-pins-collapsed") === "1";
			pinnedSection.classList.toggle("dsx2-pinned-closed", collapsed);
			chevron.classList.toggle("dsx2-chevron-closed", collapsed);
			pinnedHead.addEventListener("click", () => {
				collapsed = !collapsed;
				pinnedSection.classList.toggle("dsx2-pinned-closed", collapsed);
				chevron.classList.toggle("dsx2-chevron-closed", collapsed);
				window.localStorage.setItem("dsx2-pins-collapsed", collapsed ? "1" : "0");
			});
			pinnedRows = document.createElement("div");
			pinnedRows.className = "dsx2-pinned-rows";
			pinnedSection.appendChild(pinnedHead);
			pinnedSection.appendChild(pinnedRows);
			const search = document.createElement("div");
			search.className = "dsx2-search";
			const icon = document.createElement("span");
			icon.innerHTML = SEARCH_SVG;
			searchInput = document.createElement("input");
			searchInput.className = "dsx2-search-input";
			searchInput.placeholder = "搜索会话、项目或 Host";
			searchInput.addEventListener("input", () => { filter = searchInput.value; renderAll(); });
			search.appendChild(icon);
			search.appendChild(searchInput);
			listDiv = document.createElement("div");
			listDiv.className = "dsx2-list";
			hostDiv.appendChild(bar);
			hostDiv.appendChild(pinnedSection);
			hostDiv.appendChild(search);
			hostDiv.appendChild(listDiv);
		}

		function observeRoot(root) {
			if (resizer !== null) { try { resizer.disconnect(); } catch (error) {} resizer = null; }
			try {
				resizer = new ResizeObserver(entries => {
					if (disposed || entries.length === 0) return;
					railHidden = entries[0].contentRect.width < 100;
					if (hostDiv !== null) hostDiv.style.display = railHidden ? "none" : "";
					applyModeClass();
				});
				resizer.observe(root);
			} catch (error) { resizer = null; }
		}

		function ensureHost() {
			if (disposed) return;
			const anchor = document.querySelector('[data-slot="sidebar.workspaces"]');
			if (anchor === null || anchor.firstElementChild === null) return;
			const root = anchor.firstElementChild;
			if (hostDiv === null) build();
			if (hostRoot !== root) {
				if (hostRoot !== null) hostRoot.classList.remove("dsx2-time-root");
				hostRoot = root;
				observeRoot(root);
			}
			if (hostDiv.parentElement !== root) {
				if (hostDiv.parentElement !== null) hostDiv.parentElement.removeChild(hostDiv);
				root.insertBefore(hostDiv, root.firstChild);
				syncTabs();
				applyModeClass();
				renderAll();
			}
			decorateWorkspaceRows();
			void refreshHostInventory();
		}

		function collectStaleTitles(previous, current) {
			if (!needsTitleRefresh(previous, current)) return;
			const previousById = previous.byId || {};
			const currentById = current.byId || {};
			for (const id of current.ids || []) {
				if (previousById[id] && currentById[id] && previousById[id].running === true && currentById[id].running === false) {
					staleTitles.set(id, String(currentById[id].displayTitle || ""));
				}
			}
			titleRefreshAttempts = 0;
			queueTitleRefresh(700);
		}

		function queueTitleRefresh(delay) {
			if (disposed || titleRefreshTimer !== null || titleRefreshInFlight || typeof sessions.refresh !== "function") return;
			titleRefreshTimer = window.setTimeout(() => {
				titleRefreshTimer = null;
				refreshStaleTitles();
			}, delay);
		}

		function refreshStaleTitles() {
			if (disposed || titleRefreshInFlight || typeof sessions.refresh !== "function") return;
			titleRefreshInFlight = true;
			titleRefreshAttempts += 1;
			Promise.resolve(sessions.refresh()).catch(() => {}).finally(() => {
				titleRefreshInFlight = false;
				const snapshot = sList !== undefined ? safeSnap(sList) : undefined;
				if (snapshot !== undefined) {
					for (const [id, oldTitle] of staleTitles) {
						const current = snapshot.byId && snapshot.byId[id];
						if (current === undefined || String(current.displayTitle || "") !== oldTitle) staleTitles.delete(id);
					}
				}
				if (staleTitles.size > 0 && titleRefreshAttempts < 3) queueTitleRefresh(titleRefreshAttempts === 1 ? 2500 : 7000);
			});
		}

		function scheduleTitleHydration(delay = 250) {
			if (disposed || typeof sessions.binding !== "function") return;
			const snapshot = sList !== undefined ? safeSnap(sList) : undefined;
			for (const id of sessionsNeedingTitleHydration(snapshot, hostRuntimes, Date.now(), 40)) {
				if (titleHydrationAttempted.has(id) || titleHydrationQueued.has(id)) continue;
				titleHydrationQueued.add(id);
				titleHydrationQueue.push(id);
			}
			if (titleHydrationQueue.length === 0 || titleHydrationActive || titleHydrationTimer !== null) return;
			titleHydrationTimer = window.setTimeout(() => {
				titleHydrationTimer = null;
				void hydrateNextTitle();
			}, delay);
		}

		async function hydrateNextTitle() {
			if (disposed || titleHydrationActive) return;
			const id = titleHydrationQueue.shift();
			if (id === undefined) return;
			titleHydrationQueued.delete(id);
			titleHydrationAttempted.add(id);
			titleHydrationActive = true;
			try {
				const session = sessions.binding(id)?.session;
				if (session && typeof session.open === "function") await session.open();
			} catch (error) {
				// One failed cold read must not block the rest of the title queue.
			} finally {
				titleHydrationActive = false;
				if (!disposed && titleHydrationQueue.length > 0) {
					titleHydrationTimer = window.setTimeout(() => {
						titleHydrationTimer = null;
						void hydrateNextTitle();
					}, 120);
				}
			}
		}

		function mount(ctx) {
			unsubNavigation = sessionNavigationInterface.subscribe(scheduleRenderAll);
			unsubPresentation = sessionPresentationInterface.subscribe(scheduleRenderAll);
			stopProjectMenus = sessionMenuInterface.installProjectMenus((left, top, id, title) => {
				openMenu(left, top, menuItemsFor(id, title));
			});
			sessionMenuListener = createSessionMenuListener((left, top, id, title) => {
				openMenu(left, top, menuItemsFor(id, title));
			});
			window.addEventListener(SESSION_MENU_EVENT, sessionMenuListener);
			previousSessionSnapshot = sList !== undefined ? safeSnap(sList) : undefined;
			if (sList !== undefined) {
				try {
					unsubSessions = sList.subscribe(() => {
						const next = safeSnap(sList);
						collectStaleTitles(previousSessionSnapshot, next);
						previousSessionSnapshot = next;
						scheduleRenderAll();
						scheduleTitleHydration();
					});
				} catch (error) {}
			}
			if (wList !== undefined) { try { unsubWorkspaces = wList.subscribe(scheduleRenderAll); } catch (error) {} }
			const baselineReady = connection && connection.baselineReady;
			baselineRefreshCoordinator = createBaselineRefreshCoordinator({
				canRefresh: () => baselineReady === undefined || baselineReady.getSnapshot() === true,
				// An already accepted official baseline needs no additional initial pull.
				refreshInitial: () => connection?.initialBaselineAccepted?.getSnapshot() !== true,
				refreshSessions: () => typeof sessions.refresh === "function" ? sessions.refresh() : Promise.resolve(),
				refreshWorkspaces: () => typeof workspaces.refresh === "function" ? workspaces.refresh() : Promise.resolve(),
				onSettled: () => { scheduleRenderAll(); scheduleTitleHydration(250); },
			});
			if (baselineReady !== undefined) {
				unsubBaselineReady = baselineReady.subscribe(() => baselineRefreshCoordinator.prime());
			}
			refreshHostRuntimes();
			// Without the registry, [] is only a placeholder until HTTP inventory succeeds.
			if (hostRegistry) baselineRefreshCoordinator.observe(hostRuntimes);
			baselineRefreshCoordinator.prime();
			if (hostRegistry && typeof hostRegistry.subscribe === "function") {
				try {
					unsubHostRegistry = hostRegistry.subscribe(() => {
						refreshHostRuntimes();
						baselineRefreshCoordinator.observe(hostRuntimes);
						scheduleRenderAll();
						scheduleTitleHydration();
					});
				} catch (error) {}
			}
			const timer = typeof ctx.get === "function" ? ctx.get("timer") : undefined;
			if (timer !== undefined) {
				try { keepAlive = timer.interval(ensureHost, 800); } catch (error) {}
				try { timeTicker = timer.interval(() => { if (mode === "time") renderAll(); }, 30000); } catch (error) {}
			}
			ensureHost();
			migratePins();
			scheduleTitleHydration(1200);
		}

		function cleanup() {
			if (disposed) return;
			disposed = true;
			if (sessionMenuListener !== null) {
				window.removeEventListener(SESSION_MENU_EVENT, sessionMenuListener);
				sessionMenuListener = null;
			}
			closeMenu();
			sessionIndicatorsInterface?.render([]);
			if (titleRefreshTimer !== null) window.clearTimeout(titleRefreshTimer);
			if (titleHydrationTimer !== null) window.clearTimeout(titleHydrationTimer);
			if (baselineRefreshCoordinator !== null) baselineRefreshCoordinator.dispose();
			titleHydrationQueue = [];
			titleHydrationQueued.clear();
			for (const unsubscribe of [keepAlive, timeTicker, unsubSessions, unsubNavigation, unsubPresentation, stopProjectMenus, unsubWorkspaces, unsubHostRegistry, unsubBaselineReady]) {
				if (unsubscribe !== null) { try { unsubscribe(); } catch (error) {} }
			}
			if (resizer !== null) { try { resizer.disconnect(); } catch (error) {} }
			if (hostRoot !== null) hostRoot.classList.remove("dsx2-time-root");
			if (hostDiv !== null && hostDiv.parentElement !== null) hostDiv.parentElement.removeChild(hostDiv);
		}

		function apply(ctx) {
			const RETRY_MS = 400;
			const RETRY_MAX = 75;
			let attempts = 0;
			let started = false;
			const start = () => {
				if (started || disposed) return;
				attempts += 1;
				sessions = typeof ctx.get === "function" ? ctx.get("sessions") : ctx.sessions;
				workspaces = typeof ctx.get === "function" ? ctx.get("workspaces") : ctx.workspaces;
				workspaceRowsInterface = typeof ctx.get === "function" ? ctx.get("workspaceRowsInterface") : ctx.workspaceRowsInterface;
				sessionNavigationInterface = typeof ctx.get === "function" ? ctx.get("sessionNavigationInterface") : ctx.sessionNavigationInterface;
				sessionPresentationInterface = typeof ctx.get === "function" ? ctx.get("sessionPresentationInterface") : ctx.sessionPresentationInterface;
				sessionIndicatorsInterface = typeof ctx.get === "function" ? ctx.get("sessionIndicatorsInterface") : ctx.sessionIndicatorsInterface;
				sessionMenuInterface = typeof ctx.get === "function" ? ctx.get("sessionMenuInterface") : ctx.sessionMenuInterface;
				connection = typeof ctx.get === "function" ? ctx.get("sidebarHostsInterface") : ctx.sidebarHostsInterface;
				hostRegistry = connection && connection.hostRegistry;
				sList = sessions !== undefined ? sessions.list : undefined;
				wList = workspaces !== undefined ? workspaces.list : undefined;
				if (sList === undefined || wList === undefined || workspaceRowsInterface === undefined || sessionNavigationInterface === undefined || sessionPresentationInterface === undefined || sessionMenuInterface === undefined || sessionIndicatorsInterface === undefined) {
					if (attempts <= RETRY_MAX) window.setTimeout(start, RETRY_MS);
					else console.warn("[sidebar-views] giving up: sessions/workspaces never resolved");
					return;
				}
				started = true;
				ctx.effect(() => cleanup);
				mount(ctx);
			};
			start();
		}

		exports.inject = inject;
		exports._mergePins = mergePins;
		exports._buildTimeProjection = buildTimeProjection;
		exports._needsTitleRefresh = needsTitleRefresh;
		exports._sessionsNeedingTitleHydration = sessionsNeedingTitleHydration;
		exports._readyHostFingerprint = readyHostFingerprint;
		exports._normalizeHostInventory = normalizeHostInventory;
		exports._createBaselineRefreshCoordinator = createBaselineRefreshCoordinator;
		exports._buildWorkspaceHostDecorations = buildWorkspaceHostDecorations;
		exports._decorateWorkspaceHostRows = decorateWorkspaceHostRows;
		exports._sessionActionDetail = sessionActionDetail;
		exports._createSessionMenuListener = createSessionMenuListener;
		exports.apply = apply;
		return module.exports;
}
