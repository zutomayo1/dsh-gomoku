/**
 * 五子棋插件的宿主半侧。**将被内联进单文件产物，因此 import 会被构建脚本剥掉。**
 *
 * ## 与"嵌在 GUI 里的棋盘游戏"的区别
 *
 * 棋局的权威状态在 **Host 进程**里，不在浏览器。浏览器半侧只是这份状态的一个视图与
 * 点击入口。
 *
 * ## 对手由谁应对：agentMode
 *
 * 这是这个插件最重要的一个设计决定。
 *
 * 让**每一手**都走一次模型，代价是三重的：
 *   1. **慢**——一次落子 = 唤醒 + 一到两次工具往返，秒级；
 *   2. **脏**——每一手都要往会话里插一条用户消息，对话被棋局污染；
 *   3. **占用**——模型"想棋"期间会话没法干别的。
 *
 * 所以有三种模式：
 *
 * | 模式 | 谁来应对 | 特点 |
 * |---|---|---|
 * | `engine`（默认） | 本地棋力内核（src/ai.js） | **毫秒级、零会话副作用**；同一次 HTTP 往返里就把人这一手与应对一手一起返回 |
 * | `model` | 模型（经 session.prompt 唤醒） | 棋风像人、能解释，但慢，且每次都要在对话里留一条消息 |
 * | `manual` | 谁都不自动 | 只给调试/复盘用 |
 *
 * 模型仍然可以随时看盘（`gomoku_show`）、点评，或在 `model` 模式下亲自落子。
 *
 * ## 本文件的两条硬约束（都由实测教训换来）
 *
 * 1. **零 import（构建后）。** 本插件以符号链接装进 profile；相对导入会经 symlink
 *    落到 profile 包表之外，被解析拦截层拒绝。需要 node 内建时用惰性 `import()`。
 * 2. **注册必须走 `ctx.inject` + `scope.effect`。** 启动期插件先被加载、
 *    `tools`/`webServer` 之后才注册。写成"取不到服务就 return"会让 fiber 立即 active
 *    却什么都没注册，被宿主判为 `did not activate` 并**挡住整个 Web 启动**。
 *    `scope.effect` 保证 disable/enable 时注册被干净释放（否则下一次
 *    `tools.register` 会因同一层内工具重名而抛错）。
 */

import { BLACK, BOARD_SIZE, EMPTY, WHITE, boardText, candidateMoves, colorFromName, countStones, createBoard, isInside, isLegalMove, nameFromColor, placeStone, prettyBoard, winningLineAt, winsAt } from './engine.js';
import { chooseMove, makeRng } from './ai.js';

/** Cordis 插件名（仅用于诊断）。 */
export const name = 'gomoku-host';

/**
 * 不声明 `inject`：依赖改由 `ctx.inject` 在 apply 内部声明。
 * 这样 fiber 不会因为等待注入而停在 pending（那也会被判为未激活）。
 */
export const inject = [];

/**
 * 本插件拥有的路由前缀。
 *
 * 取顶层 `/gomoku`（而不是 `/plugins/gomoku`）的理由是**语义与结构**，不是修 bug：
 *
 * - `/plugins` 是 `@deepseek-ai/dsh-client-modules` 的 bundle 路由
 *   （源码里 `PLUGIN_ROUTE = "/plugins"`），它的职责是"下发插件资源"；本插件的
 *   API 是业务路由，不属于那一族。
 * - 两个 prefix 家族结构上互不为前缀，行为不依赖路由器的 tie-break 语义。
 *
 * ⚠️ 曾经把 `/plugins/gomoku` 的 404 归因于"被 bundle prefix 遮蔽"。**这个归因
 * 是错的**，已用单变量探针实测推翻：一个以 `kind:"prefix"` 注册在 `/plugins/probeA`
 * 的宿主路由返回 **200**。那次 404 的真正原因是 package.json 里出现了 `dsh.client`
 * 字段导致**宿主半侧不激活**（见本包 README 的对照实验）。
 */
export const GOMOKU_PATH = '/gomoku';

/** 棋谱存档目录名（位于 DSH 主目录下）。 */
const ARCHIVE_DIRNAME = 'gomoku';

/** 对手的三种应对方式。 */
const AGENT_MODES = ['engine', 'model', 'manual'];

/** 默认模式：本地引擎。毫秒级、不碰会话——这是实测之后选定的默认值。 */
const DEFAULT_AGENT_MODE = 'engine';

