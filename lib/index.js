//#region lib/types/index.js
/**
* dsh-trace-repeat — host half.
*
* Records the execution trace of ANY DSH session, atomically and versioned:
* every completed model reasoning step (`assistant/message`, recorded only
* after ALL chunks assembled into the final message) and every completed tool
* execution (`tool-result` block) becomes ONE immutable version; ordinary user
* inputs become `user` versions (context baseline). Versions are written as
* atomic JSON files (tmp + rename) under `<traceRoot>/<sessionId>/`, indexed
* by `trace.json`, and — when git is enabled — committed to a DEDICATED git
* repo rooted at `<traceRoot>` so each version is also a git commit and can be
* materialized into a worktree for inspection or resume execution.
*
* task-control integration: the recorder reconciles the pause gate with the
* `taskControl` service (Route A — task-control keeps its state in its own
* durable store, so `task-control/*` session events are never recorded). On
* pause it writes a `paused` marker version (with `forced`/`interruptedTool`
* detail) and halts reasoning/tool versioning at the boundary; on resume it
* writes a `resumed` marker version and continues. When task-control is not
* installed the gate stays open (constant recording).
*
* Replay: the `/trace` command family. `/trace resume <session> <vN>` rebuilds
* the transcript up to version N (truncated to the last balanced completed
* turn), creates a fresh session in the version's worktree, and continues from
* there.
*
* The host half is intentionally dependency-free (no bare imports) so the
* package needs no node_modules to load.
*
* @module dsh-trace-repeat
*/
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
//#endregion
const name = "trace-repeat";
const inject = ["commands", "agents", "agentDefaultModel", "sessions", "sandboxPolicy", "agentPresets"];
/** Plugin tag used on resume messages. */
const PLUGIN_TAG = "trace-repeat";
/** Default per-session version cap. */
const DEFAULT_MAX_VERSIONS = 10000;

// ── small utilities ──────────────────────────────────────────────────────────

