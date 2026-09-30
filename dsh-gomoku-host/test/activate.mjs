/**
 * 宿主半侧的本地自检：不启动 DSH、不碰 profile，直接把 `lib/index.js` 当一个
 * 模块求值，用桩 `ctx` 走一遍"注册 → 调工具 → 打路由 → 卸载"的全过程。
 *
 * 它替代不了真机验证（真机的失败模式几乎都在**模块解析**与**服务就绪时序**上，
 * 而这两样只有 profile 环境才有），但能在安装前抓掉纯粹的契约错误：
 * 导出缺失、工具 schema 形状不对、路由路径算错、权限分离失效、模式切换失效、
 * 卸载不干净导致重名注册抛错。
 *
 *     node test/activate.mjs
 */

import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

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

// #region 桩环境

/**
 * 造一个假的 cordis 上下文。
 * `ctx.inject(deps, cb)` 立即以 `scope` 调 `cb`——这模拟"服务已经就绪"的真机情形，
 * 也是本插件唯一关心的分支。
 * @returns {object} { ctx, tools, routes, disposeAll }
 */
function makeHarness() {
  /** name → 工具定义。 */
  const tools = new Map();
  /** path → 路由。 */
  const routes = new Map();
  /** 收集所有 effect 的 disposer。 */
  const disposers = [];

  const scope = {
    get: (key) => {
      if (key === 'tools') {
        return {
          register: (definition) => {
            if (tools.has(definition.name)) throw new Error(`同一层内工具重名：${definition.name}`);
            tools.set(definition.name, definition);
            return () => tools.delete(definition.name);
          },
        };
      }
      if (key === 'webServer') {
        return {
          register: (route) => {
            const key = `${route.kind}:${route.path}`;
            if (routes.has(key)) throw new Error(`路由重复注册：${key}`);
            routes.set(key, route);
            return () => routes.delete(key);
          },
        };
      }
      return undefined;
    },
    effect: (callback, label) => {
      const disposer = callback();
      const wrapped = () => {
        if (typeof disposer === 'function') disposer();
      };
      disposers.push({ wrapped, label });
      return wrapped;
    },
  };

  const ctx = {
    inject: (deps, callback) => {
      callback(scope);
    },
  };

  return {
    ctx,
    tools,
    routes,
    disposeAll: () => {
      const labels = disposers.map((entry) => entry.label);
      for (const entry of [...disposers].reverse()) entry.wrapped();
      disposers.length = 0;
      return labels;
    },
  };
}

/**
 * 造一个假的 IncomingMessage。
 * @param {string} method - HTTP 方法。
 * @param {string} url - 请求 URL。
 * @param {unknown} [body] - 请求体；undefined 表示空体。
 * @returns {object} 可被 `for await` 迭代的请求对象。
 */
function makeRequest(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/**
 * 造一个假的 ServerResponse。
 * @returns {object} 带 status / headers / body 的响应对象。
 */
function makeResponse() {
  const captured = { status: 0, headers: null, body: '' };
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status;
      captured.headers = headers;
      return this;
    },
    end(body) {
      captured.body = typeof body === 'string' ? body : '';
    },
  };
}

// #endregion

const moduleUrl = pathToFileURL(join(ROOT, 'lib', 'index.js')).href;
const host = await import(moduleUrl);

// #region 静态导出契约

check('导出 apply', typeof host.apply === 'function');
check('导出 name', host.name === 'gomoku-host', `实际 ${String(host.name)}`);
check('导出空 inject（依赖走 ctx.inject）', Array.isArray(host.inject) && host.inject.length === 0);
check('路由前缀为 /gomoku', host.GOMOKU_PATH === '/gomoku', `实际 ${String(host.GOMOKU_PATH)}`);

const harness = makeHarness();
host.apply(harness.ctx);

