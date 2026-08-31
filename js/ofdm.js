// OFDM resource grid -- demodulator only.
//
// Receive-only on purpose, exactly like the APRS chain: this page will not
// build a slot for you. Generating the signal is the challenge, and there is
// deliberately no code here that could be turned into a modulator.
//
// LTE 1.4 MHz numerology, which is the smallest authentic configuration and is
// exactly one resource block wide:
//
//   sample rate  1.92 MSps  = 128 x 15 kHz
//   FFT          128
//   subcarriers  12 used at 15 kHz spacing, DC left empty
//   symbols      7 per slot, normal cyclic prefix
//   CP           10 samples on symbol 0, 9 on symbols 1-6
//
// 10 + 128 + 6 x (9 + 128) = 960 samples = 0.5 ms exactly, which is the slot
// LTE specifies. The awkward numbers are the correct ones.
//
// Occupancy is the message: a shot is energy on a resource element.

export const RATE = 1_920_000;
export const NFFT = 128;
export const N_SC = 12;   // k -- subcarriers in a resource block
export const N_SYM = 7;   // OFDM symbols in a slot
// Symbol 0 is a SYNC symbol: all 12 subcarriers energised, always, and not part
// of the board. Timing recovery does not work without it -- a sparsely occupied
// grid can leave the early symbols silent, energy onset then locks onto
// whichever symbol carries the first shot, and CP correlation peaks identically
// at every symbol boundary so it cannot break the tie. The slot reads several
// symbols late. LTE carries sync and reference signals for exactly this reason.
export const SYNC_SYM = 0;
export const N_SHOT_SYM = N_SYM - 1;   // the board's l axis: symbols 1-6
const CP_FIRST = 10;
const CP_REST = 9;
export const SLOT_SAMPLES = CP_FIRST + NFFT + (N_SYM - 1) * (CP_REST + NFFT);

// Six subcarriers either side of DC. DC itself is unused, as LTE leaves it.
const SC_BINS = [-6, -5, -4, -3, -2, -1, 1, 2, 3, 4, 5, 6];
const binIndex = (off) => ((off % NFFT) + NFFT) % NFFT;
const cpLen = (l) => (l === 0 ? CP_FIRST : CP_REST);

// --- FFT ---------------------------------------------------------------------
// Iterative radix-2 Cooley-Tukey, in place. 128 points, so the tables are tiny
// and precomputing them once keeps the per-symbol cost negligible.

const REV = new Uint8Array(NFFT);
for (let i = 0; i < NFFT; i++) {
  let r = 0;
  for (let b = 0; b < Math.log2(NFFT); b++) if (i & (1 << b)) r |= 1 << (Math.log2(NFFT) - 1 - b);
  REV[i] = r;
}
const COS = new Float64Array(NFFT / 2);
const SIN = new Float64Array(NFFT / 2);
for (let i = 0; i < NFFT / 2; i++) {
  COS[i] = Math.cos((-2 * Math.PI * i) / NFFT);
  SIN[i] = Math.sin((-2 * Math.PI * i) / NFFT);
}

function fft(re, im) {
  for (let i = 0; i < NFFT; i++) {
    const j = REV[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= NFFT; size <<= 1) {
    const half = size >> 1;
    const step = NFFT / size;
    for (let i = 0; i < NFFT; i += size) {
      for (let j = i, k = 0; j < i + half; j++, k += step) {
        const c = COS[k], s = SIN[k];
        const tr = re[j + half] * c - im[j + half] * s;
        const ti = re[j + half] * s + im[j + half] * c;
        re[j + half] = re[j] - tr;
        im[j + half] = im[j] - ti;
        re[j] += tr;
        im[j] += ti;
      }
    }
  }
}

// --- timing ------------------------------------------------------------------

// Correlate each cyclic prefix against the symbol tail it copies. NOT a
// used-versus-unused energy ratio: shifting the window anywhere inside the CP
// leaves that ratio identical, because preserving it is what a CP is for. The
// Python reference made that mistake first and read the grid a symbol late.
function cpScore(re, im, start) {
  let total = 0;
  let pos = start;
  for (let l = 0; l < N_SYM; l++) {
    const cp = cpLen(l);
    if (pos + cp + NFFT > re.length) return -1;
    let ar = 0, ai = 0;
    for (let i = 0; i < cp; i++) {
      const a = pos + NFFT + i, b = pos + i;
      ar += re[a] * re[b] + im[a] * im[b];
      ai += im[a] * re[b] - re[a] * im[b];
    }
    total += Math.hypot(ar, ai);
    pos += cp + NFFT;
  }
  return total;
}

export function findSlot(re, im, search = 48) {
  const n = re.length;
  if (n < SLOT_SAMPLES) throw new Error(`need ${SLOT_SAMPLES} samples, got ${n}`);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const p = re[i] * re[i] + im[i] * im[i];
    if (p > peak) peak = p;
  }
  if (peak <= 0) throw new Error("no energy in the capture");
  let coarse = 0;
  for (let i = 0; i < n; i++) {
    if (re[i] * re[i] + im[i] * im[i] > 0.05 * peak) { coarse = i; break; }
  }
  const lo = Math.max(0, coarse - search);
  const hi = Math.min(n - SLOT_SAMPLES, coarse + search);
  if (hi <= lo) return Math.max(0, Math.min(coarse, n - SLOT_SAMPLES));
  let best = lo, bestScore = -Infinity;
  for (let s = lo; s <= hi; s++) {
    const sc = cpScore(re, im, s);
    if (sc > bestScore) { bestScore = sc; best = s; }
  }
  return best;
}