/** Mint a unique id (crypto.randomUUID when available, else a local fallback). */
function newId() {
	const crypto = globalThis.crypto;
	if (crypto !== void 0 && typeof crypto.randomUUID === "function") return crypto.randomUUID();
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
/** Deep-freeze a plain JSON value (mirror of dsh-llm deepFreeze). */
function deepFreeze(value) {
	if (Array.isArray(value)) {
		for (const item of value) deepFreeze(item);
		return Object.freeze(value);
	}
	if (value !== null && typeof value === "object") {
		for (const key of Object.keys(value)) deepFreeze(value[key]);
		return Object.freeze(value);
	}
	return value;
}
/** Build one user-role message (mirror of dsh-llm createUserMessage). */
function buildUserMessage(contentBlocks, source) {
	return deepFreeze(structuredClone({
		id: newId(),
		role: "user",
		content: contentBlocks,
		source: { kind: "plugin", plugin: PLUGIN_TAG, ...source }
	}));
}

// ── trace store (pure, testable) ─────────────────────────────────────────────

/** Sanitize a session id into a safe directory name. */
function encodeSessionId(sessionId) {
	return String(sessionId).replace(/[^a-zA-Z0-9._-]/g, "_");
}
/** Per-session trace directory. */
function traceDirFor(traceRoot, sessionId) {
	return join(traceRoot, encodeSessionId(sessionId));
}
/** trace.json header path for one session. */
function traceHeaderPath(traceRoot, sessionId) {
	return join(traceDirFor(traceRoot, sessionId), "trace.json");
}
/** Version file name: v-<seq>-<type>.json */
function versionFileName(seq, type) {
	return `v-${String(seq).padStart(6, "0")}-${type}.json`;
}
function versionFilePath(traceRoot, sessionId, seq, type) {
	return join(traceDirFor(traceRoot, sessionId), versionFileName(seq, type));
}
/** Atomic JSON write: tmp file + rename. */
function atomicWriteJson(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(tmp, path);
}
/** Read one version file. */
function readVersionFile(traceRoot, sessionId, seq, type) {
	return JSON.parse(readFileSync(versionFilePath(traceRoot, sessionId, seq, type), "utf8"));
}
/** Read a session trace header; rebuilds the version index from files when absent. */
function readTrace(traceRoot, sessionId) {
	const dir = traceDirFor(traceRoot, sessionId);
	const headerPath = join(dir, "trace.json");
	if (existsSync(headerPath)) {
		const header = JSON.parse(readFileSync(headerPath, "utf8"));
		header.versions = (header.versions ?? []).slice().sort((a, b) => a.seq - b.seq);
		return header;
	}
	if (!existsSync(dir)) return null;
	const versions = readdirSync(dir)
		.filter((f) => /^v-\d+-.+\.json$/.test(f))
		.map((f) => {
			try {
				const parsed = JSON.parse(readFileSync(join(dir, f), "utf8"));
				return { seq: parsed.seq, type: parsed.type, file: f, time: parsed.time, gitCommit: parsed.gitCommit ?? null };
			} catch {
				return null;
			}
		})
		.filter(Boolean)
		.sort((a, b) => a.seq - b.seq);
	return { sessionId, createdAt: versions[0]?.time ?? null, paused: false, agentOptions: null, preset: null, cwd: null, workspace: null, versions };
}
/** Append one version atomically (version file + header index). Returns the version record. */
function appendVersion(traceRoot, sessionId, version, maxVersions = DEFAULT_MAX_VERSIONS) {
	const dir = traceDirFor(traceRoot, sessionId);
	mkdirSync(dir, { recursive: true });
	const header = readTrace(traceRoot, sessionId) ?? {
		sessionId,
		createdAt: new Date().toISOString(),
		paused: false,
		agentOptions: null,
		preset: null,
		cwd: null,
		workspace: null,
		versions: []
	};
	const seq = header.versions.length > 0 ? header.versions[header.versions.length - 1].seq + 1 : 0;
	const file = versionFileName(seq, version.type);
	atomicWriteJson(join(dir, file), {
		seq,
		type: version.type,
		time: version.time ?? new Date().toISOString(),
		sessionId,
		sourceSeq: version.sourceSeq ?? null,
		turn: version.turn ?? null,
		step: version.step ?? null,
		gitCommit: null,
		meta: version.meta ?? {},
		detail: version.detail ?? {}
	});
	header.versions.push({ seq, type: version.type, file, time: version.time ?? new Date().toISOString(), gitCommit: null });
	if (version.type === "resumed") header.paused = false;
	if (version.type === "paused") header.paused = true;
	// trim oldest versions beyond the cap
	if (header.versions.length > maxVersions) {
		const removed = header.versions.splice(0, header.versions.length - maxVersions);
		for (const v of removed) {
			try { renameSync(join(dir, v.file), join(dir, `${v.file}.trimmed`)); } catch { /* ignore */ }
		}
	}
	atomicWriteJson(join(dir, "trace.json"), header);
	return { seq, type: version.type, file: basename(file), time: header.versions[header.versions.length - 1].time };
}
/** List sessions that have a trace. */
function listTracedSessions(traceRoot) {
	if (!existsSync(traceRoot)) return [];
	return readdirSync(traceRoot)
		.filter((entry) => {
			try { return existsSync(join(traceRoot, entry, "trace.json")); } catch { return false; }
		})
		.map((entry) => readTrace(traceRoot, entry))
		.filter(Boolean)
		.sort((a, b) => (b.versions[0]?.time ?? "").localeCompare(a.versions[0]?.time ?? ""));
}

// ── event → version mapping ──────────────────────────────────────────────────

/**
* Map one session event to a version record, or null when the event is not
* recorded. `info` carries live agent context (options, model selection).
*/
function mapEventToVersion(event, info) {
	const type = event.type;
	const data = event.data ?? {};
	const iso = () => new Date(event.time ?? Date.now()).toISOString();
	if (type === "assistant/message") {
		const message = data.message ?? {};
		const source = message.source ?? {};
		const content = Array.isArray(message.content) ? message.content : [];
		return {
			type: "reasoning",
			sourceSeq: event.seq,
			turn: data.turn,
			step: data.step,
			time: iso(),
			meta: {
				provider: source.provider ?? info?.agentOptions?.provider ?? null,
				model: source.model ?? info?.agentOptions?.model ?? null,
				reasoningEffort: info?.reasoningEffort ?? null,
				maxTokens: info?.agentOptions?.maxTokens ?? null
			},
			detail: { content, usage: data.usage ?? {} },
			toolCalls: content.filter((block) => block.type === "tool-call").map((block) => ({
				callId: block.id ?? block.callId,
				name: block.name,
				input: block.arguments ?? block.input
			}))
		};
	}
	if (type === "tool/call") {
		let input = null;
		try { input = JSON.parse(data.arguments ?? "null"); } catch { input = data.arguments ?? null; }
		return {
			type: "tool-call-pending",
			sourceSeq: event.seq,
			turn: data.turn,
			step: data.step,
			time: iso(),
			detail: { callId: data.callId, name: data.name, input }
		};
	}
	if (type === "tool/result") {
		const message = data.message ?? {};
		const block = (Array.isArray(message.content) ? message.content : []).find((b) => b.type === "tool-result");
		return {
			type: "tool",
			sourceSeq: event.seq,
			turn: data.turn,
			step: data.step,
			time: iso(),
			detail: {
				callId: block?.toolCallId ?? message.source?.callId,
				result: block?.content ?? [],
				isError: block?.isError === true
			}
		};
	}
	if (type === "user/message") {
		const content = Array.isArray(data.content) ? data.content : [];
		const toolResult = content.find((block) => block.type === "tool-result");
		const source = data.source ?? {};
		if (toolResult !== void 0) {
			return {
				type: "tool",
				sourceSeq: event.seq,
				turn: data.turn,
				step: data.step,
				time: iso(),
				detail: { callId: toolResult.toolCallId, result: toolResult.content ?? [], isError: toolResult.isError === true }
			};
		}
		// Skip injected runtime-context snapshots and non-intent messages.
		if (source.kind === "system-prompt" || source.plugin === "@deepseek-ai/dsh-system-prompt" || source.kind === "tool") return null;
		return {
			type: "user",
			sourceSeq: event.seq,
			turn: data.turn,
			step: data.step,
			time: iso(),
			detail: { content, source: { kind: source.kind ?? null, plugin: source.plugin ?? null } }
		};
	}
	return null;
}

// ── git versioning + worktrees ───────────────────────────────────────────────

/** Ensure the trace root doubles as a git repo (dedicated, never the workspace repo). */
function ensureTraceGit(traceRoot) {
	if (!existsSync(join(traceRoot, ".git"))) {
		execFileSync("git", ["init", "-q"], { cwd: traceRoot });
		try { execFileSync("git", ["config", "user.name", "dsh-trace-repeat"], { cwd: traceRoot }); } catch { /* ignore */ }
		try { execFileSync("git", ["config", "user.email", "trace@dsh.local"], { cwd: traceRoot }); } catch { /* ignore */ }
	}
	return traceRoot;
}
/** Commit one version; returns the commit hash ("" on failure). */
function commitVersion(traceRoot, sessionId, seq, type) {
	try {
		ensureTraceGit(traceRoot);
		execFileSync("git", ["add", "-A", encodeSessionId(sessionId)], { cwd: traceRoot });
		execFileSync("git", ["commit", "-q", "-m", `trace: ${sessionId} v${seq} ${type}`], { cwd: traceRoot });
		return execFileSync("git", ["rev-parse", "HEAD"], { cwd: traceRoot }).toString().trim();
	} catch {
		return "";
	}
}
/** Worktrees cannot live inside the repo; sibling dir under the workspace. */
function worktreeRootFor(traceRoot) {
	return join(dirname(traceRoot), `${basename(traceRoot)}-worktrees`);
}
/** Materialize one version's commit into a worktree. */
function materializeWorktree(traceRoot, sessionId, seq, commitHash) {
	const dir = join(worktreeRootFor(traceRoot), `${encodeSessionId(sessionId)}-v${seq}`);
	if (existsSync(dir)) return dir;
	if (!commitHash) throw new Error(`version v${seq} has no git commit (git versioning disabled or commit failed)`);
	execFileSync("git", ["worktree", "add", "-q", "-f", dir, commitHash], { cwd: traceRoot });
	return dir;
}
/** Patch a version's gitCommit into the header. */
function patchGitCommit(traceRoot, sessionId, seq, commitHash) {
	if (!commitHash) return;
	const header = readTrace(traceRoot, sessionId);
	if (!header) return;
	const entry = header.versions.find((v) => v.seq === seq);
	if (entry) entry.gitCommit = commitHash;
	atomicWriteJson(traceHeaderPath(traceRoot, sessionId), header);
}

// ── resume: rebuild transcript + balanced truncation ─────────────────────────

/**
* Build a balanced completed-turn seed from the trace up to `uptoSeq`.
* @returns `{ seed, balancedSeq }` — `seed` is an array of session events
* (user/message + assistant/message) ending at the last balanced completed
* turn ≤ uptoSeq, or null when no balanced point exists; `balancedSeq` is the
* version seq of that boundary (null when `seed` is null).
*/
function buildSeedFromTrace(traceRoot, sessionId, trace, uptoSeq) {
	const messages = [];
	const seqs = [];
	for (const v of trace.versions) {
		if (v.seq > uptoSeq) break;
		if (v.type === "paused" || v.type === "resumed") continue;
		const full = readVersionFile(traceRoot, sessionId, v.seq, v.type);
		if (v.type === "user") {
			if (Array.isArray(full.detail?.content) && full.detail.content.length > 0) {
				messages.push({ role: "user", content: full.detail.content, source: { kind: full.detail?.source?.kind ?? "user" } });
				seqs.push(v.seq);
			}
		} else if (v.type === "reasoning") {
			if (Array.isArray(full.detail?.content)) {
				messages.push({
					role: "assistant",
					content: full.detail.content,
					source: { kind: "model", provider: full.meta?.provider, model: full.meta?.model }
				});
				seqs.push(v.seq);
			}
		} else if (v.type === "tool") {
			const d = full.detail ?? {};
			messages.push({
				role: "user",
				content: [{ type: "tool-result", toolCallId: d.callId, content: d.result ?? [], isError: d.isError === true }],
				source: { kind: "tool", callId: d.callId }
			});
			seqs.push(v.seq);
		}
	}
	// A balanced prefix ends right after an assistant message that carries no
	// pending tool calls. Anything after the LAST such boundary (dangling tool
	// calls, tool results, mid-step messages) is dropped.
	let end = 0;
	for (let i = 0; i < messages.length; i += 1) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const hasTools = Array.isArray(message.content) && message.content.some((block) => block.type === "tool-call");
		if (!hasTools) end = i + 1;
	}
	if (end === 0) return { seed: null, balancedSeq: null };
	const slice = messages.slice(0, end);
	return {
		seed: slice.map((message, i) => {
			const id = newId();
			const time = Date.now();
			if (message.role === "assistant") {
				return {
					type: "assistant/message",
					seq: i,
					time,
					surfaceOp: "append",
					data: { turn: 1, step: i + 1, message: { ...message, id }, usage: {} }
				};
			}
			return { type: "user/message", seq: i, time, surfaceOp: "append", data: { ...message, role: "user", id } };
		}),
		balancedSeq: seqs[end - 1] ?? null
	};
}
/** Mint a unique session id. */
function mintSessionId(ctx) {
	for (let attempt = 0; attempt < 30; attempt += 1) {
		const candidate = `session-trace-${Date.now().toString(36)}-${attempt}`;
		if (ctx.sessions?.get(candidate) === void 0 && ctx.agents.get(candidate) === void 0) return candidate;
	}
	throw new Error("could not mint a unique session id");
}

