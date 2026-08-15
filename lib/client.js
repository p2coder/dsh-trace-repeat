window.__ModuleLoader__.load({
	id: "dsh-trace-repeat",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region lib/types/client/locales.js
		/** `trace-repeat` namespace dictionaries. */
		const zh = {
			"section.label": "Trace 回放",
			"section.hint": "记录任意会话的推理/tool 执行 trace（原子、版本化）。选择会话查看版本时间线，点版本看详情，可物化 worktree 或从该版本恢复执行。",
			"session.select": "会话",
			"session.empty": "尚无 trace 记录 — 任意会话运行后会自动记录",
			"session.refresh": "刷新",
			"versions.title": "版本时间线",
			"versions.empty": "该会话暂无版本",
			"version.detail": "版本详情",
			"version.back": "返回列表",
			"version.type.reasoning": "推理",
			"version.type.tool": "工具",
			"version.type.user": "输入",
			"version.type.paused": "暂停",
			"version.type.resumed": "恢复",
			"action.worktree": "打开 worktree",
			"action.resume": "从此版本恢复",
			"confirm.resume": "将以 v{seq} 之前的 trace 为上下文新开会话继续执行，确认？",
			"state.resumed": "已恢复 → 新会话 {id}",
			"state.worktree": "worktree: {path}",
			"meta.model": "模型",
			"meta.usage": "token 用量",
			"meta.time": "时间",
			"state.loading": "加载中…"
		};
		const en = {
			"section.label": "Trace replay",
			"section.hint": "Records any session's reasoning/tool trace (atomic, versioned). Pick a session to view the version timeline; click a version for details, materialize a worktree, or resume execution from it.",
			"session.select": "Session",
			"session.empty": "No traces yet — any running session is recorded automatically",
			"session.refresh": "Refresh",
			"versions.title": "Version timeline",
			"versions.empty": "No versions for this session",
			"version.detail": "Version detail",
			"version.back": "Back to list",
			"version.type.reasoning": "Reasoning",
			"version.type.tool": "Tool",
			"version.type.user": "Input",
			"version.type.paused": "Paused",
			"version.type.resumed": "Resumed",
			"action.worktree": "Open worktree",
			"action.resume": "Resume from here",
			"confirm.resume": "Resume with the trace before v{seq} as context in a new session — confirm?",
			"state.resumed": "Resumed → new session {id}",
			"state.worktree": "worktree: {path}",
			"meta.model": "Model",
			"meta.usage": "Tokens",
			"meta.time": "Time",
			"state.loading": "Loading…"
		};
		//#endregion
		const NS = "trace-repeat";
		/** Required client services: slots (settings.section), sessions (open), locale (dictionaries). */
		const inject = ["slots", "sessions", "locale"];
		const h = react.createElement;
		const TYPE_LABELS = { reasoning: "version.type.reasoning", tool: "version.type.tool", user: "version.type.user", paused: "version.type.paused", resumed: "version.type.resumed" };
		const api = (path, options) => fetch(path, options).then((res) => res.json());
		const post = (path, body) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		const LABEL = { display: "block", fontSize: 12, opacity: 0.7, margin: "8px 0 2px" };
		const INPUT = { width: "100%", boxSizing: "border-box", padding: "4px 6px", borderRadius: 6, border: "1px solid var(--dsw-alias-border, #ddd)", background: "var(--dsw-alias-bg, transparent)", color: "var(--dsw-alias-text, inherit)" };
		const BUTTON = { padding: "4px 10px", borderRadius: 6, border: "1px solid var(--dsw-alias-border, #ccc)", background: "var(--dsw-alias-bg, #fff)", color: "var(--dsw-alias-text, inherit)", cursor: "pointer" };
		const PRIMARY = { ...BUTTON, background: "var(--dsw-alias-accent, #1677ff)", borderColor: "transparent", color: "#fff" };
		const ROW = { display: "flex", gap: 6, alignItems: "flex-start", padding: "8px 0", borderBottom: "1px solid var(--dsw-alias-border, #eee)", cursor: "pointer" };
		const BADGE = { fontSize: 12, padding: "1px 8px", borderRadius: 10, border: "1px solid var(--dsw-alias-border, #ccc)" };
		const PRE = { margin: 0, padding: 8, borderRadius: 6, background: "var(--dsw-alias-bg, #fafafa)", border: "1px solid var(--dsw-alias-border, #eee)", fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 360, overflowY: "auto" };
		function makeT(locale) {
			const t = locale.bind(NS);
			return (key, params) => {
				const text = t(key);
				if (params === void 0) return text;
				return String(text).replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? `{${k}}`));
			};
		}
		/** One version timeline row (clickable). */
		function VersionRow({ t, version, selected, onClick }) {
			return h("div", {
				style: { ...ROW, ...(selected ? { background: "var(--dsw-alias-accent-soft, #eef4ff)" } : {}) },
				onClick
			},
				h("span", { style: { ...BADGE, flex: "none" } }, `v${version.seq}`),
				h("span", { style: { ...BADGE, flex: "none", color: "var(--dsw-alias-text-muted, inherit)" } }, t(TYPE_LABELS[version.type] ?? version.type)),
				h("div", { style: { flex: 1, minWidth: 0 } },
					h("div", { style: { fontSize: 12, opacity: 0.75, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, version.time),
					version.gitCommit ? h("div", { style: { fontSize: 11, opacity: 0.6 } }, `@${version.gitCommit.slice(0, 8)}`) : null));
		}
		/**
		* Trace replay settings page: session picker → version timeline → detail
		* with worktree materialization and resume-from-version.
		*/
		function TraceReplayPanel({ sessions, locale }) {
			const [t, setT] = react.useState(() => makeT(locale));
			react.useEffect(() => locale.subscribe(() => setT(() => makeT(locale))), [locale]);
			const [traced, setTraced] = react.useState([]);
			const [sessionId, setSessionId] = react.useState("");
			const [versions, setVersions] = react.useState([]);
			const [selectedSeq, setSelectedSeq] = react.useState(null);
			const [detail, setDetail] = react.useState(null);
			const [gitEnabled, setGitEnabled] = react.useState(true);
			const [error, setError] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [notice, setNotice] = react.useState(null);

			const refreshSessions = react.useCallback(() => {
				api("/trace-repeat/sessions").then((res) => { if (res.ok) setTraced(res.sessions); }).catch(() => {});
				api("/trace-repeat/info").then((res) => { if (res.ok) setGitEnabled(res.gitEnabled); }).catch(() => {});
			}, []);
			react.useEffect(() => { refreshSessions(); }, [refreshSessions]);
			// Live refresh while the page is open (traces grow while tasks run).
			react.useEffect(() => {
				const timer = window.setInterval(refreshSessions, 5000);
				return () => window.clearInterval(timer);
			}, [refreshSessions]);

			const pickSession = async (id) => {
				setSessionId(id);
				setSelectedSeq(null);
				setDetail(null);
				const res = await api(`/trace-repeat/versions?session=${encodeURIComponent(id)}`);
				if (res.ok) setVersions(res.trace.versions);
			};
			const pickVersion = async (seq) => {
				setSelectedSeq(seq);
				setDetail(null);
				const res = await api(`/trace-repeat/version?session=${encodeURIComponent(sessionId)}&seq=${seq}`);
				if (res.ok) setDetail(res.version);
			};
			const openWorktree = async () => {
				setBusy(true);
				setError(null);
				setNotice(null);
				try {
					const res = await post("/trace-repeat/worktree", { session: sessionId, seq: selectedSeq });
					if (!res.ok) { setError(res.error || "?"); return; }
					setNotice(t("state.worktree", { path: res.path }));
				} catch (err) { setError(String(err)); } finally { setBusy(false); }
			};
			const resume = async () => {
				if (!window.confirm(t("confirm.resume", { seq: selectedSeq }))) return;
				setBusy(true);
				setError(null);
				setNotice(null);
				try {
					const res = await post("/trace-repeat/resume", { session: sessionId, seq: selectedSeq });
					if (!res.ok) { setError(res.error || "?"); return; }
					setNotice(t("state.resumed", { id: res.sessionId }));
					if (sessions !== void 0 && typeof sessions.open === "function") sessions.open(res.sessionId);
				} catch (err) { setError(String(err)); } finally { setBusy(false); }
			};
			const summaryOf = (version) => {
				if (version.type === "reasoning") {
					const text = (version.detail?.content ?? []).find((b) => b.type === "text")?.text ?? "";
					return `模型 ${version.meta?.model ?? "?"} · ${text.slice(0, 60)}`;
				}
				if (version.type === "tool") return `${version.detail?.toolName ?? version.detail?.callId ?? "tool"} · ${version.detail?.isError ? "ERROR" : "ok"}`;
				if (version.type === "user") return "用户输入";
				return "";
			};
			return h("div", { style: { display: "flex", flexDirection: "column", gap: 4, maxWidth: 760 } },
				h("p", { style: { opacity: 0.75, fontSize: 13 } }, t("section.hint")),
				h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
					h("label", { style: LABEL, margin: 0 }, t("session.select")),
					h("select", { style: { ...INPUT, flex: 1, marginLeft: 6 }, value: sessionId, onChange: (e) => pickSession(e.target.value) },
						h("option", { value: "" }, traced.length === 0 ? t("session.empty") : "—"),
						traced.map((s) => h("option", { key: s.sessionId, value: s.sessionId }, `${s.sessionId} · ${s.count} 版本${s.paused ? " · 暂停中" : ""}`))),
					h("button", { style: BUTTON, type: "button", onClick: refreshSessions }, t("session.refresh"))),
				sessionId === "" ? h("p", { style: { opacity: 0.6 } }, t("session.empty")) : h(react.Fragment, null,
					h("div", { style: { marginTop: 10, fontWeight: 600 } }, t("versions.title")),
					versions.length === 0 ? h("p", { style: { opacity: 0.6 } }, t("versions.empty"))
						: h("div", { style: { maxHeight: 300, overflowY: "auto", border: "1px solid var(--dsw-alias-border, #eee)", borderRadius: 8, padding: "0 8px" } },
							versions.map((v) => h(VersionRow, { key: v.seq, t, version: v, selected: v.seq === selectedSeq, onClick: () => pickVersion(v.seq) }))),
					selectedSeq !== null && detail !== null ? h("div", { style: { marginTop: 10 } },
						h("div", { style: { display: "flex", gap: 6, alignItems: "center", marginBottom: 6 } },
							h("span", { style: { fontWeight: 700 } }, `${t("version.detail")} · v${detail.seq}`),
							h("span", { style: { ...BADGE } }, t(TYPE_LABELS[detail.type] ?? detail.type)),
							h("button", { style: { ...BUTTON, marginLeft: "auto" }, type: "button", onClick: () => { setSelectedSeq(null); setDetail(null); } }, t("version.back"))),
						h("div", { style: { fontSize: 12, opacity: 0.8, marginBottom: 6 } },
							detail.type === "reasoning"
								? `${t("meta.model")}: ${detail.meta?.provider ?? "?"} / ${detail.meta?.model ?? "?"} · ${t("meta.usage")}: ${JSON.stringify(detail.detail?.usage ?? {})} · ${t("meta.time")}: ${detail.time}`
								: `${t("meta.time")}: ${detail.time}`),
						summaryOf(detail) !== "" ? h("p", { style: { fontSize: 13, opacity: 0.85, margin: "0 0 6px" } }, summaryOf(detail)) : null,
						h(PRE, null, JSON.stringify(detail.detail ?? {}, null, 2)),
						h("div", { style: { display: "flex", gap: 6, marginTop: 8 } },
							gitEnabled ? h("button", { style: BUTTON, type: "button", disabled: busy, onClick: openWorktree }, t("action.worktree")) : null,
							h("button", { style: PRIMARY, type: "button", disabled: busy, onClick: resume }, t("action.resume"))))
						: null),
				notice !== null ? h("p", { style: { color: "#1e7d32", fontSize: 13, wordBreak: "break-all" } }, String(notice)) : null,
				error !== null ? h("p", { style: { color: "#c0392b", fontSize: 13, whiteSpace: "pre-wrap" } }, String(error)) : null);
		}
		//#endregion
		/**
		* Client plugin body: register the Trace 回放 settings page.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			const sessions = ctx.sessions;
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "trace-repeat: dictionaries");
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "trace-repeat",
				order: 40,
				label: () => ctx.locale.bind(NS)("section.label"),
				locale: NS
			}, (props) => h(TraceReplayPanel, { sessions, locale: ctx.locale, ...props })));
		}
		exports.TraceReplayPanel = TraceReplayPanel;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
