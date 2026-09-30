/**
 * 五子棋插件（Host 半侧）——**单文件、零导入**。
 *
 * ⚠️ 本文件由 `tools/build.mjs` 从 src/engine.js + src/ai.js + src/host.js 生成，
 * 请勿手工编辑。
 *
 * 为什么必须如此：本插件以符号链接装进 profile，相对导入会经 symlink 落到
 * profile 包表之外而被解析拦截层拒绝；而"取不到服务就 return"又会让 fiber
 * 立即 active 却什么都没注册，被宿主判为 did not activate 并挡住整个 Web 启动。
 * 因此本文件：零静态导入、依赖经 `ctx.inject` 在就绪后注册。
 *
 * 本包**刻意不含 `dsh.client`**：实测（A/B/C 对照）只要 package.json 里出现该
 * 字段，宿主半侧就不会激活（工具与路由全部 404）。浏览器半侧因此拆到独立的
 * `dsh-gomoku-client` 包里。
 */

// #region 规则内核（内联自 src/engine.js）

/**
 * 五子棋规则内核。纯函数、零依赖、不碰任何服务与模块。
 *
 * 这一层是权威规则所在，也是整个插件唯一"必须正确"的地方：
 *   - 不引用任何模块（连 node 内建都不用），可被内联进单文件产物；
 *   - 所有导出都是纯函数，输入输出都是普通值；
 *   - 规则取无禁手（freestyle）：双三、双四、长连全部合法，连成五子及以上即胜。
 *
 * 坐标一律写作 (row, col)，两者都在 0..14。棋盘的规范表示是一条长度 225 的
 * 一维数组（行优先）——它是唯一能安全穿过 JSON 边界的表示；对外的可读呈现
 * （给模型看的盘面、给人看的盘面）由本文件生成。
 */

/** 棋盘边长（交叉点数）。标准五子棋 15×15。 */
const BOARD_SIZE = 15;

/** 空交叉点。 */
const EMPTY = 0;
/** 黑子；黑先。 */
const BLACK = 1;
/** 白子。 */
const WHITE = 2;

/** 棋盘总交叉点数：225。 */
const CELL_COUNT = BOARD_SIZE * BOARD_SIZE;

/** 天元（棋盘正中），标准 15 路棋盘的第 (7,7) 点。 */
const TENGEN = Object.freeze({ row: 7, col: 7 });

/**
 * 四个扫描方向：横、竖、主对角（↘）、副对角（↗）。
 * 只需这四个——反方向是同一对线的重复扫描。
 *
 * 导出给棋力内核复用：方向集只有一份，两个内核不会各写一遍再走样。
 */
const DIRECTIONS = Object.freeze([
  Object.freeze([0, 1]),
  Object.freeze([1, 0]),
  Object.freeze([1, 1]),
  Object.freeze([1, -1]),
]);

/**
 * 把 (row, col) 映射为一维下标。
 * @param {number} row - 行号。
 * @param {number} col - 列号。
 * @returns {number} 一维下标。
 */
function indexOf(row, col) {
  return row * BOARD_SIZE + col;
}

/**
 * 坐标是否落在棋盘内。非整数、NaN、字符串一律为 false。
 * @param {unknown} row - 候选行号。
 * @param {unknown} col - 候选列号。
 * @returns {boolean} 是否合法坐标。
 */
function isInside(row, col) {
  return (
    Number.isInteger(row) &&
    Number.isInteger(col) &&
    row >= 0 &&
    row < BOARD_SIZE &&
    col >= 0 &&
    col < BOARD_SIZE
  );
}

/** @returns {number[]} 一条全新的空棋盘。 */
function createBoard() {
  return new Array(CELL_COUNT).fill(EMPTY);
}

/**
 * 校验一条棋盘是否结构合法：长度正确，且每格取值属于 {EMPTY, BLACK, WHITE}。
 * 用于把外部（模型、HTTP 请求体）传来的棋盘挡在规则层之外。
 * @param {unknown} board - 候选棋盘。
 * @returns {boolean} 是否是一条合法棋盘。
 */
function isValidBoard(board) {
  if (!Array.isArray(board) || board.length !== CELL_COUNT) return false;
  for (const cell of board) {
    if (cell !== EMPTY && cell !== BLACK && cell !== WHITE) return false;
  }
  return true;
}

