# Web client (mobile and desktop browsers)

A browser build of the game's portable scene core. Everything for it lives under `Web/`; nothing in
`Native/`, `Assets/` or the Android project is modified (the few source changes the WebAssembly build
needs are `patches/*.patch`, applied to a build-time copy).

```
 browser tab
 ├─ main thread   app.js  input (keyboard / gamepad / touch), ROM gate, audio context, UI shell
 │                mp-ui.js + mp-link.js  versus panel and the WebRTC connection to the other player
 ├─ worker        worker.js  the whole game: core (wasm) + WebGL2 renderer on an OffscreenCanvas
 │                mp-session.js  online session (lobby, race pump, results, records)
 │                rangefs.js  lazily fetched, read-only game data (HTTP Range + prefetch)
 └─ AudioWorklet  audio-worklet.js  jitter buffer fed with the core's own 44.1 kHz mixer output
```

The core is the same C++ the Unity plugin and the Linux harness run (`IDAS3_PORTABLE_SCENE`), compiled to
wasm32 with Emscripten. It produces the scene (vertex ranges, textures, cameras, lighting constants),
2D draw lists and audio; `www/renderer.js` turns those into WebGL2 draws, the same job
`Assets/Scripts` does in Unity.

## Requirements

* Module workers, `OffscreenCanvas` WebGL2 inside a worker, `AudioWorklet`: Chrome/Edge, Firefox 105+, Safari 17+.
* Memory: the core runs with a 2 GB ceiling; about 307 MB of heap and ~215 MB of cached game data were
  in use in the menu-to-race session that was measured (see Limitations: not measured on a phone).
* The player supplies their own **GDS-0033** disc image, like the desktop game (see below).

## Build

Prerequisites: Emscripten 3.1.x (built and tested with 3.1.55), Python 3, Node 18+.

```
export EMCC=/path/to/emcc
Web/build/build_wasm.sh  build/wasm -j8        # compile the units (patches are applied first; a failing patch aborts)
Web/build/link_wasm.sh   build/wasm web        # idas_core.js + idas_core.wasm
Web/build/package_web.sh build/wasm dist       # www/* + core -> dist/
python3 -I Web/tools/make_manifest.py Native --set boot=Web/tools/prefetch/boot.txt --set menus=Web/tools/prefetch/menus.txt > manifest.json
```

For the Node tests of online play also link `Web/build/link_wasm.sh build/wasm node-core` (the same core as an ES module
that can be instantiated several times in one process).

`link_wasm.sh` links at `-O0` by default because the glue optimizer needs npm packages that are not
always installed. Run Binaryen's `wasm-opt -O2` over `idas_core.wasm` for a release build (not done or
measured yet). `build_native.sh` builds the same units for Linux for debugging and for `tests/`.

## Run

```
node Web/tools/serve.mjs --www dist --data Native --manifest manifest.json --port 8080
```

Open `http://localhost:8080/`, choose the disc files, play. Query options: `?stats=1` (overlay),
`?scale=<factor>` / `?maxlong=<px>` (render size; defaults 0.75 / 1280 on touch devices, 1 / 1920 otherwise), `?touch=1` (force touch controls),
`?data=<url>` (game data base URL, default `game/` next to the page), `?manifest=<url>`. A `config.json` next to
`index.html` (`{"data": ..., "manifest": ...}`) sets the same two URLs; the dev server has none.

`serve.mjs` is a development server. For hosting, put `dist/` and the converted game data
(`/game/`, from `Native/data`) behind any static host that supports **HTTP Range requests**, serves
`/game/` with long-lived caching, and compresses the compressible file types. A race session reads
~215 MB of the 2.85 GiB tree; the boot set is ~140 MB raw (~40 MB compressed) and menu to race ~75 MB
raw more. Prefetch sets are recorded from the client's access log (`make_manifest.py --set boot=list`).

## GitHub Pages

The repository already holds the game data (`Native/data`), and `.github/workflows/static.yml` deploys the
whole repository as one Pages site, so the browser client is committed as a static folder, **`play/`**, next to
the data. Its `config.json` points at `../Native/`, relative to the page, so it works under any path:

```
https://<user>.github.io/<repo>/play/        the game (the repository root redirects here)
https://<user>.github.io/<repo>/Native/data  the files it streams
```

Rebuild `play/` after changing anything in `Web/www` or the core (needs the wasm build above):

```
Web/build/package_pages.sh build/wasm play
```

then commit `play/`; the next push to `main` deploys it. Notes:

* Pages' documented limit is 1 GB per site; this repository's deployment was accepted at 2.3 GB, so it is
  over the documented limit. If GitHub starts refusing it, host `Native/data` elsewhere (below).
* Only one workflow should deploy Pages. `jekyll-gh-pages.yml` and `static.yml` both do, from the same
  branch; keep one (`static.yml`, since Jekyll would try to build the whole repository).
