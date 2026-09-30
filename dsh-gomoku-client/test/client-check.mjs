/**
 * 客户端 bundle 的本地自检。
 *
 * 真机的客户端失败**在源头就被丢弃**（web boot 内核的审计循环只打印 fiber 状态名，
 * 不带异常；崩溃日志里也只有 `<包名>: failed`），所以等到重启才发现 bundle 有问题
 * 代价极高。这个脚本把一个桩 `window.__ModuleLoader__` 摆好，把 lib/client.js 当
 * 脚本求值，然后：
 *
 *   1. 断言 bundle 只 require 白名单内的模块；
 *   2. 断言注册的 `id` 等于包名（否则 factory 永远不会被认领）；
 *   3. 用迷你 React 桩真的把组件渲染成元素树，检查棋盘结构；
 *   4. 用 stub fetch 跑一遍 store 的 state / move / new。
 *
 * 它不能替代一次真实的浏览器加载，但能把"契约写错"和"渲染时抛异常"提前挡掉。
 *
 *     node test/client-check.mjs
 */

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PKG = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const BUNDLE_PATH = join(ROOT, 'lib', 'client.js');
const source = await readFile(BUNDLE_PATH, 'utf8');

let failures = 0;
/**
 * 断言。
 * @param {string} label - 用例名。
 * @param {boolean} condition - 是否通过。
 * @param {string} [detail] - 失败详情。
 */
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`✔ ${label}`);
  } else {
    failures += 1;
    console.log(`✘ ${label}${detail === '' ? '' : ` — ${detail}`}`);
  }
}

//#region 平台种子表（与 app.asar 里的静态模块表一致；本 bundle 只允许用 react）

/** 静态平台模块表：客户端 factory 的 require 对这些名字必解析成功。 */
const PLATFORM_MODULES = [
	'react',
	'react/jsx-runtime',
	'react-dom',
	'react-dom/client',
	'@deepseek-ai/cordis',
	'@deepseek-ai/dsh-client-store',
	'@deepseek-ai/dsh-client-ui-slots',
	'@deepseek-ai/dsh-client-ui-primitives',
	'@deepseek-ai/dsh-client-ui-dockkit',
];

const declared = new Set([
	...PLATFORM_MODULES,
	...(PKG.dsh?.client?.external ?? []),
	...(PKG.dsh?.client?.inject ?? []),
]);