/**
 * 该坐标是否可落子（在盘内且为空）。
 * @param {number[]} board - 当前棋盘。
 * @param {number} row - 行号。
 * @param {number} col - 列号。
 * @returns {boolean} 是否可落子。
 */
function isLegalMove(board, row, col) {
  if (!isValidBoard(board) || !isInside(row, col)) return false;
  return board[indexOf(row, col)] === EMPTY;
}

/**
 * 某个坐标上的棋子颜色。
 * @param {number[]} board - 当前棋盘。
 * @param {number} row - 行号。
 * @param {number} col - 列号。
 * @returns {number} EMPTY / BLACK / WHITE；盘外或非法棋盘返回 EMPTY。
 */
function cellAt(board, row, col) {
  if (!isValidBoard(board) || !isInside(row, col)) return EMPTY;
  return board[indexOf(row, col)];
}

/**
 * 在一维棋盘上放下一子。越界或该点非空时返回 null（调用方负责解释原因）。
 * @param {number[]} board - 当前棋盘。
 * @param {number} row - 行号。
 * @param {number} col - 列号。
 * @param {number} color - BLACK 或 WHITE。
 * @returns {number[]|null} 新棋盘，或 null 表示非法落子。
 */
function placeStone(board, row, col, color) {
  if (color !== BLACK && color !== WHITE) return null;
  if (!isLegalMove(board, row, col)) return null;
  const next = board.slice();
  next[indexOf(row, col)] = color;
  return next;
}

/**
 * 从刚落下的一子出发，检查是否形成五连（含长连）。
 *
 * 只扫描经过 (row, col) 的四条线，因此既有棋局里早已存在的连线不会被误判为
 * 新胜——胜负必须由"这一步"造成。
 * @param {number[]} board - 落子后的棋盘。
 * @param {number} row - 刚落子的行号。
 * @param {number} col - 刚落子的列号。
 * @returns {boolean} 该步是否直接获胜。
 */
function winsAt(board, row, col) {
  if (!isValidBoard(board) || !isInside(row, col)) return false;
  const color = board[indexOf(row, col)];
  if (color !== BLACK && color !== WHITE) return false;
  for (const [dr, dc] of DIRECTIONS) {
    let count = 1;
    for (let step = 1; step < BOARD_SIZE; step += 1) {
      if (cellAt(board, row + dr * step, col + dc * step) !== color) break;
      count += 1;
    }
    for (let step = 1; step < BOARD_SIZE; step += 1) {
      if (cellAt(board, row - dr * step, col - dc * step) !== color) break;
      count += 1;
    }
    if (count >= 5) return true;
  }
  return false;
}

/**
 * 找出刚落下一子所形成的那条取胜连线（用于 UI 高亮）。
 *
 * 四条线里取第一条达到五连的，返回整条连续段（长连会整段返回）。
 * @param {number[]} board - 落子后的棋盘。
 * @param {number} row - 刚落子的行号。
 * @param {number} col - 刚落子的列号。
 * @returns {Array<{row: number, col: number}>} 取胜的交叉点；无连线时为空数组。
 */
function winningLineAt(board, row, col) {
  if (!isValidBoard(board) || !isInside(row, col)) return [];
  const color = board[indexOf(row, col)];
  if (color !== BLACK && color !== WHITE) return [];
  for (const [dr, dc] of DIRECTIONS) {
    const line = [{ row, col }];
    for (let step = 1; step < BOARD_SIZE; step += 1) {
      const r = row + dr * step;
      const c = col + dc * step;
      if (cellAt(board, r, c) !== color) break;
      line.push({ row: r, col: c });
    }
    for (let step = 1; step < BOARD_SIZE; step += 1) {
      const r = row - dr * step;
      const c = col - dc * step;
      if (cellAt(board, r, c) !== color) break;
      line.unshift({ row: r, col: c });
    }
    if (line.length >= 5) return line;
  }
  return [];
}

/**
 * 按"离天元由近及远、同距按行再按列"列出所有可落点。
 *
 * 这个顺序对模型有实际价值：五子棋的合理着手集中在已有棋子附近，边缘空点几乎
 * 总是废棋。把它作为候选列表的默认次序，能显著减少模型给出远端废棋的比例。
 * @param {number[]} board - 当前棋盘。
 * @returns {Array<{row: number, col: number, distance: number}>} 有序候选点。
 */