// --- demodulation ------------------------------------------------------------

/** Interleaved complex float32 -> { cells, mags, start, syncSeen }.
 *  `cells` is a Set of "l,k" in BOARD coordinates (l 0-5, k 0-11). */
// Carrier frequency offset in cycles/sample, from the phase of the same CP
// correlation timing already needs. A frequency offset rotates the prefix
// against the tail it copies: angle(r) = 2*pi * df * NFFT / fs. Only the phase
// was being discarded. Good to half a subcarrier spacing; past that the phase
// wraps and neighbouring subcarriers have merged anyway.
function estimateCfo(re, im, start) {
  let ar = 0, ai = 0;
  let pos = start;
  for (let l = 0; l < N_SYM; l++) {
    const cp = cpLen(l);
    if (pos + cp + NFFT > re.length) break;
    for (let i = 0; i < cp; i++) {
      const a = pos + NFFT + i, b = pos + i;
      ar += re[a] * re[b] + im[a] * im[b];
      ai += im[a] * re[b] - re[a] * im[b];
    }
    pos += cp + NFFT;
  }
  return Math.atan2(ai, ar) / (2 * Math.PI * NFFT);
}

export function demodulate(interleaved, start) {
  const n = Math.floor(interleaved.length / 2);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    re[i] = interleaved[2 * i];
    im[i] = interleaved[2 * i + 1];
  }
  if (start === undefined) start = findSlot(re, im);

  const df = estimateCfo(re, im, start);
  if (df !== 0) {
    for (let i = 0; i < n; i++) {
      const a = -2 * Math.PI * df * i;
      const c = Math.cos(a), s2 = Math.sin(a);
      const r = re[i] * c - im[i] * s2;
      im[i] = re[i] * s2 + im[i] * c;
      re[i] = r;
    }
  }

  const used = new Set(SC_BINS.map(binIndex));
  used.add(0);
  const mags = [];
  const noise = [];
  let pos = start;
  for (let l = 0; l < N_SYM; l++) {
    pos += cpLen(l);
    const br = new Float64Array(NFFT);
    const bi = new Float64Array(NFFT);
    for (let i = 0; i < NFFT; i++) { br[i] = re[pos + i]; bi[i] = im[pos + i]; }
    pos += NFFT;
    fft(br, bi);
    const row = new Float64Array(N_SC);
    for (let k = 0; k < N_SC; k++) {
      const b = binIndex(SC_BINS[k]);
      row[k] = Math.hypot(br[b], bi[b]) / NFFT;
    }
    mags.push(row);
    for (let b = 0; b < NFFT; b++) {
      if (!used.has(b)) noise.push(Math.hypot(br[b], bi[b]) / NFFT);
    }
  }

  noise.sort((a, b) => a - b);
  const floor = noise.length ? noise[Math.floor(noise.length / 2)] : 0;
  let peak = 0;
  for (const row of mags) for (const v of row) if (v > peak) peak = v;
  // Two-sided. The floor alone misreads a silent grid; the peak alone misreads
  // one with a single occupied element.
  const threshold = Math.max(8 * floor, 0.35 * peak);

  let syncSeen = 0;
  for (let k = 0; k < N_SC; k++) if (mags[SYNC_SYM][k] > threshold) syncSeen++;

  // Board coordinates: symbol 0 is sync and is never a shot.
  const cells = new Set();
  for (let l = 1; l < N_SYM; l++) {
    for (let k = 0; k < N_SC; k++) {
      if (mags[l][k] > threshold) cells.add(`${l - 1},${k}`);
    }
  }
  return { cells, mags, start, syncSeen };
}
