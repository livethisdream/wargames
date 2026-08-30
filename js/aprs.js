// AX.25 / APRS demodulator. Receive only, on purpose.
//
// This page never builds a frame for the player. Synthesising the signal is
// the whole challenge; a "generate my packet" button here would delete it.
// So: demodulate and display, never modulate.
//
// Ported from sigid/aprs.py + sigid/modem.py in the challenge repo, and
// checked against them sample-for-sample rather than by eye.
//
// Bell 202: 1200 Hz mark / 2200 Hz space, keyed at 1200 baud, frequency
// modulating a narrowband FM carrier. NRZI line coding, so a data 0 flips the
// tone and a 1 holds it -- which makes the link immune to tone-pair inversion
// and is why nothing here ever guesses a polarity. HDLC framing with 0x7E
// flags, a stuffed 0 after every five consecutive 1s, bits least-significant
// first, and a CRC-16/X.25 frame check sequence sent little-endian.

export const BAUD = 1200;
export const MARK_HZ = 1200.0;
export const SPACE_HZ = 2200.0;
const FLAG = 0x7e;
const CONTROL_UI = 0x03;
const PID_NO_L3 = 0xf0;
const MIN_FRAME = 18;
const FLAG_BITS = Array.from({ length: 8 }, (_, i) => (FLAG >> i) & 1);

// --- filters -----------------------------------------------------------------

function sinc(x) {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

// scipy.signal.firwin(numtaps, cutoff, fs=fs) with the default Hamming window
// and scale=True: a windowed sinc normalised to unity gain at DC.
export function firwin(numtaps, cutoff, fs) {
  const w = cutoff / (fs / 2); // cutoff normalised to Nyquist
  const alpha = 0.5 * (numtaps - 1);
  const h = new Float64Array(numtaps);
  let sum = 0;
  for (let n = 0; n < numtaps; n++) {
    const m = n - alpha;
    const win = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (numtaps - 1));
    h[n] = w * sinc(w * m) * win;
    sum += h[n];
  }
  for (let n = 0; n < numtaps; n++) h[n] /= sum;
  return h;
}

// Causal FIR, same length as the input -- matching scipy's lfilter, group
// delay and all. The delay is identical on both discriminator arms, so it
// cancels in their difference, and the timing-phase sweep absorbs the rest.
function lfilter(h, x) {
  const n = x.length;
  const m = h.length;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    const kmax = m < i + 1 ? m : i + 1;
    for (let k = 0; k < kmax; k++) acc += h[k] * x[i - k];
    y[i] = acc;
  }
  return y;
}

// --- demodulation ------------------------------------------------------------

// Quadrature discriminator -> instantaneous frequency in radians/sample.
export function fmDemod(re, im) {
  const n = re.length - 1;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // angle(x[i+1] * conj(x[i]))
    const pr = re[i + 1] * re[i] + im[i + 1] * im[i];
    const pi = im[i + 1] * re[i] - re[i + 1] * im[i];
    out[i] = Math.atan2(pi, pr);
  }
  return out;
}

// Correlate against each tone and compare envelopes. The low-pass corner sits
// below the tone spacing, so each arm rejects the other tone while still
// passing 1200 baud keying.
export function afskDiscriminate(audio, fs, baud = BAUD) {
  const h = firwin(255, 0.6 * baud, fs);
  const envelope = (f) => {
    const n = audio.length;
    const zr = new Float64Array(n);
    const zi = new Float64Array(n);
    const k = (-2 * Math.PI * f) / fs;
    for (let i = 0; i < n; i++) {
      const a = k * i;
      zr[i] = audio[i] * Math.cos(a);
      zi[i] = audio[i] * Math.sin(a);
    }
    const fr = lfilter(h, zr);
    const fi = lfilter(h, zi);
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.hypot(fr[i], fi[i]);
    return out;
  };
  const mark = envelope(MARK_HZ);
  const space = envelope(SPACE_HZ);
  const d = new Float64Array(audio.length);
  for (let i = 0; i < d.length; i++) d[i] = mark[i] - space[i];
  return d;
}

// Integrate over each symbol period -> one soft value per symbol. A running
// sum makes every candidate timing phase a single cheap pass.
export function softSymbols(x, fs, symrate, phaseFrac = 0) {
  const sps = fs / symrate;
  const nsym = Math.floor(x.length / sps) - 1;
  if (nsym < 1) return new Float64Array(0);
  const csum = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) csum[i + 1] = csum[i] + x[i];
  const edges = [];
  for (let i = 0; i <= nsym; i++) {
    const e = Math.floor(i * sps + phaseFrac * sps);
    if (e < csum.length) edges.push(e);
  }
  if (edges.length < 2) return new Float64Array(0);
  const out = new Float64Array(edges.length - 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = (csum[edges[i + 1]] - csum[edges[i]]) / sps;
  }
  return out;
}

