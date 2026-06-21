# VibeProf

A handwriting-first note-taking app for iPad + Apple Pencil with a **real-time AI tutor that doesn't just talk — it picks up the pen and writes on your work alongside you.**

## Inspiration

Plenty of AI tutors will *chat* with you, and a few will *talk* with you. But none of them actually **draw**. If you're working a math problem by hand, today's tools make you stop, photograph your page, and read a wall of text back. The teaching moment is lost.

We couldn't find a "vibecode"-style, real-time tutor that does what a good human tutor does: sit next to you, watch your handwriting as you write it, *circle the sign error in red*, and write the next step in the margin while explaining it out loud. So we built VibeProf, where the canvas — not a chat box — is the primary teaching surface.

## What it does

- **Natural handwriting canvas** — pen, highlighter, and eraser with pressure, an Apple-Pencil-only input mode, multi-page notebooks, pan/zoom, undo, autosave, and JSON export.
- **Two ways to get help:**
  - **Check** — sends a snapshot of *your* work (AI marks stripped out) to a vision model for Socratic feedback plus on-canvas annotations.
  - **Voice (Live)** — a low-latency, interruptible spoken tutor (OpenAI Realtime over WebRTC, with a Gemini Live fallback) that explains while it draws.
- **The tutor draws** — it issues structured canvas commands: `circle_region`, `underline`, `draw_arrow`, `highlight_box`, `write_label`, and `write_formula` (LaTeX auto-normalized to clean Unicode like `πr²` and `√`).
- **Marks mistakes in red** — a circle on the exact step with a 2–4 word note ("sign error", "missing unit") synced to what it's saying.
- **Knows its own marks** — AI strokes are tracked separately from yours, so it can erase or rewrite *only its own* annotations (`erase_ai_region`, `replace_ai_text`, `clear_ai_annotations`) and never touches your handwriting.
- **Spatially & temporally aware** — uses a free-space map and a stroke timeline (order, duration, position) to place new writing in open space, avoid overlapping you, and build on hints it already wrote instead of repeating them.

## How we built it

- **Frontend:** React 19 + Vite + TypeScript. A custom pointer-driven `<canvas>` engine handles pressure strokes, highlighter, eraser, pan/zoom, and Apple Pencil input, with lucide-react for the UI.
- **Backend:** a deliberately dependency-light Node HTTP/HTTPS server with a file-based JSON store for notebooks, pages, strokes, snapshots, and stroke timelines.
- **The tutor brain:** the AI never touches pixels directly. It returns a validated list of high-level drawing commands that the client renders into real strokes — so the same command schema powers both the text "Check" path and the realtime voice tool (`apply_canvas_commands`).
- **Models:** a multi-provider registry (Anthropic → OpenAI → Gemini → local mock) with graceful fallback. Voice runs on OpenAI Realtime over WebRTC, with Gemini Live as a backup transport.
- **On-device feel:** local self-signed HTTPS + a cert-download helper so the iPad mic and WebRTC work over your LAN.

## Challenges we ran into

- **Placement.** Getting the tutor to write in *empty* space and not on top of the student's handwriting (or its own earlier hints) took a real spatial model — a free-space map plus AI-annotation bounds fed back into every prompt.
- **Speech/ink sync.** A voice tutor that talks for ten seconds and then draws feels broken. We pushed the model to emit the smallest useful mark *first*, then narrate around it, so ink and audio land together.
- **"Erase only your own marks."** Cleanly separating AI strokes from student strokes — and supporting character-level edits to the tutor's own writing — without ever clobbering the student's work.
- **Math that reads like math.** Normalizing messy LaTeX into clean handwritten-looking Unicode, and rendering multi-step derivations as a tidy vertical chain.
- **iPad reality.** Microphone + WebRTC on a LAN IP demand HTTPS, so we had to ship local certificate generation and trust as a first-class setup step.

## Accomplishments that we're proud of

- A tutor that **circles your mistake in red and writes the fix in the margin** in real time — the thing we couldn't find anywhere else.
- A clean command-based drawing protocol shared across text and voice, so the AI's marks are always validated, bounded, and undoable.
- Genuinely usable on an iPad with Apple Pencil, voice, and live ink — not just a desktop demo.
- Resilient multi-provider fallback so a single down API doesn't kill the session.

## What we learned

