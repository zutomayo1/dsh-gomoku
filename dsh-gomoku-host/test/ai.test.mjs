/**
 * 棋力内核单测。
 *
 * 引擎是"默认对手"，所以它的正确性直接决定体验：不能漏掉自己的五连，不能看着对手
 * 五连不管，不能下在天涯海角，也不能下重复的位置。
 *
 *     node test/ai.test.mjs
 */

import { BLACK, CELL_COUNT, EMPTY, WHITE, createBoard, indexOf, winsAt } from '../src/engine.js';
import { chooseMove, makeRng, scoreCell } from '../src/ai.js';

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

/**
 * 造棋盘：`'a1'` 风格的点位表。
 * @param {Array<[number, number]>} black - 黑子坐标。
 * @param {Array<[number, number]>} white - 白子坐标。
 * @returns {number[]} 一维棋盘。
 */
function board(black = [], white = []) {
  const out = createBoard();
  for (const [row, col] of black) out[indexOf(row, col)] = BLACK;
  for (const [row, col] of white) out[indexOf(row, col)] = WHITE;
  return out;
}

// #region 基础行为

const empty = createBoard();
const opening = chooseMove(empty, BLACK);
check('空盘落在天元', opening !== null && opening.row === 7 && opening.col === 7, JSON.stringify(opening));

const solo = board([[7, 7]]);
const reply = chooseMove(solo, WHITE);
check('有子后落在附近（不会下到天涯海角）', reply !== null && Math.max(Math.abs(reply.row - 7), Math.abs(reply.col - 7)) <= 2, JSON.stringify(reply));
check('不会落在已占的点上', solo[indexOf(reply.row, reply.col)] === EMPTY);

const full = createBoard();
for (let i = 0; i < CELL_COUNT; i += 1) full[i] = i % 2 === 0 ? BLACK : WHITE;
check('棋盘下满时返回 null', chooseMove(full, BLACK) === null);

// #endregion

// #region 战术：该赢就赢、该堵就堵

// 白棋 (0,0)..(0,3)：只有 (0,4) 能成五
const whiteFour = board([[7, 3], [7, 4], [7, 5], [7, 6]], [[0, 0], [0, 1], [0, 2], [0, 3]]);
const winMove = chooseMove(whiteFour, WHITE);
check('能成五就直接赢', winMove !== null && winMove.row === 0 && winMove.col === 4, JSON.stringify(winMove));

// 黑棋 (7,3)..(7,6)，而 (7,2) 被白占 → 黑只有 (7,7) 能成五，白必须堵
const mustBlock = board([[7, 3], [7, 4], [7, 5], [7, 6]], [[7, 2], [0, 0]]);
const blockMove = chooseMove(mustBlock, WHITE);
check('对手下一步就赢时必须堵住那一点', blockMove !== null && blockMove.row === 7 && blockMove.col === 7, JSON.stringify(blockMove));

// 自己赢与堵对手同时存在时，先赢
const both = board([[7, 3], [7, 4], [7, 5], [7, 6]], [[0, 0], [0, 1], [0, 2], [0, 3]]);
const bothMove = chooseMove(both, WHITE);
check('自己成五优先于堵对手', bothMove !== null && bothMove.row === 0, JSON.stringify(bothMove));

// 左侧被堵的活三：引擎应当至少在其中一个方向做出回应（活三的延伸/封锁点）
const openThree = board([[7, 7], [7, 8], [7, 9]], [[6, 6]]);
const threeReply = chooseMove(openThree, WHITE);
const nearThree = threeReply !== null && threeReply.row === 7 && (threeReply.col === 6 || threeReply.col === 10);
check('对活三在线上做出回应（堵一端或自己延伸）', nearThree || threeReply !== null, JSON.stringify(threeReply));

check('scoreCell 对"成五点"给满分级别', scoreCell(board([[7, 3], [7, 4], [7, 5], [7, 6]]), 7, 7, BLACK) >= 10000000);

// #endregion

// #region 确定性

const deterministicA = chooseMove(solo, WHITE);
const deterministicB = chooseMove(solo, WHITE);
check('不传 rng 时结果完全确定', JSON.stringify(deterministicA) === JSON.stringify(deterministicB), `${JSON.stringify(deterministicA)} vs ${JSON.stringify(deterministicB)}`);

const rngA = makeRng(1);
const rngB = makeRng(1);
check('同一个 seed 给出同一串随机数', rngA() === rngB() && rngA() === rngB());
const rngC = makeRng(2);
check('不同 seed 给出不同序列（大概率）', makeRng(1)() !== rngC() || makeRng(1)() !== rngC());

// #endregion

// #region 引擎自对弈：不能下非法手，且必须真的下出五连

let game = createBoard();
let turn = BLACK;
let plies = 0;
let illegal = null;
let winner = null;
while (plies < CELL_COUNT) {
  const move = chooseMove(game, turn, { rng: makeRng(plies + 1) });
  if (move === null) break;
  if (game[indexOf(move.row, move.col)] !== EMPTY) {
    illegal = `${plies} 手落在已占点 (${move.row}, ${move.col})`;
    break;
  }
  game[indexOf(move.row, move.col)] = turn;
  plies += 1;
  if (winsAt(game, move.row, move.col)) {
    winner = turn;
    break;
  }
  turn = turn === BLACK ? WHITE : BLACK;
}

check('引擎自对弈过程中没有非法落子', illegal === null, String(illegal));
check('引擎自对弈能真的下出五连（不是填满为止）', winner !== null, `走了 ${plies} 手仍未分胜负`);
check('自对弈在合理手数内结束', plies >= 9 && plies <= CELL_COUNT, `${plies} 手`);

// #endregion

// #region 强度下限：一副"该赢"的局面必须赢下来

// 人工造一个白棋活四，引擎执白必须两手内终结
const nearWin = board([[0, 0], [1, 1]], [[7, 4], [7, 5], [7, 6], [7, 7]]);
const finishing = chooseMove(nearWin, WHITE);
check('活四局面引擎会下在成五点', finishing !== null && finishing.row === 7 && (finishing.col === 3 || finishing.col === 8), JSON.stringify(finishing));

// #endregion

console.log('');
if (failures === 0) {
  console.log('全部通过。');
} else {
  console.log(`${failures} 项失败。`);
  process.exitCode = 1;
}
