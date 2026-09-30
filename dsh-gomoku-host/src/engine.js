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
export const BOARD_SIZE = 15;

/** 空交叉点。 */
export const EMPTY = 0;
/** 黑子；黑先。 */
export const BLACK = 1;
/** 白子。 */
export const WHITE = 2;

/** 棋盘总交叉点数：225。 */
export const CELL_COUNT = BOARD_SIZE * BOARD_SIZE;

/** 天元（棋盘正中），标准 15 路棋盘的第 (7,7) 点。 */
export const TENGEN = Object.freeze({ row: 7, col: 7 });

/**
 * 四个扫描方向：横、竖、主对角（↘）、副对角（↗）。
 * 只需这四个——反方向是同一对线的重复扫描。
 *
 * 导出给棋力内核复用：方向集只有一份，两个内核不会各写一遍再走样。
 */
export const DIRECTIONS = Object.freeze([
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
export function indexOf(row, col) {
  return row * BOARD_SIZE + col;
}

/**
 * 坐标是否落在棋盘内。非整数、NaN、字符串一律为 false。
 * @param {unknown} row - 候选行号。
 * @param {unknown} col - 候选列号。
 * @returns {boolean} 是否合法坐标。
 */
export function isInside(row, col) {
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
export function createBoard() {
  return new Array(CELL_COUNT).fill(EMPTY);
}

/**
 * 校验一条棋盘是否结构合法：长度正确，且每格取值属于 {EMPTY, BLACK, WHITE}。
 * 用于把外部（模型、HTTP 请求体）传来的棋盘挡在规则层之外。
 * @param {unknown} board - 候选棋盘。
 * @returns {boolean} 是否是一条合法棋盘。
 */
export function isValidBoard(board) {
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
export function isLegalMove(board, row, col) {
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
export function cellAt(board, row, col) {
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
export function placeStone(board, row, col, color) {
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
export function winsAt(board, row, col) {
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
export function winningLineAt(board, row, col) {
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
export function candidateMoves(board) {
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
export function boardText(board) {
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
export function prettyBoard(board) {
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
export function countStones(board) {
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
export function colorFromName(name) {
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
export function nameFromColor(color) {
  if (color === BLACK) return 'black';
  if (color === WHITE) return 'white';
  return null;
}
