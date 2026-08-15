// Local smoke test for dsh-trace-repeat host half: atomic store, event→version
// mapping, task-control pause gating, balanced seed truncation, and git
// commit + worktree materialization (in a tmp dir).
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendVersion, atomicWriteJson, buildSeedFromTrace, commitVersion, encodeSessionId,
  ensureTraceGit, handleSessionEvent, mapEventToVersion, materializeWorktree,
  readTrace, readVersionFile, traceDirFor, versionFileName
} from "../lib/index.js";

const root = mkdtempSync(join(tmpdir(), "dsh-trace-repeat-test-"));
try {
  // --- paths + encoding -------------------------------------------------------
  if (encodeSessionId("session-a/b") !== "session-a_b") throw new Error("session id encoding wrong");
  if (versionFileName(7, "reasoning") !== "v-000007-reasoning.json") throw new Error("version file name wrong");
  if (traceDirFor(root, "s1") !== join(root, "s1")) throw new Error("trace dir wrong");

  // --- atomic write + rebuild --------------------------------------------------
  atomicWriteJson(join(root, "x", "trace.json"), { a: 1 });
  if (!existsSync(join(root, "x", "trace.json"))) throw new Error("atomic write missing");
  if (existsSync(join(root, "x", "trace.json.tmp"))) throw new Error("tmp file left behind");

  // --- appendVersion ------------------------------------------------------------
  const v1 = appendVersion(root, "s1", { type: "reasoning", time: "2026-01-01T00:00:00Z", meta: { provider: "p", model: "m" }, detail: { content: [{ type: "text", text: "hi" }] } });
  const v2 = appendVersion(root, "s1", { type: "tool", time: "2026-01-01T00:00:01Z", detail: { callId: "c1", result: [] } });
  if (v1.seq !== 0 || v2.seq !== 1) throw new Error("seq not monotonic");
  const trace = readTrace(root, "s1");
  if (trace.versions.length !== 2 || trace.versions[1].type !== "tool") throw new Error("header index wrong");
  if (trace.paused !== false) throw new Error("header paused should be false");
  console.log("appendVersion ->", trace.versions.map((v) => `v${v.seq}:${v.type}`).join(", "));

  // --- rebuild from files (header deleted) --------------------------------------
  rmSync(join(root, "s1", "trace.json"));
  const rebuilt = readTrace(root, "s1");
  if (rebuilt.versions.length !== 2) throw new Error("rebuild from files failed");
  console.log("rebuild ->", rebuilt.versions.length, "versions");

  // --- event mapping ------------------------------------------------------------
  const reasoning = mapEventToVersion({ type: "assistant/message", seq: 5, time: 1, data: { turn: 1, step: 2, message: { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "bash", input: { command: "ls" } }, { type: "text", text: "ok" }], source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-flash" } }, usage: { inputTokens: 10 } } }, { agentOptions: {} });
  if (reasoning.type !== "reasoning" || reasoning.meta.provider !== "deepseek-official" || reasoning.toolCalls.length !== 1) throw new Error("reasoning mapping wrong");
  console.log("reasoning ->", reasoning.type, reasoning.meta.provider, "toolCalls:", reasoning.toolCalls.length);

  const tool = mapEventToVersion({ type: "user/message", seq: 6, time: 2, data: { content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "done" }], isError: false }], source: { kind: "tool", callId: "c1" } } }, {});
  if (tool.type !== "tool" || tool.detail.callId !== "c1") throw new Error("tool mapping wrong");
  const user = mapEventToVersion({ type: "user/message", seq: 7, time: 3, data: { content: [{ type: "text", text: "hello" }], source: { kind: "user" } } }, {});
  if (user.type !== "user") throw new Error("user mapping wrong");
  const snapshot = mapEventToVersion({ type: "user/message", seq: 8, time: 4, data: { content: [{ type: "text", text: "context" }], source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt" } } }, {});
  if (snapshot !== null) throw new Error("system-prompt snapshot should be skipped");
  const customPaused = mapEventToVersion({ type: "task-control/paused", seq: 9, time: 5, data: {} }, {});
  const customResumed = mapEventToVersion({ type: "task-control/resumed", seq: 10, time: 6, data: {} }, {});
  if (customPaused !== null || customResumed !== null) throw new Error("custom task-control events must not map to versions (Route A: state lives in the taskControl store)");
  const chunk = mapEventToVersion({ type: "assistant/chunk", seq: 11, time: 7, data: {} }, {});
  if (chunk !== null) throw new Error("chunk should not be a version");
  console.log("mapping: reasoning/tool/user/snapshot-skip/custom-event-skip/chunk-skip OK");

  // --- recorder with pause gating (state comes from the taskControl service) ---
  const events = [];
  const tcState = { paused: false, forced: false, interruptedTool: null };
  const mkCtx = () => ({
    logger: { error: (...a) => console.log("[error]", ...a) },
    get: (key) => key === "taskControl" ? { state: () => tcState } : undefined,
    agents: { get: () => undefined },
    agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) },
    sessions: { get: () => undefined },
    sandboxPolicy: { workspaceRoot: root }
  });
  const state = { paused: new Set(), lastToolCalls: new Map(), pendingToolCalls: new Map(), lastSeq: new Map() };
  const config = { traceRoot: join(root, "rt"), traceGit: false, maxVersions: 100 };
  const session = { id: "sess-1" };
  const ev = (seq, type, data, source) => ({ seq, type, time: seq, data: source !== void 0 ? { content: data, source } : data });
  const fire = (e) => handleSessionEvent(mkCtx(), config.traceRoot, config, state, session, e);
  fire(ev(0, "user/message", [{ type: "text", text: "task prompt" }], { kind: "user" }));
  fire(ev(1, "assistant/message", { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "a1" }], source: { kind: "model", provider: "p", model: "m" } }, usage: {} }));
  tcState.paused = true;
  fire(ev(2, "assistant/message", { turn: 1, step: 2, message: { role: "assistant", content: [{ type: "text", text: "during pause" }], source: { kind: "model", provider: "p", model: "m" } }, usage: {} }));
  fire(ev(3, "user/message", [{ type: "text", text: "new input while paused" }], { kind: "user" }));
  tcState.paused = false;
  fire(ev(4, "assistant/message", { turn: 1, step: 3, message: { role: "assistant", content: [{ type: "text", text: "after resume" }], source: { kind: "model", provider: "p", model: "m" } }, usage: {} }));
  // native tool pipeline: tool/call + tool/result
  fire({ seq: 5, type: "tool/call", time: 5, data: { turn: 1, step: 4, callId: "call_1", name: "bash", arguments: JSON.stringify({ command: "echo hi" }) } });
  fire({ seq: 6, type: "tool/result", time: 6, data: { turn: 1, step: 4, message: { source: { kind: "tool", callId: "call_1" }, content: [{ type: "tool-result", toolCallId: "call_1", content: [{ type: "text", text: "hi" }], isError: false }], role: "user" } } });
  const recorded = readTrace(config.traceRoot, "sess-1");
  const types = recorded.versions.map((v) => v.type);
  console.log("recorder types ->", types.join(","));
  const expected = ["user", "reasoning", "paused", "user", "resumed", "reasoning", "tool"];
  if (JSON.stringify(types) !== JSON.stringify(expected)) throw new Error(`pause gating wrong: ${types.join(",")}`);
  if (recorded.paused !== false) throw new Error("header paused should be cleared after resume");
  const toolVersion = readVersionFile(config.traceRoot, "sess-1", 6, "tool");
  if (toolVersion.detail.toolName !== "bash" || toolVersion.detail.input?.command !== "echo hi") {
    throw new Error(`tool version should carry name+input from tool/call: ${JSON.stringify(toolVersion.detail)}`);
  }
  if (toolVersion.detail.result?.[0]?.text !== "hi") throw new Error("tool version result missing");
  console.log("tool version ->", toolVersion.detail.toolName, JSON.stringify(toolVersion.detail.input), "result:", JSON.stringify(toolVersion.detail.result));

  // --- balanced seed truncation --------------------------------------------------
  // Build a trace: user, reasoning-with-tool-call, tool, reasoning-final
  const seedCtx = mkCtx();
  const seedState = { paused: new Set(), lastToolCalls: new Map(), pendingToolCalls: new Map(), lastSeq: new Map() };
  const s2 = { id: "sess-2" };
  const rt2 = join(root, "rt2");
  const ev2 = (seq, type, data, source) => ({ seq, type, time: seq, data: source !== void 0 ? { content: data, source } : data });
  handleSessionEvent(seedCtx, rt2, { traceRoot: rt2, traceGit: false, maxVersions: 100 }, seedState, s2, ev2(0, "user/message", [{ type: "text", text: "task" }], { kind: "user" }));
  handleSessionEvent(seedCtx, rt2, { traceRoot: rt2, traceGit: false, maxVersions: 100 }, seedState, s2, ev2(1, "assistant/message", { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "bash", input: {} }], source: { kind: "model", provider: "p", model: "m" } }, usage: {} }));
  handleSessionEvent(seedCtx, rt2, { traceRoot: rt2, traceGit: false, maxVersions: 100 }, seedState, s2, ev2(2, "user/message", [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "out" }], isError: false }], { kind: "tool", callId: "c1" }));
  handleSessionEvent(seedCtx, rt2, { traceRoot: rt2, traceGit: false, maxVersions: 100 }, seedState, s2, ev2(3, "assistant/message", { turn: 1, step: 2, message: { role: "assistant", content: [{ type: "text", text: "final" }], source: { kind: "model", provider: "p", model: "m" } }, usage: {} }));
  const trace2 = readTrace(rt2, "sess-2");
  // seed up to v3 (final assistant, no tool calls) -> full 4 messages, balanced at v3
  const seedFull = buildSeedFromTrace(rt2, "sess-2", trace2, 3);
  if (seedFull.seed.length !== 4) throw new Error(`full seed should have 4 messages, got ${seedFull.seed.length}`);
  if (seedFull.seed[seedFull.seed.length - 1].type !== "assistant/message") throw new Error("full seed should end with assistant");
  if (seedFull.balancedSeq !== 3) throw new Error(`full seed balancedSeq should be 3, got ${seedFull.balancedSeq}`);
  // seed up to v1 (assistant with tool call) -> no balanced point
  const seedCut = buildSeedFromTrace(rt2, "sess-2", trace2, 1);
  if (seedCut.seed !== null || seedCut.balancedSeq !== null) throw new Error("mid-turn version should have no balanced seed");
  // seed up to v2 (tool result) -> still no balanced point
  const seedMid = buildSeedFromTrace(rt2, "sess-2", trace2, 2);
  if (seedMid.seed !== null) throw new Error("tool-result end should have no balanced seed");
  console.log("seed: full ->", seedFull.seed.length, "messages @v" + seedFull.balancedSeq, "; mid-turn -> null");

  // --- git commit + worktree ------------------------------------------------------
  const gitRoot = join(root, "git-trace");
  appendVersion(gitRoot, "s3", { type: "user", time: "2026-01-01T00:00:00Z", detail: { content: [{ type: "text", text: "hello" }] } });
  const hash = commitVersion(gitRoot, "s3", 0, "user");
  if (!hash) throw new Error("git commit failed");
  const wt = materializeWorktree(gitRoot, "s3", 0, hash);
  if (!existsSync(join(wt, "s3", "v-000000-user.json"))) throw new Error("worktree does not contain the version file");
  console.log("git ->", hash.slice(0, 8), "worktree:", wt);
  console.log("worktree root listing:", readdirSync(join(gitRoot, "..", "git-trace-worktrees")).join(", "));

  console.log("\nALL HOST HALF CHECKS PASSED");
} finally {
  rmSync(root, { recursive: true, force: true });
}
