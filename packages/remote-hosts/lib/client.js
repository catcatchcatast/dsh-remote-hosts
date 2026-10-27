window.__ModuleLoader__.load({
	id: "dsh-remote-hosts",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __defProp = Object.defineProperty;
		var __exportAll = (all, no_symbols) => {
			let target = {};
			for (var name in all) __defProp(target, name, {
				get: all[name],
				enumerable: true
			});
			if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
			return target;
		};
		//#endregion
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
		//#region src/third_party/composer-history/recall.ts
		const DEFAULT_EXTRACT = {
			kinds: ["user"],
			max: 0
		};
		/**
		* Extract the recall history from a session's nodes in time order (newest
		* last): admitted node kinds only, text blocks joined per node, blank
		* entries dropped, adjacent duplicates merged, bounded to `max` newest
		* entries. One entry per submitted message.
		* @param nodes - projected conversation nodes in seq order.
		* @param options - partial extraction tunables; defaults read user nodes
		*   unbounded (the historical behavior).
		* @returns non-blank entries, oldest first.
		*/
		function extractHistory(nodes, options = {}) {
			const kinds = options.kinds ?? DEFAULT_EXTRACT.kinds;
			const max = options.max ?? DEFAULT_EXTRACT.max;
			const entries = [];
			let head = 0;
			for (const node of nodes) {
				if (!kinds.includes(node.kind)) continue;
				const text = node.texts.join("\n");
				if (text.trim() === "") continue;
				if (entries[entries.length - 1] === text) continue;
				entries.push(text);
				if (max > 0 && entries.length - head > max) head++;
			}
			return head === 0 ? entries : entries.slice(head);
		}
		const WORD_CHAR = /[\p{L}\p{N}_]/u;
		const WHITESPACE = /\s/u;
		/**
		* Whether a live trigger token ('/' or '@' at a word boundary) sits at the
		* caret — the menu-open fallback when the inputTriggers service is missing.
		* Mirrors the slash pipeline's boundary rules: a trigger opens at
		* start-of-draft, after whitespace, or after punctuation; '/' additionally
		* stays dead directly after '/' and after a scheme separator (`https:/…`).
		* @param draft - composer draft text.
		* @param caret - caret offset into `draft`.
		*/
		function hasActiveTriggerToken(draft, caret) {
			for (let i = caret - 1; i >= 0; i--) {
				const ch = draft.charAt(i);
				if (WHITESPACE.test(ch)) return false;
				if (ch !== "/" && ch !== "@") continue;
				if (i > 0) {
					const prev = draft.charAt(i - 1);
					if (WORD_CHAR.test(prev)) continue;
					if (ch === "/") {
						if (prev === "/") continue;
						if (prev === ":" && i >= 2 && !WHITESPACE.test(draft.charAt(i - 2))) continue;
					}
				}
				return true;
			}
			return false;
		}
		/** Logical ↑ edge: the caret sits on the first line (or the draft has one line). */
		function upAtLogicalEdge(draft, caret) {
			const firstNewline = draft.indexOf("\n");
			return firstNewline === -1 || caret <= firstNewline;
		}
		/** Logical ↓ edge: the caret sits on the last line. */
		function downAtLogicalEdge(draft, caret) {
			return caret > draft.lastIndexOf("\n");
		}
		/**
		* Keyboard/composition/selection gate shared by every key. Modifier sets
		* allowed: none, or Ctrl alone on the arrows when enableCtrlAlias is on.
		* @param frame - the key press facts.
		* @param options - tunables.
		*/
		function keysAllowed(frame, options) {
			if (frame.isComposing || frame.hasSelection) return false;
			if (frame.altKey || frame.metaKey || frame.shiftKey) return false;
			if (frame.key === "escape") return !frame.ctrlKey;
			return !frame.ctrlKey || options.enableCtrlAlias;
		}
		/** Interception gate: keyboard facts plus the input phase and the picker state. */
		function interceptionGate(frame, options) {
			if (frame.phase !== "plain") return false;
			if (frame.menuOpen) return false;
			return keysAllowed(frame, options);
		}
		/**
		* The draft-recall machine. All mutation stays inside; every method is a
		* pure function of its arguments plus the internal state.
		*/
		var DraftRecall = class {
			options;
			state = { kind: "idle" };
			/** @param options - resolved tunables (the plugin Config output). */
			constructor(options) {
				this.options = options;
			}
			/** Current state (tests and diagnostics). */
			stateOf() {
				return this.state;
			}
			/** Leave browsing without touching the draft (session switch, teardown). */
			reset() {
				this.state = { kind: "idle" };
			}
			/**
			* User edit guard: when browsing and the draft diverged from the browsed
			* entry, the edit becomes the new draft and browsing ends. Called on every
			* composer input event with the live DOM value (which already carries the
			* edit at capture time).
			* @param draft - the composer's current value.
			*/
			noteDraftChange(draft) {
				const state = this.state;
				if (state.kind !== "browsing") return;
				if (draft !== state.history[state.index]) this.state = { kind: "idle" };
			}
			/**
			* ↑: in IDLE the first recall stashes {draft, caret} and fills the newest
			* entry (gated by recallWithDraft); while browsing an eligible ↑ walks one
			* entry older, stopping at index 0 with a hold.
			* @param frame - key facts plus the fresh history extraction.
			* @returns the effect to apply.
			*/
			up(frame) {
				if (!interceptionGate(frame, this.options) || !frame.upEdge) return { kind: "pass" };
				const history = frame.history;
				const state = this.state;
				if (state.kind === "idle") {
					if (history.length === 0) return { kind: "pass" };
					if (this.options.recallWithDraft === "gate" && frame.draft !== "") return { kind: "pass" };
					const index = history.length - 1;
					const text = history[index];
					if (text === void 0) return { kind: "pass" };
					this.state = {
						kind: "browsing",
						index,
						savedDraft: frame.draft,
						savedCaret: frame.caret,
						history
					};
					return {
						kind: "fill",
						text
					};
				}
				if (history.length === 0) {
					this.state = { kind: "idle" };
					return { kind: "pass" };
				}
				const index = Math.min(state.index, history.length - 1);
				if (index <= 0) {
					this.state = {
						...state,
						index,
						history
					};
					return { kind: "hold" };
				}
				const next = index - 1;
				const text = history[next];
				if (text === void 0) return { kind: "pass" };
				this.state = {
					...state,
					index: next,
					history
				};
				return {
					kind: "fill",
					text
				};
			}
			/**
			* ↓: IDLE always passes (plain caret movement). While browsing an eligible
			* ↓ walks one entry newer; at the newest entry it restores the stashed
			* draft (and caret, when restoreCaret) and returns to IDLE.
			* @param frame - key facts plus the fresh history extraction.
			* @returns the effect to apply.
			*/
			down(frame) {
				if (!interceptionGate(frame, this.options)) return { kind: "pass" };
				const state = this.state;
				if (state.kind === "idle") return { kind: "pass" };
				const history = frame.history;
				if (history.length === 0) {
					this.state = { kind: "idle" };
					return { kind: "pass" };
				}
				if (!frame.downEdge) return { kind: "pass" };
				const index = Math.min(state.index, history.length - 1);
				if (index < history.length - 1) {
					const next = index + 1;
					const text = history[next];
					if (text === void 0) return { kind: "pass" };
					this.state = {
						...state,
						index: next,
						history
					};
					return {
						kind: "fill",
						text
					};
				}
				this.state = { kind: "idle" };
				return this.options.restoreCaret ? {
					kind: "restore",
					text: state.savedDraft,
					caret: state.savedCaret
				} : {
					kind: "restore",
					text: state.savedDraft
				};
			}
			/**
			* Esc: while browsing and restoreOnEscape is on, restore the stashed draft
			* (and caret) and return to IDLE, consuming the key. Every other Esc —
			* including while the menu or a popup owns it — passes untouched.
			* @param frame - key facts.
			* @returns the effect to apply.
			*/
			escape(frame) {
				if (!this.options.restoreOnEscape) return { kind: "pass" };
				if (!interceptionGate(frame, this.options)) return { kind: "pass" };
				const state = this.state;
				if (state.kind === "idle") return { kind: "pass" };
				this.state = { kind: "idle" };
				return this.options.restoreCaret ? {
					kind: "restore",
					text: state.savedDraft,
					caret: state.savedCaret
				} : {
					kind: "restore",
					text: state.savedDraft
				};
			}
		};
		//#endregion
		//#region src/input-recall.js
		const bindings = /* @__PURE__ */ new WeakMap();
		const options = {
			recallWithDraft: "save",
			restoreOnEscape: true,
			edgeMode: "logical",
			enableCtrlAlias: false,
			restoreCaret: false
		};
		/** 只投影已发布的当前Chat人类消息，不拉历史、不保留另一个索引。 */
		function historyOf(chat) {
			if (!chat?.nodes?.values) return [];
			const nodes = [...chat.nodes.values()].filter((node) => ["user", "steering"].includes(node.kind) && node.data?.source?.kind === "user");
			nodes.sort((a, b) => a.data.seq - b.data.seq);
			return extractHistory(nodes.map((node) => ({
				kind: "user",
				texts: node.data.content.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text)
			})));
		}
		/** 只读原输入的纯文字逻辑位置；Range不是浏览器Selection，生产不写光标。 */
		function caretOf(editor, draft) {
			if (draft === "") return {
				caret: 0,
				hasSelection: false
			};
			const selection = editor.ownerDocument.getSelection();
			if (!selection || !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) return {
				caret: 0,
				hasSelection: true
			};
			const range = editor.ownerDocument.createRange();
			range.selectNodeContents(editor);
			range.setEnd(selection.anchorNode, selection.anchorOffset);
			const text = (node) => {
				if (node.nodeType === 3) return node.data;
				if (node.nodeName === "BR") return "\n";
				if (node.nodeName === "P" && node.childNodes.length === 1 && node.firstChild.nodeName === "BR") return "";
				return [...node.childNodes].map(text).join("");
			};
			const prefix = [...range.cloneContents().childNodes].map(text).join("\n");
			return {
				caret: Math.min(prefix.length, draft.length),
				hasSelection: !selection.isCollapsed
			};
		}
		/** 一个原输入卡片只保一个绑定；旧disposer不得撤掉后来的所有者。 */
		function bindInputRecall(card, read) {
			bindings.get(card)?.();
			const recall = new DraftRecall(options);
			let active = true, scope, actions, composing = false, compositionUntil = 0, lastWrite;
			const reset = () => {
				recall.reset();
				lastWrite = void 0;
			};
			const input = () => {
				reset();
			};
			const start = () => {
				composing = true;
			};
			const end = () => {
				composing = false;
				compositionUntil = Date.now() + 10;
			};
			const keydown = (event) => {
				if (!active || event.defaultPrevented || ![
					"ArrowUp",
					"ArrowDown",
					"Escape"
				].includes(event.key)) return;
				const editor = event.target?.closest?.("[data-composer-input][contenteditable=\"true\"]");
				if (!editor || !card.contains(editor) || event.target.closest("[data-composer-overlay]")) return;
				const frame = read();
				if (!frame?.input || !frame.actions || frame.sessionId === void 0) return;
				if (scope !== frame.sessionId || actions !== frame.actions) {
					reset();
					scope = frame.sessionId;
					actions = frame.actions;
				}
				const state = frame.input;
				if (state.attachmentIds.length || state.occurrences.length || state.phase !== "plain") {
					reset();
					return;
				}
				const pending = lastWrite && state.draft === lastWrite.before && state.draftRev === lastWrite.rev;
				const draft = pending ? lastWrite.text : state.draft;
				recall.noteDraftChange(draft);
				if (lastWrite && !pending && state.draft !== lastWrite.text) lastWrite = void 0;
				const { caret, hasSelection } = caretOf(editor, draft);
				const key = event.key === "ArrowUp" ? "up" : event.key === "ArrowDown" ? "down" : "escape";
				const effect = recall[key]({
					key,
					ctrlKey: event.ctrlKey,
					altKey: event.altKey,
					metaKey: event.metaKey,
					shiftKey: event.shiftKey,
					isComposing: composing || Date.now() < compositionUntil || event.isComposing || event.keyCode === 229 || editor.hasAttribute("data-composer-composing"),
					hasSelection,
					phase: state.phase,
					menuOpen: hasActiveTriggerToken(draft, caret),
					draft,
					caret,
					history: historyOf(frame.chat),
					upEdge: upAtLogicalEdge(draft, caret),
					downEdge: downAtLogicalEdge(draft, caret)
				});
				if (effect.kind === "pass") return;
				event.preventDefault();
				if (effect.kind === "fill" || effect.kind === "restore") {
					lastWrite = {
						before: state.draft,
						rev: state.draftRev,
						text: effect.text
					};
					frame.actions.setDraft(effect.text);
				}
			};
			card.addEventListener("keydown", keydown);
			card.addEventListener("input", input);
			card.addEventListener("compositionstart", start);
			card.addEventListener("compositionend", end);
			const stop = () => {
				if (!active) return;
				active = false;
				card.removeEventListener("keydown", keydown);
				card.removeEventListener("input", input);
				card.removeEventListener("compositionstart", start);
				card.removeEventListener("compositionend", end);
				reset();
				if (bindings.get(card) === stop) bindings.delete(card);
			};
			bindings.set(card, stop);
			return stop;
		}
		/** 标准session props是唯一数据入口；隐藏锚点只定位原卡片，不替换编辑器。 */
		function InputRecall({ sessionId, useSession, useConversation, useInput, inputActions }) {
			const marker = (0, react.useRef)(null);
			const current = (0, react.useRef)(null);
			const session = useSession((state) => state);
			current.current = {
				sessionId,
				input: useInput((state) => state),
				chat: useConversation((state) => state.views.get("chat")),
				actions: inputActions
			};
			(0, react.useLayoutEffect)(() => {
				const card = marker.current?.closest("[data-composer-card]");
				if (!card || session.removed) return;
				return bindInputRecall(card, () => current.current);
			}, [
				sessionId,
				inputActions,
				session.removed
			]);
			return (0, react.createElement)("span", {
				hidden: true,
				ref: marker,
				"data-dsh-input-recall": ""
			});
		}
		function installInputRecall(ctx) {
			return ctx.slots.inject("conversation.input.overlay", () => ctx.slots.register({
				name: "conversation.input.overlay",
				id: "dsh-remote-hosts.input-recall"
			}, InputRecall));
		}
		//#endregion
		//#region ../remote-hosts-settings-rc1/src/client/RemoteHostsSection.jsx
		const card = {
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 12,
			padding: "12px 14px",
			display: "flex",
			flexDirection: "column",
			gap: 8
		};
		const row = {
			display: "flex",
			gap: 8,
			flexWrap: "wrap",
			alignItems: "center"
		};
		const button = {
			font: "inherit",
			padding: "4px 10px",
			borderRadius: 8,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-secondary, transparent)",
			color: "var(--dsw-alias-label-primary)",
			cursor: "pointer"
		};
		const input = {
			font: "inherit",
			padding: "4px 8px",
			borderRadius: 8,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "transparent",
			color: "inherit",
			colorScheme: "light dark"
		};
		const muted = {
			margin: 0,
			fontSize: 12,
			lineHeight: "18px",
			color: "var(--dsw-alias-label-tertiary)"
		};
		const optionStyle = {
			color: "var(--dsw-alias-label-primary, #222)",
			background: "var(--dsw-alias-bg-base, #fff)"
		};
		function browserDiagnosticsSnapshot() {
			if (typeof window === "undefined") return "notAvailable";
			const diagnostics = window.__DSH_REMOTE_DIAGNOSTICS__;
			if (typeof diagnostics?.snapshot !== "function") return "notAvailable";
			try {
				return diagnostics.snapshot() ?? "notAvailable";
			} catch {
				return "notAvailable";
			}
		}
		function downloadDiagnostics(value) {
			const objectUrl = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
			const link = document.createElement("a");
			link.href = objectUrl;
			link.download = "dsh-remote-diagnostics.json";
			try {
				document.body?.appendChild(link);
				link.click();
			} finally {
				link.remove();
				const revoke = () => URL.revokeObjectURL(objectUrl);
				if (typeof window !== "undefined" && typeof window.setTimeout === "function") window.setTimeout(revoke, 0);
				else revoke();
			}
		}
		function errorText(t, code) {
			if (!code) return "";
			const key = `error_${code}`;
			const text = t(key);
			return text === key ? t("error_HOST_UNAVAILABLE") : text;
		}
		function HostCard({ host, t, busy, onAction, onEdit }) {
			const state = t(`state_${host.state}`) === `state_${host.state}` ? host.state : t(`state_${host.state}`);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				style: card,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: row,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: {
								width: 8,
								height: 8,
								borderRadius: "50%",
								background: host.state === "connected" ? "var(--dsw-alias-success, #3c3)" : "var(--dsw-alias-label-tertiary)"
							} }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: host.kind === "local" ? t("local") : host.label }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: muted,
								children: state
							})
						]
					}),
					host.kind === "remote" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						style: muted,
						children: [
							host.alias,
							" · 127.0.0.1:",
							host.localPort,
							" → 127.0.0.1:",
							host.remotePort,
							" · ",
							host.launch
						]
					}),
					host.kind === "local" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						style: muted,
						children: ["127.0.0.1:", host.localPort]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: muted,
						children: host.helperReadable ? t("helperYes") : t("helperNo")
					}),
					host.lastError && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: muted,
						children: errorText(t, host.lastError)
					}),
					host.kind === "local" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: row,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: button,
							disabled: busy || !host.restartAvailable,
							title: host.restartAvailable ? void 0 : t("localRestartUnavailable"),
							onClick: () => onAction("restart", host),
							children: t("restart")
						})
					}),
					host.kind === "remote" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: row,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: button,
								disabled: busy,
								onClick: () => onEdit(host),
								children: t("edit")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: button,
								disabled: busy,
								onClick: () => onAction("retry", host),
								children: t("retry")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: button,
								disabled: busy,
								onClick: () => onAction("disconnect", host),
								children: t("disconnect")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: button,
								disabled: busy || !host.restartAvailable,
								title: host.restartAvailable ? void 0 : t("restartUnavailable"),
								onClick: () => onAction("restart", host),
								children: t("restart")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: button,
								disabled: busy,
								onClick: () => onAction("remove", host),
								children: t("remove")
							})
						]
					})
				]
			});
		}
		function RemoteHostsSection({ hostsApi, t }) {
			const [data, setData] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)("");
			const [busy, setBusy] = (0, react.useState)(false);
			const [exportBusy, setExportBusy] = (0, react.useState)(false);
			const [aliases, setAliases] = (0, react.useState)([]);
			const [draft, setDraft] = (0, react.useState)(null);
			const [editingId, setEditingId] = (0, react.useState)(null);
			const requests = (0, react.useRef)({
				live: true,
				generation: 0,
				refreshing: false,
				mutating: false,
				exporting: false
			});
			const refresh = (0, react.useCallback)(async () => {
				const state = requests.current;
				if (!state.live || state.refreshing || state.mutating) return;
				state.refreshing = true;
				const generation = state.generation;
				try {
					const value = await hostsApi.call("status");
					if (!state.live || generation !== state.generation) return;
					setData(value);
					setError("");
				} catch (reason) {
					if (!state.live || generation !== state.generation) return;
					setError(errorText(t, reason.code ?? reason.message));
				} finally {
					state.refreshing = false;
				}
			}, [hostsApi, t]);
			(0, react.useEffect)(() => {
				const releaseInventory = hostsApi.mountStatusView?.();
				requests.current.live = true;
				refresh();
				const timer = setInterval(() => {
					refresh();
				}, 4e3);
				return () => {
					clearInterval(timer);
					requests.current.live = false;
					requests.current.generation++;
					releaseInventory?.();
				};
			}, [refresh]);
			const run = async (endpoint, payload, confirmText) => {
				const state = requests.current;
				if (!state.live || state.mutating) return false;
				if (confirmText && !window.confirm(confirmText)) return false;
				state.mutating = true;
				const generation = ++state.generation;
				setBusy(true);
				try {
					const value = await hostsApi.call(endpoint, payload);
					if (!state.live || generation !== state.generation) return false;
					setData(value);
					setError("");
					return true;
				} catch (reason) {
					if (!state.live || generation !== state.generation) return false;
					setError(errorText(t, reason.code ?? reason.message));
					return false;
				} finally {
					state.mutating = false;
					if (state.live) setBusy(false);
				}
			};
			const openAdd = async () => {
				const state = requests.current;
				if (!state.live || state.mutating) return;
				const generation = state.generation;
				try {
					const listed = await hostsApi.call("discoverAliases");
					if (!state.live || generation !== state.generation) return;
					setAliases(listed.aliases ?? []);
					setEditingId(null);
					setDraft({
						alias: listed.aliases?.[0] ?? "",
						label: listed.aliases?.[0] ?? "",
						localPort: data?.suggestedLocalPort ?? 33080,
						remotePort: 3080,
						launch: "none"
					});
					setError("");
				} catch (reason) {
					if (!state.live || generation !== state.generation) return;
					setError(errorText(t, reason.code ?? reason.message));
				}
			};
			const openEdit = (host) => {
				setEditingId(host.id);
				setDraft({
					alias: host.alias,
					label: host.label,
					localPort: host.localPort,
					remotePort: host.remotePort,
					launch: host.launch,
					enabled: host.enabled
				});
			};
			const saveDraft = async () => {
				if (!draft || editingId === null && !draft.alias) return;
				const endpoint = editingId === null ? "add" : "update";
				const payload = editingId === null ? draft : {
					...draft,
					hostId: editingId
				};
				if (await run(endpoint, payload)) {
					setDraft(null);
					setEditingId(null);
				}
			};
			const onAction = (action, host) => {
				if (action === "restart") return run("restart", { hostId: host.id }, t("restartConfirm").replace("{label}", host.label));
				if (action === "remove") return run("remove", { hostId: host.id }, t("removeConfirm").replace("{label}", host.label));
				return run(action, { hostId: host.id });
			};
			const exportDiagnostics = async () => {
				const state = requests.current;
				if (!state.live || state.mutating || state.exporting) return;
				state.exporting = true;
				setExportBusy(true);
				try {
					const serverDiagnostics = await hostsApi.call("exportDiagnostics", {});
					if (!state.live) return;
					downloadDiagnostics({
						...serverDiagnostics,
						browser: browserDiagnosticsSnapshot()
					});
					setError("");
				} catch (reason) {
					if (!state.live) return;
					setError(errorText(t, reason.code ?? reason.message));
				} finally {
					state.exporting = false;
					if (state.live) setExportBusy(false);
				}
			};
			const pageBusy = busy || exportBusy;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					gap: 12,
					maxWidth: 640,
					color: "var(--dsw-alias-label-primary)"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						style: {
							margin: 0,
							fontSize: 16
						},
						children: t("title")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: muted,
						children: t("intro")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: muted,
						children: t("diagnosticsScope")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						disabled: pageBusy,
						style: {
							...button,
							alignSelf: "flex-start"
						},
						onClick: () => {
							exportDiagnostics();
						},
						children: exportBusy ? t("exportDiagnosticsBusy") : t("exportDiagnostics")
					}),
					error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: muted,
						children: error
					}),
					(data?.hosts ?? []).map((host) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(HostCard, {
						host,
						t,
						busy: pageBusy,
						onAction,
						onEdit: openEdit
					}, host.id)),
					draft ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						style: card,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: editingId === null ? t("add") : t("edit") }),
							editingId === null && aliases.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: muted,
								children: t("emptyAliases")
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								editingId === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									style: muted,
									children: [t("alias"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
										style: {
											...input,
											marginLeft: 8
										},
										value: draft.alias,
										onChange: (event) => setDraft({
											...draft,
											alias: event.target.value,
											label: draft.label || event.target.value
										}),
										children: aliases.map((alias) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: alias,
											style: optionStyle,
											children: alias
										}, alias))
									})]
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
									style: muted,
									children: [
										t("alias"),
										": ",
										draft.alias
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									style: muted,
									children: [t("label"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										style: {
											...input,
											marginLeft: 8
										},
										value: draft.label,
										onChange: (event) => setDraft({
											...draft,
											label: event.target.value
										})
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									style: muted,
									children: [t("localPort"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										style: {
											...input,
											marginLeft: 8,
											width: 80
										},
										type: "number",
										value: draft.localPort,
										onChange: (event) => setDraft({
											...draft,
											localPort: Number(event.target.value)
										})
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									style: muted,
									children: [t("remotePort"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										style: {
											...input,
											marginLeft: 8,
											width: 80
										},
										type: "number",
										value: draft.remotePort,
										onChange: (event) => setDraft({
											...draft,
											remotePort: Number(event.target.value)
										})
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									style: muted,
									children: [t("launch"), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
										style: {
											...input,
											marginLeft: 8
										},
										value: draft.launch,
										onChange: (event) => setDraft({
											...draft,
											launch: event.target.value
										}),
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "none",
											style: optionStyle,
											children: t("launchNone")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "systemd-user",
											style: optionStyle,
											children: t("launchSystemd")
										})]
									})]
								})
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: row,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: button,
									disabled: pageBusy || editingId === null && !draft.alias,
									onClick: () => {
										saveDraft();
									},
									children: t("save")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: button,
									disabled: pageBusy,
									onClick: () => {
										setDraft(null);
										setEditingId(null);
									},
									children: t("cancel")
								})]
							})
						]
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						disabled: pageBusy,
						style: {
							...button,
							alignSelf: "flex-start"
						},
						onClick: () => {
							openAdd();
						},
						children: t("add")
					})
				]
			});
		}
		//#endregion
		//#region ../remote-hosts-settings-rc1/src/client/locales.js
		const en = {
			nav: "Remote hosts",
			title: "Remote hosts",
			intro: "This computer talks to other DSH instances over OpenSSH aliases from your SSH config. Closing this page or disconnecting a tunnel does not stop remote DSH. Tailscale is configured in the Tailscale app, not here.",
			diagnosticsScope: "Exports local forwarding and this page's diagnostics only; session content and credentials are excluded.",
			exportDiagnostics: "Export diagnostics",
			exportDiagnosticsBusy: "Exporting diagnostics…",
			local: "This computer",
			add: "Add host",
			edit: "Edit host",
			alias: "SSH alias",
			label: "Display name",
			localPort: "Local forward port",
			remotePort: "Remote DSH port",
			launch: "If remote DSH is down",
			launchNone: "Do not start it",
			launchSystemd: "Restart via systemd --user",
			retry: "Retry connection",
			disconnect: "Disconnect tunnel",
			restart: "Restart DSH",
			restartConfirm: "Restart DSH on {label}? Sessions on that computer will be interrupted. Other hosts are unaffected. This is not a tunnel disconnect.",
			remove: "Remove registration",
			removeConfirm: "Remove {label} from this Hub? Remote DSH and remote files are not stopped or deleted.",
			save: "Save",
			cancel: "Cancel",
			enabled: "Connect automatically",
			emptyAliases: "No unused concrete aliases in the SSH config.",
			unavailable: "Host list is unavailable.",
			state_offline: "offline",
			state_connecting: "connecting",
			state_connected: "online",
			state_disabled: "disabled",
			helperYes: "Bootstrap helper readable",
			helperNo: "Bootstrap helper not readable",
			restartUnavailable: "Restart needs launch=systemd-user on that host.",
			localRestartUnavailable: "Local restart is unavailable in this runtime.",
			error_FORWARD: "SSH forward failed",
			error_BOOTSTRAP_READ: "Could not read remote bootstrap helper",
			error_BOOTSTRAP_VALIDATE: "Remote bootstrap helper was invalid",
			error_AUTHENTICATION: "Official root authentication failed",
			error_HOST_CONNECTION_FAILED_FORWARD: "SSH forward failed",
			error_HOST_CONNECTION_FAILED_BOOTSTRAP_READ: "Could not read remote bootstrap helper",
			error_HOST_CONNECTION_FAILED_BOOTSTRAP_VALIDATE: "Remote bootstrap helper was invalid",
			error_HOST_CONNECTION_FAILED_AUTHENTICATION: "Official root authentication failed",
			error_RESTART_UNSUPPORTED: "No service manager for restart",
			error_RESTART_FAILED: "Remote DSH restart failed",
			error_LOCAL_RESTART_IDENTITY: "The local runtime identity changed; restart was refused.",
			error_LOCAL_RESTART_BROKER_FAILED: "The local restart broker failed before exit.",
			error_LOCAL_RESTART_READY_TIMEOUT: "The local restart broker did not become ready.",
			error_LOCAL_RESTART_PORT_OCCUPIED: "The configured local port is owned by an unexpected process.",
			error_LOCAL_RESTART_LAUNCH_FAILED: "The managed local launcher could not start DSH.",
			error_MANAGED_RUNTIME_BUSY: "Another managed local launcher is already running.",
			error_HOST_UNAVAILABLE: "Request failed"
		};
		const zh = {
			nav: "远程主机",
			title: "远程主机",
			intro: "本机通过 OpenSSH 配置里的 alias 连接其他 DSH。关闭页面或断开隧道不会停止远端 DSH。Tailscale 在 Tailscale 应用中配置，不在本页。",
			diagnosticsScope: "仅导出本机转发与当前页面诊断，不含会话正文和凭据。",
			exportDiagnostics: "导出诊断日志",
			exportDiagnosticsBusy: "正在导出诊断日志…",
			local: "本机",
			add: "添加主机",
			edit: "编辑主机",
			alias: "SSH alias",
			label: "显示名",
			localPort: "本机转发端口",
			remotePort: "远端 DSH 端口",
			launch: "远端 DSH 未运行时",
			launchNone: "不远程拉起",
			launchSystemd: "用 systemd --user 重启服务",
			retry: "重试连接",
			disconnect: "断开隧道",
			restart: "重启 DSH",
			restartConfirm: "重启 {label} 上的 DSH？那台电脑上的会话会中断。其他主机不受影响。这不是断开隧道。",
			remove: "去掉登记",
			removeConfirm: "从 Hub 去掉 {label}？不会停止远端 DSH，也不会删除远端文件。",
			save: "保存",
			cancel: "取消",
			enabled: "自动连接",
			emptyAliases: "SSH 配置里没有尚未使用的具体 alias。",
			unavailable: "无法读取主机列表。",
			state_offline: "离线",
			state_connecting: "连接中",
			state_connected: "在线",
			state_disabled: "已停用",
			helperYes: "可读 bootstrap helper",
			helperNo: "读不到 bootstrap helper",
			restartUnavailable: "重启需要该主机的 launch 为 systemd-user。",
			localRestartUnavailable: "当前运行时没有可用的本机重启能力。",
			error_FORWARD: "SSH 转发失败",
			error_BOOTSTRAP_READ: "读不到远端 bootstrap helper",
			error_BOOTSTRAP_VALIDATE: "远端 bootstrap helper 无效",
			error_AUTHENTICATION: "官方根路径认证失败",
			error_HOST_CONNECTION_FAILED_FORWARD: "SSH 转发失败",
			error_HOST_CONNECTION_FAILED_BOOTSTRAP_READ: "读不到远端 bootstrap helper",
			error_HOST_CONNECTION_FAILED_BOOTSTRAP_VALIDATE: "远端 bootstrap helper 无效",
			error_HOST_CONNECTION_FAILED_AUTHENTICATION: "官方根路径认证失败",
			error_RESTART_UNSUPPORTED: "没有可用于重启的服务管理器",
			error_RESTART_FAILED: "远端 DSH 重启失败",
			error_LOCAL_RESTART_IDENTITY: "本机运行时身份已变化，已拒绝重启。",
			error_LOCAL_RESTART_BROKER_FAILED: "本机重启 broker 在退出前失败。",
			error_LOCAL_RESTART_READY_TIMEOUT: "本机重启 broker 未在时限内就绪。",
			error_LOCAL_RESTART_PORT_OCCUPIED: "配置的本机端口由非预期进程占用。",
			error_LOCAL_RESTART_LAUNCH_FAILED: "受控本机 launcher 无法启动 DSH。",
			error_MANAGED_RUNTIME_BUSY: "已有受控本机 launcher 正在运行。",
			error_HOST_UNAVAILABLE: "请求失败"
		};
		//#endregion
		//#region ../remote-hosts-settings-rc1/src/client/index.js
		var client_exports = /* @__PURE__ */ __exportAll({
			apply: () => apply$1,
			inject: () => inject$1
		});
		const NS$2 = "settings.remoteHosts";
		const inject$1 = [
			"slots",
			"remoteHostsInterface",
			"locale"
		];
		function apply$1(ctx) {
			ctx.effect(() => ctx.locale.register(NS$2, {
				zh,
				en
			}), "remote-hosts-settings-rc1: copy");
			const original = ctx.get("remoteHostsInterface"), labels = ctx.get("remoteWorkspaceHostLabels");
			const hostsApi = labels ? labels.managementClient(original) : original;
			const t = ctx.locale.bind(NS$2);
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "remote-hosts",
				order: 80,
				label: () => t("nav"),
				locale: NS$2,
				inject: () => ({
					hostsApi,
					t
				})
			}, RemoteHostsSection));
		}
		//#endregion
		//#region ../runtime-interface/src/client/workspace-recency.js
		const RECENCY = Symbol.for("dsh.runtime-interface.workspace-recency");
		const identity = (value) => value;
		const adapters = /* @__PURE__ */ new WeakMap();
		/** 只派生展示items：成员最新数字时间降序，同值及空组保原相对顺序。 */
		function workspaceRecencySnapshot(snapshot, sessions) {
			if (!Array.isArray(snapshot?.items) || snapshot.items.length < 2) return snapshot;
			const ranked = snapshot.items.map((workspace, index) => ({
				workspace,
				index,
				time: (workspace.sessionIds ?? []).reduce((latest, id) => {
					const value = sessions?.byId?.[id]?.updatedAt;
					return Number.isFinite(value) ? Math.max(latest, value) : latest;
				}, -Infinity)
			})).sort((a, b) => b.time - a.time || a.index - b.index);
			if (ranked.every((row, index) => row.index === index)) return snapshot;
			return {
				...snapshot,
				items: ranked.map((row) => row.workspace)
			};
		}
		/** 保原entry/children/store授权。只恢复仍由本次拥有的component，不覆盖其它后装所有者。 */
		function installWorkspaceRecency(entry) {
			const original = entry?.component;
			if (typeof original !== "function" || original[RECENCY]) return () => {};
			const previous = adapters.get(entry);
			if (previous?.original === original) return previous.mount();
			const mounted = /* @__PURE__ */ new Set();
			let active = true;
			function RecencyProjection(props) {
				const groupBy = props.useStore((state) => state.groupBy);
				const orderBy = props.useStore((state) => state.orderBy);
				const sessions = props.useSessions(identity);
				const enabled = groupBy === "workspace" && orderBy === "updated";
				const project = (0, react.useMemo)(() => {
					const cache = /* @__PURE__ */ new WeakMap();
					return (snapshot) => {
						if (!snapshot || typeof snapshot !== "object") return snapshot;
						if (!cache.has(snapshot)) cache.set(snapshot, workspaceRecencySnapshot(snapshot, sessions));
						return cache.get(snapshot);
					};
				}, [sessions]);
				const useWorkspaces = (0, react.useMemo)(() => function useRecencyWorkspaces(selector = identity, ...args) {
					return props.useWorkspaces((snapshot) => selector(project(snapshot)), ...args);
				}, [props.useWorkspaces, project]);
				return (0, react.createElement)(original, enabled ? {
					...props,
					useWorkspaces
				} : props);
			}
			function WorkspaceRecency(props) {
				const [enabled, setEnabled] = (0, react.useState)(active);
				(0, react.useEffect)(() => {
					mounted.add(setEnabled);
					setEnabled(active);
					return () => mounted.delete(setEnabled);
				}, []);
				return (0, react.createElement)(enabled ? RecencyProjection : original, props);
			}
			Object.defineProperty(WorkspaceRecency, RECENCY, { value: true });
			function mount() {
				active = true;
				entry.component = WorkspaceRecency;
				for (const update of mounted) update(true);
				return () => {
					active = false;
					for (const update of mounted) update(false);
					if (entry.component === WorkspaceRecency) entry.component = original;
				};
			}
			adapters.set(entry, {
				original,
				mount
			});
			return mount();
		}
		//#endregion
		//#region src/workspace-host-labels.js
		const NS$1 = "remote-hosts.workspace-host-labels";
		/** CSS字符串和style闭标签均作转义，名称只作为文字，不成为选择器或HTML。 */
		function quoted(value) {
			return "\"" + String(value).replace(/[\u0000-\u001f\u007f"\\<>]/g, (char) => "\\" + char.codePointAt(0).toString(16) + " ") + "\"";
		}
		function workspaceHostStyles(hosts, selector, unknown, flat = false) {
			const rules = [selector() + "::after{content:" + quoted(unknown) + ";order:1;flex:0 1 auto;min-inline-size:0;max-inline-size:112px;margin-inline-start:4px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;pointer-events:none;}", selector() + "::before{content:\"\";order:2;width:7px;height:7px;border-radius:50%;flex:none;margin-inline-start:1px;background:var(--dsw-alias-label-tertiary,#777);pointer-events:none;}"];
			if (flat) {
				rules.push(selector() + "::before{margin-inline-end:4px;align-self:center;}");
				rules.push(selector() + " > span[class$=\"_time\"]{order:3;}");
				rules.push(selector() + ":not(" + selector("local") + ") > span[class$=\"_time\"]{min-inline-size:4em;text-align:right;}");
				rules.push(selector() + " > span[class$=\"_pinIndicator\"]{order:4;}");
				rules.push(selector() + " > span[class$=\"_rowActions\"]{order:5;}");
			}
			rules.push(selector("local") + "::after{content:none;display:none;}");
			rules.push(selector("local") + "::before{content:none;display:none;}");
			const seen = /* @__PURE__ */ new Set(["local"]);
			for (const host of hosts) {
				if (seen.has(host.hostId)) continue;
				let target;
				try {
					target = selector(host.hostId);
				} catch {
					continue;
				}
				seen.add(host.hostId);
				rules.push(target + "::after{content:" + quoted(host.label) + ";}");
				const state = String(host.state || "").toLowerCase();
				const color = [
					"connected",
					"online",
					"ready"
				].includes(state) ? "var(--dsw-alias-state-success-primary,#22c55e)" : [
					"connecting",
					"reconnecting",
					"starting"
				].includes(state) ? "var(--dsw-alias-state-warn-primary,#f59e0b)" : "var(--dsw-alias-label-tertiary,#777)";
				rules.push(target + "::before{background:" + color + ";}");
			}
			return rules.join("\n");
		}
		function installWorkspaceHostLabels(ctx, labels) {
			ctx.effect(() => ctx.locale.register(NS$1, {
				zh: { unknown: "未知主机" },
				en: { unknown: "Unknown host" }
			}), "remote-hosts: workspace Host label copy");
			function WorkspaceHostLabels({ t, useStore }) {
				const hosts = (0, react.useSyncExternalStore)(labels.subscribe, labels.getSnapshot);
				const groupBy = useStore((state) => state.groupBy);
				return (0, react.createElement)("style", { "data-dsh-workspace-host-labels": "" }, workspaceHostStyles(hosts, groupBy === "flat" ? labels.sessionHostSelector : labels.workspaceHostSelector, t("unknown"), groupBy === "flat"));
			}
			ctx.slots.inject("shell.overlay", () => ctx.slots.inject("sidebar.workspaces.directoryFlow", () => {
				const entry = ctx.slots.entries("sidebar.workspaces").find((item) => item.children?.["sidebar.workspaces.directoryFlow"]);
				if (!entry?.store || typeof entry.component !== "function") return () => {};
				const restore = installWorkspaceRecency(entry);
				let stop;
				try {
					stop = ctx.slots.register({
						name: "shell.overlay",
						id: "dsh-remote-hosts.workspace-host-labels",
						locale: NS$1,
						store: entry.store
					}, WorkspaceHostLabels);
				} catch (error) {
					restore();
					throw error;
				}
				return () => {
					try {
						stop();
					} finally {
						restore();
					}
				};
			}));
		}
		//#endregion
		//#region ../runtime-interface/src/client/workspace-host-labels.js
		function hostRowSelector(kind, hostId) {
			if (hostId !== void 0 && (typeof hostId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(hostId))) throw new TypeError("HOST_ID_INVALID");
			return `[role="treeitem"][data-row-key^="${kind}:rh1.${hostId === void 0 ? "" : btoa(hostId).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "") + "."}"]`;
		}
		const workspaceHostSelector = (hostId) => hostRowSelector("workspace", hostId);
		const sessionHostSelector = (hostId) => hostRowSelector("session", hostId);
		/** 官方复合工作区身份只在接口叶解释；原生本地ID和未知形状不触发库存读取。 */
		function hasRemoteIdentity(id) {
			const parts = typeof id === "string" ? id.split(".") : [];
			if (parts.length !== 3 || parts[0] !== "rh1" || !/^[A-Za-z0-9_-]+$/.test(parts[2])) return false;
			try {
				const hostId = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
				return hostId !== "local" && workspaceHostSelector(hostId).includes("rh1." + parts[1] + ".");
			} catch {
				return false;
			}
		}
		function hasRemoteWorkspace(snapshot) {
			return (Array.isArray(snapshot?.items) ? snapshot.items : []).some((item) => hasRemoteIdentity(item?.workspaceId));
		}
		/** 名称和状态共享一份有界显示投影；只读既有认证库存，不触发业务连接。 */
		function createWorkspaceHostLabels(initialHosts) {
			const listeners = /* @__PURE__ */ new Set();
			let statusViews = 0;
			let pendingStatus = 0;
			let inventory;
			const normalize = (hosts) => Object.freeze([...new Map((Array.isArray(hosts) ? hosts : []).flatMap((host) => {
				const hostId = host?.hostId ?? host?.id;
				try {
					workspaceHostSelector(hostId);
				} catch {
					return [];
				}
				if (typeof hostId !== "string") return [];
				return [[hostId, Object.freeze({
					hostId,
					label: typeof host.label === "string" && host.label.trim() ? host.label : hostId,
					state: typeof host.state === "string" ? host.state : "unknown"
				})]];
			})).values()]);
			let roster = normalize(initialHosts);
			const observe = (hosts) => {
				const next = normalize(hosts);
				if (next.length === roster.length && next.every((host, i) => host.hostId === roster[i].hostId && host.label === roster[i].label && host.state === roster[i].state)) return;
				roster = next;
				for (const listener of [...listeners]) try {
					listener();
				} catch {}
			};
			return Object.freeze({
				getSnapshot: () => roster,
				subscribe(fn) {
					listeners.add(fn);
					return () => listeners.delete(fn);
				},
				workspaceHostSelector,
				sessionHostSelector,
				managementClient(api) {
					return Object.freeze({
						...api,
						mountStatusView() {
							statusViews++;
							inventory?.sync();
							let active = true;
							return () => {
								if (active) {
									active = false;
									statusViews--;
									inventory?.sync();
								}
							};
						},
						async call(...args) {
							const status = args[0] === "status";
							if (status) {
								pendingStatus++;
								inventory?.sync();
							}
							try {
								const result = await api.call(...args);
								if (Array.isArray(result.hosts)) observe(result.hosts);
								return result;
							} catch (error) {
								if (args[0] === "status") observe(roster.map((host) => ({
									...host,
									state: "unknown"
								})));
								throw error;
							} finally {
								if (status) {
									pendingStatus--;
									inventory?.sync();
								}
							}
						}
					});
				},
				watchInventory(workspaces, environment = {}) {
					if (inventory) throw new Error("WORKSPACE_HOST_INVENTORY_ALREADY_BOUND");
					const document = environment.document ?? globalThis.document;
					const read = environment.fetch ?? globalThis.fetch;
					const later = environment.setTimeout ?? globalThis.setTimeout;
					const cancel = environment.clearTimeout ?? globalThis.clearTimeout;
					let stopped = false, pending, timer, epoch = 0;
					const sessions = environment.sessions;
					const remoteSession = () => {
						const ids = sessions?.getSnapshot()?.ids;
						return Array.isArray(ids) && ids.some(hasRemoteIdentity);
					};
					const eligible = () => !stopped && document?.visibilityState === "visible" && statusViews === 0 && pendingStatus === 0 && (hasRemoteWorkspace(workspaces.getSnapshot()) || remoteSession());
					const clearTimer = () => {
						if (timer !== void 0) {
							cancel(timer);
							timer = void 0;
						}
					};
					async function refresh() {
						if (!eligible() || pending) return;
						const request = {
							controller: new AbortController(),
							epoch
						};
						pending = request;
						try {
							const response = await read("/api/browser-host-hub-rc1/host-inventory", {
								method: "GET",
								credentials: "same-origin",
								headers: { Accept: "application/json" },
								signal: request.controller.signal
							});
							if (!response.ok) throw new Error("HOST_INVENTORY_UNAVAILABLE");
							const value = await response.json(), seen = /* @__PURE__ */ new Set();
							if (!Array.isArray(value?.hosts) || value.hosts.some((host) => {
								if (!host || typeof host.hostId !== "string" || typeof host.label !== "string" || !host.label.trim() || typeof host.state !== "string" || seen.has(host.hostId)) return true;
								try {
									workspaceHostSelector(host.hostId);
								} catch {
									return true;
								}
								seen.add(host.hostId);
								return false;
							})) throw new Error("HOST_INVENTORY_INVALID");
							if (!request.controller.signal.aborted && request.epoch === epoch && eligible()) {
								const ids = new Set(value.hosts.map((host) => host.hostId));
								observe([...value.hosts, ...roster.filter((host) => !ids.has(host.hostId)).map((host) => ({
									...host,
									state: "unknown"
								}))]);
							}
						} catch {
							if (!request.controller.signal.aborted && request.epoch === epoch && eligible()) observe(roster.map((host) => ({
								...host,
								state: "unknown"
							})));
						} finally {
							if (pending === request) pending = void 0;
							if (eligible()) if (request.controller.signal.aborted) refresh();
							else timer = later(() => {
								timer = void 0;
								refresh();
							}, 4e3);
						}
					}
					function sync() {
						if (!eligible()) {
							epoch++;
							clearTimer();
							pending?.controller.abort();
							return;
						}
						if (!pending && timer === void 0) refresh();
					}
					const owner = { sync };
					inventory = owner;
					const stopWorkspaces = workspaces.subscribe(sync);
					const stopSessions = sessions?.subscribe(sync);
					document?.addEventListener("visibilitychange", sync);
					sync();
					return () => {
						if (stopped) return;
						stopped = true;
						epoch++;
						clearTimer();
						pending?.controller.abort();
						stopWorkspaces();
						stopSessions?.();
						document?.removeEventListener("visibilitychange", sync);
						if (inventory === owner) inventory = void 0;
					};
				}
			});
		}
		//#endregion
		//#region ../runtime-interface/src/client/model-catalog.js
		const fail = (code) => new Error(code);
		function sessionModelHost(sessionId) {
			if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 4096) throw fail("MODEL_SESSION_ID_INVALID");
			if (!sessionId.startsWith("rh1.")) return "local";
			const parts = /^rh1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(sessionId);
			if (!parts) throw fail("MODEL_SESSION_ID_INVALID");
			try {
				const decode = (value) => {
					const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
					const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
					const bytes = new TextEncoder().encode(decoded);
					const canonical = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
					if (!decoded || canonical !== value) throw fail("MODEL_SESSION_ID_INVALID");
					return decoded;
				};
				const host = decode(parts[1]);
				decode(parts[2]);
				if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(host)) throw fail("MODEL_SESSION_ID_INVALID");
				return host;
			} catch {
				throw fail("MODEL_SESSION_ID_INVALID");
			}
		}
		//#endregion
		//#region ../runtime-interface/src/client/workspace-path-menu.js
		const NS = "remote-hosts.workspace-path-menu";
		const installed = /* @__PURE__ */ new WeakMap();
		const emptySubscribe = () => () => {};
		const emptySnapshot = () => void 0;
		const nativeApps = [
			"explorer",
			"finder",
			"filemanager"
		];
		/** ID和路径来自本条权威列表；保留POSIX/Windows原字符串，不引用当前选中会话。 */
		function createWorkspacePathActions({ sessions, workspaces, slots }) {
			const face = () => slots.entries("conversation.session.header.utilities").find((entry) => entry.options.id === "open-in-app")?.inject?.();
			function resolve(kind, id) {
				const row = kind === "workspace" ? workspaces.list.getSnapshot()?.items?.find((item) => item.workspaceId === id) : sessions.list.getSnapshot()?.byId?.[id];
				if (!row || kind === "session" && row.id !== id) return;
				const path = kind === "workspace" ? row.path : row.cwd;
				if (typeof path !== "string" || !path.trim() || path.includes("\0") || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path)) return;
				let host;
				try {
					host = sessionModelHost(id);
				} catch {
					return;
				}
				return {
					path,
					host
				};
			}
			function nativeOpener(target) {
				if (target?.host !== "local") return;
				const value = face(), apps = value?.hooks?.openInAppApps?.getSnapshot();
				const app = nativeApps.find((app) => Array.isArray(apps) && apps.includes(app));
				if (app && typeof value.launch === "function" && ["idle", "error"].includes(value.hooks.openInAppLaunch?.getSnapshot()?.phase)) return {
					value,
					app
				};
			}
			return {
				resolve,
				face,
				canOpen(kind, id) {
					return !!nativeOpener(resolve(kind, id));
				},
				async run(action, kind, id) {
					const target = resolve(kind, id);
					if (!target) throw new Error("WORKSPACE_PATH_UNAVAILABLE");
					if (action === "copy") {
						if (!await (0, _deepseek_ai_dsh_client_ui_primitives.writeClipboard)(target.path)) throw new Error("WORKSPACE_PATH_COPY_FAILED");
					} else if (action === "open") {
						const opener = nativeOpener(target);
						if (!opener) throw new Error("WORKSPACE_FOLDER_OPENER_UNAVAILABLE");
						await opener.value.launch(opener.app, target.path);
					}
				}
			};
		}
		/** Root批准的021局部DOM接缝：只在准确原工作区三点打开期间补普通button，原Menu继续处理键盘/焦点/关闭。 */
		function installWorkspaceGroupMenu({ document, actions, workspaces, slots, locale, t, reportFailure }) {
			installed.get(document)?.();
			let current, disposed = false;
			function clear() {
				const old = current;
				current = void 0;
				old?.stop();
			}
			function onClick(event) {
				const trigger = event.target?.closest?.("button");
				const row = trigger?.closest("[role=\"treeitem\"][data-row-key^=\"workspace:\"]");
				const lane = row?.querySelector("span[class$=\"_rowActions\"]");
				if (!row || trigger !== lane?.firstElementChild?.querySelector("button")) return;
				if (current?.trigger === trigger) {
					clear();
					return;
				}
				clear();
				const id = row.getAttribute("data-row-key").slice(10);
				if (!actions.resolve("workspace", id)) return;
				const entry = slots.entries("sidebar.workspaces").find((entry) => entry.children?.["sidebar.workspaces.directoryFlow"]);
				if (!entry?.locale) return;
				const nativeT = locale.bind(entry.locale);
				const existing = new Set(document.querySelectorAll("[role=\"menu\"]"));
				const added = /* @__PURE__ */ new Map(), stops = [];
				let menu, expiry, stopped = false;
				const stop = () => {
					if (stopped) return;
					stopped = true;
					clearTimeout(expiry);
					observer.disconnect();
					for (const stop of stops) stop();
					for (const node of added.values()) node.remove();
					added.clear();
				};
				const finish = () => {
					if (current?.stop === stop) clear();
					else stop();
				};
				function sync() {
					if (!menu || stopped) return;
					const available = actions.resolve("workspace", id) ? ["copy", ...actions.canOpen("workspace", id) ? ["open"] : []] : [];
					for (const [key, node] of added) if (!available.includes(key)) {
						node.remove();
						added.delete(key);
					}
					const template = menu.querySelector("button[role=\"menuitem\"]")?.parentElement;
					if (!template) return;
					for (const action of available) {
						if (added.has(action)) continue;
						const wrap = template.cloneNode(true), button = wrap.querySelector("button");
						button.querySelector("svg")?.parentElement.remove();
						button.lastElementChild.textContent = t(action);
						button.removeAttribute("aria-keyshortcuts");
						button.dataset.dshWorkspacePathAction = action;
						button.addEventListener("click", () => {
							if (stopped || disposed) return;
							trigger.click();
							if (trigger.isConnected) trigger.focus({ preventScroll: true });
							actions.run(action, "workspace", id).catch(() => reportFailure(action));
						});
						template.parentElement.appendChild(wrap);
						added.set(action, wrap);
					}
				}
				const observer = new MutationObserver((records) => {
					if (menu && !menu.isConnected) {
						finish();
						return;
					}
					if (menu) return;
					const candidates = records.flatMap((record) => [...record.addedNodes]).filter((node) => node.nodeType === 1 && node.getAttribute("role") === "menu" && !existing.has(node));
					for (const candidate of candidates) {
						const buttons = [...candidate.querySelectorAll("button[role=\"menuitem\"]")];
						if (buttons.length !== 2 || buttons[0].textContent !== nativeT("rename") || buttons[1].textContent !== nativeT("delete.workspace")) continue;
						if (!trigger.isConnected || !row.isConnected) {
							finish();
							return;
						}
						menu = candidate;
						clearTimeout(expiry);
						sync();
						stops.push(workspaces.list.subscribe(sync));
						const hooks = actions.face()?.hooks;
						if (hooks?.openInAppApps) stops.push(hooks.openInAppApps.subscribe(sync));
						if (hooks?.openInAppLaunch) stops.push(hooks.openInAppLaunch.subscribe(sync));
						return;
					}
				});
				current = {
					trigger,
					stop
				};
				observer.observe(document.body, { childList: true });
				expiry = setTimeout(() => {
					if (!menu) finish();
				}, 0);
			}
			document.addEventListener("click", onClick, true);
			const dispose = () => {
				if (disposed) return;
				disposed = true;
				clear();
				document.removeEventListener("click", onClick, true);
				if (installed.get(document) === dispose) installed.delete(document);
			};
			installed.set(document, dispose);
			return dispose;
		}
		function installWorkspacePathMenus(ctx) {
			const notices = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)(null);
			let alive = true, sequence = 0;
			const reportFailure = (action) => {
				if (alive) notices.set({
					action,
					sequence: ++sequence
				});
			};
			ctx.effect(() => () => {
				alive = false;
				notices.set(null);
			}, "workspace path menu: release notice");
			const actions = createWorkspacePathActions({
				sessions: ctx.get("sessions"),
				workspaces: ctx.get("workspaces"),
				slots: ctx.slots
			});
			ctx.effect(() => ctx.locale.register(NS, {
				zh: {
					copy: "复制工作区路径",
					open: "打开工作区文件夹",
					copyFailed: "工作区路径复制失败",
					openFailed: "工作区文件夹打开失败"
				},
				en: {
					copy: "Copy workspace path",
					open: "Open workspace folder",
					copyFailed: "Could not copy workspace path",
					openFailed: "Could not open workspace folder"
				}
			}), "workspace path menu: locale");
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "workspace-path-failure",
				locale: NS
			}, ({ t }) => {
				const notice = (0, react.useSyncExternalStore)(notices.subscribe, notices.getSnapshot);
				return notice ? (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Toast, {
					key: notice.sequence,
					text: t(notice.action + "Failed"),
					onDone() {
						if (notices.getSnapshot() === notice) notices.set(null);
					}
				}) : null;
			}));
			function PathItem({ sessionId, useMenuOpenState, t, action }) {
				(0, react.useSyncExternalStore)(ctx.get("sessions").list.subscribe, ctx.get("sessions").list.getSnapshot);
				const hooks = actions.face()?.hooks;
				for (const key of ["openInAppApps", "openInAppLaunch"]) (0, react.useSyncExternalStore)(hooks?.[key]?.subscribe ?? emptySubscribe, hooks?.[key]?.getSnapshot ?? emptySnapshot);
				const [, setOpen] = useMenuOpenState();
				if (!actions.resolve("session", sessionId) || action === "open" && !actions.canOpen("session", sessionId)) return null;
				return (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.MenuItemButton, {
					icon: (0, react.createElement)(action === "copy" ? _deepseek_ai_dsh_client_ui_primitives.IconCopyOutlineRegular : _deepseek_ai_dsh_client_ui_primitives.IconFolderOpenRegular),
					onSelect() {
						setOpen(false);
						actions.run(action, "session", sessionId).catch(() => reportFailure(action));
					}
				}, t(action));
			}
			ctx.slots.inject("sidebar.workspaces.session.menu.item", () => {
				const stops = ["copy", "open"].map((action, i) => ctx.slots.register({
					name: "sidebar.workspaces.session.menu.item",
					id: "workspace-path-" + action,
					order: 460 + i,
					locale: NS
				}, (props) => (0, react.createElement)(PathItem, {
					...props,
					action
				})));
				return () => {
					for (const stop of stops) stop();
				};
			});
			ctx.effect(() => installWorkspaceGroupMenu({
				document: globalThis.document,
				actions,
				workspaces: ctx.get("workspaces"),
				slots: ctx.slots,
				locale: ctx.locale,
				t: ctx.locale.bind(NS),
				reportFailure
			}), "workspace path menu: original group portal");
		}
		//#endregion
		//#region src/client.js
		const inject = [];
		function apply(ctx) {
			ctx.inject([
				"slots",
				"locale",
				"sessions",
				"workspaces"
			], (scope) => {
				installWorkspacePathMenus(scope);
			});
			ctx.inject(["slots"], (scope) => {
				scope.effect(() => installInputRecall(scope), "remote-hosts: current-session input recall");
			});
			const labels = createWorkspaceHostLabels(globalThis.__DSH_BROWSER_HOST_HUB__?.getHosts?.() ?? []);
			ctx.provide("remoteWorkspaceHostLabels", labels);
			ctx.inject(["workspaces", "sessions"], (scope) => {
				scope.effect(() => labels.watchInventory(scope.get("workspaces").list, { sessions: scope.get("sessions").list }), "remote-hosts: visible workspace Host inventory");
			});
			ctx.inject(inject$1, (scope) => {
				scope.plugin(client_exports);
			});
			ctx.inject(["slots", "locale"], (scope) => {
				installWorkspaceHostLabels(scope, labels);
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map