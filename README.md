# GRCon26 CTF

> AWAITING TRANSMISSION. THIS TERMINAL DOES NOT SPEAK FIRST.

**Live at:** https://livethisdream.github.io/wargames/

A transmission was captured. Demodulate it, and it will tell you what to send
back. Build that, modulate it, and load the IQ into the page.

## What this is

Nearly every signals CTF challenge is receive-only: you are handed a capture and
asked to pull something out of it. This one asks you to go the other way — to
*synthesise* a valid modulated signal. That is a different skill, and a rarer
one.

Identifying what you are looking at is part of the work, so the parameters are
not written down here. The capture will tell you everything you need.

## How the flag works, and why it is not in this repo

The page is static. Anything it holds, you can read — so it holds no flag.

What ships is AES-256-GCM ciphertext whose key is derived from a correctly
constructed frame. Demodulate your own transmission, and the page derives that
key from what it recovered and decrypts. Read the source instead and you find an
encrypted blob and a decryptor, which are worth nothing without the frame.

The page is also **receive-only by design**. It will not build a packet for you,
because building it is the challenge — and there is deliberately no code here
that could be turned into one.

## Running it locally

Any static file server works. The page fetches the blob, so opening
`index.html` straight off the filesystem will not work.

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000/>.

## Contents

| Path | |
|---|---|
| `index.html` | the terminal |
| `js/aprs.js` | the demodulator |
| `js/main.js` | file handling, key derivation, decryption |
| `challenge/briefing.*` | the captured transmission |
| `flag_blob.json` | ciphertext and nonce. No flag. |
