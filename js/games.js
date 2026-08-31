// Game engines. Pure logic -- no DOM, no fetch, nothing to render.
//
// Kept separate from the UI for the same reason the Python reference is:
// the interesting properties are provable, and they are only provable if the
// engine can run headless. `proveUnwinnable()` at the bottom is the reason.
//
// NOTE ON FLAGS: these games carry none, and cannot. For the page to say
// "hit", the page must know where the ships are -- so the layout is in the
// bundle, and anyone who reads it wins without playing. Tic-tac-toe is worse:
// it is a solved game, so a drawn final position can be computed by anyone in
// seconds. A static page can only gate a flag on work the player does that the
// page does not already contain, which is what the uplink challenge does. So
// these are the reward for solving that, not a second lock.

// =============================================================================
// Tic-tac-toe
// =============================================================================
//
// WOPR plays perfect minimax, so the player cannot win. Draw or decline; both
// end the game, and one of them is the point.

export const EMPTY = " ";
export const PLAYER = "X";
export const SERVER = "O";

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

export function winner(board) {
  for (const [a, b, c] of LINES) {
    if (board[a] !== EMPTY && board[a] === board[b] && board[b] === board[c]) {
      return board[a];
    }
  }
  return board.includes(EMPTY) ? null : "D";
}

const memo = new Map();

function minimax(board, turn) {
  const key = board.join("") + turn;
  const hit = memo.get(key);
  if (hit) return hit;

  const result = winner(board);
  if (result !== null) {
    const score = { [SERVER]: 1, [PLAYER]: -1, D: 0 }[result];
    const out = [score, null];
    memo.set(key, out);
    return out;
  }

  let bestScore = null;
  let bestMove = null;
  for (let i = 0; i < 9; i++) {
    if (board[i] !== EMPTY) continue;
    board[i] = turn;
    const [score] = minimax(board, turn === SERVER ? PLAYER : SERVER);
    board[i] = EMPTY;
    const better =
      bestScore === null ||
      (turn === SERVER && score > bestScore) ||
      (turn === PLAYER && score < bestScore);
    if (better) {
      bestScore = score;
      bestMove = i;
    }
  }
  const out = [bestScore, bestMove];
  memo.set(key, out);
  return out;
}

export function serverMove(board) {
  return minimax([...board], SERVER)[1];
}

export class TicTacToe {
  constructor() {
    this.board = Array(9).fill(EMPTY);
    this.finished = false;
    this.outcome = null; // "D", "O", or "declined"
  }

  play(index) {
    if (this.finished) return { ok: false, error: "game over" };
    if (index < 0 || index > 8 || this.board[index] !== EMPTY) {
      return { ok: false, error: "that square is taken" };
    }
    this.board[index] = PLAYER;

    let reply = null;
    if (winner(this.board) === null) {
      reply = serverMove(this.board);
      this.board[reply] = SERVER;
    }
    const result = winner(this.board);
    if (result !== null) {
      this.finished = true;
      this.outcome = result;
    }
    return { ok: true, serverMove: reply, result };
  }

  decline() {
    if (this.finished) return { ok: false, error: "game over" };
    this.finished = true;
    this.outcome = "declined";
    return { ok: true, result: "declined" };
  }
}

// Exhaustively walk every legal player strategy against serverMove() and
// report what outcomes exist. An assertion in a comment is not a proof.
export function proveUnwinnable() {
  const outcomes = { X: 0, O: 0, D: 0 };
  const board = Array(9).fill(EMPTY);

  function walk() {
    const result = winner(board);
    if (result !== null) {
      outcomes[result]++;
      return;
    }
    for (let i = 0; i < 9; i++) {
      if (board[i] !== EMPTY) continue;
      board[i] = PLAYER;
      if (winner(board) === null) {
        const m = serverMove(board);
        board[m] = SERVER;
        walk();
        board[m] = EMPTY;
      } else {
        walk();
      }
      board[i] = EMPTY;
    }
  }
  walk();
  return outcomes;
}

// =============================================================================
// Battleship on a time-frequency grid
// =============================================================================
//
// Columns are time slots, rows are frequency channels, so the board and a
// waterfall are the same object. Salvo fire and a proximity leak on misses
// keep the round-trip count sane: blind 8x8 Battleship takes about 40 shots.