// ── recorder ─────────────────────────────────────────────────────────────────

function agentInfoOf(ctx, session) {
	const agent = ctx.agents?.get(session.id);
	const selection = ctx.agentDefaultModel?.currentSelection?.();
	return {
		agentOptions: agent?.options ?? null,
		reasoningEffort: selection?.reasoningEffort ?? null,
		cwd: session.meta?.cwd ?? session.header?.cwd ?? null,
		preset: session.meta?.agentPreset ?? session.header?.agentPreset ?? null
	};
}
/**
* Reconcile the pause gate with task-control's OWN durable store (Route A:
* task-control no longer writes `task-control/*` session events — a session
* containing them would become unloadable). On every session event we ask the
* `taskControl` service for the current state and record paused/resumed
* marker versions on transitions. The service is absent when task-control is
* not installed: the gate then stays open (constant recording).
*/
function reconcilePause(ctx, traceRoot, config, state, sessionId) {
	const tc = ctx.get?.("taskControl");
	const tcState = tc?.state?.(sessionId);
	const pausedNow = tcState?.paused === true;
	const wasPaused = state.paused.has(sessionId);
	if (pausedNow === wasPaused) return;
	if (pausedNow) {
		state.paused.add(sessionId);
		appendMarkerVersion(traceRoot, config, sessionId, "paused", {
			forced: tcState?.forced === true,
			interruptedTool: tcState?.interruptedTool ?? null
		});
		return;
	}
	state.paused.delete(sessionId);
	appendMarkerVersion(traceRoot, config, sessionId, "resumed", {});
}
/** Append one marker version (paused / resumed) and git-commit it when enabled. */
function appendMarkerVersion(traceRoot, config, sessionId, type, detail) {
	const version = { type, sourceSeq: null, time: new Date().toISOString(), detail };
	const { seq } = appendVersion(traceRoot, sessionId, version, config.maxVersions);
	if (config.traceGit) patchGitCommit(traceRoot, sessionId, seq, commitVersion(traceRoot, sessionId, seq, version.type));
}
/**
* Handle one session/event: dedupe by seq, reconcile the pause gate, map,
* gate on pause, append, commit.
*/
function handleSessionEvent(ctx, traceRoot, config, state, session, event) {
	const sessionId = session.id;
	if (typeof sessionId !== "string" || sessionId.length === 0) return;
	const last = state.lastSeq.get(sessionId) ?? -1;
	if (event.seq <= last) return;
	reconcilePause(ctx, traceRoot, config, state, sessionId);
	const version = mapEventToVersion(event, agentInfoOf(ctx, session));
	if (version === null) {
		state.lastSeq.set(sessionId, event.seq);
		return;
	}
	if (version.type === "tool-call-pending") {
		const pending = state.pendingToolCalls.get(sessionId) ?? new Map();
		pending.set(version.detail.callId, { name: version.detail.name, input: version.detail.input });
		state.pendingToolCalls.set(sessionId, pending);
		state.lastSeq.set(sessionId, event.seq);
		return;
	}
	if (state.paused.has(sessionId) && (version.type === "reasoning" || version.type === "tool")) {
		state.lastSeq.set(sessionId, event.seq);
		return;
	}
	if (version.type === "tool") {
		const pending = state.pendingToolCalls.get(sessionId);
		const fromPending = pending?.get(version.detail.callId);
		if (fromPending) {
			version.detail.toolName = fromPending.name;
			version.detail.input = fromPending.input;
			pending.delete(version.detail.callId);
		} else {
			// Fallback: match against tool calls embedded in the last assistant message.
			const calls = state.lastToolCalls.get(sessionId) ?? [];
			const match = calls.find((call) => call.callId === version.detail.callId);
			if (match) {
				version.detail.toolName = match.name;
				version.detail.input = match.input;
			}
		}
	}
	if (version.type === "reasoning") {
		state.lastToolCalls.set(sessionId, version.toolCalls ?? []);
		delete version.toolCalls;
	}
	const { seq } = appendVersion(traceRoot, sessionId, version, config.maxVersions);
	if (config.traceGit) patchGitCommit(traceRoot, sessionId, seq, commitVersion(traceRoot, sessionId, seq, version.type));
	state.lastSeq.set(sessionId, event.seq);
}