// A data 0 flips the line, a 1 holds it. One bit shorter than its input: the
// first level has no predecessor and carries no data by itself.
export function nrziDecode(levels) {
  const out = new Int8Array(levels.length - 1);
  for (let i = 1; i < levels.length; i++) {
    out[i - 1] = levels[i] === levels[i - 1] ? 1 : 0;
  }
  return out;
}

function findSync(bits, pattern) {
  const hits = [];
  const n = bits.length - pattern.length;
  outer: for (let i = 0; i <= n; i++) {
    for (let k = 0; k < pattern.length; k++) {
      if (bits[i + k] !== pattern[k]) continue outer;
    }
    hits.push(i);
  }
  return hits;
}

// Remove the stuffed 0 that follows every five consecutive 1s.
function destuff(bits) {
  const out = [];
  let ones = 0;
  let i = 0;
  while (i < bits.length) {
    if (ones === 5) {
      ones = 0; // this bit is the stuffed 0; drop it
      i += 1;
      continue;
    }
    const b = bits[i];
    out.push(b);
    ones = b ? ones + 1 : 0;
    i += 1;
  }
  return out;
}

function bitsToBytes(bits) {
  const out = [];
  for (let i = 0; i + 7 < bits.length; i += 8) {
    let v = 0;
    for (let k = 0; k < 8; k++) v |= bits[i + k] << k;
    out.push(v);
  }
  return Uint8Array.from(out);
}

// CRC-16/X.25: reflected 0x1021, init 0xFFFF, output complemented.
export function fcs(data) {
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
    }
  }
  return (crc ^ 0xffff) & 0xffff;
}

function decodeAddress(b7) {
  let call = "";
  for (let i = 0; i < 6; i++) call += String.fromCharCode(b7[i] >> 1);
  return {
    call: call.trimEnd(),
    ssid: (b7[6] >> 1) & 0x0f,
    last: (b7[6] & 1) === 1,
  };
}

// UI frame -> object, or null if the FCS or the structure does not hold.
export function parseFrame(frame) {
  if (frame.length < MIN_FRAME) return null;
  const body = frame.subarray(0, frame.length - 2);
  const check = frame[frame.length - 2] | (frame[frame.length - 1] << 8);
  if (fcs(body) !== check) return null;

  // Addresses run until one has its extension bit set. Ten is well past any
  // legal digipeater path and stops a corrupt frame walking into the body.
  const addrs = [];
  let i = 0;
  for (;;) {
    if (body.length - i < 7 || addrs.length >= 10) return null;
    const a = decodeAddress(body.subarray(i, i + 7));
    addrs.push(a);
    i += 7;
    if (a.last) break;
  }
  if (addrs.length < 2) return null;

  const n = addrs.length * 7;
  if (body.length < n + 2 || body[n] !== CONTROL_UI || body[n + 1] !== PID_NO_L3) {
    return null;
  }
  let info = "";
  for (let k = n + 2; k < body.length; k++) info += String.fromCharCode(body[k]);
  return {
    dest: [addrs[0].call, addrs[0].ssid],
    src: [addrs[1].call, addrs[1].ssid],
    path: addrs.slice(2).map((a) => [a.call, a.ssid]),
    info,
    bytes: frame,
  };
}

function decodeBits(bits) {
  const flags = findSync(bits, FLAG_BITS);
  const frames = [];
  for (let i = 0; i + 1 < flags.length; i++) {
    const a = flags[i];
    const z = flags[i + 1];
    if (z - a <= 8) continue; // back-to-back flags: no payload
    const f = parseFrame(bitsToBytes(destuff(Array.from(bits.subarray(a + 8, z)))));
    if (f) frames.push(f);
  }
  return frames;
}

// Interleaved complex float32 -> list of UI frames.
//
// No polarity sweep: NRZI is differential, so an inverted tone assignment
// decodes identically. Only the symbol timing phase is unknown, and a frame is
// accepted only on a passing FCS, so a wrong phase cannot manufacture one.
export function demodulate(interleaved, fs, baud = BAUD, phases = 16) {
  const n = Math.floor(interleaved.length / 2);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    re[i] = interleaved[2 * i];
    im[i] = interleaved[2 * i + 1];
  }
  const audio = fmDemod(re, im);
  const d = afskDiscriminate(audio, fs, baud);
  for (let p = 0; p < phases; p++) {
    const s = softSymbols(d, fs, baud, p / phases);
    if (s.length < 64) continue;
    const levels = new Int8Array(s.length);
    for (let i = 0; i < s.length; i++) levels[i] = s[i] > 0 ? 1 : 0;
    const frames = decodeBits(nrziDecode(levels));
    if (frames.length) return frames;
  }
  return [];
}
