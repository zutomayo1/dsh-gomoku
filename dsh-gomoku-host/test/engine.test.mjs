/**
 * 规则内核单元测试（针对内核源码 src/engine.js）。
 *
 * 内核是唯一"必须正确"的一层，因此这里覆盖边界与不变量：
 * 越界/占用点/非法颜色、四方向取胜、长连、以及"胜负必须由最后一步造成"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BLACK,
  BOARD_SIZE,
  CELL_COUNT,
  EMPTY,
  TENGEN,
  WHITE,
  boardText,
  candidateMoves,
  cellAt,
  colorFromName,
  countStones,
  createBoard,
  indexOf,
  isInside,
  isLegalMove,
  isValidBoard,
  nameFromColor,
  placeStone,
  prettyBoard,
  winningLineAt,
  winsAt,
} from '../src/engine.js';

/**
 * 在空盘上按顺序落子。
 * @param {Array<[number, number, number]>} moves - [row, col, color] 列表。
 * @returns {number[]} 最终棋盘。
 */
function boardWith(moves) {
  let board = createBoard();
  for (const [row, col, color] of moves) {
    const next = placeStone(board, row, col, color);
    assert.notEqual(next, null, `脚手架落子失败: ${row},${col}`);
    board = next;
  }
  return board;
}

test('棋盘尺寸与常量自洽', () => {
  assert.equal(BOARD_SIZE, 15);
  assert.equal(CELL_COUNT, 225);
  assert.equal(createBoard().length, CELL_COUNT);
  assert.equal(TENGEN.row, 7);
  assert.equal(indexOf(7, 7), 112);
});

test('isInside 拒绝越界、非整数与错误类型', () => {
  assert.equal(isInside(0, 0), true);
  assert.equal(isInside(14, 14), true);
  assert.equal(isInside(-1, 0), false);
  assert.equal(isInside(0, 15), false);
  assert.equal(isInside(1.5, 0), false);
  assert.equal(isInside(NaN, 0), false);
  assert.equal(isInside('3', 0), false);
  assert.equal(isInside(null, 0), false);
});

test('isValidBoard 挡掉结构非法的棋盘', () => {
  assert.equal(isValidBoard(createBoard()), true);
  assert.equal(isValidBoard([]), false);
  assert.equal(isValidBoard(new Array(CELL_COUNT).fill(9)), false);
  assert.equal(isValidBoard(new Array(CELL_COUNT).fill('0')), false);
  assert.equal(isValidBoard(null), false);
});

test('placeStone 不改入参且返回新数组', () => {
  const empty = createBoard();
  const next = placeStone(empty, 7, 7, BLACK);
  assert.notEqual(next, empty);
  assert.equal(empty[indexOf(7, 7)], EMPTY);
});

test('placeStone 拒绝越界、占用点与非法颜色', () => {
  const empty = createBoard();
  assert.equal(placeStone(empty, 15, 0, BLACK), null);
  assert.equal(placeStone(empty, -1, 0, BLACK), null);
  assert.equal(placeStone(empty, 0, 0, 7), null);
  const one = placeStone(empty, 0, 0, BLACK);
  assert.equal(placeStone(one, 0, 0, WHITE), null, '占用点不可再落子');
});

test('winsAt 识别四个方向的五连', () => {
  const horizontal = boardWith([
    [7, 3, BLACK], [0, 0, WHITE],
    [7, 4, BLACK], [0, 1, WHITE],
    [7, 5, BLACK], [0, 2, WHITE],
    [7, 6, BLACK], [0, 3, WHITE],
    [7, 7, BLACK],
  ]);
  assert.equal(winsAt(horizontal, 7, 7), true);
  assert.equal(winsAt(horizontal, 7, 3), true, '连线上任意一子都判胜');

  const vertical = boardWith([
    [2, 9, BLACK], [0, 0, WHITE],
    [3, 9, BLACK], [0, 1, WHITE],
    [4, 9, BLACK], [0, 2, WHITE],
    [5, 9, BLACK], [0, 3, WHITE],
    [6, 9, BLACK],
  ]);
  assert.equal(winsAt(vertical, 6, 9), true);

  const down = boardWith([
    [1, 1, BLACK], [0, 0, WHITE],
    [2, 2, BLACK], [0, 1, WHITE],
    [3, 3, BLACK], [0, 2, WHITE],
    [4, 4, BLACK], [0, 3, WHITE],
    [5, 5, BLACK],
  ]);
  assert.equal(winsAt(down, 5, 5), true);

  const up = boardWith([
    [10, 4, BLACK], [0, 0, WHITE],
    [9, 5, BLACK], [0, 1, WHITE],
    [8, 6, BLACK], [0, 2, WHITE],
    [7, 7, BLACK], [0, 3, WHITE],
    [6, 8, BLACK],
  ]);
  assert.equal(winsAt(up, 6, 8), true);
});

test('四连不算胜利，长连算胜利', () => {
  const four = boardWith([
    [7, 3, BLACK], [0, 0, WHITE],
    [7, 4, BLACK], [0, 1, WHITE],
    [7, 5, BLACK], [0, 2, WHITE],
    [7, 6, BLACK],
  ]);
  assert.equal(winsAt(four, 7, 6), false);

  const six = boardWith([
    [7, 2, BLACK], [0, 0, WHITE],
    [7, 3, BLACK], [0, 1, WHITE],
    [7, 4, BLACK], [0, 2, WHITE],
    [7, 5, BLACK], [0, 3, WHITE],
    [7, 6, BLACK], [0, 4, WHITE],
    [7, 7, BLACK],
  ]);
  assert.equal(winsAt(six, 7, 4), true);
});