// ── resume execution ─────────────────────────────────────────────────────────

/** Resume from version vN: rebuild seed, materialize worktree, create session, continue. */
async function resumeFromVersion(ctx, traceRoot, config, sessionId, seq) {
	const trace = readTrace(traceRoot, sessionId);
	if (!trace) return { ok: false, error: `no trace for session "${sessionId}"` };
	const version = trace.versions.find((v) => v.seq === seq);
	if (!version) return { ok: false, error: `version v${seq} not found in trace of "${sessionId}"` };
	const built = buildSeedFromTrace(traceRoot, sessionId, trace, seq);
	if (built.seed === null) return { ok: false, error: `version v${seq} 处于回合中间（无平衡恢复点）；请从更早的「推理完成」版本恢复` };
	const fromSeq = built.balancedSeq ?? seq;
	const fromVersion = trace.versions.find((v) => v.seq === fromSeq);
	let cwd = trace.cwd;
	if (config.traceGit) {
		try {
			cwd = materializeWorktree(traceRoot, sessionId, fromSeq, fromVersion?.gitCommit);
		} catch (error) {
			return { ok: false, error: `worktree materialization failed: ${String(error)}` };
		}
	}
	const newSessionId = mintSessionId(ctx);
	const selection = ctx.agentDefaultModel?.currentSelection?.() ?? {};
	const agentOptions = {
		provider: selection.provider,
		model: selection.model
	};
	const handle = await ctx.agents.create({
		sessionId: newSessionId,
		meta: {
			...(cwd ? { cwd } : {}),
			...(trace.preset ? { agentPreset: trace.preset } : {})
		},
		seed: built.seed,
		agentOptions,
		// The loop does NOT mount meta.agentPreset — mount explicitly so the
		// resumed session gets the original preset's tools/prompt.
		setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, trace.preset ?? void 0); }
	});
	handle.agent.followup(buildUserMessage(
		[{ type: "text", text: `[trace-repeat] 已从会话 ${sessionId} 的版本 v${fromSeq}（请求 v${seq}）恢复执行。以上是恢复点之前的完整 trace，请基于它继续完成任务。` }],
		{}
	));
	return { ok: true, sessionId: newSessionId, cwd: cwd ?? null, from: { sessionId, seq: fromSeq, requested: seq } };
}