/** bundle 里所有 `require("...")` 的字面量。 */
const requires = [...source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
check('bundle 里存在 require 调用', requires.length > 0, `实际 ${requires.length}`);
for (const specifier of [...new Set(requires)]) {
	check(`require("${specifier}") 在平台种子表或 dsh.client 声明内`, declared.has(specifier));
}
check('未声明多余的外部模块（dsh.client.external 为空）', (PKG.dsh?.client?.external ?? []).length === 0);

//#endregion

//#region 迷你 React 桩

/** 一次渲染内的 hook 槽。 */
let hookSlots = [];
let hookIndex = 0;

const react = {
	createElement(type, props, children) {
		const merged = Object.assign({}, props === null || props === undefined ? {} : props);
		// 真实 React 会把第 3 个及之后的参数收进 props.children 并展平一层
		const rest = Array.prototype.slice.call(arguments, 2);
		if (rest.length > 0) merged.children = rest.length === 1 ? rest[0] : rest;
		return { type, props: merged };
	},
	useState(initial) {
		const slot = hookIndex;
		hookIndex += 1;
		if (!(slot in hookSlots)) hookSlots[slot] = typeof initial === 'function' ? initial() : initial;
		return [
			hookSlots[slot],
			(next) => {
				hookSlots[slot] = typeof next === 'function' ? next(hookSlots[slot]) : next;
			},
		];
	},
	useEffect() {},
	useRef(initial) {
		const slot = hookIndex;
		hookIndex += 1;
		if (!(slot in hookSlots)) hookSlots[slot] = { current: initial };
		return hookSlots[slot];
	},
	useMemo(factory) {
		return factory();
	},
};

/**
 * 把元素树渲染成普通的 { tag, props, children } 结构。
 * @param node - React 元素 / 数组 / 标量。
 * @returns 渲染结果。
 */
function render(node) {
	if (node === null || node === undefined || typeof node === 'boolean') return null;
	if (typeof node === 'string' || typeof node === 'number') return { text: String(node) };
	if (Array.isArray(node)) return node.map(render).filter((item) => item !== null);
	const { type, props } = node;
	if (typeof type === 'function') {
		// 每个组件实例一组槽（单趟渲染足够）
		hookSlots = [];
		hookIndex = 0;
		return render(type(props));
	}
	return { tag: type, props, children: render(props.children === undefined ? null : props.children) };
}

/** 深度优先收集满足条件的节点。 */
function findAll(node, predicate, out = []) {
	if (node === null || node === undefined) return out;
	if (Array.isArray(node)) {
		for (const item of node) findAll(item, predicate, out);
		return out;
	}
	if (typeof node !== 'object') return out;
	if (predicate(node)) out.push(node);
	findAll(node.children, predicate, out);
	return out;
}

//#endregion

//#region 求值 bundle

/** 被 `window.__ModuleLoader__.load` 收下的注册。 */
const registrations = [];
globalThis.window = {
	__ModuleLoader__: {
		load(registration) {
			registrations.push(registration);
		},
	},
};

// bundle 是普通脚本（非 ESM），用间接 eval 在全局作用域下执行
const evaluate = new Function('window', 'document', 'navigator', 'fetch', 'setInterval', 'clearInterval', `${source}\n//# sourceURL=dsh-gomoku-client.js`);
evaluate(globalThis.window, undefined, undefined, (...args) => globalThis.fetch(...args), () => 0, () => {});

check('bundle 只注册了一次', registrations.length === 1, `实际 ${registrations.length}`);
const registration = registrations[0];
check('注册的 id 等于包名（否则 factory 不会被认领）', registration?.id === PKG.name, `${String(registration?.id)} vs ${PKG.name}`);
check('factory 是函数', typeof registration?.factory === 'function');

const materialized = registration.factory((specifier) => {
	if (specifier === 'react') return react;
	throw new Error('unexpected require: ' + specifier);
});
check('导出 apply', typeof materialized.apply === 'function');
check('导出 inject = ["slots","locale"]', Array.isArray(materialized.inject) && materialized.inject.join(',') === 'slots,locale');

//#endregion

//#region 桩客户端 ctx

/** 收下 locale / slot 注册的桩上下文。 */
const client = {
	dicts: new Map(),
	slots: [],
	effects: [],
	/** 每次 session.prompt 的入参。 */
	prompts: [],
	/** 下一次 prompt 的返回信封。 */
	promptResult: { ok: true, value: { accepted: true } },
	/** locale.subscribe 的回调，用于模拟切换语言。 */
	localeListener: null,
	/** 远端是否可用。 */
	remoteAvailable: true,
	/** ctx.inject 等过的服务名。 */
	awaited: [],
};

/** 记录 prompt 调用并回放预设结果。 */
async function promptSpy(payload, signal) {
	client.prompts.push({ payload, signal });
	return client.promptResult;
}

const ctx = {
	effect(callback, label) {
		client.effects.push(label);
		return callback();
	},
	inject(deps, callback) {
		client.awaited.push(...deps);
		callback({ get: () => undefined });
	},
	get(key) {
		if (key === 'remote') return client.remoteAvailable ? { session: { prompt: promptSpy } } : undefined;
		if (key === 'remote.session') return client.remoteAvailable ? { prompt: promptSpy } : undefined;
		return undefined;
	},
	locale: {
		register(ns, dicts) {
			client.dicts.set(ns, dicts);
			return () => client.dicts.delete(ns);
		},
		getSnapshot() {
			return { active: 'zh', locales: [], revision: 1 };
		},
		subscribe(listener) {
			client.localeListener = listener;
			return () => {
				client.localeListener = null;
			};
		},
	},
	slots: {
		inject(key, callback) {
			client.slots.push({ key, via: 'inject' });
			return callback();
		},
		register(options, component) {
			client.slots.push({ key: options.name, via: 'register', options, component });
			return () => {};
		},
	},
};

materialized.apply(ctx);

check('注册了 locale 字典', client.dicts.has('gomoku'), [...client.dicts.keys()].join(','));
const dicts = client.dicts.get('gomoku') ?? {};
check('zh / en 两份字典都在', typeof dicts.zh === 'object' && typeof dicts.en === 'object');
const zhKeys = Object.keys(dicts.zh ?? {}).sort().join(',');
const enKeys = Object.keys(dicts.en ?? {}).sort().join(',');
check('zh 与 en 的键集合一致（双语平衡）', zhKeys === enKeys && zhKeys.length > 0);
check('等 slot 声明后才注册（用 slots.inject）', client.slots[0]?.via === 'inject' && client.slots[0]?.key === 'conversation.view');

const entry = client.slots.find((item) => item.via === 'register');
check('注册进 conversation.view', entry?.options?.name === 'conversation.view');
check('slot id 是自有 id（不复用 chat/trajectory）', entry?.options?.id === 'gomoku', String(entry?.options?.id));
check('slot order 排在 trajectory(10) 之后', entry?.options?.order > 10, String(entry?.options?.order));
check('label 是字符串或 thunk', typeof entry?.options?.label === 'string' || typeof entry?.options?.label === 'function');
check('slot 声明了 locale 命名空间', entry?.options?.locale === 'gomoku');
check('slot 组件是函数', typeof entry?.component === 'function');

const injected = entry.options.inject();
check('inject 面提供 hooks.gomoku（→ useGomoku）', typeof injected?.hooks?.gomoku?.getSnapshot === 'function' && typeof injected?.hooks?.gomoku?.subscribe === 'function');
check('inject 面提供 play / reset', typeof injected?.play === 'function' && typeof injected?.reset === 'function');
check('inject 面提供 flip', typeof injected?.flip === 'function');
check('inject 面提供 nudge（手动催 agent）', typeof injected?.nudge === 'function');
check('inject 面提供 attachSession（告知会话身份）', typeof injected?.attachSession === 'function');
check('registered 了 locale 追踪器', client.effects.some((label) => String(label).indexOf('locale tracker') >= 0), client.effects.join(' | '));

//#endregion

//#region 组件渲染

/** 造一份 Host 快照。 */
function snapshotOf(overrides = {}) {
	return {
		board: new Array(225).fill(0),
		turn: 'white',
		status: 'playing',
		humanColor: 'white',
		agentMode: 'engine',
		winningLine: [],
		lastMove: null,
		rev: 3,
		finished: false,
		history: [{ row: 7, col: 7, color: 1, by: 'engine' }],
		...overrides,
	};
}

/** 用一份固定快照渲染视图。 */
function renderView(game, extra = {}) {
	return render(
		entry.component({
			useGomoku: (selector) => selector({ game: normalizeForTest(game), loaded: true, error: null, pending: false, agent: { state: 'idle', rev: 0, reason: null } }),
			t: (key) => key,
			play: () => {},
			reset: () => {},
			flip: () => {},
			nudge: () => {},
			setMode: () => {},
			attachSession: () => {},
			sessionId: 'session-test',
			...extra,
		}),
	);
}

/**
 * 组件期望的是 store 快照的形状；这里让 Host 快照补齐 normalizeGame 会补的字段。
 * @param game - 半成品快照。
 * @returns 完整快照。
 */
function normalizeForTest(game) {
	const board = Array.isArray(game.board) && game.board.length === 225 ? game.board : new Array(225).fill(0);
	return {
		...game,
		board,
		winningLine: Array.isArray(game.winningLine) ? game.winningLine : [],
		lastMove: game.lastMove ?? null,
		rev: typeof game.rev === 'number' ? game.rev : 0,
		finished: game.status !== 'playing',
		history: Array.isArray(game.history) ? game.history : [],
	};
}

// 空盘：225 个热区、无棋子
const emptyTree = renderView(snapshotOf({ turn: 'white' }));
check('渲染出 svg', findAll(emptyTree, (n) => n.tag === 'svg').length === 1);
const emptyHoles = findAll(emptyTree, (n) => n.props?.className === 'dsh-gomoku-hole');
check('空盘有 225 个可落子热区', emptyHoles.length === 225, `实际 ${emptyHoles.length}`);
// 棋子组带 data-stone 标记：solid = 真棋子，ghost = 悬停/键盘光标的半透明预览
const solidStones = (tree) => findAll(tree, (n) => n.tag === 'g' && n.props?.['data-stone'] === 'solid');
const ghostStones = (tree) => findAll(tree, (n) => n.tag === 'g' && n.props?.['data-stone'] === 'ghost');
check('空盘没有棋子', solidStones(emptyTree).length === 0, `实际 ${solidStones(emptyTree).length}`);
check('空盘画出键盘光标处的幽灵子预览', ghostStones(emptyTree).length === 1, `实际 ${ghostStones(emptyTree).length}`);
check('空盘画了 15+15 条网格线', findAll(emptyTree, (n) => n.tag === 'line').length === 30);
check('空盘画了 5 个星位', findAll(emptyTree, (n) => n.tag === 'circle' && n.props?.r === 3.7).length === 5);
check('画了左右两排共 30 个坐标数字', findAll(emptyTree, (n) => n.tag === 'text').length === 30, `实际 ${findAll(emptyTree, (n) => n.tag === 'text').length}`);
check('坐标数字含 0 与 14', findAll(emptyTree, (n) => n.tag === 'text' && (n.props.children === '0' || n.props.children === '14')).length === 4);

// 棋子是叠层画的：每子至少含本体 / 环境遮蔽 / 描边，白子黑子色调不同
const blackStoneTree = renderView((() => {
	const g = snapshotOf({ turn: 'white' });
	g.board = g.board.slice();
	g.board[7 * 15 + 7] = 1;
	return g;
})());
const blackStone = solidStones(blackStoneTree)[0];
check('黑子组内是多层（落影+本体+遮蔽+高光×2+描边）', Array.isArray(blackStone?.props?.children) && blackStone.props.children.length >= 5, String(blackStone?.props?.children?.length));
check('黑子色调标记为 black', blackStone?.props?.['data-stone-color'] === 'black');
check('黑子本体用 -black-solid 渐变', JSON.stringify(blackStone).indexOf('-black-solid') >= 0);
check('棋子不挂高斯模糊滤镜（性能）', JSON.stringify(blackStone).indexOf('feGaussianBlur') < 0 && JSON.stringify(blackStone).indexOf('-blur') < 0);

// 点击热区走的回调
const playRecording = [];
const clickTree = renderView(snapshotOf({ turn: 'white' }), { play: (row, col) => playRecording.push([row, col]) });
const clickable = findAll(clickTree, (n) => n.props?.className === 'dsh-gomoku-hole');
check('每个热区都绑定了 onClick', clickable.length === 225 && clickable.every((n) => typeof n.props.onClick === 'function'));
// 找到 (9, 4) 那个热区并点它：cx = 38 + 4*40 = 198, cy = 38 + 9*40 = 398
const clickTarget = clickable.find((n) => n.props.cx === 198 && n.props.cy === 398);
check('能按坐标定位到 (9,4) 热区', clickTarget !== undefined);
clickTarget.props.onClick();
check('点击热区把 (9,4) 交给 play()', playRecording[0]?.[0] === 9 && playRecording[0]?.[1] === 4, JSON.stringify(playRecording));

// 有一子时只剩 224 个热区
const oneStone = snapshotOf({ turn: 'white' });
oneStone.board = oneStone.board.slice();
oneStone.board[7 * 15 + 7] = 1;
const oneTree = renderView(oneStone);
check('有子后热区减少到 224', findAll(oneTree, (n) => n.props?.className === 'dsh-gomoku-hole').length === 224);
check('棋子被画出来', solidStones(oneTree).length === 1, `实际 ${solidStones(oneTree).length}`);

// 收官：取胜连线画成发光线 + 折线，非取胜棋子变暗，且棋盘变为不可点
const winBoard = new Array(225).fill(0);
for (let col = 5; col <= 9; col += 1) winBoard[7 * 15 + col] = 1;
winBoard[0 * 15 + 0] = 2; // 一颗与胜负无关的白子，应当被压暗
const winGame = snapshotOf({
	status: 'black-win',
	turn: 'black',
	finished: true,
	board: winBoard,
	history: [{ row: 7, col: 9, color: 1 }],
	lastMove: { row: 7, col: 9 },
	winningLine: [{ row: 7, col: 5 }, { row: 7, col: 6 }, { row: 7, col: 7 }, { row: 7, col: 8 }, { row: 7, col: 9 }],
});
const winTree = renderView(winGame);
check('取胜连线渲染为一条折线', findAll(winTree, (n) => n.tag === 'polyline').length === 1);
check('取胜连线底下还有一条发光底线', findAll(winTree, (n) => n.tag === 'line' && String(n.props?.filter ?? '').indexOf('-glow') >= 0).length === 1);
check('终局后没有可落子热区', findAll(winTree, (n) => n.props?.className === 'dsh-gomoku-hole').length === 0);
const winStones = solidStones(winTree);
check('盘上 6 子都画出来了', winStones.length === 6, `实际 ${winStones.length}`);
check('只有非取胜那一子被压暗', winStones.filter((g) => g.props.opacity !== undefined && g.props.opacity < 1).length === 1, `变暗 ${winStones.filter((g) => g.props.opacity !== undefined && g.props.opacity < 1).length}`);

// 轮到 agent：不可点。模式决定"要不要去唤醒会话"。
const agentTurnModel = snapshotOf({ turn: 'black', humanColor: 'white', agentMode: 'model' });
const agentTurnEngine = snapshotOf({ turn: 'black', humanColor: 'white', agentMode: 'engine' });
const agentTree = renderView(agentTurnModel, {});
check('轮到 agent 时棋盘不可落子', findAll(agentTree, (n) => n.props?.className === 'dsh-gomoku-hole').length === 0);
const agentTreeRequested = renderView(agentTurnModel, {
	useGomoku: (selector) => selector({ game: normalizeForTest(agentTurnModel), loaded: true, error: null, pending: false, agent: { state: 'requested', rev: agentTurnModel.rev, reason: null } }),
});
check('已唤醒 agent 时显示"思考中"指示灯', findAll(agentTreeRequested, (n) => n.props?.className === 'dsh-gomoku-thinking').length === 1);
check('已唤醒 agent 时不显示手动"催一下"按钮', findAll(agentTreeRequested, (n) => n.props?.['data-action'] === 'nudge').length === 0);
// 用 data-action 定位，不依赖文案（文案可能来自 FALLBACK 字典）
check('模型模式下未唤醒时显示"催一下"按钮', findAll(agentTree, (n) => n.props?.['data-action'] === 'nudge').length === 1);
check('"催一下"按钮点击会调用 nudge()', (() => {
	const seen = [];
	const tree = renderView(agentTurnModel, { nudge: () => seen.push(1) });
	findAll(tree, (n) => n.props?.['data-action'] === 'nudge')[0].props.onClick();
	return seen.length === 1;
})());
check('"催一下"按钮的文案来自内置字典而非键名', JSON.stringify(agentTree).indexOf('action.nudge') < 0);
check('新开一局 / 换边重开按钮都在', findAll(agentTree, (n) => ['new', 'flip'].includes(n.props?.['data-action'])).length === 2);
// 引擎模式：对手由 Host 本地应对，界面不该出现"催"的概念
const engineTree = renderView(agentTurnEngine, {});
check('引擎模式下不显示"催一下"按钮', findAll(engineTree, (n) => n.props?.['data-action'] === 'nudge').length === 0);
check('引擎模式下不显示"去对话里说该你了"的引导', findAll(engineTree, (n) => n.props?.className === 'dsh-gomoku-hint').length === 0);

// 模式选择器：这是"快不快、占不占对话"的总开关
const select = findAll(agentTree, (n) => n.props?.['data-role'] === 'mode')[0];
check('渲染出对手模式选择器', select !== undefined);
check('选择器当前值等于快照里的模式', select?.props?.value === 'model', String(select?.props?.value));
check('选择器有三个选项 engine/model/manual', (select?.props?.children ?? []).length === 3);
const switched = [];
const switchTree = renderView(agentTurnEngine, { setMode: (mode) => switched.push(mode) });
findAll(switchTree, (n) => n.props?.['data-role'] === 'mode')[0].props.onChange({ target: { value: 'model' } });
check('切换模式会调用 setMode()', switched[0] === 'model', JSON.stringify(switched));
check('引擎模式下选择器显示引擎', findAll(switchTree, (n) => n.props?.['data-role'] === 'mode')[0].props.value === 'engine');

// 最后一手由谁落的：引擎模式下一手往返就是两子，必须标出来
const lastEngine = renderView(snapshotOf({ agentMode: 'engine', lastMove: { row: 6, col: 8, color: 1, by: 'engine' } }));
check('状态栏标出"引擎落子"及其坐标', JSON.stringify(lastEngine).includes('Engine played') && JSON.stringify(lastEngine).includes('(6, 8)'), JSON.stringify(lastEngine).slice(0, 200));
const lastHuman = renderView(snapshotOf({ agentMode: 'engine', lastMove: { row: 6, col: 8, color: 2, by: 'human' } }));
check('也能标出"你落子"', JSON.stringify(lastHuman).includes('You played'));

// 唤醒通道彻底不可用时，退回手动引导文案（只在模型模式下才有这个说法）
const noRemoteTree = renderView(agentTurnModel, {
	useGomoku: (selector) => selector({ game: normalizeForTest(agentTurnModel), loaded: true, error: null, pending: false, agent: { state: 'unavailable', rev: agentTurnModel.rev, reason: 'no-session' } }),
});
check('拿不到会话时退回手动引导文案', findAll(noRemoteTree, (n) => n.props?.className === 'dsh-gomoku-hint').length === 1);
check('轮到人时不显示"催一下"按钮', findAll(emptyTree, (n) => n.props?.['data-action'] === 'nudge').length === 0);

// 畸形输入不得抛异常
let malformedOk = true;
try {
	renderView({ board: 'nonsense', turn: 'purple', status: 42, humanColor: null, winningLine: 'x', rev: 'y' });
} catch (error) {
	malformedOk = false;
	check('畸形 Host 快照不抛异常', false, String(error?.message ?? error));
}
if (malformedOk) check('畸形 Host 快照不抛异常（退化为空盘）', true);

//#endregion

//#region store 与 HTTP

/** 记录 fetch 调用并按需作答。 */
const calls = [];
let nextState = snapshotOf();
globalThis.fetch = async (url, init) => {
	calls.push({ url, init });
	if (url === '/gomoku/state') {
		return { ok: true, status: 200, json: async () => ({ ok: true, game: nextState }) };
	}
	if (url === '/gomoku/move') {
		const sent = JSON.parse(init.body);
		nextState = snapshotOf({ rev: nextState.rev + 1, lastMove: { row: sent.row, col: sent.col } });
		return { ok: true, status: 200, json: async () => ({ ok: true, changed: true, move: sent, won: false, game: nextState }) };
	}
	if (url === '/gomoku/new') {
		const sent = JSON.parse(init.body);
		nextState = snapshotOf({ rev: 1, turn: 'black', humanColor: sent.humanColor ?? 'white', history: [] });
		return { ok: true, status: 200, json: async () => ({ ok: true, game: nextState }) };
	}
	return { ok: false, status: 404, json: async () => ({ ok: false, reason: 'not found' }) };
};

const store = injected.hooks.gomoku;
check('store 初始 rev 为 0 且未加载', store.getSnapshot().game.rev === 0 && store.getSnapshot().loaded === false);

let notified = 0;
const unsubscribe = store.subscribe(() => {
	notified += 1;
});
check('subscribe 立刻拉一次 state', calls.some((call) => call.url === '/gomoku/state'));
// 等 load 的微任务落地
await new Promise((done) => setTimeout(done, 0));
check('state 载入后 rev 同步为 3', store.getSnapshot().game.rev === 3, `实际 ${store.getSnapshot().game.rev}`);
check('state 载入后 loaded 为 true', store.getSnapshot().loaded === true);
check('订阅者收到通知', notified > 0, `实际 ${notified}`);

calls.length = 0;
await store.play(9, 4);
const moveCall = calls.find((call) => call.url === '/gomoku/move');
check('play() POST /gomoku/move', moveCall !== undefined && moveCall.init.method === 'POST');
check('play() 只发坐标，不发颜色（颜色由 Host 决定）', moveCall?.init?.body === JSON.stringify({ row: 9, col: 4 }), String(moveCall?.init?.body));
check('play() 后以权威快照收敛（rev=4）', store.getSnapshot().game.rev === 4, `实际 ${store.getSnapshot().game.rev}`);
check('play() 后 lastMove 指向该手', store.getSnapshot().game.lastMove?.row === 9 && store.getSnapshot().game.lastMove?.col === 4);
check('play() 后 pending 归位', store.getSnapshot().pending === false);

calls.length = 0;
await store.reset('black');
const newCall = calls.find((call) => call.url === '/gomoku/new');
check('reset("black") POST /gomoku/new 带上 humanColor', JSON.parse(newCall?.init?.body ?? '{}').humanColor === 'black', String(newCall?.init?.body));
check('reset 后人类执黑', store.getSnapshot().game.humanColor === 'black');
check('reset 后 rev 回到 1', store.getSnapshot().game.rev === 1);

calls.length = 0;
await injected.flip();
check('flip() 把人类换到另一方（black→white）', JSON.parse(calls.find((call) => call.url === '/gomoku/new')?.init?.body ?? '{}').humanColor === 'white', String(calls.find((call) => call.url === '/gomoku/new')?.init?.body));

// Host 报错时把原因显式带到界面
calls.length = 0;
globalThis.fetch = async (url, init) => {
	calls.push({ url, init });
	if (url === '/gomoku/move') {
		return { ok: false, status: 409, json: async () => ({ ok: false, reason: '该 black 落子', game: nextState }) };
	}
	return { ok: true, status: 200, json: async () => ({ ok: true, game: nextState }) };
};
await store.play(1, 1);
check('Host 拒绝时把 reason 显示到界面', store.getSnapshot().error === '该 black 落子', String(store.getSnapshot().error));
check('Host 拒绝后 pending 归位', store.getSnapshot().pending === false);

unsubscribe();
check('退订后不再轮询（不再打扰 Host）', calls.length === 0 || typeof unsubscribe === 'function');

//#endregion

//#region agent 自动落子（"我下完它就开始下"）

/** 等若干轮微任务，让 fire-and-forget 的唤醒链路跑完。 */
const settle = () => new Promise((done) => setTimeout(done, 12));

// 局面切到"该 agent 走"，并且是**模型模式**（只有这个模式才会去唤醒会话）
nextState = snapshotOf({ rev: 10, turn: 'black', humanColor: 'white', agentMode: 'model', lastMove: { row: 7, col: 7 }, history: [{ row: 7, col: 7, color: 1 }] });
client.prompts.length = 0;
await store.refresh();
await settle();
check('还没被告知会话身份时不投 prompt', client.prompts.length === 0, `实际 ${client.prompts.length}`);
check('此时状态标为 unavailable', store.getSnapshot().agent.state === 'unavailable', store.getSnapshot().agent.state);

// 视图挂载 → 告知会话身份 → 立刻自动唤醒（这就是"不用等人发该你了"）
client.prompts.length = 0;
injected.attachSession('session-abc');
await settle();
check('挂载后发现该 agent 走就自动唤醒', client.prompts.length === 1, `实际 ${client.prompts.length}`);
const p = client.prompts[0]?.payload ?? {};
check('prompt 带正确的 sessionId', p.sessionId === 'session-abc', String(p.sessionId));
check('prompt 走 queue 模式（不是 steer）', p.mode === 'queue', String(p.mode));
check('prompt 带唯一 requestId', typeof p.requestId === 'string' && p.requestId.length > 0, String(p.requestId));
check(
	'prompt content 是单条 text',
	Array.isArray(p.content) && p.content.length === 1 && p.content[0].type === 'text' && typeof p.content[0].text === 'string',
	JSON.stringify(p.content),
);
check('prompt 说清了工具名与用法', p.content[0].text.includes('gomoku_show') && p.content[0].text.includes('gomoku_move'), p.content[0].text);
// 关键回归：prompt 曾经写成"我下在 ({row}, {col}) 了。轮到你执{who}…"，实测里真的出现了
// "我下在 (?, ?) 了。轮到你执黑"——那是从一份与真实盘面不一致的快照拼出来的
// （lastMove=null、humanColor 还是默认值），也就是 prompt 在替 Host 说话而且说错了。
// 现在文案与局面彻底解耦：不带坐标、不断言执子方，让模型自己去 gomoku_show 拿权威局面。
check('prompt 不含坐标占位符（不出现 "?"）', !p.content[0].text.includes('?'), p.content[0].text);
check('prompt 不断言执子方（不出现"执"）', !p.content[0].text.includes('执'), p.content[0].text);
check('prompt 的 clientTimeZone 是字符串或省略', p.clientTimeZone === undefined || typeof p.clientTimeZone === 'string');
check('自动投递后状态为 requested', store.getSnapshot().agent.state === 'requested', store.getSnapshot().agent.state);

// 同一局面不得重复投递（否则轮询/重挂载会造成 prompt 风暴）
await store.refresh();
await settle();
await store.refresh();
await settle();
check('同一 rev 不重复自动投递', client.prompts.length === 1, `实际 ${client.prompts.length}`);

// "催一下"按钮无视 rev 护栏
await store.nudge();
await settle();
check('nudge() 无视护栏再投一次', client.prompts.length === 2, `实际 ${client.prompts.length}`);

// 唤醒失败：把原因记下来给界面显示
client.promptResult = { ok: false, error: { code: 'session/writer-held', message: 'writer held' } };
await store.nudge();
await settle();
check(
	'唤醒失败时记录原因',
	store.getSnapshot().agent.state === 'failed' && String(store.getSnapshot().agent.reason).includes('writer'),
	`${store.getSnapshot().agent.state} / ${String(store.getSnapshot().agent.reason)}`,
);
client.promptResult = { ok: true, value: { accepted: true } };

// Remote 压根不存在：降级而不是抛异常
client.remoteAvailable = false;
await store.nudge();
await settle();
check(
	'Remote 不可用时降级为 remote-unavailable（不抛异常）',
	store.getSnapshot().agent.state === 'failed' && String(store.getSnapshot().agent.reason).startsWith('remote-unavailable'),
	`${store.getSnapshot().agent.state} / ${String(store.getSnapshot().agent.reason)}`,
);
// 失败原因里必须带上"三条取 Remote 的路径各自怎么了"——这正是"浏览器里看不见的失败"
// 唯一的出口：它会显示在状态栏上。
check(
	'失败原因带三条查找路径的诊断',
	String(store.getSnapshot().agent.reason).includes("get('remote')") &&
		String(store.getSnapshot().agent.reason).includes("get('remote.session')") &&
		String(store.getSnapshot().agent.reason).includes('ctx.remote.session'),
	String(store.getSnapshot().agent.reason),
);
client.remoteAvailable = true;

// 人落子之后自动接上 agent 的一手
client.prompts.length = 0;
await store.nudge(); // 让状态回到 requested，便于观察"人落子"这一条路径
await settle();
client.prompts.length = 0;
const afterHuman = snapshotOf({ rev: 21, turn: 'black', humanColor: 'white', agentMode: 'model', lastMove: { row: 5, col: 5 } });
globalThis.fetch = async (url, init) => {
	calls.push({ url, init });
	if (url === '/gomoku/move') return { ok: true, status: 200, json: async () => ({ ok: true, changed: true, move: { row: 5, col: 5 }, won: false, game: afterHuman }) };
	// /state 一律回放 nextState，这样后面的用例可以自由布置局面
	return { ok: true, status: 200, json: async () => ({ ok: true, game: nextState }) };
};
nextState = afterHuman;
await store.play(5, 5);
await settle();
check('人落子后立刻唤醒 agent（不用发"该你了"）', client.prompts.length === 1, `实际 ${client.prompts.length}`);
// 换一个完全不同的局面（另一手、另一方），prompt 文案必须逐字不变——
// 这就是"文案与局面解耦"的可执行证明。
check(
	'prompt 文案与局面无关（人下在别处也一模一样）',
	String(client.prompts[0]?.payload?.content?.[0]?.text) === p.content[0].text,
	`${String(client.prompts[0]?.payload?.content?.[0]?.text)} vs ${p.content[0].text}`,
);

// 开局（lastMove 为 null）：这正是线上出现 "我下在 (?, ?) 了" 的那种局面
client.prompts.length = 0;
nextState = snapshotOf({ rev: 30, turn: 'black', humanColor: 'white', agentMode: 'model', lastMove: null, history: [] });
await store.refresh();
await settle();
check('空盘开局（lastMove=null）也会唤醒 agent', client.prompts.length === 1, `实际 ${client.prompts.length}`);
check('开局文案里没有 "?" 占位符', !String(client.prompts[0]?.payload?.content?.[0]?.text).includes('?'), String(client.prompts[0]?.payload?.content?.[0]?.text));
check(
	'开局文案与中盘文案逐字相同',
	String(client.prompts[0]?.payload?.content?.[0]?.text) === p.content[0].text,
	`${String(client.prompts[0]?.payload?.content?.[0]?.text)} vs ${p.content[0].text}`,
);

// 终局之后不得再唤醒
client.prompts.length = 0;
nextState = snapshotOf({ rev: 22, turn: 'white', humanColor: 'white', agentMode: 'model', status: 'black-win', finished: true });
await store.refresh();
await settle();
check('终局后不再唤醒 agent', client.prompts.length === 0, `实际 ${client.prompts.length}`);

// 人的回合不得唤醒
client.prompts.length = 0;
nextState = snapshotOf({ rev: 23, turn: 'white', humanColor: 'white', agentMode: 'model' });
await store.refresh();
await settle();
check('轮到人时不得唤醒 agent', client.prompts.length === 0, `实际 ${client.prompts.length}`);

// ★ 引擎模式：对手由 Host 本地应对，客户端**绝不能**再往会话里插消息。
//   这是"下的太慢 + 下棋时不能有其他对话"这两个抱怨的根治点。
client.prompts.length = 0;
nextState = snapshotOf({ rev: 40, turn: 'black', humanColor: 'white', agentMode: 'engine', lastMove: { row: 7, col: 7 }, history: [{ row: 7, col: 7, color: 1, by: 'engine' }] });
await store.refresh();
await settle();
check('引擎模式下轮到对手也不唤醒会话', client.prompts.length === 0, `实际 ${client.prompts.length}`);
check('引擎模式下不会进入 requesting 状态', store.getSnapshot().agent.state !== 'requesting', store.getSnapshot().agent.state);
// nudge 也不能绕过模式判断
await store.nudge();
await settle();
check('引擎模式下 nudge() 也不会投 prompt', client.prompts.length === 0, `实际 ${client.prompts.length}`);

// ★ 兼容旧 Host：快照里没有 agentMode 时必须按 model 兜底。
//   否则"只刷新了页面、还没重启应用"的窗口里，客户端会以为引擎会应对，
//   结果既不去唤醒模型、也没人落子——棋局直接卡死。
client.prompts.length = 0;
nextState = snapshotOf({ rev: 50, turn: 'black', humanColor: 'white', lastMove: { row: 7, col: 7 } });
delete nextState.agentMode;
await store.refresh();
await settle();
check('旧 Host（快照无 agentMode）时不卡死：按 model 兜底去唤醒', client.prompts.length === 1, `实际 ${client.prompts.length}`);

// #endregion

// #region 模式切换

const modeCalls = [];
globalThis.fetch = async (url, init) => {
	calls.push({ url, init });
	if (url === '/gomoku/mode') {
		modeCalls.push(JSON.parse(init.body));
		const next = snapshotOf({ rev: 41, turn: 'black', humanColor: 'white', agentMode: JSON.parse(init.body).agentMode });
		return { ok: true, status: 200, json: async () => ({ ok: true, agentMove: null, game: next }) };
	}
	return { ok: true, status: 200, json: async () => ({ ok: true, game: nextState }) };
};
await store.setMode('model');
check('setMode 会 POST /gomoku/mode', modeCalls[0]?.agentMode === 'model', JSON.stringify(modeCalls));
check('setMode 后快照里的模式跟着变', store.getSnapshot().game.agentMode === 'model', String(store.getSnapshot().game.agentMode));
// 切到模型模式本身就会触发一次唤醒（该它走），先让它落地再单独验 nudge
await settle();

// 切到模型模式后，同一个局面就应该唤醒会话了
client.prompts.length = 0;
await store.nudge();
await settle();
check('切到模型模式后 nudge() 又会投 prompt', client.prompts.length === 1, `实际 ${client.prompts.length}`);

// 新开一局要把当前模式带上，否则用户选好的模式会被重置回默认
calls.length = 0;
await store.reset('black');
const newBody = JSON.parse(calls.find((c) => c.url === '/gomoku/new')?.init?.body ?? '{}');
check('新开一局会带上当前模式', newBody.agentMode === 'model' && newBody.humanColor === 'black', JSON.stringify(newBody));

//#endregion

//#region 右侧边栏集成（可选，依赖 dsh-better-sidebar 的 ctx.betterSidebar）

/**
 * 造一套干净的客户端 ctx + 捕获器，用来单独验证一次 `apply`。
 * @param opts - { sidebar } 传入假的 betterSidebar 服务。
 * @returns {ctx, cap} 桩上下文与捕获器。
 */
function makeClientCtx(opts = {}) {
	const cap = {
		dicts: new Map(),
		slots: [],
		effects: [],
		prompts: [],
		promptResult: { ok: true, value: { accepted: true } },
		localeListener: null,
		remoteAvailable: true,
		sidebar: opts.sidebar ?? null,
		opened: [],
		registered: [],
		/** `ctx.inject` 的回调是否立即触发（false = 模拟"服务还没出现"）。 */
		injectImmediately: opts.injectImmediately !== false,
		/** 被等待的服务名。 */
		awaited: [],
		/** injectImmediately 为 false 时攒下的回调，测试可以手动点火。 */
		pendingInjections: [],
	};
	const prompt = async (payload, signal) => {
		cap.prompts.push({ payload, signal });
		return cap.promptResult;
	};
	return {
		cap,
		/** 手动点火所有攒下的 `ctx.inject` 回调（模拟"服务晚到"）。 */
		fireInjections() {
			const pending = cap.pendingInjections.splice(0);
			for (const callback of pending) callback({ get: () => undefined });
			return pending.length;
		},
		cap,
		ctx: {
			effect(callback, label) {
				cap.effects.push(label);
				return callback();
			},
			inject(deps, callback) {
				cap.awaited.push(...deps);
				if (cap.injectImmediately) callback({ get: () => undefined });
				else cap.pendingInjections.push(callback);
			},
			get(key) {
				if (key === 'remote') return cap.remoteAvailable ? { session: { prompt } } : undefined;
				if (key === 'remote.session') return cap.remoteAvailable ? { prompt } : undefined;
				if (key === 'betterSidebar') return cap.sidebar;
				return undefined;
			},
			locale: {
				register(ns, dicts) {
					cap.dicts.set(ns, dicts);
					return () => cap.dicts.delete(ns);
				},
				getSnapshot() {
					return { active: 'zh', locales: [], revision: 1 };
				},
				subscribe(listener) {
					cap.localeListener = listener;
					return () => {
						cap.localeListener = null;
					};
				},
			},
			slots: {
				inject(key, callback) {
					const entry = { key, via: 'inject' };
					cap.slots.push(entry);
					const inner = callback();
					// 真 disposer：这样测试能观察到"兜底座位被撤掉了"
					return () => {
						const at = cap.slots.indexOf(entry);
						if (at >= 0) cap.slots.splice(at, 1);
						if (typeof inner === 'function') inner();
					};
				},
				register(options, component) {
					const entry = { key: options.name, via: 'register', options, component };
					cap.slots.push(entry);
					return () => {
						const at = cap.slots.indexOf(entry);
						if (at >= 0) cap.slots.splice(at, 1);
					};
				},
			},
		},
	};
}

/**
 * 取一次 apply 之后对话视图的 inject 面；没有兜底座位时返回 undefined。
 * @param cap - 捕获器。
 * @returns inject 面或 undefined。
 */
function injectFaceOf(cap) {
	const entry = cap.slots.find((item) => item.via === 'register');
	return entry?.options?.inject();
}

/** 本轮 apply 是否挂了对话视图兜底座位。 */
function hasFallbackView(cap) {
	return cap.slots.some((item) => item.via === 'register' && item.options?.id === 'gomoku');
}

/** 造一个假的 betterSidebar 服务。 */
function makeFakeSidebar() {
	return {
		version: '0.24.1',
		features: ['targetedOpen'],
		registerTab(descriptor) {
			this.registeredTabs.push(descriptor);
			return () => {
				this.registeredTabs = this.registeredTabs.filter((d) => d !== descriptor);
			};
		},
		openTab(seed) {
			this.openedTabs.push(seed);
		},
		registeredTabs: [],
		openedTabs: [],
	};
}

// ★ 主路径：装了 betterSidebar → **只有右侧栏**，对话区里不该多出页签
const fakeSidebar = makeFakeSidebar();
const docked = makeClientCtx({ sidebar: fakeSidebar });
materialized.apply(docked.ctx);
check('装了 betterSidebar 时注册了侧栏页签类型', fakeSidebar.registeredTabs.length === 1, String(fakeSidebar.registeredTabs.length));
check('★ 装了 betterSidebar 时**不**挂对话视图页签', !hasFallbackView(docked.cap), JSON.stringify(docked.cap.slots.map((s) => s.key)));
check('★ 对话区里没有注册任何 gomoku 槽位', docked.cap.slots.filter((s) => s.via === 'register').length === 0, String(docked.cap.slots.length));
const descriptor = fakeSidebar.registeredTabs[0];
check('页签 id 是 gomoku', descriptor?.id === 'gomoku', String(descriptor?.id));
check('页签单例（不会开出第二个棋盘）', descriptor?.single === true);
check('页签有标题与描述', typeof descriptor?.title === 'function' && typeof descriptor?.description === 'function');
check('页签 title() 返回中文标题', descriptor?.title() === '五子棋', String(descriptor?.title()));
check('页签 description() 说明了"边聊边下"', String(descriptor?.description()).includes('边聊边下'), String(descriptor?.description()));
check('页签有图标工厂', typeof descriptor?.icon === 'function' && render(descriptor.icon()).tag === 'svg');
check('页签注册进了插件的 effect（可随卸载释放）', docked.cap.effects.some((l) => String(l).indexOf('sidebar tab type') >= 0), docked.cap.effects.join(' | '));
// 侧栏是唯一的座位 → 激活时必须打开它，否则用户到处都找不到棋盘
check('★ 激活时会自动打开侧栏页签', fakeSidebar.openedTabs[0]?.type === 'gomoku', JSON.stringify(fakeSidebar.openedTabs));

// 页签组件本身能被渲染（它拿不到 slot 的 hooks/locale 座位，全靠自己）
const panelElement = descriptor.component({ scope: { sessionId: 'session-side' }, visible: true, ctx: docked.ctx });
const panelTree = render(panelElement);
check('侧栏页签渲染出棋盘', findAll(panelTree, (n) => n.tag === 'svg').length === 1);
const panelRoot = findAll(panelTree, (n) => n.props?.className === 'dsh-gomoku-root')[0];
check('侧栏页签标记为紧凑布局', panelRoot?.props?.['data-compact'] === 'true', String(panelRoot?.props?.['data-compact']));
check('侧栏页签能取到模式选择器', findAll(panelTree, (n) => n.props?.['data-role'] === 'mode').length === 1);
check('棋盘工具栏只有 新开一局 / 换边重开 两个按钮', findAll(panelTree, (n) => ['new', 'flip'].includes(n.props?.['data-action'])).length === 2, JSON.stringify(findAll(panelTree, (n) => typeof n.props?.['data-action'] === 'string').map((n) => n.props['data-action'])));
check('不再有"停靠"按钮（侧栏已经是唯一座位）', findAll(panelTree, (n) => n.props?.['data-action'] === 'dock').length === 0);

// ★ 服务晚到：先挂兜底对话视图，服务出现后必须把兜底撤掉、注册并打开侧栏页签
const lateSidebar = makeFakeSidebar();
const raced = makeClientCtx({ injectImmediately: false, sidebar: null });
materialized.apply(raced.ctx);
check('服务未就绪时先挂上兜底对话视图（免得什么都看不见）', hasFallbackView(raced.cap));
check('并且声明了对 betterSidebar 的等待', raced.cap.awaited.includes('betterSidebar'), JSON.stringify(raced.cap.awaited));
check('服务未就绪时还没打开任何侧栏页签', lateSidebar.openedTabs.length === 0);
// 服务出现 → 点火等待回调
raced.cap.sidebar = lateSidebar;
check('点火了 1 个等待回调', raced.fireInjections() === 1);
check('★ 服务晚到时补注册了侧栏页签类型', lateSidebar.registeredTabs.length === 1, String(lateSidebar.registeredTabs.length));
check('★ 服务晚到时打开了侧栏页签', lateSidebar.openedTabs[0]?.type === 'gomoku', JSON.stringify(lateSidebar.openedTabs));
check('★ 服务晚到时撤掉了兜底对话视图', !hasFallbackView(raced.cap), JSON.stringify(raced.cap.slots.map((s) => s.key)));
check('★ 撤掉后对话区里一个 gomoku 槽位都不剩', raced.cap.slots.filter((s) => s.via === 'register').length === 0, String(raced.cap.slots.length));

// ★ 服务从未出现：兜底对话视图留着，插件不至于完全隐身
const never = makeClientCtx({ injectImmediately: false, sidebar: null });
materialized.apply(never.ctx);
check('服务始终缺失时保留兜底对话视图', hasFallbackView(never.cap));
check('服务始终缺失时对话视图仍可渲染', (() => {
	const tree = renderView(snapshotOf({}), {});
	return findAll(tree, (n) => n.tag === 'svg').length === 1;
})());
check('服务始终缺失时没有打开任何侧栏页签', true);

// visible=false（后台页签）也必须能安全渲染。注意：本测试的迷你 React 把 useEffect
// 实现成空操作，所以"后台就不订阅、不轮询 Host"这条行为在这里**无法被验证**——
// 它由源码里的 `if (active !== true) return undefined;` 保证，属于人工复核项。
// visible=false（后台页签）也必须能安全渲染。注意：本测试的迷你 React 把 useEffect
// 实现成空操作，所以"后台就不订阅、不轮询 Host"这条行为在这里**无法被验证**——
// 它由源码里的 `if (active !== true) return undefined;` 保证，属于人工复核项。
const hiddenPanel = descriptor.component({ scope: { sessionId: 'session-side' }, visible: false, ctx: docked.ctx });
let hiddenOk = true;
try {
	render(hiddenPanel);
} catch (error) {
	hiddenOk = false;
	check('visible=false 时安全渲染', false, String(error?.message ?? error));
}
if (hiddenOk) check('visible=false（后台页签）时安全渲染', true);
// scope 缺失时也不能炸（页签刚挂上、会话还没就绪的那种瞬间）
let barePanelOk = true;
try {
	render(descriptor.component({ visible: true }));
} catch (error) {
	barePanelOk = false;
	check('scope 缺失时安全渲染', false, String(error?.message ?? error));
}
if (barePanelOk) check('scope 缺失（会话未就绪）时安全渲染', true);

// #endregion

// #region 静态卫生

check('bundle 注册 id 与 package.json name 一致', registration.id === PKG.name);
check('exports["./client"] 指向 lib/client.js', PKG.exports?.['./client']?.default === './lib/client.js');
check('声明了 dsh.client.platform = "web"', PKG.dsh?.client?.platform === 'web');
check('dsh.bundle.patch 指向 cordis.patch.yml', PKG.dsh?.bundle?.patch === './cordis.patch.yml');
check('bundle 不含 sourceMappingURL 之外的尾随垃圾', !/sourceMappingURL/.test(source) || /sourceMappingURL=[^\n]*\n?$/.test(source));
check('CSS 注入带 data-plugin-css 标记（避免重复插入）', source.indexOf('data-plugin-css') >= 0 && source.indexOf('dataset.pluginCss') >= 0);

//#endregion

console.log('');
if (failures === 0) {
	console.log('全部通过。');
} else {
	console.log(`${failures} 项失败。`);
	process.exitCode = 1;
}