/**
 * 解析 DSH 主目录：`$DSH_HOME` 优先，否则用户主目录下的 `.dsh`。
 * 不用 node:path/os，避免任何模块解析。
 * @returns {string} DSH 主目录的绝对路径。
 */
function dshHome() {
  const env = process.env;
  const explicit = env.DSH_HOME;
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return explicit.replace(/[\\/]+$/, '');
  }
  const home =
    env.USERPROFILE || env.HOME || (env.HOMEDRIVE && env.HOMEPATH ? env.HOMEDRIVE + env.HOMEPATH : '');
  const sep = process.platform === 'win32' ? '\\' : '/';
  return home === '' ? '.dsh' : home.replace(/[\\/]+$/, '') + sep + '.dsh';
}

/**
 * 拼接路径片段，使用当前平台分隔符。
 * @param {...string} segments - 路径片段。
 * @returns {string} 拼接结果。
 */
function joinPath(...segments) {
  const sep = process.platform === 'win32' ? '\\' : '/';
  const parts = [];
  for (const segment of segments) {
    if (typeof segment !== 'string' || segment === '') continue;
    parts.push(segment.replace(/[\\/]+$/, ''));
  }
  if (parts.length === 0) return '';
  return parts.join(sep).replace(new RegExp(sep + sep + '+', 'g'), sep);
}

/**
 * 惰性取 node 内建模块。用 dynamic import 而非静态导入：静态导入会在模块加载期
 * 触发解析，而本插件要求"加载期零解析"——这是它能在 profile 里稳定激活的前提。
 * @param {string} specifier - 内建模块名，如 'node:fs/promises'。
 * @returns {Promise<any>} 模块命名空间。
 */
function builtin(specifier) {
  return import(specifier);
}

/**
 * 把外部传来的模式名规范化。
 * @param {unknown} raw - 候选模式名。
 * @returns {'engine'|'model'|'manual'|null} 合法模式名，或 null。
 */
function normalizeMode(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().toLowerCase();
  return AGENT_MODES.includes(text) ? text : null;
}

/**
 * 这一局里"对手"执哪一方：人类执子的另一方。
 * @param {object} game - 棋局。
 * @returns {number} BLACK 或 WHITE。
 */
function agentColorOf(game) {
  return game.humanColor === BLACK ? WHITE : BLACK;
}

/**
 * 人类执哪一方：优先用显式配置，否则取"非 agent 的那一方"。
 * @param {object} options - 配置。
 * @returns {number} BLACK 或 WHITE。
 */
function resolveHumanColor(options) {
  if (options.humanColor === BLACK || options.humanColor === WHITE) return options.humanColor;
  const blackIsAgent = options.blackIsAgent !== false;
  const whiteIsAgent = options.whiteIsAgent === true;
  // 两方都是 agent 时退回黑方（仅作占位）
  return blackIsAgent && !whiteIsAgent ? WHITE : BLACK;
}

/**
 * 新建一局。
 *
 * 默认：**黑方交给对手、白方交给人类**（人类执白、对手执黑，黑先），对手用本地引擎。
 * @param {object} [options] - 可选配置。
 * @param {number} [options.humanColor] - 人类执子方。
 * @param {string} [options.agentMode] - 对手应对方式。
 * @returns {object} 新棋局。
 */
function createGame(options = {}) {
  const humanColor = resolveHumanColor(options);
  const agentMode = normalizeMode(options.agentMode) ?? DEFAULT_AGENT_MODE;
  return {
    id: 'default',
    board: createBoard(),
    turn: BLACK,
    status: 'playing',
    history: [],
    winningLine: [],
    rev: 1,
    humanColor,
    agentMode,
  };
}

/**
 * 对外的棋局快照：补齐派生字段，供工具返回值与 HTTP 响应共用。
 * @param {object} game - 棋局。
 * @returns {object} 可 JSON 序列化的快照。
 */
function gameSnapshot(game) {
  return {
    id: game.id,
    rev: game.rev,
    board: game.board,
    turn: nameFromColor(game.turn),
    status: game.status,
    history: game.history,
    winningLine: game.winningLine,
    humanColor: nameFromColor(game.humanColor),
    agentColor: nameFromColor(agentColorOf(game)),
    agentMode: game.agentMode,
    counts: countStones(game.board),
    lastMove: game.history.length > 0 ? game.history[game.history.length - 1] : null,
    finished: game.status !== 'playing',
  };
}