// ── commands ─────────────────────────────────────────────────────────────────

function ok(text) { return { kind: "success", text }; }
function err(text) { return { kind: "error", text }; }
function formatTimeline(trace) {
	const lines = [`Trace: ${trace.sessionId} — ${trace.versions.length} version(s), created ${trace.createdAt ?? "?"}`];
	for (const v of trace.versions) {
		lines.push(`  v${String(v.seq).padStart(3, " ")} ${v.type.padEnd(9)} ${v.time}${v.gitCommit ? ` @${v.gitCommit.slice(0, 8)}` : ""}`);
	}
	return lines.join("\n");
}
function registerCommands(ctx, traceRoot, config) {
	ctx.commands.register({
		name: "trace",
		description: "list traced sessions",
		input: { hint: "[list|<sessionId>|show <sessionId> [vN]|resume <sessionId> <vN>]" },
		handler: (invocation) => {
			const parts = (invocation.rawInput ?? "").trim().split(/\s+/).filter(Boolean);
			const [sub, a, b] = parts;
			if (sub === "show" && a) {
				const trace = readTrace(traceRoot, a);
				if (!trace) return err(`no trace for session "${a}"`);
				if (b !== void 0) {
					const seq = Number(b.replace(/^v/i, ""));
					const v = trace.versions.find((x) => x.seq === seq);
					if (!v) return err(`version v${seq} not found`);
					const full = readVersionFile(traceRoot, a, seq, v.type);
					return ok(`${formatTimeline({ ...trace, versions: [v] })}\n\n${JSON.stringify({ meta: full.meta, detail: full.detail }, null, 2)}`);
				}
				return ok(formatTimeline(trace));
			}
			if (sub === "resume" && a && b) {
				return resumeFromVersion(ctx, traceRoot, config, a, Number(b.replace(/^v/i, ""))).then((result) =>
					result.ok ? ok(`resumed from v${b}: new session ${result.sessionId}${result.cwd ? ` in ${result.cwd}` : ""}`) : err(result.error));
			}
			if (sub === "list" && a) {
				const trace = readTrace(traceRoot, a);
				return trace ? ok(formatTimeline(trace)) : err(`no trace for session "${a}"`);
			}
			// default: list sessions
			const sessions = listTracedSessions(traceRoot);
			if (sessions.length === 0) return ok(`no traces yet under ${traceRoot}`);
			return ok(`traced sessions (${sessions.length}):\n` + sessions.map((s) => `  ${s.sessionId} — ${s.versions.length} version(s)`).join("\n"));
		}
	});
}

