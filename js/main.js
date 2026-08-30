import { demodulate } from "./aprs.js";
import { TicTacToe, Battleship, EMPTY, SALVO, COLS, ROWS } from "./games.js";

const out = document.getElementById("out");
const rateEl = document.getElementById("rate");

const say = (html, cls = "") => { out.className = cls; out.innerHTML = html; };
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// The flag is NOT in this bundle. What ships is AES-GCM ciphertext whose key is
// SHA-256 of a correctly built AX.25 frame -- so the page can hand out a flag it
// has never held, and reading the source gets you an encrypted blob and a
// decryptor rather than an answer.
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
    return null;   // wrong frame; GCM refuses rather than returning noise
  }
}

document.getElementById("file").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  const rate = Number(rateEl.value);
  if (!Number.isFinite(rate) || rate <= 0) return say("Set a sample rate first.", "err");

  say("Reading…");
  const buf = await file.arrayBuffer();

  if (buf.byteLength % 8 !== 0) {
    return say(
      `That file is ${buf.byteLength} bytes, which is not a whole number of ` +
      `complex float32 samples (8 bytes each).<br>` +
      `<span class="muted">A WAV or a real-valued file will not work — this wants ` +
      `interleaved I/Q.</span>`, "err");
  }
  const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  if (String.fromCharCode(...head) === "RIFF") {
    return say("That is a WAV file. This wants raw interleaved complex float32, " +
               "not a WAV container.", "err");
  }

  const iq = new Float32Array(buf);
  const probe = iq.subarray(0, Math.min(iq.length, 4096));
  for (let i = 0; i < probe.length; i++) {
    if (!Number.isFinite(probe[i])) {
      return say("That file contains NaN or infinity in its first samples.", "err");
    }
  }

  say(`Demodulating ${(iq.length / 2).toLocaleString()} samples…`);
  await new Promise((r) => setTimeout(r, 0));   // let the browser paint

  let frames;
  const t0 = performance.now();
  try {
    frames = demodulate(iq, rate);
  } catch (e) {
    return say(`Demodulator failed: ${esc(String(e))}`, "err");
  }
  const ms = Math.round(performance.now() - t0);

  if (!frames.length) {
    return say(
      `No frame recovered (${ms} ms).<br><span class="muted">` +
      `Check the sample rate first. Note that nothing is accepted unless its ` +
      `checksum is right, so a subtly malformed frame looks exactly like ` +
      `silence from here.</span>`, "warn");
  }

  const lines = frames.map((f) =>
    `  ${esc(f.src[0])}&gt;${esc(f.dest[0])}:${esc(f.info)}`).join("\n");

  for (const f of frames) {
    const flag = await tryUnseal(f.bytes);
    if (flag) {
      say(
        `Recovered ${frames.length} frame(s) in ${ms} ms:\n<pre>${lines}</pre>` +
        `<div class="flag">${esc(flag)}</div>`);
      revealGames();
      return;
    }
  }

  say(
    `Recovered ${frames.length} frame(s) in ${ms} ms:\n<pre>${lines}</pre>` +
    `<span class="muted">Decoded cleanly, but that is not the frame this terminal ` +
    `is waiting for. Read the briefing again — the source address and the exact ` +
    `text both matter.</span>`, "warn");
});

// --- games -------------------------------------------------------------------
// Revealed only after the uplink is solved. They carry no flag and cannot: for
// the page to say "hit" it must know where the ships are, and tic-tac-toe is a
// solved game. They are the reward, not a second lock.


const COL_LETTERS = "ABCDEFGH";
let ttt, bs, selected = [];

function renderTtt() {
  const host = document.getElementById("ttt");
  host.innerHTML = "";
  ttt.board.forEach((v, i) => {
    const b = document.createElement("button");
    b.textContent = v === EMPTY ? "" : v;
    b.disabled = ttt.finished || v !== EMPTY;
    b.addEventListener("click", () => {
      const r = ttt.play(i);
      if (!r.ok) return;
      renderTtt();
      const log = document.getElementById("ttt-log");
      if (ttt.finished) {
        log.textContent =
          ttt.outcome === "D" ? "NO WINNER. THERE NEVER IS."
          : ttt.outcome === "O" ? "YOU LOSE. TRY AGAIN, OR DO NOT."
          : "";
      }
    });
    host.appendChild(b);
  });
}

function newTtt() {
  ttt = new TicTacToe();
  document.getElementById("ttt-log").textContent = "";
  renderTtt();
}

function renderBs() {
  const host = document.getElementById("bs");
  host.innerHTML = "";
  const corner = document.createElement("div");
  corner.className = "hd";
  host.appendChild(corner);
  for (let c = 0; c < COLS; c++) {
    const h = document.createElement("div");
    h.className = "hd";
    h.textContent = COL_LETTERS[c];
    host.appendChild(h);
  }
  for (let r = 0; r < ROWS; r++) {
    const h = document.createElement("div");
    h.className = "hd";
    h.textContent = r + 1;
    host.appendChild(h);
    for (let c = 0; c < COLS; c++) {
      const k = `${c},${r}`;
      const b = document.createElement("button");
      const isHit = bs.hits.has(k);
      const isMiss = bs.misses.has(k);
      if (isHit) { b.className = "hit"; b.textContent = "X"; }
      else if (isMiss) { b.className = "miss"; b.textContent = String(bs.proximity(c, r)); }
      else if (selected.some(([x, y]) => x === c && y === r)) b.className = "sel";
      b.disabled = isHit || isMiss || bs.finished;
      b.addEventListener("click", () => {
        const at = selected.findIndex(([x, y]) => x === c && y === r);
        if (at >= 0) selected.splice(at, 1);
        else if (selected.length < SALVO) selected.push([c, r]);
        renderBs();
      });
      host.appendChild(b);
    }
  }
}

function newBs() {
  const call = (document.getElementById("bs-call").value || "SDRDLE").toUpperCase();
  bs = new Battleship(call);
  selected = [];
  document.getElementById("bs-log").textContent =
    `Board seeded from ${call}. Four contacts, 12 cells.`;
  renderBs();
}

function fireSalvo() {
  if (!selected.length) {
    document.getElementById("bs-log").textContent = "Select up to four cells first.";
    return;
  }
  const res = bs.fire(selected);
  selected = [];
  renderBs();
  const log = document.getElementById("bs-log");
  if (!res.ok) { log.textContent = res.error; return; }
  const lines = res.results.map((x) => {
    const cell = `${COL_LETTERS[x.c]}${x.r + 1}`;
    if (x.outcome === "sunk") return `${cell}  HIT — ${x.ship.toUpperCase()} DESTROYED`;
    if (x.outcome === "hit") return `${cell}  HIT`;
    if (x.outcome === "repeat") return `${cell}  already fired`;
    return `${cell}  miss (${x.proximity} adjacent)`;
  });
  log.textContent = lines.join("\n") +
    `\n\n${res.shots} shots · ${res.remaining} contacts remaining` +
    (res.finished ? "\n\nALL CONTACTS DESTROYED." : "");
}

export function revealGames() {
  const el = document.getElementById("games");
  if (!el || !el.hidden) return;
  el.hidden = false;
  document.getElementById("ttt-new").addEventListener("click", newTtt);
  document.getElementById("ttt-decline").addEventListener("click", () => {
    if (ttt.decline().ok) {
      renderTtt();
      document.getElementById("ttt-log").textContent = "DECLINED. THAT WAS THE MOVE.";
    }
  });
  document.getElementById("bs-new").addEventListener("click", newBs);
  document.getElementById("bs-fire").addEventListener("click", fireSalvo);
  newTtt();
  newBs();
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}
