import { demodulate } from "./aprs.js";

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
      `Check the sample rate, that the file is interleaved complex float32, ` +
      `and that the FCS is correct — a frame is only accepted on a passing ` +
      `checksum, so a bad CRC looks exactly like silence.</span>`, "warn");
  }

  const lines = frames.map((f) =>
    `  ${esc(f.src[0])}&gt;${esc(f.dest[0])}:${esc(f.info)}`).join("\n");

  for (const f of frames) {
    const flag = await tryUnseal(f.bytes);
    if (flag) {
      return say(
        `Recovered ${frames.length} frame(s) in ${ms} ms:\n<pre>${lines}</pre>` +
        `<div class="flag">${esc(flag)}</div>`);
    }
  }

  say(
    `Recovered ${frames.length} frame(s) in ${ms} ms:\n<pre>${lines}</pre>` +
    `<span class="muted">Decoded cleanly, but that is not the frame this terminal ` +
    `is waiting for. Read the briefing again — the source address and the exact ` +
    `text both matter.</span>`, "warn");
});