check('注册了四个工具', harness.tools.size === 4, `实际 ${harness.tools.size}`);
check(
  '工具名齐备',
  ['gomoku_show', 'gomoku_move', 'gomoku_new', 'gomoku_archive'].every((n) => harness.tools.has(n)),
);
check('注册了 /gomoku 前缀路由', harness.routes.has('prefix:/gomoku'), [...harness.routes.keys()].join(','));

for (const [name, definition] of harness.tools) {
  check(`${name} 的 parameters 是 object 型 JSON Schema`, definition.parameters?.type === 'object' && typeof definition.parameters.properties === 'object');
  check(`${name} 有 output.render`, typeof definition.output?.render === 'function');
  const rendered = definition.output.render({}, { board: 'B', summary: 'S', reason: 'R', path: 'P', moves: 3 });
  check(`${name} 的 render 返回 content blocks`, Array.isArray(rendered) && rendered[0]?.type === 'text');
}

/** 打一次假请求。 */
async function call(method, path, body) {
  const route = harness.routes.get(`prefix:${host.GOMOKU_PATH}`);
  const response = makeResponse();
  await route.handler(makeRequest(method, host.GOMOKU_PATH + path, body), response);
  return { status: response.captured.status, json: response.captured.body === '' ? null : JSON.parse(response.captured.body) };
}

const show = harness.tools.get('gomoku_show');
const move = harness.tools.get('gomoku_move');
const newGame = harness.tools.get('gomoku_new');

// #endregion

// #region 默认就是引擎模式：一次往返里把人和引擎的两手都办掉

const fresh = await call('POST', '/new', {});
check('新局默认是引擎模式', fresh.json?.game?.agentMode === 'engine', String(fresh.json?.game?.agentMode));
check('新局人类执白、另一方执黑', fresh.json?.game?.humanColor === 'white' && fresh.json?.game?.agentColor === 'black');
check('新局里引擎已经把开局那一手走掉了', fresh.json?.game?.counts?.black === 1 && fresh.json?.game?.counts?.white === 0, JSON.stringify(fresh.json?.game?.counts));
check('开局那一手标为 engine', fresh.json?.game?.history?.[0]?.by === 'engine', JSON.stringify(fresh.json?.game?.history));
check('开局那一手落在天元', fresh.json?.agentMove?.row === 7 && fresh.json?.agentMove?.col === 7, JSON.stringify(fresh.json?.agentMove));
check('人一进来就该自己下（轮到白）', fresh.json?.game?.turn === 'white', String(fresh.json?.game?.turn));

// 人落一手 —— 同一次响应里必须带回引擎的应对
const humanMove = await call('POST', '/move', { row: 0, col: 0 });
check('人类落子成功', humanMove.status === 200 && humanMove.json.ok === true, JSON.stringify(humanMove.json).slice(0, 160));
check('① 响应里带回引擎的应对（同一往返）', humanMove.json?.agentMove !== null && humanMove.json?.agentMove !== undefined, JSON.stringify(humanMove.json?.agentMove));
check('② 引擎那一手标为 engine', humanMove.json?.agentMove?.by === 'engine', JSON.stringify(humanMove.json?.agentMove));
check('③ 一手往返后棋盘上多了两子', humanMove.json?.game?.counts?.black === 2 && humanMove.json?.game?.counts?.white === 1, JSON.stringify(humanMove.json?.game?.counts));
check('④ 又轮到人了（可以一直点下去）', humanMove.json?.game?.turn === 'white', String(humanMove.json?.game?.turn));
check('⑤ rev 一次加 2（人一手 + 引擎一手）', humanMove.json?.game?.rev === fresh.json.game.rev + 2, `${fresh.json.game.rev} → ${humanMove.json?.game?.rev}`);

// 权限分离依然成立
const forbidden = await call('POST', '/move', { row: 5, col: 5, color: 'black' });
check('人类路由拒绝对手颜色（403）', forbidden.status === 403, `status=${forbidden.status}`);
const reoccupy = await call('POST', '/move', { row: 0, col: 0 });
check('人类路由拒绝重复落子（409）', reoccupy.status === 409, `status=${reoccupy.status}`);

