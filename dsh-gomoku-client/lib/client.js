/**
 * 五子棋插件（浏览器半侧，免构建 bundle）。v0.2.0
 *
 * 形态与随产品发布的客户端插件一致：bundle 只做一件事——向
 * `window.__ModuleLoader__.load({ id, factory })` 注册一个 factory；factory 在
 * **首次物化**时才运行，返回模块导出（apply / inject）。因此本文件既是源码也是
 * 产物，不需要任何构建工具链。
 *
 * ## 为什么 `id` 必须是包名
 *
 * `@deepseek-ai/dsh-client-modules` 用**包的 manifest 名**作为浏览器模块标识，
 * 并据此组装 boot graph（`/plugins/<包名>/client.js?rev=<rev>`）。注册时的 `id`
 * 与包名不一致，factory 永远不会被认领——这是"脚本加载了但插件没生效"的典型原因。
 * 本包名 `dsh-gomoku-client`，所以这里必须写同一个字符串。
 *
 * ## 渲染位置
 *
 * 对话区新增一个"五子棋"视图（slot `conversation.view`，与 chat / trajectory 并列）。
 *
 * ## 数据来源与"agent 自动落子"
 *
 * 棋局的权威状态在 Host 半侧（独立的 `dsh-gomoku-host` 包）的 `/gomoku` 路由：
 *   GET  /gomoku/state   → { ok, game }
 *   POST /gomoku/new     → { ok, game }
 *   POST /gomoku/move    → { ok, changed, move, won, game }
 *
 * 但 agent 的落子**不是**这个插件能直接做的：那是一个模型决定。所以人落子之后，
 * 本插件通过 Host 的 Session Remote 往当前会话投一条 prompt：
 *
 *     ctx.get("remote").session.prompt({
 *       requestId, sessionId, mode: "queue",
 *       content: [{ type: "text", text: "（五子棋）我下在 (7,7) 了。轮到你执黑，…" }],
 *       clientTimeZone,
 *     })
 *
 * 这正是输入框 Send 按钮走的那条路（`@deepseek-ai/dsh-api-session-controller` 的
 * `@Remote('prompt')`）。会话被唤醒 → 模型调用 `gomoku_move` → 客户端轮询到新的
 * `rev` → 棋盘更新。于是"我下完 agent 就开始下"，不必有人去发"该你了"。
 *
 * 唤醒用 `rev` 做护栏（同一局面只自动请求一次），失败则退回"手动催一下"按钮；
 * Remote 本身是**惰性、可选**获取的——拿不到也绝不让棋盘渲染不出来。
 *
 * 注意路由前缀是 `/gomoku`（Host 半侧的 `GOMOKU_PATH`），不是 `/plugins/gomoku`。
 * `/plugins` 是 dsh-client-modules 的 bundle 路由（`PLUGIN_ROUTE`），本插件的业务
 * API 不属于那一族；改前缀时**两侧必须同时改**。
 *
 * ## 只用白名单内的模块
 *
 * 客户端 factory 的 `require` 只能解析平台种子表里的名字（react、react-dom、
 * `@deepseek-ai/cordis`、`dsh-client-ui-slots` 等）+ boot graph 里的包行。本 bundle
 * 刻意只 require `react`，不引入任何需要 `dsh.client.external` 声明的依赖。
 */

