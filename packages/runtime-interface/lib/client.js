window.__ModuleLoader__.load({
	id: "dsh-runtime-interface",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region src/client/cold-restore.js
		/** Own one cold list consumption and its ordered public completion in this page. */
		function bindColdRestoreSelection(scope, bridge) {
			if (typeof bridge?.bindColdRestoreReader !== "function") return () => {};
			let disposed = false;
			let completedRead;
			let captured;
			const release = (read) => {
				for (const stop of read?.stops ?? []) stop();
				if (captured === read) captured = void 0;
			};
			const unbind = bridge.bindColdRestoreReader(() => {
				const sessions = scope.get("sessions");
				const selection = scope.get("uiWorkspace")?.selection;
				const generation = scope.get("connection")?.generation;
				const value = selection?.getSnapshot?.();
				if (typeof sessions?.refresh !== "function" || typeof selection?.subscribe !== "function" || typeof generation?.subscribe !== "function") return value;
				const current = generation.getSnapshot();
				if (disposed || current === void 0 || typeof value?.sessionId !== "string" || !value.sessionId) return void 0;
				const controller = new AbortController();
				const read = {
					sessions,
					sessionId: value.sessionId,
					generation,
					current,
					controller,
					stops: [],
					accepted: false,
					consumed: false
				};
				captured = read;
				read.stops.push(selection.subscribe(() => {
					if (!read.accepted && selection.getSnapshot()?.sessionId !== read.sessionId) controller.abort();
				}));
				read.stops.push(generation.subscribe(() => {
					if (generation.getSnapshot() !== current) controller.abort();
				}));
				return Object.defineProperty({ sessionId: read.sessionId }, "signal", { value: controller.signal });
			}, (value, phase) => {
				const read = captured;
				if (!read || disposed) return;
				if (read.consumed) {
					if (read.accepted && phase === "complete" && value?.result?.ok === true && !read.controller.signal.aborted && read.generation.getSnapshot() === read.current) completedRead = read;
					return;
				}
				read.consumed = true;
				read.accepted = phase === "target";
				if (phase === "complete" && value?.result?.ok === true && !read.controller.signal.aborted && read.generation.getSnapshot() === read.current) completedRead = read;
				if (phase !== "target" && phase !== "failed") {
					release(read);
					return;
				}
				let first;
				try {
					first = read.sessions.refresh();
				} catch {
					release(read);
					return;
				}
				const complete = () => {
					if (disposed || read.generation.getSnapshot() !== read.current) return;
					return read.sessions.refresh();
				};
				Promise.resolve(first).then(complete, complete).then(() => release(read), () => release(read));
			});
			const dispose = () => {
				disposed = true;
				completedRead = void 0;
				captured?.controller.abort();
				release(captured);
				unbind();
			};
			return Object.assign(dispose, { completeBaselineAccepted: () => !disposed && completedRead !== void 0 && !completedRead.controller.signal.aborted && completedRead.generation.getSnapshot() === completedRead.current });
		}
		//#endregion
		//#region src/stream-failure.js
		/**
		* Stable stream-failure vocabulary owned by the runtime boundary.
		*
		* Host business code must never inspect raw transport text to decide whether a
		* read subscription may be reopened.  This module reduces every stream failure
		* to five allow-listed fields (`source`, `reason`, `recoverable`, `stage` and,
		* for ordering errors, the bounded `expected`/`actual` indices) so that the
		* existing backoff consumers keep working without parsing messages, while the
		* diagnostic journal can persist exactly the same vocabulary.
		*
		* Recoverability is derived from the reason, never from the reported value:
		* authentication refusals, invalid data, version incompatibility, cancellation
		* and resource exhaustion stay terminal.  Only transient transport conditions
		* and ordinary stream completion are reopenable, and only read subscriptions
		* are ever reopened - writes, creations and approvals are never replayed.
		*/
		/** Where the failure was observed. */
		const STREAM_FAILURE_SOURCES = Object.freeze([
			"interface",
			"carrier",
			"hub",
			"queue"
		]);
		/** Which side of the first snapshot the failure belongs to. */
		const STREAM_FAILURE_STAGES = Object.freeze(["bootstrap", "live"]);
		/** Stable reason enumeration. */
		const STREAM_FAILURE_REASONS = Object.freeze([
			"unknown",
			"first-frame-timeout",
			"transport-timeout",
			"transport-disconnected",
			"connect-failed",
			"stream-ended",
			"sequence-gap",
			"attempt-mismatch",
			"invalid-frame",
			"invalid-snapshot",
			"incompatible",
			"unauthorized",
			"aborted",
			"resource-limit"
		]);
		const RECOVERABLE_REASONS = /* @__PURE__ */ new Set([
			"first-frame-timeout",
			"transport-timeout",
			"transport-disconnected",
			"connect-failed",
			"stream-ended"
		]);
		const REASON_SET = new Set(STREAM_FAILURE_REASONS);
		new Set(STREAM_FAILURE_SOURCES);
		new Set(STREAM_FAILURE_STAGES);
		const MAX_COUNT = Number.MAX_SAFE_INTEGER;
		/**
		* Error codes owned by the runtime interface and the Browser transport, mapped
		* to one stable reason and one stable source.  Order matters: the first prefix
		* that matches wins.
		*/
		const FAILURE_TABLE = Object.freeze([
			[
				"runtime-interface/stream-closed",
				"resource-limit",
				"interface"
			],
			[
				"runtime-interface/unsupported-version",
				"incompatible",
				"interface"
			],
			[
				"runtime-interface/invalid-stream",
				"invalid-frame",
				"interface"
			],
			[
				"runtime-interface/invalid-events",
				"invalid-frame",
				"interface"
			],
			[
				"runtime-interface/invalid-event",
				"invalid-frame",
				"interface"
			],
			[
				"runtime-interface/invalid-request",
				"invalid-frame",
				"interface"
			],
			[
				"runtime-interface/invalid-identity",
				"invalid-frame",
				"interface"
			],
			[
				"runtime-interface/invalid-sequence",
				"invalid-frame",
				"interface"
			],
			[
				"runtime-interface/invalid-channel",
				"invalid-frame",
				"interface"
			],
			[
				"runtime-interface/unauthorized",
				"unauthorized",
				"interface"
			],
			[
				"runtime-interface/forbidden",
				"unauthorized",
				"interface"
			],
			[
				"runtime-interface/capability-unavailable",
				"incompatible",
				"interface"
			],
			[
				"runtime-interface/stream-first-frame-timeout",
				"first-frame-timeout",
				"interface"
			],
			[
				"runtime-interface/stream-timeout",
				"transport-timeout",
				"interface"
			],
			[
				"runtime-interface/queue-overflow",
				"resource-limit",
				"queue"
			],
			[
				"runtime-interface/buffer-limit",
				"resource-limit",
				"queue"
			],
			[
				"runtime-interface/aborted",
				"aborted",
				"interface"
			],
			[
				"browser-host-hub-rc1/stream-first-frame-timeout",
				"first-frame-timeout",
				"hub"
			],
			[
				"browser-host-hub-rc1/stream-timeout",
				"transport-timeout",
				"hub"
			],
			[
				"browser-host-hub-rc1/stream-disconnected",
				"transport-disconnected",
				"hub"
			],
			[
				"browser-host-hub-rc1/connect-failed",
				"connect-failed",
				"hub"
			],
			[
				"browser-host-hub-rc1/stream-ended",
				"stream-ended",
				"hub"
			],
			[
				"browser-host-hub-rc1/unauthorized",
				"unauthorized",
				"hub"
			],
			[
				"browser-host-hub-rc1/resource-limit",
				"resource-limit",
				"hub"
			],
			[
				"browser-host-hub-rc1/stream-backpressure",
				"resource-limit",
				"queue"
			],
			[
				"browser-host-hub-rc1/invalid-stream",
				"invalid-frame",
				"hub"
			]
		]);
		/** Transport codes raised by Node, WebSocket and AbortSignal. */
		const TRANSPORT_REASONS = new Map([
			["ETIMEDOUT", "transport-timeout"],
			["UND_ERR_CONNECT_TIMEOUT", "transport-timeout"],
			["UND_ERR_HEADERS_TIMEOUT", "transport-timeout"],
			["UND_ERR_BODY_TIMEOUT", "transport-timeout"],
			["ABORT_ERR", "aborted"],
			["ERR_CANCELED", "aborted"],
			["ECONNRESET", "transport-disconnected"],
			["EPIPE", "transport-disconnected"],
			["ERR_STREAM_PREMATURE_CLOSE", "transport-disconnected"],
			["ECONNREFUSED", "connect-failed"],
			["EHOSTUNREACH", "connect-failed"],
			["ENETUNREACH", "connect-failed"],
			["ENOTFOUND", "connect-failed"],
			["EAI_AGAIN", "connect-failed"],
			["ENETDOWN", "connect-failed"],
			["WS_ERR_UNSUPPORTED_MESSAGE_LENGTH", "resource-limit"],
			...[
				"WS_ERR_INVALID_UTF8",
				"WS_ERR_UNEXPECTED_RSV_1",
				"WS_ERR_INVALID_OPCODE",
				"WS_ERR_EXPECTED_MASK",
				"WS_ERR_UNEXPECTED_MASK",
				"WS_ERR_INVALID_CLOSE_CODE",
				"WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH"
			].map((code) => [code, "invalid-frame"])
		]);
		const LEGACY_CARRIER_REASONS = /* @__PURE__ */ new Map([
			["CARRIER_DISCONNECTED", "transport-disconnected"],
			["CARRIER_STREAM_ENDED", "stream-ended"],
			["CARRIER_RESULT_HTTP_401", "unauthorized"],
			["CARRIER_RESULT_HTTP_403", "unauthorized"],
			["HOST_CONNECTION_FAILED_AUTHENTICATION", "unauthorized"],
			["HOST_CONNECTION_FAILED_BOOTSTRAP_VALIDATE", "incompatible"],
			["HOST_CONNECTION_FAILED_FORWARD", "connect-failed"],
			["HOST_CONNECTION_FAILED_BOOTSTRAP_READ", "connect-failed"],
			["HOST_CONNECTION_FAILED_CONNECT", "connect-failed"]
		]);
		function isRecord(value) {
			return value !== null && typeof value === "object" && !Array.isArray(value);
		}
		function boundedEnum(list, value) {
			return typeof value === "string" && list.includes(value) ? value : void 0;
		}
		function boundedCount(value) {
			return Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT && !Object.is(value, -0) ? value : void 0;
		}
		function reasonFromCode(code) {
			if (typeof code !== "string" || code.length === 0 || code.length > 128) return void 0;
			for (const [prefix, reason] of FAILURE_TABLE) if (code.startsWith(prefix)) return reason;
			const transport = TRANSPORT_REASONS.get(code);
			if (transport !== void 0) return transport;
			const namespaced = /^(?:transport|stream)[/:](.+)$/.exec(code)?.[1];
			if (namespaced !== void 0) {
				const normalized = namespaced.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
				const direct = `stream-${normalized}`;
				if (REASON_SET.has(direct)) return direct;
				if (normalized === "timeout") return "transport-timeout";
				if (normalized === "disconnected" || normalized === "closed") return "transport-disconnected";
				if (normalized === "failed") return "connect-failed";
				if (REASON_SET.has(normalized)) return normalized;
			}
		}
		function recoverableFor(reason) {
			return RECOVERABLE_REASONS.has(reason);
		}
		/**
		* Project arbitrary input - a journal row being persisted, re-read or exported -
		* onto the same vocabulary.  Anything outside the allow-lists is dropped, and
		* `recoverable` is always recomputed instead of trusted.
		*/
		function sanitizeStreamFailure(input) {
			if (!isRecord(input)) return void 0;
			const reason = boundedEnum(STREAM_FAILURE_REASONS, input.reason) ?? reasonFromCode(isRecord(input.error) ? input.error.code : input.code);
			if (reason === void 0) return void 0;
			const row = {
				source: boundedEnum(STREAM_FAILURE_SOURCES, input.source) ?? "interface",
				reason
			};
			row.recoverable = reason === "aborted" ? false : recoverableFor(reason);
			const stage = boundedEnum(STREAM_FAILURE_STAGES, input.stage);
			if (stage !== void 0) row.stage = stage;
			const expected = boundedCount(input.expected);
			if (expected !== void 0) row.expected = expected;
			const actual = boundedCount(input.actual);
			if (actual !== void 0) row.actual = actual;
			return row;
		}
		const TRANSPORT_OPERATIONS = /* @__PURE__ */ new Set([
			"ws-error",
			"ws-close",
			"ws-end",
			"ws-cancel",
			"lazy-drop",
			"ssh-close",
			"ssh-exit",
			"ssh-error"
		]);
		const CANCEL_SOURCES = /* @__PURE__ */ new Set([
			"none",
			"caller",
			"entry"
		]);
		const CLOSE_SOURCES = /* @__PURE__ */ new Set([
			"socket-error",
			"socket-eof",
			"protocol-end",
			"protocol-error",
			"caller-abort",
			"entry-abort",
			"reader-return",
			"auth-refused",
			"entry-death",
			"host-lifetime",
			"caller-close",
			"connect-failed",
			"child-exit",
			"child-error"
		]);
		const TRANSPORT_CODES = /* @__PURE__ */ new Set([
			...TRANSPORT_REASONS.keys(),
			"ENOENT",
			"EACCES",
			"EPERM",
			"ESRCH",
			"ENOEXEC",
			...LEGACY_CARRIER_REASONS.keys()
		]);
		function sanitizeTransportDiagnostic(input) {
			if (!isRecord(input)) return {};
			const row = {};
			for (const key of ["entry", "read"]) if (/^[a-f0-9]{20}$/.test(input[key] ?? "")) row[key] = input[key];
			for (const [key, allowed] of [
				["operation", TRANSPORT_OPERATIONS],
				["cancelSource", CANCEL_SOURCES],
				["closeSource", CLOSE_SOURCES],
				["errorCode", TRANSPORT_CODES]
			]) if (allowed.has(input[key])) row[key] = input[key];
			for (const [key, low, high] of [
				[
					"httpStatus",
					100,
					599
				],
				[
					"sshPid",
					1,
					4294967295
				],
				[
					"exitCode",
					-2147483648,
					4294967295
				]
			]) if (Number.isSafeInteger(input[key]) && input[key] >= low && input[key] <= high) row[key] = input[key];
			if ([
				"SIGTERM",
				"SIGKILL",
				"SIGINT",
				"SIGHUP"
			].includes(input.exitSignal)) row.exitSignal = input.exitSignal;
			if (typeof input.killIntent === "boolean") row.killIntent = input.killIntent;
			return row;
		}
		//#endregion
		//#region src/client/model-catalog.js
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
		function catalogStore() {
			let state = {
				value: null,
				status: "idle",
				error: null
			};
			const listeners = /* @__PURE__ */ new Set();
			return {
				getSnapshot: () => state,
				subscribe(fn) {
					listeners.add(fn);
					return () => listeners.delete(fn);
				},
				set(value) {
					state = value;
					for (const listener of [...listeners]) listener();
				}
			};
		}
		function hostCatalog(rpc, hostId) {
			const store = catalogStore();
			const reasoning = /* @__PURE__ */ new Map();
			let generation = 0, inflight, aborter, disposed = false;
			const reset = () => {
				generation++;
				aborter?.abort();
				inflight = void 0;
				store.set({
					value: null,
					status: "idle",
					error: null
				});
			};
			const catalog = {
				store,
				reasoningFor(selection) {
					return reasoning.get(JSON.stringify([selection.provider, selection.model]));
				},
				load() {
					if (disposed) return Promise.reject(fail("MODEL_CATALOG_DISPOSED"));
					const state = store.getSnapshot();
					if (state.status === "ready") return Promise.resolve(state.value);
					if (inflight) return inflight;
					const ticket = generation;
					const controller = aborter = new AbortController();
					store.set({
						...state,
						status: "loading",
						error: null
					});
					const operation = Promise.resolve().then(() => {
						controller.signal.throwIfAborted();
						return rpc.call("/api", "session/modelCatalog", {
							args: {},
							__hostId: hostId
						}, controller.signal);
					}).then((response) => {
						const value = response?.value;
						if (response?.ok !== true || !value || !Array.isArray(value.groups) || !Array.isArray(value.failures) || !Array.isArray(value.routableProviders) || typeof value.default?.provider !== "string" || typeof value.default?.model !== "string") throw fail("MODEL_CATALOG_UNAVAILABLE");
						if (ticket === generation && !disposed) {
							for (const group of value.groups) for (const model of group.models) reasoning.set(JSON.stringify([group.id, model.id]), model.reasoning);
							store.set({
								value,
								status: "ready",
								error: null
							});
						}
						return value;
					}).catch(() => {
						if (ticket === generation && !disposed) store.set({
							value: null,
							status: "error",
							error: "MODEL_CATALOG_UNAVAILABLE"
						});
						throw fail("MODEL_CATALOG_UNAVAILABLE");
					}).finally(() => {
						if (ticket === generation && inflight === operation) inflight = void 0;
					});
					inflight = operation;
					return operation;
				},
				refresh() {
					reset();
					catalog.load().catch(() => {});
				},
				resetGeneration() {
					reasoning.clear();
					catalog.refresh();
				},
				dispose() {
					disposed = true;
					reasoning.clear();
					reset();
				}
			};
			return catalog;
		}
		/** Own the native catalog seam, including resident directory subscriptions.
		* Keep native directory identity, projection, selection and scope teardown.
		* Never hold the factory catalog substitution across await.
		*/
		function bindHostModelCatalogs(ctx, resolver, rpc) {
			if (typeof resolver?.directoryFor !== "function" || typeof resolver.catalog?.load !== "function" || typeof resolver.catalog?.store?.subscribe !== "function" || typeof rpc?.call !== "function" || typeof ctx?.on !== "function" || typeof ctx?.remote?.$on !== "function") throw fail("MODEL_INTERFACE_INCOMPATIBLE");
			const resident = resolver.live?.directories?.values;
			if (!resident || typeof resident[Symbol.iterator] !== "function" || typeof resolver.ctx?.sessions?.scope !== "function") throw fail("MODEL_INTERFACE_INCOMPATIBLE");
			const compatible = (directory) => typeof directory?.syncInputs === "function" && typeof directory.unsubscribeCatalog === "function" && typeof directory.projected?.getSnapshot === "function" && typeof directory.store?.getSnapshot === "function" && typeof directory.store?.set === "function" && typeof directory.catalog?.store?.subscribe === "function";
			for (const directory of resident) {
				if (!compatible(directory)) throw fail("MODEL_INTERFACE_INCOMPATIBLE");
				sessionModelHost(directory.sessionId);
			}
			const catalogs = /* @__PURE__ */ new Map(), bindings = /* @__PURE__ */ new Map(), original = resolver.directoryFor;
			const catalogFor = (sessionId) => {
				const hostId = sessionModelHost(sessionId);
				if (!catalogs.has(hostId)) catalogs.set(hostId, hostCatalog(rpc, hostId));
				return catalogs.get(hostId);
			};
			const detach = (directory, binding) => {
				binding.unsubscribe();
				if (directory.syncInputs === binding.syncInputs) if (binding.descriptor) Object.defineProperty(directory, "syncInputs", binding.descriptor);
				else delete directory.syncInputs;
				if (directory.catalog === binding.catalog) {
					directory.catalog = binding.nativeCatalog;
					if (!directory.disposed) directory.unsubscribeCatalog = binding.nativeCatalog.store.subscribe(() => directory.syncInputs());
					directory.syncInputs();
				}
				bindings.delete(directory);
			};
			const attach = (directory, catalog, nativeCatalog) => {
				if (bindings.has(directory)) {
					if (directory.catalog !== catalog) throw fail("MODEL_INTERFACE_INCOMPATIBLE");
					return;
				}
				if (!compatible(directory)) throw fail("MODEL_INTERFACE_INCOMPATIBLE");
				const scope = resolver.ctx.sessions.scope(directory.sessionId);
				if (typeof scope?.effect !== "function") throw fail("MODEL_INTERFACE_INCOMPATIBLE");
				const descriptor = Object.getOwnPropertyDescriptor(directory, "syncInputs"), originalSync = directory.syncInputs;
				const syncInputs = function() {
					if (this.disposed) return originalSync.call(this);
					const before = this.store.getSnapshot();
					originalSync.call(this);
					const after = this.store.getSnapshot(), selected = this.projected.getSnapshot()?.next;
					const retained = selected !== void 0 && after.current === null && this.catalog.store.getSnapshot().value === null;
					const selecting = before.status === "selecting" && after.pending !== null;
					if (retained || selecting) this.store.set({
						...after,
						...retained ? { current: selected } : {},
						...selecting ? { status: "selecting" } : {}
					});
				};
				directory.unsubscribeCatalog();
				directory.catalog = catalog;
				Object.defineProperty(directory, "syncInputs", {
					configurable: true,
					writable: true,
					value: syncInputs
				});
				const binding = {
					catalog,
					nativeCatalog,
					descriptor,
					syncInputs,
					unsubscribe: directory.unsubscribeCatalog = catalog.store.subscribe(() => directory.syncInputs())
				};
				bindings.set(directory, binding);
				try {
					binding.release = scope.effect(() => () => {
						if (bindings.get(directory) === binding) detach(directory, binding);
					}, "runtime-interface: directory catalog binding");
					if (typeof binding.release !== "function") throw fail("MODEL_INTERFACE_INCOMPATIBLE");
				} catch (error) {
					detach(directory, binding);
					throw error;
				}
				directory.syncInputs();
				catalog.load().catch(() => {});
			};
			const descriptor = Object.getOwnPropertyDescriptor(resolver, "directoryFor");
			const directoryFor = function(sessionId) {
				const catalog = catalogFor(sessionId);
				const previous = this.catalog;
				try {
					this.catalog = catalog;
					const directory = original.call(this, sessionId);
					attach(directory, catalog, directory.catalog === catalog ? previous : directory.catalog);
					return directory;
				} finally {
					this.catalog = previous;
				}
			};
			const restoreFactory = () => {
				if (Object.getOwnPropertyDescriptor(resolver, "directoryFor")?.value === directoryFor) if (descriptor) Object.defineProperty(resolver, "directoryFor", descriptor);
				else delete resolver.directoryFor;
			};
			Object.defineProperty(resolver, "directoryFor", {
				configurable: true,
				writable: true,
				value: directoryFor
			});
			try {
				for (const directory of resident) attach(directory, catalogFor(directory.sessionId), directory.catalog);
			} catch (error) {
				for (const binding of bindings.values()) binding.release();
				for (const catalog of catalogs.values()) catalog.dispose();
				restoreFactory();
				throw error;
			}
			const refresh = () => {
				for (const catalog of catalogs.values()) catalog.refresh();
			};
			const stops = [ctx.on("connection/reset", () => {
				for (const catalog of catalogs.values()) catalog.resetGeneration();
			})];
			for (const event of [
				"llm/adapters-updated",
				"settings/document-updated",
				"credentials/reference-updated"
			]) stops.push(ctx.remote.$on(event, refresh));
			return () => {
				for (const stop of stops) if (typeof stop === "function") stop();
				for (const binding of bindings.values()) binding.release();
				for (const catalog of catalogs.values()) catalog.dispose();
				catalogs.clear();
				restoreFactory();
			};
		}
		//#endregion
		//#region src/client/agent-presets.js
		const HERO = "conversation.hero.agentPreset";
		const refusal = (code) => ({
			ok: false,
			error: {
				code,
				message: "Agent preset choices changed; choose again",
				details: {}
			}
		});
		/** Adapt public registered chip faces, preserving the official controller and renderer.
		* The synchronous face scope captures its RPC before await; it is never held across await.
		* Automatic official stage application also goes through the selection guard. */
		function bindAgentPresetTargets({ slots, sessions, rpc, bridge, on, onRemote }) {
			if (!bridge) return () => {};
			if (typeof slots?.entries !== "function" || typeof slots?.register !== "function" || typeof slots?.subscribe !== "function" || typeof rpc?.call !== "function") throw Error("AGENT_PRESET_INTERFACE_INCOMPATIBLE");
			const original = rpc.call, descriptor = Object.getOwnPropertyDescriptor(rpc, "call");
			const seats = /* @__PURE__ */ new Map(), stops = [];
			let active = true, scoped, origin, shadow, owner, installing = false, epoch = 0;
			const target = (seat) => seat.sessionId === void 0 ? bridge.getSelectedHost() ?? "local" : sessionModelHost(seat.sessionId);
			const current = (seat) => !seat.disposed && (seat.sessionId === void 0 || sessions.binding(seat.sessionId) === seat.binding && (sessions.list.getSnapshot().byId[seat.sessionId]?.retainedBy?.mainView ?? 0) > 0);
			const stamp = (seat) => `${epoch}:${seat.generation}:${target(seat)}:${seat.sessionId ?? ""}:${current(seat)}`;
			const inScope = (seat, fn) => {
				const before = scoped;
				try {
					scoped = seat;
					return fn();
				} finally {
					scoped = before;
				}
			};
			const readTarget = (hostId, signal) => original.call(rpc, "/api", "agentPresets/list", {
				args: {},
				__hostId: hostId
			}, signal);
			const refresh = (seat) => {
				if (active && seat) seat.face.load().catch(() => {});
			};
			const validResponse = (response) => response?.ok === true && Array.isArray(response.value?.presets);
			const call = function(channel, method, payload, signal) {
				if (!active || channel !== "/api") return original.call(this, channel, method, payload, signal);
				const seat = scoped ?? (method === "agentPresets/select" ? seats.get(payload?.args?.agentId) : void 0);
				if (method === "agentPresets/list" && seat) {
					const hostId = target(seat), ticket = stamp(seat);
					return Promise.resolve(readTarget(hostId, signal)).then((response) => {
						if (!active || ticket !== stamp(seat)) return refusal("agent-preset/target-changed");
						if (validResponse(response)) seat.roster = response.value.presets;
						return response;
					});
				}
				if (method !== "agentPresets/select") return original.call(this, channel, method, payload, signal);
				const hostId = sessionModelHost(payload?.args?.agentId), id = payload?.args?.agentPreset;
				const staged = origin;
				origin = void 0;
				return (async () => {
					if (seat && (target(seat) !== hostId || !current(seat)) || staged?.id === id && staged.hostId !== hostId) {
						refresh(seat);
						return refusal("agent-preset/target-changed");
					}
					const result = await original.call(rpc, channel, method, {
						...payload,
						__hostId: hostId
					}, signal);
					if (result?.ok === false && ["agent-preset/not-found", "agent-preset/invalid"].includes(result.error?.code)) refresh(seat);
					return result;
				})();
			};
			Object.defineProperty(rpc, "call", {
				configurable: true,
				writable: true,
				value: call
			});
			const wrap = (entry, sessionId) => {
				const official = entry.inject(sessionId), store = official?.hooks?.agentPresetSeat;
				if (!store || typeof official.load !== "function" || typeof official.select !== "function") throw Error("AGENT_PRESET_FACE_INCOMPATIBLE");
				const existing = seats.get(sessionId);
				if (existing?.store === store) return existing.face;
				const seat = {
					sessionId,
					store,
					roster: [],
					selecting: false,
					loaded: false,
					generation: 0,
					binding: sessionId === void 0 ? void 0 : sessions.binding(sessionId)
				};
				const face = {
					...official,
					async load() {
						if (!active) return;
						seat.loaded = true;
						const ticket = stamp(seat);
						await inScope(seat, () => official.load());
						if (!active || ticket !== stamp(seat)) return;
						if (origin && origin.hostId !== target(seat) && store.getSnapshot().current === origin.id) store.set({
							...store.getSnapshot(),
							current: seat.roster.find((row) => row.isDefault)?.id ?? ""
						});
					},
					async select(id) {
						if (!active || seat.selecting || store.getSnapshot().busy) return;
						seat.selecting = true;
						const hostId = target(seat);
						try {
							if (!current(seat)) return refusal("agent-preset/target-changed").error.message;
							origin = {
								hostId,
								id
							};
							const result = await inScope(seat, () => official.select(id));
							if (sessionId !== void 0 && origin?.hostId === hostId && origin.id === id) origin = void 0;
							return result;
						} finally {
							seat.selecting = false;
						}
					}
				};
				seat.face = face;
				seats.set(sessionId, seat);
				if (sessionId !== void 0) sessions.binding(sessionId)?.ctx?.effect?.(() => () => {
					seat.disposed = true;
					seat.generation++;
					if (seats.get(sessionId) === seat) seats.delete(sessionId);
				}, "runtime-interface: preset binding lifetime");
				return face;
			};
			const install = () => {
				if (!active || installing) return;
				const entry = slots.entries(HERO).find((item) => item !== shadow?.entry && (item.options.priority ?? 0) === 0 && typeof item.inject === "function");
				if (entry === owner) return;
				installing = true;
				try {
					for (const seat of seats.values()) {
						seat.disposed = true;
						seat.generation++;
					}
					shadow?.dispose();
					shadow = void 0;
					seats.clear();
					owner = entry;
					if (entry) shadow = {
						dispose: slots.register({
							name: HERO,
							priority: -1,
							locale: entry.locale,
							inject: (sessionId) => wrap(entry, sessionId)
						}, entry.component),
						entry: slots.entriesOfSlot(HERO)[0]
					};
				} finally {
					installing = false;
				}
			};
			stops.push(slots.subscribe(HERO, install));
			stops.push(bridge.onSelectedHost(() => {
				for (const seat of seats.values()) if (seat.sessionId === void 0) {
					seat.generation++;
					if (seat.loaded) refresh(seat);
				}
			}));
			const refreshAfterOfficial = () => queueMicrotask(() => {
				if (active) {
					for (const seat of seats.values()) if (seat.loaded) refresh(seat);
				}
			});
			if (typeof on === "function") stops.push(on("connection/reset", () => {
				epoch++;
				refreshAfterOfficial();
			}));
			if (typeof onRemote === "function") stops.push(onRemote("settings/document-updated", (namespace) => {
				if (namespace === "agent-preset-registry") refreshAfterOfficial();
			}));
			install();
			return () => {
				if (!active) return;
				active = false;
				epoch++;
				for (const stop of stops) stop?.();
				shadow?.dispose();
				seats.clear();
				origin = void 0;
				if (rpc.call === call) if (descriptor) Object.defineProperty(rpc, "call", descriptor);
				else delete rpc.call;
			};
		}
		//#endregion
		//#region src/client/index.js
		const CHANNEL = "/remote-hosts";
		const METHODS = /* @__PURE__ */ new Set([
			"status",
			"discoverAliases",
			"add",
			"update",
			"remove",
			"retry",
			"disconnect",
			"restart",
			"exportDiagnostics"
		]);
		const REQUEST_KEYS = /* @__PURE__ */ new Set([
			"id",
			"hostId",
			"label",
			"alias",
			"localPort",
			"remotePort",
			"launch",
			"enabled"
		]);
		const HOST_KEYS = [
			"id",
			"kind",
			"label",
			"alias",
			"state",
			"lastError",
			"localPort",
			"remotePort",
			"launch",
			"enabled",
			"restartAvailable",
			"restartState",
			"helperReadable"
		];
		const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
		const failure = (code) => Object.assign(new Error(code), { code });
		function responseValue(method, result) {
			if (!record(result) || result.ok !== true) {
				const code = result?.error?.code;
				throw failure(typeof code === "string" && /^[A-Z][A-Z0-9_]{1,80}$/.test(code) ? code : "HOST_UNAVAILABLE");
			}
			const value = result.value;
			if (!record(value)) throw failure("HOST_UNAVAILABLE");
			if (method === "exportDiagnostics") {
				if (value.schemaVersion !== 1 || value.scope !== "local-hub-only" || !Array.isArray(value.events) || value.events.length > 512) throw failure("HOST_UNAVAILABLE");
				const fields = [
					"time",
					"phase",
					"endpoint",
					"code",
					"host",
					"session",
					"closeCode",
					"count",
					"durationMs",
					"lastSeq"
				];
				return Object.freeze({
					schemaVersion: 1,
					scope: value.scope,
					generatedAt: value.generatedAt,
					limit: 512,
					dropped: value.dropped,
					persistenceAvailable: value.persistenceAvailable,
					events: Object.freeze(value.events.map((event) => {
						if (!record(event)) throw failure("HOST_UNAVAILABLE");
						return Object.freeze({
							...Object.fromEntries(fields.filter((key) => Object.hasOwn(event, key)).map((key) => [key, event[key]])),
							...sanitizeStreamFailure(event),
							...sanitizeTransportDiagnostic(event)
						});
					}))
				});
			}
			if (method === "discoverAliases") {
				if (!Array.isArray(value.aliases) || value.aliases.some((alias) => typeof alias !== "string" || alias.length > 256)) throw failure("HOST_UNAVAILABLE");
				return Object.freeze({ aliases: Object.freeze([...value.aliases]) });
			}
			if (!Array.isArray(value.hosts) || !Number.isInteger(value.suggestedLocalPort)) throw failure("HOST_UNAVAILABLE");
			const hosts = value.hosts.map((host) => {
				if (!record(host) || typeof host.id !== "string" || !["local", "remote"].includes(host.kind) || typeof host.state !== "string") throw failure("HOST_UNAVAILABLE");
				return Object.freeze(Object.fromEntries(HOST_KEYS.filter((key) => Object.hasOwn(host, key)).map((key) => [key, host[key]])));
			});
			return Object.freeze({
				hosts: Object.freeze(hosts),
				suggestedLocalPort: value.suggestedLocalPort
			});
		}
		/** Own the official browser RPC binding; UI gets only this stable, bounded API. */
		function createRemoteHostsClient(rpc) {
			if (typeof rpc?.call !== "function") throw new TypeError("official client RPC binding is required");
			return Object.freeze({ async call(method, payload = {}, signal) {
				signal?.throwIfAborted();
				if (!METHODS.has(method) || !record(payload) || Object.keys(payload).some((key) => !REQUEST_KEYS.has(key))) throw failure("HOST_UNAVAILABLE");
				for (const [key, value] of Object.entries(payload)) if (["localPort", "remotePort"].includes(key)) {
					if (!Number.isInteger(value) || value < 1024 || value > 65535) throw failure("HOST_PORT_INVALID");
				} else if (key === "enabled") {
					if (typeof value !== "boolean") throw failure("HOST_UNAVAILABLE");
				} else if (typeof value !== "string" || value.length > 4096 || value.includes("\0")) throw failure("HOST_UNAVAILABLE");
				return responseValue(method, await rpc.call(CHANNEL, method, { ...payload }, signal));
			} });
		}
		const inject = ["connection"];
		function apply(ctx) {
			const bridge = globalThis.__DSH_BROWSER_HOST_HUB__;
			if (bridge) ctx.effect(() => bindColdRestoreSelection(ctx, bridge), "runtime-interface: cold restore selection");
			ctx.provide("remoteHostsInterface", createRemoteHostsClient(ctx.get("connection").rpc));
			if (!bridge) return;
			ctx.inject([
				"modelDirectories",
				"remote",
				"sessions"
			], (scope) => {
				scope.effect(() => bindHostModelCatalogs(scope, scope.get("modelDirectories"), ctx.get("connection").rpc), "runtime-interface: host model catalogs");
			});
			ctx.inject([
				"slots",
				"sessions",
				"remote"
			], (scope) => {
				scope.effect(() => bindAgentPresetTargets({
					slots: scope.slots,
					sessions: scope.sessions,
					rpc: ctx.get("connection").rpc,
					bridge,
					on: (...args) => scope.on(...args),
					onRemote: (...args) => scope.remote.$on(...args)
				}), "runtime-interface: host agent preset choices");
			});
		}
		//#endregion
		exports.apply = apply;
		exports.createRemoteHostsClient = createRemoteHostsClient;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map