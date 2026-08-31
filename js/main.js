import { demodulate as demodAprs } from "./aprs.js";
import { demodulate as demodOfdm, N_SC, N_SHOT_SYM } from "./ofdm.js";
import { TicTacToe, Battleship, parseCell, EMPTY, SALVO, COLS, ROWS } from "./games.js";

const YEAR = "2026";
const out = document.getElementById("out");
const rateEl = document.getElementById("rate");

const say = (html, cls = "") => { out.className = cls; out.innerHTML = html; };
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// Everything is driven by uploaded signal. Nothing here is clickable except a
// local reset -- you play by transmitting, which is the whole point of the
// challenge and the reason the page has no modulator in it.
let stage = "uplink";          // uplink -> tictactoe -> battleship
let ttt, bs;

// The flag is NOT in this bundle. What ships is AES-GCM ciphertext whose key is
// SHA-256 of a correctly built AX.25 frame, so the page hands out a flag it has
// never held.
async function tryUnseal(frameBytes) {
  const blob = await (await fetch("flag_blob.json", { cache: "no-store" })).json();
  const keyBytes = await crypto.subtle.digest("SHA-256", frameBytes);
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64(blob.nonce) }, key, b64(blob.ct));
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

const link = (file) =>
  `<a href="challenge/${file}.sigmf-data" download>${file}.sigmf-data</a> · ` +
  `<a href="challenge/${file}.cfile" download>${file}.cfile</a>`;

// --- rendering ---------------------------------------------------------------

function renderTtt() {
  const host = document.getElementById("ttt");
  host.innerHTML = "";
  ttt.board.forEach((v) => {
    const b = document.createElement("button");
    b.textContent = v === EMPTY ? "" : v;
    b.disabled = true;                 // display only: moves arrive as signal
    host.appendChild(b);
  });
}

function renderBs() {
  const host = document.getElementById("bs");
  host.innerHTML = "";
  const corner = document.createElement("div");
  corner.className = "hd";
  corner.textContent = "k\\l";
  host.appendChild(corner);
  for (let c = 0; c < COLS; c++) {
    const h = document.createElement("div");
    h.className = "hd";
    h.textContent = c;
    host.appendChild(h);
  }
  for (let r = 0; r < ROWS; r++) {
    const h = document.createElement("div");
    h.className = "hd";
    h.textContent = r;
    host.appendChild(h);
    for (let c = 0; c < COLS; c++) {
      const k = `${c},${r}`;
      const b = document.createElement("button");
      b.disabled = true;               // display only
      if (bs.hits.has(k)) { b.className = "hit"; b.textContent = "X"; }
      else if (bs.misses.has(k)) { b.className = "miss"; b.textContent = String(bs.proximity(c, r)); }
      host.appendChild(b);
    }
  }
}

function newTtt() {
  ttt = new TicTacToe();
  document.getElementById("ttt-log").textContent = "";
  renderTtt();
}