// #endregion

// #region 模式切换

const toModel = await call('POST', '/mode', { agentMode: 'model' });
check('可切到模型模式', toModel.status === 200 && toModel.json?.game?.agentMode === 'model', JSON.stringify(toModel.json?.game?.agentMode));
check('切到模型模式时不会顺手让引擎走一手', toModel.json?.agentMove === null, JSON.stringify(toModel.json?.agentMove));

const modelHuman = await call('POST', '/move', { row: 0, col: 1 });
check('模型模式下人类落子仍然成功', modelHuman.status === 200 && modelHuman.json.ok === true);
check('模型模式下不再自动应对（交由模型）', modelHuman.json?.agentMove === null, JSON.stringify(modelHuman.json?.agentMove));

const toEngine = await call('POST', '/mode', { agentMode: 'engine' });
check('切回引擎模式时会立刻补上该它走的那一手', toEngine.json?.agentMove !== null && toEngine.json?.agentMove !== undefined, JSON.stringify(toEngine.json?.agentMove));
check('补上之后又轮到人', toEngine.json?.game?.turn === 'white', String(toEngine.json?.game?.turn));

const badMode = await call('POST', '/mode', { agentMode: 'nonsense' });
check('非法模式被拒（400）', badMode.status === 400, `status=${badMode.status}`);

const manual = await call('POST', '/mode', { agentMode: 'manual' });
check('manual 模式生效', manual.json?.game?.agentMode === 'manual');
const manualMove = await call('POST', '/move', { row: 0, col: 2 });
check('manual 模式下没人自动应对', manualMove.json?.agentMove === null, JSON.stringify(manualMove.json?.agentMove));

// #endregion

// #region 模型模式（工具通道）

const modelGame = await newGame.execute({ mode: 'model' });
check('工具可开一局模型模式', modelGame.status === 'playing' && modelGame.board.includes('模型应对'), modelGame.board.slice(0, 80));
const modelState = await call('GET', '/state');
check('工具开的新局确实是 model 模式', modelState.json?.game?.agentMode === 'model', String(modelState.json?.game?.agentMode));
check('模型模式下新局棋盘是空的（引擎不插手）', modelState.json?.game?.counts?.black === 0 && modelState.json?.game?.counts?.white === 0, JSON.stringify(modelState.json?.game?.counts));

const agentFirst = await move.execute({ row: 7, col: 7 });
check('agent 用工具落黑子成功', agentFirst.ok === true, JSON.stringify(agentFirst).slice(0, 200));
check('agent 落子标为 model', (await call('GET', '/state')).json?.game?.history?.[0]?.by === 'model');
check('模型模式下引擎不接管', (await call('GET', '/state')).json?.game?.counts?.black === 1 && (await call('GET', '/state')).json?.game?.counts?.white === 0);

const wrongTurn = await move.execute({ row: 0, col: 0, color: 'black' });
check('工具拒绝非轮次方落子', wrongTurn.ok === false && wrongTurn.reason.includes('该 white'), wrongTurn.reason);

const whiteToolMove = await move.execute({ row: 7, col: 8 });
check('agent 可代白方落子（颜色省略＝按轮次）', whiteToolMove.ok === true, whiteToolMove.summary);

// 轮到黑（对手）了，先让 agent 补一手，才轮到人类走路由
await move.execute({ row: 8, col: 8 });
const toolRouteMove = await call('POST', '/move', { row: 6, col: 8 });
check('模型模式下人类路由也照常工作', toolRouteMove.status === 200 && toolRouteMove.json.ok === true, `status=${toolRouteMove.status} ${String(toolRouteMove.json?.reason)}`);

// #endregion

// #region 终局