* Data on another host (object storage/CDN, or `raw.githubusercontent.com`): build with
  `package_pages.sh build/wasm play --data-url https://host/path/Native/`. That host only has to send
  `Access-Control-Allow-Origin`. Range support is optional: a plain `Range: bytes=a-b` header needs no CORS
  preflight, and a host that ignores Range or fails it makes the client fetch the whole file once and keep it
  (`tests/rangefs_test.cjs` covers all three cases). `raw.githubusercontent.com` is not a CDN and is rate limited.
* HTTPS (which Pages gives you) is what browsers require for the audio engine on a phone.
* `tools/prefetch/boot.txt` and `menus.txt` are the file lists the client downloads up front.
* Not tested here: the real `github.io` site (this environment cannot reach it); the layout and Range
  behaviour were tested against a local server.

**Hosting the data is the owner's decision**: those files are the game's converted assets. The ROM gate
below does not make them private.

## ROM gate

`www/romgate.js` is a port of `Assets/Scripts/Idas3RomValidation.cs`: exact size and SHA-256 of
`gds-0033.chd`, or the CUE sheet (same normalization, 16 KiB limit) plus the three BINs. Files are read
in the browser and not uploaded; nothing is remembered between visits. As on desktop this is a check
inside the client the player runs, so it is not a technical barrier. There is deliberately no flag or
query parameter that skips it; the automated tests replace the gate module inside Playwright only.

## Online play (head-to-head versus)

Two browser players race each other. Press **VERSUS** (top left, on the menus):

1. **Host a race**: the page makes an invitation **link**. Send it to the other player in any chat app and keep the page open.
2. The other player **opens the link**. The game loads, the join screen comes up with the link filled in, they check
   their name and press **Join**. Both browsers connect and meet in the lobby. Nobody copies a reply code.

The link looks like `https://<site>/play/#join=<26 random characters>`. The part after `#` is never sent to the
site that serves the game; it names a private mailbox room (below). A guest who already has the game open can paste
the link into the join screen (or into the address bar of that tab). An invitation is good for one guest and for
15 minutes while the host's page stays open; a second guest is told the seat is taken, and a cancelled
invitation says so.

**If the link does not work**, the host's page and the join screen each have the manual way, which needs nothing
but a chat app: the host sends a **pairing code**, the guest pastes it and sends back a **reply code**, the host
pastes that and presses **Connect**. The host's page opens that section by itself when the mailbox cannot be
reached, and the join box accepts either a link or a code.

In the lobby each player picks a car (their own saved cars and the stock cars) and transmission, the host picks
course, direction, boost and collisions, the guest presses **I am ready**, the host starts. There is a text chat in
the lobby. The race uses the game's own VS screens, HUD, countdown and original result screens; afterwards both
players return to the lobby.

* **How it stays in sync.** Both browsers simulate the whole race from the exchanged controls (the core's
  "input authority" mode: the packets carry only controls, the core rolls back and replays when a late packet
  differs from its prediction, and a lost packet is repaired by the next one). The host announces the result and
  the guest accepts it only if its own simulation agrees. The two sides must run the identical core, so the
  lobby refuses a different build (the build id is a hash of `idas_core.wasm`, in `build.json`).
* **Records.** Battle record per car (battles, wins, level, streak) and the last 50 races are kept on the device
  (`/saves/web-online/records.json`, IndexedDB). The progression arithmetic and the tuning-point reward are the
  core's own, the same calls the desktop game uses.
* **What the link needs (the mailbox).** A browser cannot find another browser on its own, so the two pages
  exchange their connection details (the pairing and reply codes, which the link flow sends automatically)
  through a tiny public mailbox: a topic named after the random room on **[ntfy.sh](https://ntfy.sh)**, a free
  public publish/subscribe service (`POST` a message, read it back as a server-sent-event stream). Only the
  pairing codes pass through it, each a few hundred bytes, and they are dropped after ~12 hours; the race itself
  never touches it. The room name has 130 random bits, so it cannot be guessed, but the codes contain
  the players' network addresses, so anyone who has the link (or the service's operator) can read them; that is
  the same thing the codes reveal when pasted in a chat. ntfy.sh is a third party with its own rate limits and
  terms, and it is the one outside dependency of the link flow. To use another mailbox, set
  `"signal": "https://your-server"` in `config.json` (`package_pages.sh ... --signal-url <url>`), or open the page
  with `?signal=<url>`; `?signal=off` switches links off and leaves the codes. Any
  ntfy-compatible server works, and `Web/tools/signal-relay.mjs` is a ~100-line one you can run yourself
  (`node Web/tools/signal-relay.mjs --port 8787`, behind HTTPS for an HTTPS page; it keeps messages in memory
  for 12 hours and rate limits each address; used by the tests).