// ── apply ────────────────────────────────────────────────────────────────────

/**
* Host plugin body: subscribe to session events and register the `/trace`
* command family.
* @param ctx - host plugin context.
* @param config - optional `{ traceRoot?, traceGit?, maxVersions? }`.
*/
function apply(ctx, config = {}) {
	const workspaceRoot = ctx.sandboxPolicy?.workspaceRoot ?? process.cwd();
	const traceRoot = config.traceRoot ? (config.traceRoot.startsWith("/") ? config.traceRoot : join(workspaceRoot, config.traceRoot)) : join(workspaceRoot, ".dsh-trace");
	const resolved = {
		traceRoot,
		traceGit: config.traceGit !== false,
		maxVersions: Number.isFinite(config.maxVersions) ? config.maxVersions : DEFAULT_MAX_VERSIONS
	};
	const state = { paused: new Set(), lastToolCalls: new Map(), pendingToolCalls: new Map(), lastSeq: new Map() };
	ctx.on("session/event", (session, event) => {
		try {
			handleSessionEvent(ctx, traceRoot, resolved, state, session, event);
		} catch (error) {
			ctx.logger?.error?.("trace-repeat: record failed: " + String(error));
		}
	});
	registerCommands(ctx, traceRoot, resolved);
}
//#endregion
export { DEFAULT_MAX_VERSIONS, PLUGIN_TAG, appendVersion, apply, atomicWriteJson, buildSeedFromTrace, buildUserMessage, commitVersion, encodeSessionId, ensureTraceGit, handleSessionEvent, inject, listTracedSessions, mapEventToVersion, materializeWorktree, mintSessionId, name, patchGitCommit, readTrace, readVersionFile, resumeFromVersion, traceDirFor, traceHeaderPath, versionFileName, worktreeRootFor };