const winHarness = makeHarness();
host.apply(winHarness.ctx);
const winMove = winHarness.tools.get('gomoku_move');
const winNew = winHarness.tools.get('gomoku_new');
// 用 manual 模式自己摆棋，避免引擎中途插手
await winNew.execute({ mode: 'manual' });
for (let i = 0; i < 5; i += 1) {
  await winMove.execute({ row: 0, col: i, color: 'black' });
  if (i < 4) await winMove.execute({ row: 5, col: i, color: 'white' });
}
const afterWin = await winHarness.tools.get('gomoku_show').execute({});
check('五连判胜', afterWin.status === 'black-win', afterWin.status);
const afterEnd = await winMove.execute({ row: 9, col: 9, color: 'white' });
check('终局后拒绝继续落子', afterEnd.ok === false && afterEnd.reason.includes('已结束'), afterEnd.reason);

const winRoute = winHarness.routes.get('prefix:/gomoku');
const winResponse = makeResponse();
await winRoute.handler(makeRequest('GET', '/gomoku/state'), winResponse);
const winState = JSON.parse(winResponse.captured.body).game;
check('快照带取胜连线（供 UI 高亮）', winState.winningLine.length === 5, `实际 ${winState.winningLine.length}`);
check('快照带 by 字段（人/模型/引擎）', Array.isArray(winState.history) && winState.history.every((h) => typeof h.by === 'string'));

// 同一层内重名必须显式报错，不能静默双注册
let duplicateThrew = false;
let duplicateMessage = '';
try {
  host.apply(winHarness.ctx);
} catch (error) {
  duplicateThrew = true;
  duplicateMessage = String(error?.message ?? error);
}
check('未卸载就重复 apply 会显式报重名（不静默双注册）', duplicateThrew && duplicateMessage.includes('重名'), duplicateMessage);

// #endregion

// #region 棋盘文字与畸形输入

const boardText = (await show.execute({})).board;
const boardLines = boardText.split('\n').slice(1, 17);
check('盘面文字恰好 16 行', boardLines.length === 16, `实际 ${boardLines.length}`);
check('盘面 16 行严格等宽', new Set(boardLines.map((line) => line.length)).size === 1, [...new Set(boardLines.map((line) => line.length))].join(','));
const strides = [];
for (let c = 0; c < 15; c += 1) {
  strides.push(boardLines[0].slice(3 + c * 3, 3 + c * 3 + 2) === String(c).padStart(2, ' '));
}
check('列号表头逐列落在同一偏移（第 10 列起不错位）', strides.every(Boolean), `失败列 ${strides.map((ok, i) => (ok ? '' : i)).filter(Boolean).join(',')}`);
check('盘面说明里写清了另一方由谁应对', boardText.includes('引擎') || boardText.includes('模型') || boardText.includes('不自动应对'), boardText.split('\n').filter((l) => l.includes('另一方')).join(''));

check('未知路由 404', (await call('GET', '/nope')).status === 404);
check('畸形 JSON 请求体被拒（400）', (await (async () => {
  const route = harness.routes.get(`prefix:${host.GOMOKU_PATH}`);
  const response = makeResponse();
  const request = { method: 'POST', url: `${host.GOMOKU_PATH}/move`, async *[Symbol.asyncIterator]() { yield Buffer.from('{not json', 'utf8'); } };
  await route.handler(request, response);
  return { status: response.captured.status };
})()).status === 400);

// #endregion

// #region 卸载干净

const labels = harness.disposeAll();
check('卸载释放了 4 个工具 + 1 条路由', harness.tools.size === 0 && harness.routes.size === 0, labels.join(' | '));
let reapplyOk = true;
try {
  host.apply(harness.ctx);
} catch (error) {
  reapplyOk = false;
  check('卸载后可重新安装（无重名残留）', false, String(error?.message ?? error));
}
if (reapplyOk) check('卸载后可重新安装（无重名残留）', harness.tools.size === 4);
check('每个 effect 都带标签（便于诊断与有序释放）', labels.every((label) => typeof label === 'string' && label.startsWith('gomoku:')), labels.join(' | '));

// #endregion

console.log('');
if (failures === 0) {
  console.log('全部通过。');
} else {
  console.log(`${failures} 项失败。`);
  process.exitCode = 1;
}