function candidateMoves(board) {
  const out = [];
  if (!isValidBoard(board)) return out;
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (board[indexOf(row, col)] !== EMPTY) continue;
      out.push({
        row,
        col,
        distance: Math.max(Math.abs(row - TENGEN.row), Math.abs(col - TENGEN.col)),
      });
    }
  }
  out.sort((a, b) => a.distance - b.distance || a.row - b.row || a.col - b.col);
  return out;
}

/**
 * 渲染成模型可读的盘面文字：第一行列号表头，其后每行以行号开头。
 *
 * 表头与每一行都用**统一 2 字符单元格**（表头是右对齐的列号，盘面是 空格+单字符
 * 符号），这样列号与棋子严格同列。这一点是实测踩过的坑：早期版本用单字符列号
 * （第 10 列与第 0 列都显示 "0"，模型会错认列），改用不补白的两位数后又因单元
 * 格宽度不一致从第 10 列起整体漂移。统一宽度是唯一同时满足"无歧义"与"严格对齐"
 * 的做法。
 * @param {number[]} board - 当前棋盘。
 * @returns {string} 16 行的盘面文字（1 行表头 + 15 行盘面）。
 */
function boardText(board) {
  if (!isValidBoard(board)) throw new TypeError('boardText: invalid board');
  const glyph = { [EMPTY]: '·', [BLACK]: 'B', [WHITE]: 'W' };
  const header = [
    '  ',
    ...Array.from({ length: BOARD_SIZE }, (_, c) => String(c).padStart(2, ' ')),
  ].join(' ');
  const rows = [];
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    const cells = [];
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      cells.push(' ' + glyph[board[indexOf(row, col)]]);
    }
    rows.push([String(row).padStart(2, ' '), ...cells].join(' '));
  }
  return [header, ...rows].join('\n');
}

/**
 * 渲染成人类可读的盘面文字（用于棋谱存档与调试）。与 {@link boardText} 同样
 * 采用统一 2 字符单元格，只是棋子用实心/空心圆，便于肉眼阅读。
 * @param {number[]} board - 当前棋盘。
 * @returns {string} 16 行的盘面文字。
 */
function prettyBoard(board) {
  if (!isValidBoard(board)) throw new TypeError('prettyBoard: invalid board');
  const glyph = { [EMPTY]: '·', [BLACK]: '●', [WHITE]: '○' };
  const cols = Array.from({ length: BOARD_SIZE }, (_, c) => String(c).padStart(2, ' ')).join(' ');
  const out = [`  ${cols}`];
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    const cells = [];
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      cells.push(' ' + glyph[board[indexOf(row, col)]]);
    }
    out.push([String(row).padStart(2, ' '), ...cells].join(' '));
  }
  return out.join('\n');
}

/**
 * 统计棋子数量。用于校验客户端传来的棋盘与权威棋盘是否同源。
 * @param {number[]} board - 当前棋盘。
 * @returns {{black: number, white: number, empty: number}} 计数。
 */
function countStones(board) {
  const result = { black: 0, white: 0, empty: 0 };
  if (!isValidBoard(board)) return result;
  for (const cell of board) {
    if (cell === BLACK) result.black += 1;
    else if (cell === WHITE) result.white += 1;
    else result.empty += 1;
  }
  return result;
}

/**
 * 把颜色名转成棋子取值。接受 'black' / 'white'（大小写不敏感，也认中英文单字）。
 * @param {unknown} name - 颜色名。
 * @returns {number|null} BLACK / WHITE，无法识别时 null。
 */
function colorFromName(name) {
  if (typeof name !== 'string') return null;
  const text = name.trim().toLowerCase();
  if (text === 'black' || text === 'b' || text === '黑') return BLACK;
  if (text === 'white' || text === 'w' || text === '白') return WHITE;
  return null;
}

/**
 * 棋子取值转颜色名。
 * @param {number} color - BLACK / WHITE。
 * @returns {'black'|'white'|null} 颜色名。
 */