function openGames() {
  const el = document.getElementById("games");
  el.hidden = false;
  document.getElementById("rules-link").innerHTML = link("rules");
  newTtt();
  stage = "tictactoe";
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function openGrid() {
  const wrap = document.getElementById("bs-wrap");
  if (!wrap.hidden) return;
  wrap.hidden = false;
  // Answered in the waveform it introduces, not in a paragraph about it.
  document.getElementById("grid-link").innerHTML =
    `WELCOME TO THE NEXT LEVEL.<br>` + link("nextlevel");
  bs = new Battleship("SDRDLE");
  document.getElementById("bs-log").textContent =
    `${Object.keys(bs.fleet).length} contacts. ` +
    `Up to ${SALVO} elements per transmission.`;
  renderBs();
  stage = "battleship";
  wrap.scrollIntoView({ behavior: "smooth", block: "start" });
}

// --- moves -------------------------------------------------------------------

// After a game ends the terminal asks again, and the answer arrives the same
// way every other move does. Nothing here is a button.
const AGAIN = "TRANSMIT NEW OR DECLINE.";

function handleTttFrame(info, lines, ms) {
  if (/\bDECLINE\b/i.test(info)) {
    if (!ttt.finished) ttt.decline();
    renderTtt();
    document.getElementById("ttt-log").textContent = "DECLINED. THAT WAS THE MOVE.";
    openGrid();
    say(`<pre>${lines}</pre><span class="muted">Declined.</span>`);
    return;
  }
  if (/\bNEW\b/i.test(info)) {
    newTtt();
    say(`<pre>${lines}</pre><span class="muted">New game.</span>`);
    return;
  }
  if (ttt.finished) {
    say(`<pre>${lines}</pre><span class="muted">That game is over. ${AGAIN}</span>`, "warn");
    return;
  }
  const idx = parseCell(info);
  if (idx === null) {
    say(`<pre>${lines}</pre><span class="muted">No move in that frame.</span>`, "warn");
    return;
  }
  const r = ttt.play(idx);
  renderTtt();
  if (!r.ok) {
    say(`<pre>${lines}</pre><span class="muted">${esc(r.error)}</span>`, "warn");
    return;
  }
  const log = document.getElementById("ttt-log");
  log.textContent = ttt.finished
    ? (ttt.outcome === "D" ? `NO WINNER. THERE NEVER IS.\n${AGAIN}`
       : `YOU LOSE.\n${AGAIN}`)
    : "";
  say(`<pre>${lines}</pre><span class="muted">Move accepted (${ms} ms).</span>`);
}

function handleSalvo(cells, ms) {
  const shots = [...cells].map((s) => s.split(",").map(Number));
  const res = bs.fire(shots);
  renderBs();
  const log = document.getElementById("bs-log");
  if (!res.ok) { log.textContent = res.error; return; }
  log.textContent = res.results.map((x) => {
    const cell = `k${x.r}/l${x.c}`;
    if (x.outcome === "sunk") return `${cell}  HIT — ${x.ship.toUpperCase()} DESTROYED`;
    if (x.outcome === "hit") return `${cell}  HIT`;
    if (x.outcome === "repeat") return `${cell}  already fired`;
    return `${cell}  miss (${x.proximity} adjacent)`;
  }).join("\n") +
    `\n\n${res.shots} shots · ${res.remaining} contacts remaining` +
    (res.finished ? "\n\nALL CONTACTS DESTROYED." : "");
  say(`<span class="muted">Salvo of ${shots.length} resolved (${ms} ms).</span>`);
}

// --- upload ------------------------------------------------------------------

document.getElementById("file").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  const rate = Number(rateEl.value);
  if (!Number.isFinite(rate) || rate <= 0) return say("Set a sample rate first.", "err");

  say("Reading…");
  const buf = await file.arrayBuffer();
  if (buf.byteLength % 8 !== 0) return say("Not a whole number of samples.", "err");
  if (String.fromCharCode(...new Uint8Array(buf, 0, Math.min(4, buf.byteLength))) === "RIFF") {
    return say("That is a WAV container.", "err");
  }
  const iq = new Float32Array(buf);
  const probe = iq.subarray(0, Math.min(iq.length, 4096));
  for (let i = 0; i < probe.length; i++) {
    if (!Number.isFinite(probe[i])) return say("Non-finite samples.", "err");
  }

  say(`Demodulating ${(iq.length / 2).toLocaleString()} samples…`);
  await new Promise((r) => setTimeout(r, 0));
  const t0 = performance.now();

  // Try APRS first, then the resource grid. Auto-detection rather than a mode
  // switch: a player should not have to tell the terminal what they sent.
  let frames = [];
  try { frames = demodAprs(iq, rate); } catch { /* fall through to OFDM */ }
  const ms = Math.round(performance.now() - t0);

  if (frames.length) {
    const lines = frames.map((f) =>
      `  ${esc(f.src[0])}&gt;${esc(f.dest[0])}:${esc(f.info)}`).join("\n");
    if (stage === "uplink") {
      for (const f of frames) {
        const flag = await tryUnseal(f.bytes);
        if (flag) {
          say(`Recovered ${frames.length} frame(s) in ${ms} ms:\n<pre>${lines}</pre>` +
              `<div class="flag">${esc(flag)}</div>`);
          openGames();
          return;
        }
      }
      const hasYear = frames.some((f) => f.info.includes(YEAR));
      return say(`Recovered ${frames.length} frame(s) in ${ms} ms:\n<pre>${lines}</pre>` +
        `<span class="muted">` +
        (hasYear ? "Not the expected frame." : `No ${YEAR} in your message.`) +
        `</span>`, "warn");
    }
    return handleTttFrame(frames[0].info, lines, ms);
  }

  if (stage !== "battleship") {
    return say(`No frame recovered (${ms} ms).`, "warn");
  }

  let grid;
  try { grid = demodOfdm(iq); } catch (e) {
    return say(`No frame recovered, and no resource grid either.`, "warn");
  }
  if (grid.syncSeen < N_SC) {
    return say(`Sync symbol incomplete: ${grid.syncSeen} of ${N_SC} subcarriers.`, "warn");
  }
  if (!grid.cells.size) return say("Sync found, but no elements occupied.", "warn");
  handleSalvo(grid.cells, Math.round(performance.now() - t0));
});