/**
 * 在棋局上落一子。这是唯一的写入口，权威性都汇聚在这里。
 *
 * 校验顺序刻意如此：先确认局未终、坐标合法、点为空、颜色与轮次一致，再落子并
 * 判定胜负。任何一步失败都返回 `{ ok: false, reason }` 而**不改动棋局**。
 * @param {object} game - 棋局（会被就地修改）。
 * @param {number} row - 行号。
 * @param {number} col - 列号。
 * @param {number} color - BLACK / WHITE。
 * @param {'human'|'model'|'engine'} [by] - 这一手由谁落的（记进棋谱）。
 * @returns {object} 成功为 { ok: true, move, won }，失败为 { ok: false, reason }。
 */
function applyMove(game, row, col, color, by = 'human') {
  if (game.status !== 'playing') {
    return { ok: false, reason: `棋局已结束（${game.status}），请先开新局。` };
  }
  if (color !== BLACK && color !== WHITE) {
    return { ok: false, reason: '颜色只能是 black 或 white。' };
  }
  if (!isInside(row, col)) {
    return {
      ok: false,
      reason: `坐标 (${row}, ${col}) 超出棋盘：行与列都必须在 0 到 ${BOARD_SIZE - 1} 之间。`,
    };
  }
  if (color !== game.turn) {
    return {
      ok: false,
      reason: `现在该 ${nameFromColor(game.turn)} 落子，但请求的是 ${nameFromColor(color)}。`,
    };
  }
  if (!isLegalMove(game.board, row, col)) {
    return { ok: false, reason: `(${row}, ${col}) 已经有子了，请选择空点。` };
  }

  const next = placeStone(game.board, row, col, color);
  if (next === null) return { ok: false, reason: '落子被规则层拒绝。' };

  game.board = next;
  game.history.push({ row, col, color, by });
  game.rev += 1;

  const won = winsAt(game.board, row, col);
  if (won) {
    game.status = color === BLACK ? 'black-win' : 'white-win';
    game.winningLine = winningLineAt(game.board, row, col);
  } else if (!game.board.includes(EMPTY)) {
    game.status = 'draw';
  } else {
    game.turn = color === BLACK ? WHITE : BLACK;
  }

  return { ok: true, move: { row, col, color, by }, won };
}

/**
 * 该对手走、而且模式是引擎 → 立刻由本地棋力内核落一手。
 *
 * **只走一手**，绝不循环：这样 `POST /move` 一次往返就能把"人这一手 + 引擎的应对"
 * 一起返回，界面上一帧到位，而且永远不会把请求拖住。
 * @param {object} game - 棋局（会被就地修改）。
 * @returns {object|null} 引擎落下的那一手，或 null（不该它走/无法落子）。
 */
function playEngineMove(game) {
  if (game.agentMode !== 'engine') return null;
  if (game.status !== 'playing') return null;
  const color = agentColorOf(game);
  if (game.turn !== color) return null;
  // 用 rev 做种子：同一局面重放得到同一手（可复现），不同局面开局不重样
  const move = chooseMove(game.board, color, { rng: makeRng(game.rev * 2654435761 + game.history.length) });
  if (move === null) return null;
  const result = applyMove(game, move.row, move.col, color, 'engine');
  return result.ok ? result.move : null;
}

/**
 * 把棋局讲成模型可读的一段文字：盘面 + 该谁走 + 局势提示。
 *
 * 刻意把候选点直接摆到模型面前，因为五子棋的合理着手集中在已有棋子附近；
 * 这能明显减少远端废棋。也会说清"另一方由谁应对"——否则模型看到棋盘上多了
 * 一手却不知道是谁下的。
 * @param {object} game - 棋局。
 * @returns {string} 盘面说明。
 */