function nameFromColor(color) {
  if (color === BLACK) return 'black';
  if (color === WHITE) return 'white';
  return null;
}

// #endregion

// #region 棋力内核（内联自 src/ai.js）

/**
 * 五子棋棋力内核（Host 半侧）。纯函数、零依赖（除规则内核）。
 *
 * ## 为什么需要它
 *
 * 让"agent 的每一手"都走一次模型，代价是三重的：
 *   1. **慢**——一次落子 = 一次唤醒 + 一次（或两次）工具往返，秒级；
 *   2. **脏**——每一手都要往会话里插一条用户消息，对话被棋局污染；
 *   3. **占用**——模型在"想棋"的这段时间里，会话没法干别的。
 *
 * 所以真正负责应对的应该是**本地引擎**：毫秒级、零会话副作用、离线可玩。
 * 模型仍然可以看盘、点评、甚至在"模型模式"下亲自落子（见 host.js 的 agentMode），
 * 但它不再被绑在每一手上。
 *
 * ## 算法
 *
 * 经典的"五窗口计分"：
 *   对每个候选点，假设某一方在此落子，然后枚举**经过这一点的 4 个方向 × 6 个长度为 5
 *   的窗口**；窗口里只要没有对方棋子，就按窗口中己方子数计一个权重。
 *   于是"活四/冲四/活三"这些形状不需要专门写规则——它们天然会让更多窗口、更高的
 *   子数命中，权重自然堆上去。
 *
 * 一手棋的总分 = 我下在这里的价值 + 对手下在这里的价值 × 防守系数。
 * 前者让我抓胜机，后者让我堵对手。先看"能不能立刻赢"，再看"对手是不是立刻要赢"，
 * 否则按总分取最优。
 */



/** 一个长度为 5 的窗口里，己方子数对应的权重（下标即子数）。 */
const WINDOW_SCORE = [0, 1, 10, 1000, 100000, 10000000];

/** 达到这个分数说明窗口里已经五连——即"下这里就直接赢"。 */
const WIN_SCORE = WINDOW_SCORE[5];

/** 候选点只考虑已有棋子周围这个距离以内的空点（棋盘边缘的远点几乎总是废棋）。 */
const NEIGHBORHOOD = 2;

/**
 * 假设某一方在 (row, col) 落一子，这一点的价值。
 *
 * 越界一律当作对方棋子（挡死了），这正是我们想要的语义：贴着边线的窗口价值天然更低。
 * @param {number[]} board - 当前棋盘（不含这一子）。
 * @param {number} row - 行号。
 * @param {number} col - 列号。
 * @param {number} color - 假设落子的颜色。
 * @returns {number} 价值分。
 */
function scoreCell(board, row, col, color) {
  const opponent = color === EMPTY ? EMPTY : color === 1 ? 2 : 1;
  let total = 0;
  for (const [dr, dc] of DIRECTIONS) {
    // 窗口起点相对 (row, col) 的偏移：-4..0，覆盖所有包含该点的长度为 5 的窗口
    for (let offset = -4; offset <= 0; offset += 1) {
      let mine = 0;
      let blocked = false;
      for (let step = 0; step < 5; step += 1) {
        const r = row + (offset + step) * dr;
        const c = col + (offset + step) * dc;
        if (!isInside(r, c)) {
          blocked = true;
          break;
        }
        const cell = offset + step === 0 ? color : cellAt(board, r, c);
        if (cell === opponent) {
          blocked = true;
          break;
        }
        if (cell === color) mine += 1;
      }
      if (!blocked) total += WINDOW_SCORE[mine];
    }
  }
  return total;
}

/**
 * 生成候选点：已有棋子周围 NEIGHBORHOOD 格以内的空点。
 * @param {number[]} board - 当前棋盘。
 * @returns {Array<{row: number, col: number, distance: number}>} 候选点（含到天元的距离）。
 */
function candidates(board) {
  const out = [];
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (cellAt(board, row, col) !== EMPTY) continue;
      let near = false;
      for (let dr = -NEIGHBORHOOD; dr <= NEIGHBORHOOD && !near; dr += 1) {
        for (let dc = -NEIGHBORHOOD; dc <= NEIGHBORHOOD; dc += 1) {
          if (dr === 0 && dc === 0) continue;
          if (cellAt(board, row + dr, col + dc) !== EMPTY) {
            near = true;
            break;
          }
        }
      }
      if (!near) continue;
      out.push({ row, col, distance: Math.max(Math.abs(row - TENGEN.row), Math.abs(col - TENGEN.col)) });
    }
  }
  return out;
}