// One LTE resource block, normal cyclic prefix: 12 subcarriers by 7 OFDM
// symbols. Not an arbitrary 8x8 -- if the board is a time-frequency grid then
// it should be a real one, and an LTE RB is the rare standard whose basic unit
// IS a small 2D block. Cells are resource elements, addressed (k, l) as in the
// spec: k the subcarrier, l the symbol.
export const COLS = 7;    // l -- OFDM symbols in a slot
export const ROWS = 12;   // k -- subcarriers in a resource block
export const SHIPS = [
  ["carrier", 5], ["battleship", 4], ["cruiser", 3], ["submarine", 3], ["destroyer", 2],
];
export const SALVO = 4;

// cyrb128 + sfc32: a small, fast, well-distributed seeded PRNG. Deliberately
// NOT Math.random() -- placement must be reproducible from the callsign so a
// reload does not silently reshuffle a game in progress.
function seedFrom(str) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  return [
    (h1 ^ h2 ^ h3 ^ h4) >>> 0,
    (h2 ^ h1) >>> 0,
    (h3 ^ h1) >>> 0,
    (h4 ^ h1) >>> 0,
  ];
}

function sfc32([a, b, c, d]) {
  return function () {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export function placeShips(callsign, cols = COLS, rows = ROWS, ships = SHIPS) {
  const rnd = sfc32(seedFrom(`wargames:${callsign}`));
  const taken = new Set();
  const fleet = {};
  for (const [name, length] of ships) {
    let placed = false;
    for (let attempt = 0; attempt < 1000 && !placed; attempt++) {
      const horizontal = rnd() < 0.5;
      const cells = [];
      if (horizontal) {
        const c = Math.floor(rnd() * (cols - length + 1));
        const r = Math.floor(rnd() * rows);
        for (let i = 0; i < length; i++) cells.push([c + i, r]);
      } else {
        const c = Math.floor(rnd() * cols);
        const r = Math.floor(rnd() * (rows - length + 1));
        for (let i = 0; i < length; i++) cells.push([c, r + i]);
      }
      if (cells.every(([c, r]) => !taken.has(`${c},${r}`))) {
        cells.forEach(([c, r]) => taken.add(`${c},${r}`));
        fleet[name] = { cells, length };
        placed = true;
      }
    }
    if (!placed) throw new Error(`could not place ${name}`);
  }
  return fleet;
}

export class Battleship {
  constructor(callsign, { cols = COLS, rows = ROWS, salvo = SALVO, leak = true } = {}) {
    this.cols = cols;
    this.rows = rows;
    this.salvo = salvo;
    this.leak = leak;
    this.fleet = placeShips(callsign, cols, rows);
    this.shipAt = new Map();
    for (const [name, ship] of Object.entries(this.fleet)) {
      for (const [c, r] of ship.cells) this.shipAt.set(`${c},${r}`, name);
    }
    this.hits = new Set();
    this.misses = new Set();
    this.sunk = new Set();
    this.shots = 0;
    this.finished = false;
  }

  // Ship cells among the eight neighbours. This leak is what shortens the game
  // from ~40 shots to something playable over a slow link.
  proximity(c, r) {
    let n = 0;
    for (let dc = -1; dc <= 1; dc++) {
      for (let dr = -1; dr <= 1; dr++) {
        if (dc === 0 && dr === 0) continue;
        if (this.shipAt.has(`${c + dc},${r + dr}`)) n++;
      }
    }
    return n;
  }

  fire(cells) {
    if (this.finished) return { ok: false, error: "all contacts destroyed" };
    if (cells.length > this.salvo) {
      return { ok: false, error: `${cells.length} shots, salvo is ${this.salvo}` };
    }
    const results = [];
    for (const [c, r] of cells) {
      const k = `${c},${r}`;
      if (this.hits.has(k) || this.misses.has(k)) {
        results.push({ c, r, outcome: "repeat" });
        continue;
      }
      this.shots++;
      if (this.shipAt.has(k)) {
        this.hits.add(k);
        const name = this.shipAt.get(k);
        const entry = { c, r, outcome: "hit" };
        if (this.fleet[name].cells.every(([x, y]) => this.hits.has(`${x},${y}`))) {
          this.sunk.add(name);
          entry.outcome = "sunk";
          entry.ship = name;
        }
        results.push(entry);
      } else {
        this.misses.add(k);
        const entry = { c, r, outcome: "miss" };
        if (this.leak) entry.proximity = this.proximity(c, r);
        results.push(entry);
      }
    }
    if (this.sunk.size === Object.keys(this.fleet).length) this.finished = true;
    return {
      ok: true,
      results,
      shots: this.shots,
      remaining: Object.keys(this.fleet).length - this.sunk.size,
      finished: this.finished,
    };
  }
}
