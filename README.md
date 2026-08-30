# WOPR — GRCon26 CTF

> GREETINGS PROFESSOR FALKEN. SHALL WE PLAY A GAME?

A transmit-to-play challenge. A transmission was captured; demodulate it, and it
will tell you what to send back. Build that frame yourself, modulate it, and
load the IQ into the page.

**Live at:** https://livethisdream.github.io/wargames/

## What this is

Nearly every signals CTF challenge is receive-only: you are handed a capture and
asked to pull something out of it. This one asks you to go the other way — to
*synthesise* a valid modulated signal. That is a different skill, and a rarer
one.

Built on [argilo](https://github.com/argilo)'s "Shall we play a game?" from
GRCon22, which ran the same loop over the air on 903.5 MHz with a real
transmitter and a spectrum-painted reply. This is the version that needs no
hardware and no server, so it can stay up indefinitely.

## The signal

Everything the page expects, stated plainly — the puzzle is in the construction,
not in guessing the parameters:

- Bell 202 AFSK: 1200 Hz mark, 2200 Hz space, keyed at 1200 baud
- NRZI line coding — a data 0 flips the tone, a 1 holds it
- HDLC framing with `0x7E` flags, a stuffed 0 after every five consecutive 1s,
  bits least-significant first
- An AX.25 UI frame: six-character addresses shifted left one bit plus an SSID
  byte, control `0x03`, PID `0xF0`, then the information field, then a
  CRC-16/X.25 frame check sequence sent little-endian
- Narrowband FM onto a baseband carrier at zero offset
- Interleaved complex float32, 48000 samples/second

Tone polarity does not matter, because NRZI is differential. Neither does how
much flag preamble you send.

## How the flag works, and why it is not in this repo

The page is static. Anything it holds, you can read — so it holds no flag.

What ships is AES-256-GCM ciphertext whose key is the SHA-256 of a correctly
constructed AX.25 frame. Demodulate your own transmission, and the page derives
the key from what it recovered and decrypts. Read the source instead and you
find an encrypted blob and a decryptor, which are worth nothing without the
frame.

The page is also **receive-only by design**. It will not build a packet for you,
because building it is the challenge.

## Running it locally

Any static file server works — the page uses `fetch` for the blob, so opening
`index.html` from the filesystem will not work.

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000/>.

## Contents

| Path | |
|---|---|
| `index.html` | the terminal |
| `js/aprs.js` | AX.25/APRS demodulator — FM discriminator, AFSK, NRZI, HDLC, FCS |
| `js/main.js` | file handling, key derivation, decryption |
| `challenge/briefing.*` | the captured transmission, as a SigMF pair plus a `.cfile` |
| `flag_blob.json` | ciphertext and nonce. No flag. |