function describeGame(game) {
  const lines = [];
  const human = nameFromColor(game.humanColor) === 'black' ? '黑' : '白';
  const agent = human === '黑' ? '白' : '黑';
  const modeText =
    game.agentMode === 'engine'
      ? '本地引擎自动应对（毫秒级，不占用会话）'
      : game.agentMode === 'model'
        ? '模型应对（每一手都会在对话里唤醒一次）'
        : '不自动应对';
  lines.push('棋盘（15×15，B=黑，W=白，·=空）：');
  lines.push(boardText(game.board));
  lines.push('');
  const { black, white } = countStones(game.board);
  lines.push(`黑 ${black} 子，白 ${white} 子。`);
  lines.push(`人类执${human}，另一方执${agent}，该方当前由：${modeText}。`);
  if (game.status === 'playing') {
    lines.push(`轮到 ${nameFromColor(game.turn)} 落子。`);
    const candidates = candidateMoves(game.board).slice(0, 12);
    if (candidates.length > 0) {
      lines.push(
        `推荐优先考虑的空点（由棋盘中心向外）：${candidates
          .map((m) => `(${m.row}, ${m.col})`)
          .join(' ')}`,
      );
    }
  } else if (game.status === 'draw') {
    lines.push('棋盘已满，和棋。');
  } else {
    lines.push(`${game.status === 'black-win' ? '黑' : '白'}方获胜。`);
  }
  if (game.history.length > 0) {
    const last = game.history[game.history.length - 1];
    const who = last.by === 'engine' ? '引擎' : last.by === 'model' ? '模型' : '人类';
    lines.push(`最后一手：${who} ${nameFromColor(last.color) === 'black' ? '黑' : '白'} (${last.row}, ${last.col})。`);
  }
  return lines.join('\n');
}

/**
 * 文本型工具输出：DSH 的工具结果由 content blocks 组成。
 * @param {string} text - 正文。
 * @returns {Array<{type: 'text', text: string}>} content blocks。
 */
function textContent(text) {
  return [{ type: 'text', text }];
}

/**
 * 挂载 Host 半侧。
 *
 * 棋局状态放在 inject 回调**之外**，使它在服务注销后重新注册时不丢。回调内的
 * 注册全部挂在 `scope` 的 effect 上，随 scope 一起释放——这一点很重要：本插件
 * 会被反复 disable/enable（热迭代），若注册泄漏，下一次 `tools.register` 会因为
 * **同一层内工具重名**而抛错，导致再次安装的 `apply` 直接失败。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主 cordis 上下文。
 */
