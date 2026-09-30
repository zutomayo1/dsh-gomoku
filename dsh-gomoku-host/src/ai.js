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

import { BOARD_SIZE, DIRECTIONS, EMPTY, TENGEN, cellAt, isInside } from './engine.js';

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
export function scoreCell(board, row, col, color) {
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
export function candidates(board) {
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
export function chooseMove(board, color, options = {}) {
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
export function makeRng(seed) {
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