/**
 * 选一手棋。
 *
 * 决策顺序（先确定性、后启发式）：
 *   1. 空盘 → 天元；
 *   2. 我能立刻五连的点 → 直接赢；
 *   3. 对手能立刻五连的点 → 必须堵；
 *   4. 否则按 `我方价值 + 对手价值 × 防守系数` 取最高。
 *
 * 第 4 步里"并列最优"的取舍：先把与最高分相差不到 `TIE_RATIO` 的点都收集起来，
 * 优先取离天元近的；若给了 `options.rng`，则在其中随机取一个（让每局开局不重样）。
 * 不传 `rng` 时完全确定——单测依赖这一点。
 * @param {number[]} board - 当前棋盘。
 * @param {number} color - 要落子的一方。
 * @param {{rng?: () => number, defense?: number}} [options] - 可选项。
 * @returns {{row: number, col: number}|null} 选中的点；无处可落时 null。
 */
function chooseMove(board, color, options = {}) {
  const rng = typeof options.rng === 'function' ? options.rng : null;
  const defense = typeof options.defense === 'number' ? options.defense : 0.85;
  const opponent = color === 1 ? 2 : 1;

  const pool = candidates(board);
  if (pool.length === 0) {
    return cellAt(board, TENGEN.row, TENGEN.col) === EMPTY ? { row: TENGEN.row, col: TENGEN.col } : null;
  }

  const scored = [];
  for (const point of pool) {
    const attack = scoreCell(board, point.row, point.col, color);
    // 直接赢：不必再算别的
    if (attack >= WIN_SCORE) return { row: point.row, col: point.col };
    const block = scoreCell(board, point.row, point.col, opponent);
    scored.push({ row: point.row, col: point.col, distance: point.distance, attack, block, total: attack + block * defense });
  }

  // 对手立刻要赢的点必须堵：这是唯一"哪怕自己价值不高也要下"的情形
  let bestBlock = 0;
  for (const item of scored) bestBlock = Math.max(bestBlock, item.block);
  if (bestBlock >= WIN_SCORE) {
    const urgent = scored.filter((item) => item.block >= WIN_SCORE);
    return urgent.length === 1 ? { row: urgent[0].row, col: urgent[0].col } : pickTied(urgent, rng);
  }

  let best = -Infinity;
  for (const item of scored) best = Math.max(best, item.total);
  const tied = scored.filter((item) => item.total >= best * 0.98);
  return pickTied(tied, rng);
}

/**
 * 在一组并列候选中挑一个：优先离天元近，其次按行列稳定排序，最后可选随机。
 * @param {Array<{row: number, col: number, distance: number}>} list - 候选。
 * @param {(() => number)|null} rng - 可选随机源。
 * @returns {{row: number, col: number}} 选中的点。
 */
function pickTied(list, rng) {
  const sorted = list.slice().sort((a, b) => a.distance - b.distance || a.row - b.row || a.col - b.col);
  if (rng === null || sorted.length === 1) return { row: sorted[0].row, col: sorted[0].col };
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(rng() * sorted.length)));
  return { row: sorted[index].row, col: sorted[index].col };
}

/**
 * 造一个很轻的确定性伪随机源（xorshift32）。
 *
 * 用它而不是 `Math.random` 有两个好处：单测可复现；每局的"随机感"只来自 seed，
 * 出问题时可以把 seed 抄下来重放。
 * @param {number} seed - 任意 32 位整数。
 * @returns {() => number} 返回 [0, 1) 的函数。
 */
function makeRng(seed) {
  let state = (seed | 0) === 0 ? 0x9e3779b9 : seed | 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    // >>> 0 之后取小数部分，得到 [0, 1)
    return (state >>> 0) / 4294967296;
  };
}

/** 让调用方知道"引擎是否认为这手会直接取胜"的门槛。 */
export { WIN_SCORE };

// #endregion

// #region 宿主半侧（内联自 src/host.js）

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

// #endregion