export function apply(ctx) {
  /** 当前棋局；一次只维护一局。 */
  let game = createGame();

  ctx.inject(['tools', 'webServer'], (scope) => {
    const tools = scope.get('tools');
    const webServer = scope.get('webServer');
    if (tools === undefined || webServer === undefined) {
      console.info('[gomoku] 注入回调触发但服务缺失，本次不注册。');
      return;
    }

    /**
     * 把模型给的落子参数解析成颜色。缺省时用"当前该走的一方"，这是最常见的意图。
     * @param {unknown} raw - 参数里的 color。
     * @returns {number} BLACK / WHITE。
     */
    const resolveColor = (raw) => {
      const parsed = colorFromName(raw);
      return parsed === null ? game.turn : parsed;
    };

    scope.effect(
      () =>
        tools.register({
          name: 'gomoku_show',
          description:
            '查看当前五子棋棋局：返回棋盘、该谁走、双方子数、最后一手是谁下的、以及优先考虑的空点。想在对话里讨论局势或确认轮次时调用。无副作用。',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          output: {
            schema: {
              type: 'object',
              properties: {
                board: { type: 'string', description: '棋盘文字' },
                turn: { type: 'string', description: '该谁走' },
                status: { type: 'string', description: '棋局状态' },
              },
            },
            render: (_args, value) => textContent(value.board),
          },
          execute: async () => ({
            board: describeGame(game),
            turn: nameFromColor(game.turn),
            status: game.status,
          }),
        }),
      'gomoku: tool gomoku_show',
    );

    scope.effect(
      () =>
        tools.register({
          name: 'gomoku_move',
          description:
            '在五子棋棋局上落一子。行列都从 0 到 14，(0,0) 在左上角，中心是天元 (7,7)。颜色可省略，默认按当前该走的一方。非法落子会被拒绝并说明原因，此时棋局不变。注意：默认模式下另一方由本地引擎自动应对，不需要你来走；只有把对手设成 model 模式时才该由你落子。',
          parameters: {
            type: 'object',
            properties: {
              row: { type: 'integer', minimum: 0, maximum: BOARD_SIZE - 1, description: '行号 0-14' },
              col: { type: 'integer', minimum: 0, maximum: BOARD_SIZE - 1, description: '列号 0-14' },
              color: {
                type: 'string',
                enum: ['black', 'white'],
                description: '执子方；省略则按当前轮次',
              },
            },
            required: ['row', 'col'],
            additionalProperties: false,
          },
          output: {
            schema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                board: { type: 'string', description: '落子后的棋盘' },
                summary: { type: 'string', description: '这一手的一句话说明' },
                reason: { type: 'string', description: '失败原因' },
              },
            },
            render: (_args, value) => textContent(value.summary ?? value.reason ?? value.board ?? ''),
          },
          execute: async (args) => {
            const color = resolveColor(args?.color);
            const result = applyMove(game, args?.row, args?.col, color, 'model');
            if (!result.ok) {
              return {
                ok: false,
                reason: result.reason,
                summary: `落子失败：${result.reason}`,
                board: describeGame(game),
              };
            }
            // 若这一手之后轮到引擎那一方，让它立刻接着走
            const reply = playEngineMove(game);
            const who = color === BLACK ? '黑' : '白';
            const ending =
              game.status === 'playing'
                ? `轮到 ${nameFromColor(game.turn) === 'black' ? '黑' : '白'}。`
                : game.status === 'draw'
                  ? '棋盘已满，和棋。'
                  : `${game.status === 'black-win' ? '黑' : '白'}方五连获胜。`;
            const replyText = reply === null ? '' : `引擎应对 (${reply.row}, ${reply.col})。`;
            return {
              ok: true,
              summary: `${who}方落子 (${args?.row}, ${args?.col})。${replyText}${ending}`,
              board: describeGame(game),
            };
          },
        }),
      'gomoku: tool gomoku_move',
    );

    scope.effect(
      () =>
        tools.register({
          name: 'gomoku_new',
          description:
            '开一局新的五子棋（清空棋盘，黑先）。可指定哪一方由人类执子，以及另一方由谁应对：mode=engine（默认，本地引擎，毫秒级且不碰会话）/ model（模型应对，每一手都要在对话里唤醒一次）/ manual（不自动应对）。',
          parameters: {
            type: 'object',
            properties: {
              human: { type: 'string', enum: ['black', 'white'], description: '人类执子方；默认 white' },
              mode: { type: 'string', enum: AGENT_MODES, description: '对手应对方式；默认 engine' },
            },
            additionalProperties: false,
          },
          output: {
            schema: {
              type: 'object',
              properties: {
                board: { type: 'string', description: '新棋盘' },
                status: { type: 'string' },
              },
            },
            render: (_args, value) => textContent(value.board),
          },
          execute: async (args) => {
            const human = colorFromName(args?.human);
            const mode = normalizeMode(args?.mode);
            game = createGame({
              ...(human === null ? {} : { humanColor: human }),
              ...(mode === null ? {} : { agentMode: mode }),
            });
            // 新局轮到对手时，让引擎直接把开局那一手走掉，人一进来就能下
            playEngineMove(game);
            return { board: `已开新局。\n\n${describeGame(game)}`, status: game.status };
          },
        }),
      'gomoku: tool gomoku_new',
    );

    scope.effect(
      () =>
        tools.register({
          name: 'gomoku_archive',
          description:
            '把当前棋局以棋谱形式存成文件，便于回看或分享。返回写入的完整路径。默认写到 DSH 主目录下的 gomoku/ 子目录。',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '目标文件路径；省略则自动命名' },
            },
            additionalProperties: false,
          },
          output: {
            schema: {
              type: 'object',
              properties: {
                path: { type: 'string', description: '写入的路径' },
                moves: { type: 'integer', description: '手数' },
              },
            },
            render: (_args, value) => textContent(`棋谱已保存：${value.path}（${value.moves} 手）`),
          },
          execute: async (args) => {
            const { mkdir, writeFile } = await builtin('node:fs/promises');
            const dir = joinPath(dshHome(), ARCHIVE_DIRNAME);
            await mkdir(dir, { recursive: true });
            const explicit =
              typeof args?.path === 'string' && args.path.trim() !== '' ? args.path.trim() : null;
            const target = explicit ?? joinPath(dir, `gomoku-${Date.now()}.txt`);
            const lines = [
              `# 五子棋棋谱 ${new Date().toISOString()}`,
              `# 手数：${game.history.length}`,
              `# 结果：${game.status}`,
              `# 对手模式：${game.agentMode}`,
              '',
              ...game.history.map((move, i) => {
                const who = move.color === BLACK ? '黑' : '白';
                const by = move.by === 'engine' ? '引擎' : move.by === 'model' ? '模型' : '人类';
                return `${String(i + 1).padStart(3, ' ')}. ${who} (${move.row}, ${move.col})  [${by}]`;
              }),
              '',
              prettyBoard(game.board),
              '',
            ];
            await writeFile(target, lines.join('\n'), 'utf8');
            return { path: target, moves: game.history.length };
          },
        }),
      'gomoku: tool gomoku_archive',
    );

    scope.effect(
      () =>
        webServer.register({
          kind: 'prefix',
          path: GOMOKU_PATH,
          handler: async (request, response) => {
            const url = new URL(request.url ?? '/', 'http://localhost');
            const route = url.pathname.slice(GOMOKU_PATH.length) || '/';
            const send = (status, body) => {
              response.writeHead(status, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
              });
              response.end(JSON.stringify(body));
            };

            /** 读取请求体并解析 JSON；空体返回 {}。 */
            const readBody = async () => {
              const chunks = [];
              for await (const chunk of request) chunks.push(chunk);
              const raw = Buffer.concat(chunks).toString('utf8');
              if (raw === '') return { ok: true, value: {} };
              try {
                return { ok: true, value: JSON.parse(raw) };
              } catch {
                return { ok: false };
              }
            };

            try {
              if (route === '/state' && request.method === 'GET') {
                return send(200, { ok: true, game: gameSnapshot(game) });
              }

              if (route === '/archives' && request.method === 'GET') {
                const { readdir, readFile } = await builtin('node:fs/promises');
                const dir = joinPath(dshHome(), ARCHIVE_DIRNAME);
                let entries = [];
                try {
                  entries = await readdir(dir, { withFileTypes: true });
                } catch {
                  entries = [];
                }
                const archives = [];
                for (const entry of entries) {
                  if (!entry.isFile()) continue;
                  const full = joinPath(dir, entry.name);
                  try {
                    const text = await readFile(full, 'utf8');
                    archives.push({ name: entry.name, path: full, size: text.length });
                  } catch {
                    // 读不到的文件跳过，不让列表整体失败
                  }
                }
                return send(200, { ok: true, archives });
              }

              if (route === '/new' && request.method === 'POST') {
                const body = await readBody();
                if (!body.ok) return send(400, { ok: false, reason: '请求体不是合法 JSON。' });
                const human = colorFromName(body.value?.humanColor);
                const mode = normalizeMode(body.value?.agentMode);
                game = createGame({
                  ...(human === null ? {} : { humanColor: human }),
                  ...(mode === null ? {} : { agentMode: mode }),
                });
                const opening = playEngineMove(game);
                return send(200, { ok: true, agentMove: opening, game: gameSnapshot(game) });
              }

              if (route === '/mode' && request.method === 'POST') {
                const body = await readBody();
                if (!body.ok) return send(400, { ok: false, reason: '请求体不是合法 JSON。' });
                const mode = normalizeMode(body.value?.agentMode);
                if (mode === null) {
                  return send(400, {
                    ok: false,
                    reason: `模式只能是 ${AGENT_MODES.join(' / ')}。`,
                    game: gameSnapshot(game),
                  });
                }
                game.agentMode = mode;
                // 切到引擎模式时，如果正轮到它，立刻补上这一手（否则人会一直干等）
                const reply = playEngineMove(game);
                return send(200, { ok: true, agentMove: reply, game: gameSnapshot(game) });
              }

              if (route === '/move' && request.method === 'POST') {
                const body = await readBody();
                if (!body.ok) return send(400, { ok: false, reason: '请求体不是合法 JSON。' });
                // 浏览器点击是人类操作，只能落人类自己那一方：否则人就能替对手走棋。
                const requested = colorFromName(body.value?.color);
                const color = requested === null ? game.humanColor : requested;
                if (color !== game.humanColor) {
                  return send(403, {
                    ok: false,
                    reason: `浏览器只能落人类执子的一方（${nameFromColor(game.humanColor)}）。`,
                    game: gameSnapshot(game),
                  });
                }
                const revBefore = game.rev;
                const result = applyMove(game, body.value?.row, body.value?.col, color, 'human');
                if (!result.ok) {
                  return send(409, { ok: false, reason: result.reason, game: gameSnapshot(game) });
                }
                // 关键：同一次往返里就把对手的应对带回去，界面一帧到位
                const reply = playEngineMove(game);
                return send(200, {
                  ok: true,
                  changed: game.rev !== revBefore,
                  move: result.move,
                  won: result.won,
                  agentMove: reply,
                  game: gameSnapshot(game),
                });
              }

              return send(404, { ok: false, reason: `未知路由 ${route}` });
            } catch (error) {
              return send(500, {
                ok: false,
                reason: error instanceof Error ? error.message : String(error),
              });
            }
          },
        }),
      `gomoku: route ${GOMOKU_PATH}`,
    );
  });
}