- For an AI that shares a canvas with a human, **spatial and temporal context matters as much as the prompt** — *where* and *when* something was written changes the right response.
- Latency is a teaching feature: small, early, incremental marks beat one big correct-but-late answer.
- Constraining the model to a typed command vocabulary (instead of free-form output) made its behavior far more reliable and safe to render.

## What's next for VibeProf

- Smarter layout so tutor writing never overlaps and circling/underlining feel crisper.
- Persistent tutor memory of its own progress across a session and across pages.
- Better matrix/LaTeX rendering, image paste + resizing, and richer text.
- Redo, plus disabling **Check** until the previous response finishes.
- Letting the student erase tutor writing directly, and resetting tutor state on new pages/notebooks.


## Local Usage: iPad HTTPS Setup

The iPad reaches the app over your local Wi‑Fi, and the mic + live voice tutor
require HTTPS. This guide covers the full certificate process: finding your IP,
generating certs, downloading the CA on the iPad, installing the profile, and
enabling trust.

> The iPad **must be on the same Wi‑Fi network** as the Mac running the backend.

---

### 1. Find your Mac's LAN IP

```bash
ipconfig getifaddr en0      # Wi-Fi
ipconfig getifaddr en1      # wired/Thunderbolt ethernet, if used
```

Use whichever returns an address (e.g. `10.0.0.163`). This changes when you join
a different network, so re-check it each time. Substitute it for `<your-ip>` below.

### 2. Generate the certificates (Mac)

Mints a local Certificate Authority (CA) plus a server cert whose SAN list covers
`localhost`, loopback, and every auto-detected LAN IP.

```bash
cd apps/backend && ./scripts/make-certs.sh
```

If your IP isn't auto-detected, pass it (and any hostnames) explicitly:

```bash
./scripts/make-certs.sh <your-ip> my-mac.local
```

Writes to `apps/backend/data/certs/`:

- `local-ca.cer` — **the CA you trust on the iPad** (the file the iPad downloads)
- `server-cert.pem` / `server-key.pem` — what the backend serves HTTPS with

The CA is **reused** across runs, so devices that already trust it stay trusted.
Use `./scripts/make-certs.sh --new-ca` only to start fresh (every device must
then re-trust).

### 3. Start the backend (Mac)

```bash
npm run dev:backend
```

Two listeners come up:

- `https://<your-ip>:8787` — the app (HTTPS, required for mic + WebRTC)
- `http://<your-ip>:8788` — a plain‑HTTP helper page that serves the cert download

HTTPS only activates when `HTTPS_CERT_PATH`, `HTTPS_KEY_PATH`, and
`HTTPS_CA_CERT_PATH` are set in `.env` (they point at the files from step 2).

### 4. Download the CA cert (iPad → Safari)

Open **Safari** on the iPad (must be Safari — only it hands the profile to
Settings) and go to the **helper port**:

```
http://<your-ip>:8788
```

Tap **"Download local CA certificate."** You can also hit the file directly —
any of these work:

```
http://<your-ip>:8788/local-ca.cer
http://<your-ip>:8788/local-ca.pem
http://<your-ip>:8788/local-ca.crt
```

Tap **Allow** when iOS asks to download a configuration profile.

### 5. Install the profile (iPad → Settings)

1. Open **Settings** — a **"Profile Downloaded"** banner appears near the top.
2. Tap it → **Install** (top right) → enter passcode → **Install** → **Install**.

If the banner is gone: **Settings → General → VPN & Device Management**, find the
profile there, and install it.

### 6. Enable full trust (iPad — easy to miss)

Installing the profile is **not enough**; iOS won't trust it for SSL until you
flip the switch:

**Settings → General → About → Certificate Trust Settings →** enable the toggle
for **"AI Tutor Local CA."** Confirm on the warning dialog.

### 7. Open the app

In Safari on the iPad:

```
https://<your-ip>:8787
```

You should get a clean padlock (no warning), and the mic / live voice tutor will work.

---

### Notes & gotchas

- **Trust the CA once per iPad.** Re-running `make-certs.sh` to add a new IP only
  refreshes the *server* cert — restart the backend, but no iPad re-trust needed
  (it trusts the CA, not the server cert).
- **IP changed?** (new network, router reboot) Re-check step 1, re-run
  `make-certs.sh <new-ip>` if it wasn't auto-detected, then restart the backend.
- **Not Safari.** Chrome/Firefox on iOS won't install the profile — use Safari.
- **Port reference:** app = `8787`, cert/setup helper = `8788`.