test('胜负必须由最后一步造成：五连已存在时，无关落子不得判胜', () => {
  const board = boardWith([
    [7, 3, BLACK], [0, 0, WHITE],
    [7, 4, BLACK], [0, 1, WHITE],
    [7, 5, BLACK], [0, 2, WHITE],
    [7, 6, BLACK], [0, 3, WHITE],
    [7, 7, BLACK], // 黑成五连（白在 0 行只有四子，未胜）
    [14, 14, WHITE],
  ]);
  assert.equal(winsAt(board, 7, 7), true, '黑那条五连成立');
  assert.equal(winsAt(board, 14, 14), false, '白最后一步与黑线无关，不是白胜');
});

test('winningLineAt 返回完整五连', () => {
  const board = boardWith([
    [7, 3, BLACK], [0, 0, WHITE],
    [7, 4, BLACK], [0, 1, WHITE],
    [7, 5, BLACK], [0, 2, WHITE],
    [7, 6, BLACK], [0, 3, WHITE],
    [7, 7, BLACK],
  ]);
  assert.deepEqual(winningLineAt(board, 7, 5), [
    { row: 7, col: 3 },
    { row: 7, col: 4 },
    { row: 7, col: 5 },
    { row: 7, col: 6 },
    { row: 7, col: 7 },
  ]);
  assert.deepEqual(winningLineAt(boardWith([[7, 7, BLACK]]), 7, 7), []);
});

test('非法输入下安全退化', () => {
  assert.equal(winsAt(null, 7, 7), false);
  assert.equal(cellAt(null, 7, 7), EMPTY);
  assert.equal(isLegalMove(null, 7, 7), false);
  assert.deepEqual(candidateMoves(null), []);
  assert.deepEqual(countStones(null), { black: 0, white: 0, empty: 0 });
});

test('countStones 计数正确', () => {
  const board = boardWith([
    [7, 7, BLACK],
    [7, 8, WHITE],
    [8, 8, BLACK],
  ]);
  assert.deepEqual(countStones(board), { black: 2, white: 1, empty: CELL_COUNT - 3 });
});

test('颜色名与棋子取值双向转换', () => {
  assert.equal(colorFromName('black'), BLACK);
  assert.equal(colorFromName('WHITE'), WHITE);
  assert.equal(colorFromName(' 白 '), WHITE);
  assert.equal(colorFromName('red'), null);
  assert.equal(colorFromName(null), null);
  assert.equal(nameFromColor(BLACK), 'black');
  assert.equal(nameFromColor(EMPTY), null);
});

test('candidateMoves 按离天元距离排序且不含已占点', () => {
  const board = boardWith([[TENGEN.row, TENGEN.col, BLACK]]);
  const candidates = candidateMoves(board);
  assert.equal(candidates.length, CELL_COUNT - 1);
  assert.equal(candidates[0].distance, 1);
  assert.equal(candidates.some((m) => m.row === 7 && m.col === 7), false);
  for (let i = 1; i < candidates.length; i += 1) {
    assert.ok(candidates[i - 1].distance <= candidates[i].distance, '必须按距离非递减');
  }
});

test('boardText 的列号与棋子逐列严格对齐', () => {
  // 实测踩过的坑：表头与棋子列错位会让模型把子下到隔壁列。
  const board = boardWith([
    [0, 0, BLACK],
    [0, 14, WHITE],
    [7, 3, WHITE],
    [14, 7, BLACK],
  ]);
  const lines = boardText(board).split('\n');

  /** 把一行拆成非空格 token。 */
  const tokens = (line) => {
    const out = [];
    let i = 0;
    while (i < line.length) {
      if (line[i] === ' ') {
        i += 1;
        continue;
      }
      let j = i;
      while (j < line.length && line[j] !== ' ') j += 1;
      out.push({ text: line.slice(i, j), end: j - 1 });
      i = j;
    }
    return out;
  };

  const header = tokens(lines[0]);
  assert.equal(header.length, BOARD_SIZE);
  for (let c = 0; c < BOARD_SIZE; c += 1) {
    assert.equal(Number(header[c].text), c, `第 ${c} 个表头 token 应是列号 ${c}`);
  }

  const cellAtText = (row, col) => lines[row + 1][header[col].end];
  assert.equal(cellAtText(0, 0), 'B');
  assert.equal(cellAtText(0, 14), 'W');
  assert.equal(cellAtText(7, 3), 'W');
  assert.equal(cellAtText(14, 7), 'B');
  assert.equal(cellAtText(5, 5), '·');

  for (let r = 0; r < BOARD_SIZE; r += 1) {
    assert.equal(Number(lines[r + 1].slice(0, 2).trim()), r, `第 ${r} 行行号应为 ${r}`);
  }
});

test('boardText / prettyBoard 行数正确且对非法棋盘抛错', () => {
  assert.equal(boardText(createBoard()).split('\n').length, BOARD_SIZE + 1);
  assert.equal(prettyBoard(createBoard()).split('\n').length, BOARD_SIZE + 1);
  assert.throws(() => boardText([]), TypeError);
  assert.throws(() => prettyBoard(null), TypeError);
});