window.__ModuleLoader__.load({
	id: "dsh-gomoku-client",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		/**
		 * 客户端 bundle 的构建标记。
		 *
		 * ⚠️ 改这个文件时**必须同时改它**。浏览器半侧的失败在源头就被丢弃（web boot
		 * 内核的审计循环只打印 fiber 状态名，不带异常），所以"到底是新代码没加载，
		 * 还是新代码跑了但某一步失败"曾经完全无法区分。这个标记同时出现在
		 *   1) 棋盘上方的小徽章（肉眼可见，一眼分辨新旧）
		 *   2) 每条 console 诊断的前缀里
		 * 于是这个问题再也不用猜。
		 */
		const BUILD = "v0.6.0";

		/** 带 `[gomoku <build>]` 前缀的控制台诊断；控制台不可用时静默。 */
		function log(...args) {
			try {
				if (typeof console !== "undefined" && typeof console.info === "function") console.info("[gomoku " + BUILD + "]", ...args);
			} catch (_error) {
				// 诊断失败绝不能影响功能
			}
		}
		log("bundle evaluated");

		//#region 样式
		const css = `
.dsh-gomoku-root{box-sizing:border-box;display:flex;flex-direction:column;gap:14px;padding:18px;min-height:0;height:100%;overflow:auto;align-items:center}
.dsh-gomoku-root[data-compact=true]{padding:10px;gap:10px}
.dsh-gomoku-root[data-compact=true] .dsh-gomoku-bar{max-width:100%}
.dsh-gomoku-root[data-compact=true] .dsh-gomoku-board{max-width:100%}
.dsh-gomoku-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:center;width:100%;max-width:600px}
.dsh-gomoku-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#1a1a1a);margin-right:auto;display:flex;align-items:center;gap:8px}
.dsh-gomoku-badge{font-size:11px;font-weight:500;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary,#555);font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-gomoku-btn{font:inherit;font-size:12.5px;padding:5px 12px;border-radius:8px;cursor:pointer;border:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.3));background:var(--dsw-alias-bg-elevated,transparent);color:var(--dsw-alias-label-primary,inherit);transition:background .14s ease,border-color .14s ease,transform .08s ease}
.dsh-gomoku-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-gomoku-btn:active:not(:disabled){transform:translateY(1px)}
.dsh-gomoku-btn:disabled{opacity:.42;cursor:default}
.dsh-gomoku-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#2f6feb);outline-offset:1px}
.dsh-gomoku-badge[data-tone=wait]{background:rgba(47,111,235,.14);color:#2f6feb}
.dsh-gomoku-badge[data-tone=build]{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;opacity:.6}
.dsh-gomoku-mode{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--dsw-alias-label-secondary,#555)}
.dsh-gomoku-select{font:inherit;font-size:12.5px;padding:4px 8px;border-radius:8px;cursor:pointer;border:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.3));background:var(--dsw-alias-bg-elevated,transparent);color:var(--dsw-alias-label-primary,inherit)}
.dsh-gomoku-select:disabled{opacity:.42;cursor:default}
.dsh-gomoku-select:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#2f6feb);outline-offset:1px}
.dsh-gomoku-board{position:relative;width:100%;max-width:520px;aspect-ratio:1/1;border-radius:14px;overflow:hidden;box-shadow:0 10px 30px rgba(60,32,4,.22),0 2px 6px rgba(60,32,4,.18);user-select:none;touch-action:manipulation}
.dsh-gomoku-board svg{display:block;width:100%;height:100%}
.dsh-gomoku-board:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#2f6feb);outline-offset:2px}
.dsh-gomoku-hole{fill:transparent;cursor:default}
.dsh-gomoku-board[data-playable=true] .dsh-gomoku-hole{cursor:pointer}
.dsh-gomoku-board[data-playable=true] .dsh-gomoku-hole:hover{fill:rgba(40,20,0,.10)}
.dsh-gomoku-foot{display:flex;align-items:center;gap:10px;font-size:12.5px;color:var(--dsw-alias-label-secondary,#666);flex-wrap:wrap;justify-content:center;max-width:600px;text-align:center}
.dsh-gomoku-err{color:var(--dsw-alias-state-error-primary,#d33);font-size:12.5px}
.dsh-gomoku-turn{display:inline-flex;align-items:center;gap:6px}
.dsh-gomoku-chip{width:13px;height:13px;border-radius:50%;box-shadow:inset 0 -1px 2px rgba(0,0,0,.35),0 1px 2px rgba(0,0,0,.25)}
.dsh-gomoku-chip[data-c=black]{background:radial-gradient(circle at 34% 30%,#6a6a6a,#101010 72%)}
.dsh-gomoku-chip[data-c=white]{background:radial-gradient(circle at 34% 30%,#ffffff,#d2d2d2 78%)}
.dsh-gomoku-loading{opacity:.55;font-size:12.5px}
.dsh-gomoku-hint{font-size:12px;opacity:.85}
.dsh-gomoku-hint code{font-size:11.5px;padding:1px 5px;border-radius:5px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsh-gomoku-thinking{display:inline-flex;align-items:center;gap:3px}
.dsh-gomoku-dot{width:4px;height:4px;border-radius:50%;background:currentColor;animation:dsh-gomoku-pulse 1.05s ease-in-out infinite}
.dsh-gomoku-dot:nth-child(2){animation-delay:.16s}
.dsh-gomoku-dot:nth-child(3){animation-delay:.32s}
@keyframes dsh-gomoku-pulse{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-2px)}}
@media (prefers-reduced-motion:reduce){.dsh-gomoku-dot{animation:none}}
`;
		const tagId = "dsh-gomoku-client/board.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-gomoku-client";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region 常量与几何
		/** Host 的 API 前缀。必须与 dsh-gomoku-host 的 GOMOKU_PATH 一致。 */
		const API_BASE = "/gomoku";
		/** 棋盘边长（交叉点数），与 Host 半侧一致。 */
		const BOARD_SIZE = 15;
		/** 棋盘格数，用于把 Host 传来的一维数组还原成二维。 */
		const CELL_COUNT = BOARD_SIZE * BOARD_SIZE;
		/** SVG 内部坐标：每格边长。 */
		const STEP = 40;
		/** 棋盘留白（木纹边缘 + 坐标数字）。 */
		const PAD = 38;
		/** 网格线宽。 */
		const LINE = 1.15;
		/** 棋子半径（≈0.87 格，接近真实棋具的饱满度）。 */
		const STONE_R = 17.3;
		/** 星位（含天元），标准 15 路布局。 */
		const STAR_POINTS = [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]];
		/** 交叉点的 SVG 坐标。 */
		const coordOf = (index) => PAD + index * STEP;
		/** 棋盘边长（SVG 单位）。 */
		const BOARD_SPAN = PAD * 2 + (BOARD_SIZE - 1) * STEP;
		/** 轮询间隔：只在有订阅者（视图可见）时生效。 */
		const POLL_MS = 1500;
		//#endregion

		//#region 数据
		/** Host 的棋子取值。 */
		const EMPTY = 0;
		const BLACK = 1;
		const WHITE = 2;
		/**
		 * 把 Host 的一维棋盘还原成 15×15 二维数组。长度不对时返回全空棋盘——
		 * 宁可显示空盘，也不显示错位棋盘。
		 * @param board - Host 传来的一维数组。
		 * @returns 二维数组 board[row][col]。
		 */
		function toGrid(board) {
			const grid = [];
			for (let row = 0; row < BOARD_SIZE; row += 1) {
				const line = [];
				for (let col = 0; col < BOARD_SIZE; col += 1) {
					const raw = Array.isArray(board) ? board[row * BOARD_SIZE + col] : EMPTY;
					line.push(raw === BLACK || raw === WHITE ? raw : EMPTY);
				}
				grid.push(line);
			}
			return grid;
		}

		/**
		 * 把 Host 的任意响应整形成组件可以无条件信任的形状。
		 *
		 * 这里对每个字段都做兜底：Host 版本不匹配、字段缺失或类型异常时，视图退化成
		 * "空盘 + 不可落子"，而不是抛异常把整个对话区渲染掉。
		 * @param game - Host 快照。
		 * @returns 规范化后的棋局。
		 */
		function normalizeGame(game) {
			const raw = game !== null && typeof game === "object" ? game : {};
			const humanColor = raw.humanColor === "black" || raw.humanColor === "white" ? raw.humanColor : "white";
			const status = typeof raw.status === "string" ? raw.status : "playing";
			/**
			 * ⚠️ `agentMode` **缺失时按 `model` 处理**，而不是按新 Host 的默认值 `engine`。
			 *
			 * 理由：只有新版 Host 才会在快照里带 `agentMode`。旧版 Host 什么都不带，
			 * 它能提供的唯一应对方式就是"由客户端唤醒模型"。如果这里默认成 `engine`，
			 * 那么"只刷新了页面、还没重启应用"的那段窗口里，客户端会以为引擎会应对、
			 * 于是既不去唤醒模型、也没人落子——棋局直接卡死。
			 * 按 `model` 兜底则退化成"旧行为"，怎么都不会卡。
			 */
			const agentMode = raw.agentMode === "engine" || raw.agentMode === "manual" ? raw.agentMode : "model";
			return {
				board: Array.isArray(raw.board) && raw.board.length === CELL_COUNT ? raw.board.slice() : new Array(CELL_COUNT).fill(EMPTY),
				turn: raw.turn === "white" ? "white" : "black",
				status,
				humanColor,
				agentMode,
				winningLine: Array.isArray(raw.winningLine) ? raw.winningLine : [],
				lastMove: raw.lastMove !== null && typeof raw.lastMove === "object" && typeof raw.lastMove.row === "number" && typeof raw.lastMove.col === "number" ? raw.lastMove : null,
				rev: typeof raw.rev === "number" ? raw.rev : 0,
				finished: status !== "playing",
				history: Array.isArray(raw.history) ? raw.history : [],
			};
		}

		/**
		 * 请求 Host 的棋局路由。
		 *
		 * 用绝对路径（`/gomoku/...`）而不是文档相对路径：DSH 的 index.html 会插入
		 * `<base href="./">`，而 SPA 可能把 location 推到 `/session/<id>` 之类的子路径，
		 * 此时相对路径会解析到错误的目录下。
		 * @param path - 路由后缀，如 '/state'。
		 * @param init - fetch 配置。
		 * @returns {Promise<{ok: boolean, status: number, body: any}>} 结果。
		 */
		async function callRoute(path, init) {
			const response = await fetch(API_BASE + path, {
				headers: { "content-type": "application/json" },
				...init,
			});
			let body = null;
			try {
				body = await response.json();
			} catch (_error) {
				body = null;
			}
			return { ok: response.ok, status: response.status, body };
		}

		/** @returns 一个用于 prompt 的请求 id。 */
		function newRequestId() {
			try {
				if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
			} catch (_error) {
				// 退化到下面的字符串
			}
			return "gomoku-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
		}

		/** @returns 浏览器时区，取不到时 null。 */
		function timeZone() {
			try {
				const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
				return typeof zone === "string" && zone !== "" ? zone : null;
			} catch (_error) {
				return null;
			}
		}
		//#endregion

		//#region 快照源
		/**
		 * 棋局快照源：满足 `ObservableSnapshot` 的 getSnapshot / subscribe，
		 * 交给 slot 的 `hooks` 座位后即变成组件的 `useGomoku`。
		 *
		 * 只在有订阅者时轮询——把视图切走就不再打扰 Host。
		 * @param requestTurn - 往会话投一条 prompt 的异步函数（由 apply 提供，惰性取 Remote）。
		 * @param promptTextOf - 由棋局拼出 prompt 正文的函数。
		 * @returns 快照源。
		 */
		function createGameStore(requestTurn, promptTextOf) {
			let snapshot = {
				game: normalizeGame(null),
				loaded: false,
				error: null,
				pending: false,
				/** agent 自动落子的请求状态：idle / requesting / requested / failed / unavailable。 */
				agent: { state: "idle", rev: 0, reason: null },
			};
			const listeners = new Set();
			let timer = null;
			let inflight = null;
			/** 当前视图所属的会话 id（由组件在挂载时告知）。 */
			let sessionId = null;

			const publish = (next) => {
				snapshot = next;
				for (const listener of [...listeners]) listener();
			};

			const setAgent = (next) => publish({ ...snapshot, agent: next });

			/** 现在是不是"该 agent 走"。 */
			const agentToMove = () => {
				const game = snapshot.game;
				return snapshot.loaded && !snapshot.pending && game.status === "playing" && game.turn !== game.humanColor;
			};

			/**
			 * 该 agent 走就投一条 prompt 唤醒会话——这就是"我下完它就开始下"。
			 *
			 * 用 `rev` 做护栏：同一个局面只自动请求一次，避免视图重挂载 / 轮询把同一手
			 * 反复投出去造成 prompt 风暴。`force` 只给"催一下"按钮用。
			 * @param {{force?: boolean}} [options] - 选项。
			 * @returns {Promise<void>} 完成。
			 */
			/**
			 * 该 agent 走就投一条 prompt 唤醒会话——**只在 model 模式下**。
			 *
			 * engine 模式下的应对完全由 Host 的棋力内核在同一个 HTTP 往返里办掉：
			 * 毫秒级、零会话副作用。所以这里必须先看模式，否则引擎模式下每落一手
			 * 还会多插一条用户消息进对话——那正是我们要eliminate掉的东西。
			 *
			 * 用 `rev` 做护栏：同一个局面只自动请求一次，避免视图重挂载 / 轮询把同一手
			 * 反复投出去造成 prompt 风暴。`force` 只给"催一下"按钮用。
			 * @param {{force?: boolean}} [options] - 选项。
			 * @returns {Promise<void>} 完成。
			 */
			const maybeRequestAgentMove = async (options = {}) => {
				const force = options.force === true;
				if (snapshot.game.agentMode !== "model") {
					if (force) log("skip wake: mode is", snapshot.game.agentMode);
					return;
				}
				if (!agentToMove()) {
					log("skip wake: not agent's turn", {
						loaded: snapshot.loaded,
						pending: snapshot.pending,
						status: snapshot.game.status,
						turn: snapshot.game.turn,
						humanColor: snapshot.game.humanColor,
					});
					return;
				}
				if (snapshot.agent.state === "requesting") return;
				const rev = snapshot.game.rev;
				if (!force && snapshot.agent.rev === rev && (snapshot.agent.state === "requested" || snapshot.agent.state === "failed")) {
					log("skip wake: already requested for rev", rev, snapshot.agent.state);
					return;
				}
				if (typeof sessionId !== "string" || sessionId === "") {
					log("skip wake: no session id");
					setAgent({ state: "unavailable", rev, reason: "no-session" });
					return;
				}
				setAgent({ state: "requesting", rev, reason: null });
				const text = promptTextOf();
				log("waking agent", { rev, sessionId, text });
				let outcome = null;
				try {
					outcome = await requestTurn(sessionId, text);
				} catch (error) {
					outcome = { ok: false, reason: String(error && error.message ? error.message : error) };
				}
				// 期间局面可能已经变了（比如 agent 已经落子）：只在 rev 未变时写状态
				if (snapshot.game.rev !== rev && !force) return;
				if (outcome !== null && outcome.ok === true) setAgent({ state: "requested", rev, reason: null });
				else setAgent({ state: "failed", rev, reason: (outcome === null ? "请求失败" : outcome.reason) || "请求失败" });
			};

			/** 拉一次权威状态。并发调用复用同一次请求。 */
			const load = () => {
				if (inflight !== null) return inflight;
				inflight = (async () => {
					try {
						const result = await callRoute("/state", { method: "GET" });
						if (!result.ok || result.body === null || result.body.ok !== true) {
							publish({ ...snapshot, loaded: true, error: "无法读取棋局（HTTP " + result.status + "）" });
							return;
						}
						const incoming = normalizeGame(result.body.game);
						// 本地乐观状态更靠前时不回退，避免"自己刚落的子闪一下又没了"
						if (incoming.rev < snapshot.game.rev) return;
						publish({ ...snapshot, game: incoming, loaded: true, error: null, pending: false });
						void maybeRequestAgentMove();
					} catch (error) {
						publish({ ...snapshot, loaded: true, error: String(error && error.message ? error.message : error) });
					} finally {
						inflight = null;
					}
				})();
				return inflight;
			};

			const stopPolling = () => {
				if (timer !== null) {
					clearInterval(timer);
					timer = null;
				}
			};

			return {
				getSnapshot: () => snapshot,
				subscribe: (listener) => {
					listeners.add(listener);
					if (listeners.size === 1) {
						void load();
						timer = setInterval(() => void load(), POLL_MS);
					}
					return () => {
						listeners.delete(listener);
						if (listeners.size === 0) stopPolling();
					};
				},
				/**
				 * 组件挂载时告知所属会话。没有它就无法唤醒 agent（只能退回手动提示）。
				 * @param id - 会话身份。
				 */
				attachSession: (id) => {
					log("attachSession", { id: String(id), type: typeof id });
					if (typeof id !== "string" || id === "") return;
					sessionId = id;
					void maybeRequestAgentMove();
				},
				/** "催一下"：忽略 rev 护栏，再投一次（只在 model 模式有意义）。 */
				nudge: () => maybeRequestAgentMove({ force: true }),
				/** 切换对手的应对方式：engine / model / manual。 */
				setMode: async (mode) => {
					publish({ ...snapshot, pending: true, error: null, agent: { state: "idle", rev: 0, reason: null } });
					try {
						const result = await callRoute("/mode", {
							method: "POST",
							body: JSON.stringify({ agentMode: mode }),
						});
						const body = result.body;
						if (body !== null && body.game !== undefined) {
							publish({ ...snapshot, pending: false, error: body.ok === true ? null : body.reason || "切换模式失败", game: normalizeGame(body.game) });
							if (body.ok === true) void maybeRequestAgentMove();
						} else {
							publish({ ...snapshot, pending: false, error: "切换模式失败（HTTP " + result.status + "）" });
						}
					} catch (error) {
						publish({ ...snapshot, pending: false, error: String(error && error.message ? error.message : error) });
					}
				},
				/** 乐观落子：先把子画上去，再用 Host 的权威结果覆盖。 */
				play: async (row, col) => {
					const color = snapshot.game.humanColor;
					const optimistic = snapshot.game.board.slice();
					optimistic[row * BOARD_SIZE + col] = color === "black" ? BLACK : WHITE;
					publish({
						...snapshot,
						pending: true,
						error: null,
						game: { ...snapshot.game, board: optimistic, rev: snapshot.game.rev + 1 },
					});
					try {
						const result = await callRoute("/move", {
							method: "POST",
							body: JSON.stringify({ row, col }),
						});
						const body = result.body;
						if (body !== null && body.game !== undefined) {
							publish({
								...snapshot,
								pending: false,
								error: body.ok === true ? null : body.reason || "落子被拒绝",
								game: normalizeGame(body.game),
							});
							if (body.ok === true) void maybeRequestAgentMove();
						} else {
							publish({ ...snapshot, pending: false, error: "落子失败（HTTP " + result.status + "）" });
							void load();
						}
					} catch (error) {
						publish({ ...snapshot, pending: false, error: String(error && error.message ? error.message : error) });
						void load();
					}
				},
				/** 开新局；可指定人类执子方（用于"换边重开"）。模式跟着当前选择走。 */
				reset: async (humanColor) => {
					publish({ ...snapshot, pending: true, error: null, agent: { state: "idle", rev: 0, reason: null } });
					try {
						const payload = { agentMode: snapshot.game.agentMode };
						if (humanColor === "black" || humanColor === "white") payload.humanColor = humanColor;
						const result = await callRoute("/new", { method: "POST", body: JSON.stringify(payload) });
						const body = result.body;
						if (body !== null && body.game !== undefined) {
							publish({ ...snapshot, pending: false, error: null, game: normalizeGame(body.game), agent: { state: "idle", rev: 0, reason: null } });
							void maybeRequestAgentMove();
						} else {
							await load();
							publish({ ...snapshot, pending: false });
						}
					} catch (error) {
						publish({ ...snapshot, pending: false, error: String(error && error.message ? error.message : error) });
					}
				},
				refresh: load,
			};
		}
		//#endregion

		//#region 棋盘绘制
		/** 让同一页面上的多个棋盘实例各有独立的 SVG defs id。 */
		let instanceSeq = 0;

		/**
		 * 一枚棋子。
		 *
		 * 用**纯渐变叠层**画立体感，不用 `feGaussianBlur`——一个盘面最多 225 子，
		 * 每子挂一个模糊滤镜会让重绘明显变卡；径向渐变做落影既便宜又不糊。
		 *
		 * 层序（自下而上）：
		 *   1. 落影：比棋子略大、向右下偏移的径向渐变（中心深、边缘全透明）
		 *   2. 本体：偏左上的径向渐变（光源在左上）
		 *   3. 环境遮蔽：偏右下的暗环，把球体"收"进去
		 *   4. 高光：左上两枚柔光椭圆，外大而淡、内小而亮
		 *   5. 描边：极细轮廓，让白子在浅色木纹上也有边界
		 * @param props - row / col / color / ghost / dim / uid。
		 */
		function Stone(props) {
			const { row, col, color, ghost, dim, uid } = props;
			const cx = coordOf(col);
			const cy = coordOf(row);
			const isBlack = color === BLACK;
			const tone = isBlack ? "black" : "white";
			const suffix = ghost ? "ghost" : "solid";
			const groupOpacity = ghost ? 0.4 : dim ? 0.42 : 1;
			const layers = [
				react.createElement("circle", {
					key: "shadow",
					cx: cx + 1.4,
					cy: cy + 2.2,
					r: STONE_R * 1.14,
					fill: "url(#" + uid + "-shadow)",
				}),
				react.createElement("circle", {
					key: "body",
					cx,
					cy,
					r: STONE_R,
					fill: "url(#" + uid + "-" + tone + "-" + suffix + ")",
				}),
				react.createElement("circle", {
					key: "occlusion",
					cx,
					cy,
					r: STONE_R,
					fill: "url(#" + uid + "-" + tone + "-occl)",
				}),
			];
			if (!ghost) {
				layers.push(
					react.createElement("ellipse", {
						key: "glossOuter",
						cx: cx - STONE_R * 0.3,
						cy: cy - STONE_R * 0.34,
						rx: STONE_R * 0.5,
						ry: STONE_R * 0.38,
						fill: "url(#" + uid + "-gloss-outer)",
						transform: "rotate(-28 " + (cx - STONE_R * 0.3) + " " + (cy - STONE_R * 0.34) + ")",
						style: { pointerEvents: "none" },
					}),
					react.createElement("ellipse", {
						key: "glossInner",
						cx: cx - STONE_R * 0.36,
						cy: cy - STONE_R * 0.42,
						rx: STONE_R * 0.19,
						ry: STONE_R * 0.14,
						fill: "url(#" + uid + "-gloss-inner)",
						transform: "rotate(-28 " + (cx - STONE_R * 0.36) + " " + (cy - STONE_R * 0.42) + ")",
						style: { pointerEvents: "none" },
					}),
				);
			}
			layers.push(
				react.createElement("circle", {
					key: "rim",
					cx,
					cy,
					r: STONE_R - 0.35,
					fill: "none",
					stroke: isBlack ? "rgba(198,214,232,.20)" : "rgba(96,74,44,.30)",
					strokeWidth: isBlack ? 0.7 : 0.85,
				}),
			);
			return react.createElement(
				"g",
				{
					"data-stone": suffix,
					"data-stone-color": tone,
					opacity: groupOpacity,
					style: { pointerEvents: "none" },
				},
				layers,
			);
		}

		/** 木纹条纹：底部是渐变，不画成硬线。 */
		const GRAIN = [
			{ y: 22, h: 3.4, o: 0.5 },
			{ y: 74, h: 2.2, o: 0.36 },
			{ y: 128, h: 4.6, o: 0.62 },
			{ y: 186, h: 2.6, o: 0.4 },
			{ y: 238, h: 3.0, o: 0.5 },
			{ y: 296, h: 2.0, o: 0.32 },
			{ y: 352, h: 4.2, o: 0.58 },
			{ y: 410, h: 2.4, o: 0.38 },
			{ y: 468, h: 3.2, o: 0.52 },
			{ y: 526, h: 2.2, o: 0.34 },
			{ y: 580, h: 3.8, o: 0.46 },
		];

		/**
		 * 棋盘本体：木纹、坐标、网格、星位、棋子、最后一手标记、取胜连线、
		 * 悬停预览、点击热区。
		 * @param props - game / playable / onPlay / cursor / setCursor / uid。
		 */
		function BoardView(props) {
			const { game, playable, onPlay, cursor, setCursor, uid } = props;
			const grid = toGrid(game.board);
			const [hover, setHover] = react.useState(null);

			const winSet = new Set(game.winningLine.map((p) => p.row + ":" + p.col));
			const ghostAt = playable ? (hover !== null ? hover : cursor) : null;

			const defs = react.createElement("defs", null, [
				// —— 落影：中心深、边缘全透明
				react.createElement("radialGradient", { key: "shadow", id: uid + "-shadow" }, [
					react.createElement("stop", { key: "a", offset: "0%", stopColor: "rgba(58,32,4,.34)" }),
					react.createElement("stop", { key: "b", offset: "58%", stopColor: "rgba(58,32,4,.20)" }),
					react.createElement("stop", { key: "c", offset: "100%", stopColor: "rgba(58,32,4,0)" }),
				]),
				// —— 黑子（那智黑／青石）：冷调，左上受光
				react.createElement("radialGradient", { key: "bs", id: uid + "-black-solid", cx: "31%", cy: "25%", r: "84%" }, [
					react.createElement("stop", { key: "1", offset: "0%", stopColor: "#7d848c" }),
					react.createElement("stop", { key: "2", offset: "16%", stopColor: "#4c5259" }),
					react.createElement("stop", { key: "3", offset: "46%", stopColor: "#24282e" }),
					react.createElement("stop", { key: "4", offset: "78%", stopColor: "#0d1013" }),
					react.createElement("stop", { key: "5", offset: "100%", stopColor: "#04060a" }),
				]),
				// —— 白子（蛤贝）：暖调，高光更紧
				react.createElement("radialGradient", { key: "ws", id: uid + "-white-solid", cx: "31%", cy: "25%", r: "86%" }, [
					react.createElement("stop", { key: "1", offset: "0%", stopColor: "#ffffff" }),
					react.createElement("stop", { key: "2", offset: "34%", stopColor: "#fdfbf6" }),
					react.createElement("stop", { key: "3", offset: "68%", stopColor: "#f0e9dc" }),
					react.createElement("stop", { key: "4", offset: "90%", stopColor: "#ddd2be" }),
					react.createElement("stop", { key: "5", offset: "100%", stopColor: "#c9bda5" }),
				]),
				// —— 幽灵预览（悬停 / 键盘光标）
				react.createElement("radialGradient", { key: "bg", id: uid + "-black-ghost", cx: "31%", cy: "25%", r: "84%" }, [
					react.createElement("stop", { key: "1", offset: "0%", stopColor: "#828990" }),
					react.createElement("stop", { key: "2", offset: "100%", stopColor: "#0a0c10" }),
				]),
				react.createElement("radialGradient", { key: "wg", id: uid + "-white-ghost", cx: "31%", cy: "25%", r: "86%" }, [
					react.createElement("stop", { key: "1", offset: "0%", stopColor: "#ffffff" }),
					react.createElement("stop", { key: "2", offset: "100%", stopColor: "#cfc4ae" }),
				]),
				// —— 环境遮蔽：右下偏暗
				react.createElement("radialGradient", { key: "bo", id: uid + "-black-occl", cx: "72%", cy: "78%", r: "72%" }, [
					react.createElement("stop", { key: "1", offset: "0%", stopColor: "rgba(0,0,0,0)" }),
					react.createElement("stop", { key: "2", offset: "62%", stopColor: "rgba(0,0,0,0)" }),
					react.createElement("stop", { key: "3", offset: "100%", stopColor: "rgba(0,0,0,.55)" }),
				]),
				react.createElement("radialGradient", { key: "wo", id: uid + "-white-occl", cx: "72%", cy: "78%", r: "72%" }, [
					react.createElement("stop", { key: "1", offset: "0%", stopColor: "rgba(120,98,64,0)" }),
					react.createElement("stop", { key: "2", offset: "60%", stopColor: "rgba(120,98,64,0)" }),
					react.createElement("stop", { key: "3", offset: "100%", stopColor: "rgba(120,98,64,.30)" }),
				]),
				// —— 高光：柔光 + 亮点
				react.createElement("radialGradient", { key: "go", id: uid + "-gloss-outer" }, [
					react.createElement("stop", { key: "1", offset: "0%", stopColor: "rgba(255,255,255,.40)" }),
					react.createElement("stop", { key: "2", offset: "55%", stopColor: "rgba(255,255,255,.14)" }),
					react.createElement("stop", { key: "3", offset: "100%", stopColor: "rgba(255,255,255,0)" }),
				]),
				react.createElement("radialGradient", { key: "gi", id: uid + "-gloss-inner" }, [
					react.createElement("stop", { key: "1", offset: "0%", stopColor: "rgba(255,255,255,.95)" }),
					react.createElement("stop", { key: "2", offset: "70%", stopColor: "rgba(255,255,255,.45)" }),
					react.createElement("stop", { key: "3", offset: "100%", stopColor: "rgba(255,255,255,0)" }),
				]),
				// —— 木纹：底色 + 条纹 + 斜向高光 + 四周压暗
				react.createElement("linearGradient", { key: "wood", id: uid + "-wood", x1: "0%", y1: "0%", x2: "88%", y2: "100%" }, [
					react.createElement("stop", { key: "a", offset: "0%", stopColor: "#efcd96" }),
					react.createElement("stop", { key: "b", offset: "34%", stopColor: "#e6bd83" }),
					react.createElement("stop", { key: "c", offset: "68%", stopColor: "#dcae70" }),
					react.createElement("stop", { key: "d", offset: "100%", stopColor: "#cb9a5b" }),
				]),
				react.createElement("linearGradient", { key: "streak", id: uid + "-streak", x1: "0%", y1: "0%", x2: "100%", y2: "0%" }, [
					react.createElement("stop", { key: "a", offset: "0%", stopColor: "rgba(146,96,34,0)" }),
					react.createElement("stop", { key: "b", offset: "22%", stopColor: "rgba(146,96,34,.55)" }),
					react.createElement("stop", { key: "c", offset: "62%", stopColor: "rgba(120,76,24,.42)" }),
					react.createElement("stop", { key: "d", offset: "100%", stopColor: "rgba(146,96,34,0)" }),
				]),
				react.createElement("linearGradient", { key: "sheen", id: uid + "-sheen", x1: "0%", y1: "0%", x2: "70%", y2: "90%" }, [
					react.createElement("stop", { key: "a", offset: "0%", stopColor: "rgba(255,255,255,.22)" }),
					react.createElement("stop", { key: "b", offset: "45%", stopColor: "rgba(255,255,255,.04)" }),
					react.createElement("stop", { key: "c", offset: "100%", stopColor: "rgba(255,255,255,0)" }),
				]),
				react.createElement("radialGradient", { key: "vig", id: uid + "-vignette", cx: "46%", cy: "40%", r: "78%" }, [
					react.createElement("stop", { key: "a", offset: "0%", stopColor: "rgba(96,58,12,0)" }),
					react.createElement("stop", { key: "b", offset: "70%", stopColor: "rgba(96,58,12,.05)" }),
					react.createElement("stop", { key: "c", offset: "100%", stopColor: "rgba(76,44,8,.22)" }),
				]),
				// —— 取胜连线的发光（全盘只有一条，用滤镜不影响性能）
				react.createElement("filter", { key: "glow", id: uid + "-glow", x: "-40%", y: "-40%", width: "180%", height: "180%" }, [
					react.createElement("feGaussianBlur", { key: "g", stdDeviation: "3.2", result: "blur" }),
					react.createElement("feMerge", { key: "m" }, [
						react.createElement("feMergeNode", { key: "b", in: "blur" }),
						react.createElement("feMergeNode", { key: "s", in: "SourceGraphic" }),
					]),
				]),
			]);

			// —— 木纹条纹
			const grain = GRAIN.map((band) =>
				react.createElement("rect", {
					key: "grain" + band.y,
					x: 0,
					y: band.y,
					width: BOARD_SPAN,
					height: band.h,
					fill: "url(#" + uid + "-streak)",
					opacity: band.o,
				}),
			);

			// —— 坐标数字（方便人对着 agent 说"我下 (7,7)"）
			const labels = [];
			for (let i = 0; i < BOARD_SIZE; i += 1) {
				labels.push(
					react.createElement(
						"text",
						{
							key: "lx" + i,
							x: PAD - 14,
							y: coordOf(i) + 4.4,
							"text-anchor": "end",
							"font-size": 13,
							"font-weight": 500,
							fill: "rgba(74,46,12,.52)",
						},
						String(i),
					),
				);
				labels.push(
					react.createElement(
						"text",
						{
							key: "ly" + i,
							x: coordOf(i) + 0.5,
							y: PAD - 13,
							"text-anchor": "middle",
							"font-size": 13,
							"font-weight": 500,
							fill: "rgba(74,46,12,.52)",
						},
						String(i),
					),
				);
			}

			// —— 网格线
			const lines = [];
			for (let i = 0; i < BOARD_SIZE; i += 1) {
				const at = coordOf(i);
				lines.push(
					react.createElement("line", {
						key: "h" + i,
						x1: coordOf(0),
						y1: at,
						x2: coordOf(BOARD_SIZE - 1),
						y2: at,
						stroke: "rgba(58,34,6,.70)",
						strokeWidth: LINE,
						strokeLinecap: "round",
					}),
				);
				lines.push(
					react.createElement("line", {
						key: "v" + i,
						x1: at,
						y1: coordOf(0),
						x2: at,
						y2: coordOf(BOARD_SIZE - 1),
						stroke: "rgba(58,34,6,.70)",
						strokeWidth: LINE,
						strokeLinecap: "round",
					}),
				);
			}

			const stars = STAR_POINTS.map(([r, c]) =>
				react.createElement("circle", {
					key: "star" + r + "-" + c,
					cx: coordOf(c),
					cy: coordOf(r),
					r: 3.7,
					fill: "rgba(40,22,2,.86)",
				}),
			);

			const stones = [];
			for (let row = 0; row < BOARD_SIZE; row += 1) {
				for (let col = 0; col < BOARD_SIZE; col += 1) {
					const cell = grid[row][col];
					if (cell === EMPTY) continue;
					stones.push(
						react.createElement(Stone, {
							key: "s" + row + "-" + col,
							row,
							col,
							color: cell,
							uid,
							dim: winSet.size > 0 && !winSet.has(row + ":" + col) ? true : undefined,
						}),
					);
				}
			}

			const markers = [];
			if (game.lastMove !== null && !game.finished) {
				const lr = game.lastMove.row;
				const lc = game.lastMove.col;
				const cell = grid[lr] !== undefined ? grid[lr][lc] : EMPTY;
				if (cell !== EMPTY) {
					markers.push(
						react.createElement("circle", {
							key: "last",
							cx: coordOf(lc),
							cy: coordOf(lr),
							r: 4.4,
							fill: "none",
							// 黑子上用亮环、白子上用暗环，两边都看得见
							stroke: cell === BLACK ? "rgba(255,255,255,.92)" : "rgba(28,20,8,.8)",
							strokeWidth: 1.9,
						}),
					);
				}
			}

			if (game.winningLine.length >= 2) {
				const first = game.winningLine[0];
				const last = game.winningLine[game.winningLine.length - 1];
				const pts = game.winningLine.map((p) => coordOf(p.col) + "," + coordOf(p.row)).join(" ");
				markers.push(
					react.createElement("line", {
						key: "winGlow",
						x1: coordOf(first.col),
						y1: coordOf(first.row),
						x2: coordOf(last.col),
						y2: coordOf(last.row),
						stroke: "rgba(255,206,74,.85)",
						strokeWidth: 7.5,
						strokeLinecap: "round",
						filter: "url(#" + uid + "-glow)",
						style: { pointerEvents: "none" },
					}),
				);
				markers.push(
					react.createElement("polyline", {
						key: "win",
						points: pts,
						fill: "none",
						stroke: "rgba(255,236,150,.98)",
						strokeWidth: 3.1,
						strokeLinecap: "round",
						strokeLinejoin: "round",
						style: { pointerEvents: "none" },
					}),
				);
			}

			const ghosts = [];
			if (ghostAt !== null && grid[ghostAt.row] !== undefined && grid[ghostAt.row][ghostAt.col] === EMPTY) {
				ghosts.push(
					react.createElement(Stone, {
						key: "ghost",
						row: ghostAt.row,
						col: ghostAt.col,
						color: game.humanColor === "black" ? BLACK : WHITE,
						ghost: true,
						uid,
					}),
				);
			}

			const holes = [];
			if (playable) {
				for (let row = 0; row < BOARD_SIZE; row += 1) {
					for (let col = 0; col < BOARD_SIZE; col += 1) {
						if (grid[row][col] !== EMPTY) continue;
						holes.push(
							react.createElement("circle", {
								key: "h" + row + "-" + col,
								className: "dsh-gomoku-hole",
								cx: coordOf(col),
								cy: coordOf(row),
								r: STEP / 2,
								onMouseEnter: () => setHover({ row, col }),
								onMouseLeave: () => setHover(null),
								onClick: () => onPlay(row, col),
							}),
						);
					}
				}
			}

			/**
			 * 键盘落子：方向键移动光标，Enter / 空格落子。
			 * 225 个热区都做成 tab 停靠点会把 Tab 键变成灾难，所以改用"棋盘本身
			 * 可聚焦 + 内部光标"的方案。
			 * @param event - 键盘事件。
			 */
			const onKeyDown = (event) => {
				if (!playable) return;
				const at = cursor === null ? { row: 7, col: 7 } : cursor;
				let next = null;
				if (event.key === "ArrowUp") next = { row: at.row - 1, col: at.col };
				else if (event.key === "ArrowDown") next = { row: at.row + 1, col: at.col };
				else if (event.key === "ArrowLeft") next = { row: at.row, col: at.col - 1 };
				else if (event.key === "ArrowRight") next = { row: at.row, col: at.col + 1 };
				else if (event.key === "Enter" || event.key === " ") {
					if (grid[at.row][at.col] === EMPTY) onPlay(at.row, at.col);
					event.preventDefault();
					return;
				} else {
					return;
				}
				event.preventDefault();
				setCursor({ row: Math.max(0, Math.min(BOARD_SIZE - 1, next.row)), col: Math.max(0, Math.min(BOARD_SIZE - 1, next.col)) });
			};

			// 键盘光标（可落子时始终画出来，鼠标悬停优先显示幽灵子）
			if (playable && cursor !== null && grid[cursor.row][cursor.col] === EMPTY) {
				markers.push(
					react.createElement("rect", {
						key: "cursor",
						x: coordOf(cursor.col) - STONE_R,
						y: coordOf(cursor.row) - STONE_R,
						width: STONE_R * 2,
						height: STONE_R * 2,
						rx: 5,
						fill: "none",
						stroke: "rgba(47,111,235,.8)",
						strokeWidth: 2,
						strokeDasharray: "5 3",
					}),
				);
			}

			return react.createElement(
				"svg",
				{
					viewBox: "0 0 " + BOARD_SPAN + " " + BOARD_SPAN,
					role: "group",
					"aria-label": playable ? "五子棋棋盘（点击落子；可用方向键移动、回车落子）" : "五子棋棋盘",
					tabIndex: playable ? 0 : -1,
					onKeyDown,
				},
				[
					react.createElement("rect", { key: "wood", width: BOARD_SPAN, height: BOARD_SPAN, fill: "url(#" + uid + "-wood)" }),
					react.createElement("g", { key: "grain" }, grain),
					react.createElement("rect", { key: "sheen", width: BOARD_SPAN, height: BOARD_SPAN, fill: "url(#" + uid + "-sheen)" }),
					react.createElement("rect", { key: "vignette", width: BOARD_SPAN, height: BOARD_SPAN, fill: "url(#" + uid + "-vignette)" }),
					react.createElement("g", { key: "labels" }, labels),
					react.createElement("g", { key: "grid" }, lines),
					react.createElement("g", { key: "stars" }, stars),
					react.createElement("g", { key: "stones" }, stones),
					react.createElement("g", { key: "ghosts" }, ghosts),
					react.createElement("g", { key: "markers" }, markers),
					react.createElement("g", { key: "holes" }, holes),
					react.createElement("rect", {
						key: "frame",
						x: 3.5,
						y: 3.5,
						width: BOARD_SPAN - 7,
						height: BOARD_SPAN - 7,
						rx: 8,
						fill: "none",
						stroke: "rgba(88,52,10,.30)",
						strokeWidth: 2,
					}),
					defs,
				],
			);
		}
		//#endregion

		//#region 视图

		/**
		 * 造一个翻译函数：优先用座位给的 `t`，缺失（或它返回键名）时退回内置字典。
		 *
		 * 侧栏座位（`ctx.betterSidebar` 的 TabComponentProps）**没有** locale 座位，
		 * 只能自己用 `localize`；对话视图座位有框架给的 `t`。两者共用这一个工厂。
		 * @param t - 框架给的翻译函数，或 null。
		 * @returns 翻译函数。
		 */
		function makeTr(t) {
			return (key, vars) => {
				if (typeof t === "function") {
					const text = t(key, vars);
					if (typeof text === "string" && text !== key) return text;
				}
				let text = FALLBACK[key] !== undefined ? FALLBACK[key] : key;
				for (const name of Object.keys(vars === undefined ? {} : vars)) {
					text = text.split("{" + name + "}").join(String(vars[name]));
				}
				return text;
			};
		}

		/**
		 * 订阅 store 的 React 钩子（给没有框架 hooks 座位的侧栏用）。
		 *
		 * `active` 为假时不订阅——侧栏的 `visible` 语义就是"这个页签在前台吗"，
		 * 后台页签不该继续每秒轮询 Host。
		 * @param store - 快照源。
		 * @param active - 是否在前台。
		 * @returns 当前快照。
		 */
		function useStoreSnapshot(store, active) {
			const [snap, setSnap] = react.useState(() => store.getSnapshot());
			react.useEffect(() => {
				if (active !== true) return undefined;
				return store.subscribe(() => setSnap(store.getSnapshot()));
			}, [store, active]);
			return snap;
		}

		/**
		 * 棋盘区域本体：工具栏 + 棋盘 + 状态行。
		 *
		 * **被两个座位共用**：对话区的 `conversation.view` 页签，以及（可选）右侧边栏
		 * 的页签。两个座位的 props 来源完全不同（一个由 slot 的 inject 面拼成、一个由
		 * `ctx.betterSidebar` 的 TabComponentProps 给），所以这里只收摊平后的
		 * `state` / `tr` / 动作函数，不碰任何座位细节。
		 * @param props - state / tr / play / reset / flip / nudge / setMode / compact。
		 */
		function BoardArea(props) {
			const { state, tr, play, reset, flip, nudge, setMode, compact } = props;
			const game = state.game;
			const [uid] = react.useState(() => "gmk" + (instanceSeq += 1));
			const [cursor, setCursor] = react.useState(() => ({ row: 7, col: 7 }));

			const humanIsBlack = game.humanColor === "black";
			const turnIsHuman = game.turn === game.humanColor;
			const playable = !game.finished && turnIsHuman && !state.pending;
			const agentTurn = !game.finished && !turnIsHuman;
			const agent = state.agent;
			const waking = agent.state === "requesting" || agent.state === "requested";

			const statusText = () => {
				if (game.status === "black-win") return humanIsBlack ? tr("status.youWin") : tr("status.youLose");
				if (game.status === "white-win") return humanIsBlack ? tr("status.youLose") : tr("status.youWin");
				if (game.status === "draw") return tr("status.draw");
				if (state.pending) return tr("status.pending");
				if (turnIsHuman) return tr("status.yourTurn");
				if (waking) return tr("status.agentThinking");
				return tr("status.agentTurn");
			};

			const dots = react.createElement("span", { className: "dsh-gomoku-thinking" }, [
				react.createElement("span", { key: "1", className: "dsh-gomoku-dot" }),
				react.createElement("span", { key: "2", className: "dsh-gomoku-dot" }),
				react.createElement("span", { key: "3", className: "dsh-gomoku-dot" }),
			]);

			/** 需要用户手动催 agent 的情形：**只在模型模式**下才可能出现。 */
			const needNudge = agentTurn && !state.pending && !waking && game.agentMode === "model";

			/** 最后一手由谁落的——引擎模式下一手往返就是两子，不标出来会看不懂。 */
			const lastBy = game.lastMove !== null && typeof game.lastMove.by === "string" ? game.lastMove.by : null;
			const lastByText = lastBy === "engine" ? tr("last.engine") : lastBy === "model" ? tr("last.model") : lastBy === "human" ? tr("last.human") : null;

			return react.createElement(
				"div",
				{ className: "dsh-gomoku-root", "data-gomoku": "", "data-compact": compact === true ? "true" : "false" },
				[
					react.createElement("div", { key: "bar", className: "dsh-gomoku-bar" }, [
						react.createElement("div", { key: "title", className: "dsh-gomoku-title" }, [
							react.createElement("span", { key: "t" }, tr("panel.title")),
							react.createElement("span", { key: "b", className: "dsh-gomoku-badge" }, humanIsBlack ? tr("panel.youBlack") : tr("panel.youWhite")),
							// 构建徽章：一眼分辨浏览器里跑的是哪一版 bundle
							react.createElement("span", { key: "v", className: "dsh-gomoku-badge", "data-tone": "build", title: "client bundle build" }, BUILD),
						]),
						// 对手由谁应对：这是"快不快、占不占对话"的总开关
						react.createElement(
							"label",
							{ key: "mode", className: "dsh-gomoku-mode", title: game.agentMode === "engine" ? tr("mode.engineHint") : game.agentMode === "model" ? tr("mode.modelHint") : tr("mode.manualHint") },
							[
								react.createElement("span", { key: "l" }, tr("mode.label")),
								react.createElement(
									"select",
									{
										key: "s",
										"data-role": "mode",
										className: "dsh-gomoku-select",
										value: game.agentMode,
										disabled: state.pending,
										onChange: (event) => void setMode(event.target.value),
									},
									[
										react.createElement("option", { key: "e", value: "engine" }, tr("mode.engine")),
										react.createElement("option", { key: "m", value: "model" }, tr("mode.model")),
										react.createElement("option", { key: "n", value: "manual" }, tr("mode.manual")),
									],
								),
							],
						),
						react.createElement(
							"button",
							{ key: "new", type: "button", "data-action": "new", className: "dsh-gomoku-btn", disabled: state.pending, onClick: () => void reset() },
							tr("action.newGame"),
						),
						react.createElement(
							"button",
							{ key: "flip", type: "button", "data-action": "flip", className: "dsh-gomoku-btn", disabled: state.pending, onClick: () => void flip() },
							tr("action.switchSide"),
						),
					]),
					react.createElement(
						"div",
						{ key: "board", className: "dsh-gomoku-board", "data-playable": playable ? "true" : "false" },
						react.createElement(BoardView, { game, playable, onPlay: (row, col) => void play(row, col), cursor, setCursor, uid }),
					),
					react.createElement("div", { key: "foot", className: "dsh-gomoku-foot" }, [
						react.createElement("span", { key: "turn", className: "dsh-gomoku-turn" }, [
							react.createElement("span", { key: "c", className: "dsh-gomoku-chip", "data-c": game.turn }),
							react.createElement("span", { key: "s" }, statusText()),
						]),
						agentTurn && !state.pending && waking ? react.createElement("span", { key: "w", className: "dsh-gomoku-badge", "data-tone": "wait" }, dots) : null,
						needNudge
							? react.createElement(
									"button",
									{ key: "nudge", type: "button", "data-action": "nudge", className: "dsh-gomoku-btn", onClick: () => void nudge() },
									tr("action.nudge"),
								)
							: null,
						react.createElement("span", { key: "moves", className: "dsh-gomoku-badge" }, tr("panel.moves", { n: game.history.length })),
						lastByText !== null
							? react.createElement("span", { key: "last", className: "dsh-gomoku-badge" }, lastByText + (game.lastMove !== null ? ` (${game.lastMove.row}, ${game.lastMove.col})` : ""))
							: null,
						state.error !== null ? react.createElement("span", { key: "err", className: "dsh-gomoku-err" }, state.error) : null,
						agent.state === "failed"
							? react.createElement("span", { key: "aerr", className: "dsh-gomoku-err" }, tr("status.agentFailed") + "：" + String(agent.reason === null ? "" : agent.reason))
							: null,
						!state.loaded ? react.createElement("span", { key: "l", className: "dsh-gomoku-loading" }, tr("status.loading")) : null,
						// 兜底引导：唤醒通道不可用时，仍然告诉用户怎么手动推进。
						needNudge && agent.state === "unavailable"
							? react.createElement("span", { key: "hint", className: "dsh-gomoku-hint" }, [
									react.createElement("span", { key: "h" }, tr("status.agentHint")),
									" ",
									react.createElement("code", { key: "c" }, tr("hint.phrase")),
								])
							: null,
					]),
				],
			);
		}

		/**
		 * 对话区里的五子棋视图（`conversation.view` 的一个 tab）。
		 *
		 * props 由 slot 的三个座位拼成：
		 *   - `hooks: { gomoku: store }` → `useGomoku`
		 *   - `locale: NS`             → `t`
		 *   - `inject: () => ({...})`  → 动作函数
		 * 另有 slot owner 与 scope 自带的标准 props（`sessionId` 等）。
		 * @param props - 组件 props。
		 */
		function GomokuView(props) {
			const { useGomoku, sessionId, t, attachSession } = props;
			const state = useGomoku((value) => value);

			// 把自己的会话身份交给 store：没有它就无法（在模型模式下）唤醒会话。
			react.useEffect(() => {
				log("view mounted", { sessionId: String(sessionId), propKeys: Object.keys(props).join(",") });
				if (typeof attachSession === "function") attachSession(sessionId);
			}, [sessionId]);

			return react.createElement(BoardArea, {
				state,
				tr: makeTr(t),
				play: props.play,
				reset: props.reset,
				flip: props.flip,
				nudge: props.nudge,
				setMode: props.setMode,
			});
		}

		/**
		 * 右侧边栏里的棋盘页签（`ctx.betterSidebar` 的 TabDescriptor.component）。
		 *
		 * 这是"边聊边下"的落点：屏幕中间留着对话，右边常驻棋盘。它拿不到 slot 的
		 * hooks/locale 座位，所以自己订阅 store、自己用 `localize` 取文案；
		 * `visible` 为假时停止订阅（后台页签不该继续轮询 Host）。
		 * @param props - store / flip / scope / visible。
		 */
		function GomokuPanel(props) {
			const { store, flip, scope, visible } = props;
			const state = useStoreSnapshot(store, visible === true);
			const sessionId = scope !== undefined && scope !== null && typeof scope.sessionId === "string" ? scope.sessionId : "";
			react.useEffect(() => {
				if (sessionId !== "") store.attachSession(sessionId);
			}, [sessionId, store]);
			return react.createElement(BoardArea, {
				state,
				tr: makeTr((key, vars) => localize(key, vars)),
				play: store.play,
				reset: store.reset,
				flip,
				nudge: store.nudge,
				setMode: store.setMode,
				compact: true,
			});
		}
		//#endregion

		//#region locales
		/** Locale 命名空间；注册到 slot 后组件即获得该命名空间的 t()。 */
		const NS = "gomoku";
		const zh = {
			"panel.title": "五子棋",
			"panel.youBlack": "你执黑",
			"panel.youWhite": "你执白",
			"panel.moves": "{n} 手",
			"action.newGame": "新开一局",
			"action.switchSide": "换边重开",
			"action.nudge": "催 agent 落子",
			"sidebar.description": "五子棋棋盘——边聊边下，不占用对话",
			"mode.label": "对手",
			"mode.engine": "引擎",
			"mode.model": "模型",
			"mode.manual": "手动",
			"mode.engineHint": "本地棋力内核，毫秒级应对，完全不占用对话",
			"mode.modelHint": "由模型思考，较慢，且每一手都会在对话里留下一条消息",
			"mode.manualHint": "谁都不自动应对，只有你手动催",
			"last.engine": "引擎落子",
			"last.model": "模型落子",
			"last.human": "你落子",
			"status.yourTurn": "该你落子，点击棋盘",
			"status.agentTurn": "轮到 agent",
			"status.agentThinking": "agent 正在思考",
			"status.agentFailed": "没能唤醒 agent",
			"status.pending": "正在确认…",
			"status.youWin": "你赢了 🎉",
			"status.youLose": "agent 赢了",
			"status.draw": "和棋",
			"status.loading": "正在载入棋局…",
			"status.agentHint": "在对话里说",
			"hint.phrase": "该你了",
			"prompt.agentTurn": "（五子棋）轮到你落子。请先用 gomoku_show 看盘，再用 gomoku_move 落子（颜色可省略，会按轮次落子）。",
		};
		const en = {
			"panel.title": "Gomoku",
			"panel.youBlack": "You play black",
			"panel.youWhite": "You play white",
			"panel.moves": "{n} moves",
			"action.newGame": "New game",
			"action.switchSide": "Swap sides",
			"action.nudge": "Nudge agent",
			"sidebar.description": "Gomoku board — play while you chat, without touching the conversation",
			"mode.label": "Opponent",
			"mode.engine": "Engine",
			"mode.model": "Model",
			"mode.manual": "Manual",
			"mode.engineHint": "Local engine — replies in milliseconds and never touches the conversation",
			"mode.modelHint": "The model thinks; slower, and every move leaves a message in the conversation",
			"mode.manualHint": "Nothing replies automatically; you nudge it yourself",
			"last.engine": "Engine played",
			"last.model": "Model played",
			"last.human": "You played",
			"status.yourTurn": "Your turn — click the board",
			"status.agentTurn": "Agent's turn",
			"status.agentThinking": "Agent is thinking",
			"status.agentFailed": "Could not wake the agent",
			"status.pending": "Confirming…",
			"status.youWin": "You win 🎉",
			"status.youLose": "Agent wins",
			"status.draw": "Draw",
			"status.loading": "Loading game…",
			"status.agentHint": "Say",
			"hint.phrase": "your turn",
			"prompt.agentTurn": "(Gomoku) Your turn. Call gomoku_show to read the board, then play with gomoku_move (the color may be omitted — it plays the side to move).",
		};
		/**
		 * 内置兜底字典：locale 座位不可用时不至于显示键名。
		 * 按浏览器语言挑一份，中式环境默认中文。
		 */
		const FALLBACK =
			typeof navigator !== "undefined" && typeof navigator.language === "string" && navigator.language.toLowerCase().indexOf("zh") === 0 ? zh : en;

		/** 当前生效语言的字典（供组件外的文案使用）。 */
		let activeDict = FALLBACK;

		/**
		 * 按 key 取文案。组件内的 t 座位由 slot 提供；这个给组件外（拼 prompt）用。
		 * @param key - 字典键。
		 * @param vars - 占位符取值。
		 * @returns 文案。
		 */
		function localize(key, vars) {
			let text = activeDict[key] !== undefined ? activeDict[key] : FALLBACK[key] !== undefined ? FALLBACK[key] : key;
			for (const name of Object.keys(vars === undefined ? {} : vars)) {
				text = text.split("{" + name + "}").join(String(vars[name]));
			}
			return text;
		}

		/**
		 * 拼一条给模型的 prompt。
		 *
		 * ⚠️ **刻意不含任何局面断言**——不写人下在哪、不写自己执什么颜色。
		 *
		 * 早先的版本写成"我下在 ({row}, {col}) 了。轮到你执{who}…"，结果实测中出现了
		 * "我下在 (?, ?) 了。轮到你执黑"——那条 prompt 是从一份**与真实盘面不一致的
		 * 快照**拼出来的（`lastMove` 为 null、`humanColor` 还是默认值），也就是
		 * prompt 在替 Host 说话、而且说错了。
		 *
		 * 修法是**从根上取消这类断言**：prompt 只说"该你落子，先看盘再落子"，让模型
		 * 用 `gomoku_show` 去拿权威局面。这样文案与局面解耦，任何时序/陈旧问题都无法
		 * 再让 prompt 说假话；而且 `gomoku_move` 的颜色可以省略、自动按轮次落子，
		 * 所以模型**根本不需要**从 prompt 里知道执子方。
		 * @returns prompt 正文。
		 */
		function agentPromptText() {
			return localize("prompt.agentTurn");
		}
		//#endregion

		/** 必需服务：slot 注册表与 locale 字典。 */
		const inject = ["slots", "locale"];

		/**
		 * 造一个"往会话投 prompt"的函数。
		 *
		 * 刻意**不**把 `remote` / `remote.session` 写进 `inject`：那样一旦某个组合里
		 * 没有这两个服务，本插件的 fiber 会停在 pending，连棋盘都注册不出来。宁可在
		 * 真正需要唤醒 agent 的那一刻去取，取不到就退回手动提示。
		 * @param ctx - 客户端根上下文。
		 * @returns 投递函数。
		 */
		function makeRequestTurn(ctx) {
			return async function requestTurn(sessionId, text) {
				/**
				 * 依次尝试三条取 Remote 的路径，并记下哪条成功。
				 * 全部失败时，把每条路径的结果拼进 reason——它会直接显示在状态栏上，
				 * 于是"到底哪个服务没拿到"不用猜。
				 */
				const lookups = [
					[
						"get('remote').session",
						() => {
							const root = typeof ctx.get === "function" ? ctx.get("remote") : undefined;
							return root === null || root === undefined ? undefined : root.session;
						},
					],
					["get('remote.session')", () => (typeof ctx.get === "function" ? ctx.get("remote.session") : undefined)],
					[
						"ctx.remote.session",
						() => {
							const root = ctx.remote;
							return root === null || root === undefined ? undefined : root.session;
						},
					],
				];
				let target;
				let how = "none";
				const tried = [];
				for (const [label, pick] of lookups) {
					let found;
					try {
						found = pick();
					} catch (error) {
						tried.push(label + "=threw:" + String(error && error.message ? error.message : error));
						continue;
					}
					if (found !== undefined && found !== null && typeof found.prompt === "function") {
						target = found;
						how = label;
						break;
					}
					tried.push(label + "=" + (found === undefined || found === null ? "missing" : "no-prompt"));
				}
				if (target === undefined) {
					log("remote lookup FAILED:", tried.join(" | "));
					return { ok: false, reason: "remote-unavailable {" + tried.join("; ") + "}" };
				}
				log("remote resolved via", how);
				const payload = {
					requestId: newRequestId(),
					sessionId,
					mode: "queue",
					content: [{ type: "text", text }],
				};
				const zone = timeZone();
				if (zone !== null) payload.clientTimeZone = zone;
				let result;
				try {
					result = await target.prompt(payload, undefined);
				} catch (error) {
					const message = String(error && error.message ? error.message : error);
					log("prompt THREW:", message);
					return { ok: false, reason: message };
				}
				// Remote 调用的统一信封：{ ok: true, value } | { ok: false, error }
				if (result === undefined || result === null) {
					log("prompt returned empty");
					return { ok: false, reason: "empty-response" };
				}
				if (result.ok === true) {
					log("prompt accepted", { sessionId, requestId: payload.requestId, via: how });
					return { ok: true };
				}
				const error = result.error;
				const reason =
					error !== undefined && error !== null && error.message !== undefined
						? String(error.message)
						: error !== undefined && error !== null && error.code !== undefined
							? String(error.code)
							: "remote-failed";
				log("prompt REJECTED:", reason, error);
				return { ok: false, reason };
			};
		}

		/**
		 * 客户端插件体：注册字典，并把棋盘注册进对话视图。
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			ctx.effect(
				() =>
					ctx.locale.register(NS, {
						zh,
						en,
					}),
				"gomoku: dictionaries",
			);

			// 语言可能被用户切换；prompt 文案跟着走（取不到就维持当前那份）。
			const readLocale = () => {
				try {
					const snapshot = ctx.locale.getSnapshot();
					const active = snapshot !== undefined && snapshot !== null && typeof snapshot.active === "string" ? snapshot.active : "";
					activeDict = active.indexOf("zh") === 0 ? zh : en;
				} catch (_error) {
					// 保持上一次的选择
				}
			};
			readLocale();
			ctx.effect(() => {
				try {
					return ctx.locale.subscribe(readLocale);
				} catch (_error) {
					return () => {};
				}
			}, "gomoku: locale tracker");

			const store = createGameStore(makeRequestTurn(ctx), agentPromptText);

			/** 换边重开：让 Host 开一局并把人类换到另一方。 */
			const flip = async () => {
				const next = store.getSnapshot().game.humanColor === "black" ? "white" : "black";
				await store.reset(next);
			};

			/**
			 * 可选的右侧边栏集成。
			 *
			 * 官方 `sidebar.right.pane.tab` 是按**已有页签种类**派发的（它的子节点是
			 * guide / files / document 这些既有种类），没有给"新增一种页签"留口子；
			 * 而 `dsh-better-sidebar` 正好暴露了 `ctx.betterSidebar`：
			 * `registerTab({...})` 注册一种页签、`openTab({type})` 打开它，且落地在
			 * DSH 原生的右侧栏里（`target` 默认 `'right'`）。
			 *
			 * 这是**可选**的：拿不到服务就只剩对话视图那一个座位，功能不受影响。
			 * 三点让它足够稳：
			 *   1. 注册是幂等的（`registered` 标记），先来后到都只注册一次；
			 *   2. 服务**晚到**也没关系——`ctx.inject(["betterSidebar"], …)` 只让那个
			 *      回调等待，**不会**挡住本插件自己的激活（crisp：宿主半侧用的就是这个
			 *      性质）。所以"服务还没出现"不会连累棋盘；
			 *   3. 全部包在 try/catch 里——第三方服务的行为不该有机会弄坏棋盘。
			 */
			const dock = { available: false, registered: false, open: () => {} };

			/** 取 betterSidebar 服务；形状不对就当没有。 */
			const findSidebar = () => {
				try {
					const service = typeof ctx.get === "function" ? ctx.get("betterSidebar") : undefined;
					if (service === undefined || service === null) return undefined;
					if (typeof service.registerTab !== "function" || typeof service.openTab !== "function") return undefined;
					return service;
				} catch (error) {
					log("betterSidebar lookup failed", error);
					return undefined;
				}
			};

			/** 幂等注册页签类型。 */
			const ensureSidebarTab = () => {
				if (dock.registered) return true;
				const service = findSidebar();
				if (service === undefined) return false;
				try {
					ctx.effect(
						() =>
							service.registerTab({
								id: "gomoku",
								title: () => activeDict["panel.title"] ?? "五子棋",
								description: () => activeDict["sidebar.description"] ?? "",
								order: 60,
								single: true,
								icon: () =>
									react.createElement("svg", { width: 16, height: 16, viewBox: "0 0 16 16", "aria-hidden": "true" }, [
										react.createElement("rect", { key: "b", x: 1, y: 1, width: 14, height: 14, rx: 2, fill: "none", stroke: "currentColor", strokeWidth: 1.2 }),
										react.createElement("path", { key: "g", d: "M1 6h14M1 10h14M6 1v14M10 1v14", stroke: "currentColor", strokeWidth: 0.7, opacity: 0.55 }),
										react.createElement("circle", { key: "s1", cx: 6, cy: 6, r: 1.8, fill: "currentColor" }),
										react.createElement("circle", { key: "s2", cx: 10, cy: 10, r: 1.8, fill: "currentColor", opacity: 0.45 }),
									]),
								component: (tabProps) =>
									react.createElement(GomokuPanel, {
										store,
										flip,
										scope: tabProps !== undefined && tabProps !== null ? tabProps.scope : undefined,
										visible: tabProps !== undefined && tabProps !== null ? tabProps.visible : true,
									}),
							}),
						"gomoku: sidebar tab type",
					);
					dock.registered = true;
					dock.available = true;
					log("sidebar integration ready", { version: service.version });
					return true;
				} catch (error) {
					log("registerTab failed", error);
					return false;
				}
			};

	dock.open = () => {
				if (!ensureSidebarTab()) {
					log("dock unavailable: 没有 ctx.betterSidebar");
					return false;
				}
				const service = findSidebar();
				if (service === undefined) return false;
				try {
					service.openTab({ type: "gomoku" });
					log("sidebar tab opened");
					return true;
				} catch (error) {
					log("openTab failed", error);
					return false;
				}
			};

			/**
			 * 对话视图只是**兜底座位**，默认不注册。
			 *
			 * 用户选择"只保留侧边栏"，所以正常情况（`dsh-better-sidebar` 在位）棋盘
			 * 只出现在右侧栏，对话区里不会多出一个"五子棋"页签。
			 *
			 * 但也不能把话说死：万一某台机器上没有那个服务，本插件就会**什么都看不见**——
			 * 那是最难查的一类故障。所以只在"侧栏服务确实拿不到"时才挂上这个兜底座位；
			 * 一旦服务出现就立刻撤掉它，回到"只有侧边栏"。
			 */
			let fallbackViewDispose = null;

			/** 挂上对话视图兜底座位（幂等）。 */
			const registerFallbackView = () => {
				if (fallbackViewDispose !== null) return;
				if (ctx.slots === undefined || ctx.slots === null || typeof ctx.slots.inject !== "function") return;
				// 用 slots.inject 等"slot 已被声明"再注册：否则在 owner 之前注册会落空。
				fallbackViewDispose = ctx.slots.inject("conversation.view", () => {
					log("fallback: registering gomoku as a conversation view");
					return ctx.slots.register(
						{
							name: "conversation.view",
							id: "gomoku",
							order: 20,
							label: () => activeDict["panel.title"] ?? "五子棋",
							locale: NS,
							inject: () => ({
								hooks: { gomoku: store },
								play: store.play,
								reset: store.reset,
								flip,
								nudge: store.nudge,
								setMode: store.setMode,
								attachSession: store.attachSession,
							}),
						},
						GomokuView,
					);
				});
			};

			/** 撤掉兜底座位。 */
			const dropFallbackView = () => {
				if (fallbackViewDispose === null) return;
				try {
					fallbackViewDispose();
				} catch (error) {
					log("drop fallback view failed", error);
				}
				fallbackViewDispose = null;
				log("fallback: conversation view removed（棋盘只在右侧栏）");
			};

			if (ensureSidebarTab()) {
				// 侧栏是这个插件**唯一**的座位。不自动打开的话，用户重启后可能
				// 到处都找不到棋盘（那就等于坏了），所以每次激活打开一次。
				// `single: true` 让它对"已经开着"是幂等的，不会开出第二个棋盘。
				dock.open();
				log("apply done", { build: BUILD, seat: "right-sidebar-only" });
			} else {
				registerFallbackView();
				log("apply done", { build: BUILD, seat: "conversation-view-fallback（侧栏服务未就绪）" });
			}

			// 服务晚到：补注册侧栏页签、打开它，并把兜底座位撤掉
			if (typeof ctx.inject === "function") {
				ctx.inject(["betterSidebar"], () => {
					if (ensureSidebarTab()) {
						dropFallbackView();
						dock.open();
					}
				});
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