* **Network.** The connection is direct UDP (WebRTC data channels). Public STUN servers (Google, Cloudflare) are
  used only to learn each side's public address. There is **no relay for the game traffic**, so some networks cannot connect:
  symmetric NAT, strict corporate firewalls, some mobile carriers. Two devices on the same Wi-Fi work without
  internet access (pairing then uses the codes, since the link needs the mailbox). Both players see the other's IP address (inherent to peer-to-peer); nothing goes to a server of this project.
* **Keep the tab in front.** A hidden tab stops the game loop; the other player is disconnected after ~15 s.
* **Compared with the desktop game.** Browser to browser only (the desktop game uses Epic Online Services, which
  has no browser client). The host's course choice stands, with no random draw between two picks. No quick match,
  room list, player directory, sanctions, imported course packs, or crash-safe result journal (a result is written
  once it is settled). The mailbox carries only pairing messages, so there is nothing to moderate at a server.

## Controls

Keyboard and gamepad follow the desktop mapping. Touch: left-hand steering zone (drag from where you
touch), GAS/BRAKE pedals, shift ▲▼, VIEW, LIGHTS, PAUSE while driving; D-pad, OK, BACK, Y in menus.
Taps shorter than one frame are latched so they are never lost. Tilt steering is not implemented.

Saves are written to IndexedDB (`/saves`) every 10 s and when the tab is hidden or closed. Two tabs
of the same profile are last-writer-wins.

## Tests (`Web/tests`)

| test | what it checks |
| --- | --- |
| `headless_scene.cpp` (native and wasm builds) | scripted sessions; wasm state, frame and audio output match native (tiny libm differences only in a few vertex alpha values) |
| `render_dump.cjs` + `render.html` | renders captured frames/UI dumps with `renderer.js` in headless Chromium, counts GL calls |
| `boot_test.cjs` | full client boot against `serve.mjs`: loading, menus, race, stats, audio, access log |
| `rangefs_test.cjs` | reads a large file from a data server on another origin: Range works / Range fails CORS / Range ignored |
| `mp_core_test.mjs` | two cores (host/guest, Node) race over in-memory packets: same winner and finish times, with packet loss and delay; result and record calls |
| `mp_session_test.mjs` | the full online flow with two cores and two sessions: lobby, chat, ready rules, race with loss and latency, result, records, back to the lobby, leaving |
| `mp_signal_test.mjs` | pairing-code encoding: round trips, damaged/truncated codes rejected, code length |
| `mp_mailbox_test.mjs` | the invitation protocol against the local relay: link and room-name handling, host and guest meeting in either order (history replay), a second guest, a cancelled or unknown room, a damaged reply not blocking a good one, an unreachable service, the relay's rate limit |
| `mp_link_browser_test.cjs` | the single link in two real browser profiles against the local relay: opened in a fresh tab and pasted into an open one, cancelled / unknown / taken invitations, the mailbox going away (clear message, codes still pair), `?signal=off` (`MP_VIEWPORT=844x390 MP_TOUCH=1`: phone landscape) |
| `mp_browser_test.cjs` | two real browser profiles pair with codes through real WebRTC, chat, pick cars, race, leave (`MP_RESULTS=1`: race to the time-up result and back to the lobby) |
| `gate_ui_test.cjs`, `romgate_test.mjs` | gate screen and the validation logic against synthetic discs |
| `touch_test.cjs` | touch layouts and short-tap latching |
| `persist_test.cjs` | IndexedDB save persistence across reloads |

All of this ran on software GL (SwiftShader) in a container. No real phone, GPU or real GDS-0033 dump
was available.

## Renderer cost

GL calls per captured race frame (two views, 2858 draws): 70,877 at the start, **11,181** after
slab-allocated geometry buffers, texture/sampler bind dedupe and shadowed per-range uniforms; the
image is pixel-identical to the unoptimized output. The captured dumps carry no geometry ids, so the
cached-geometry path is exercised only in live runs (`gfx` in the worker stats: uploaded vertices,
cache hits, cached geometry, slabs).

## Limitations / not done

* **Online play is browser to browser, head to head only** (see above). Not done: playing against the desktop
  game, quick match / room list / player directory / online records server / sanctions (these need a server and
  a moderation policy, which is a product decision), a relay for networks that block direct connections, imported
  course packs. Tested here: two cores over simulated lossy links, and two real browser instances over WebRTC on
  one machine, with the invitation link going through a local copy of the mailbox. **Not tested:** the public
  ntfy.sh itself (this environment cannot reach it, so its cross-origin headers and limits are taken from its
  documentation and source), two different devices or networks, NAT traversal over the internet, Firefox/Safari data
  channels with these codes, phones.
* Not tested on real hardware: phone performance and memory pressure, iOS audio unlock, Safari's
  OffscreenCanvas WebGL2, acceptance of a real GDS-0033 dump.
* The wasm is unoptimized (`-O0` link, no `wasm-opt`).
* Known renderer gaps: opaque-alpha depth pre-pass, special headlight shader, imported-course variant,
  HUD group scale/offset, Arcade meter/ornament HUD themes.
