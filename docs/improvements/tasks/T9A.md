# T9A: demo, documentation and metadata audit (read-only)

| Item | Value |
| --- | --- |
| Task | T9A, read-only audit of the demos, vendored controls, documentation and metadata against #19 and #20. It prepares T9. No tracked file is modified. |
| Base commit | `1e6184c37c0d2cdb8b493d59718c9c7281787a9e` (`improve/integration` after T0; tracked product files equal `b70ba90`) |
| Branch / worktree | `t9/audit` in `/workspace/webaudio-tinysynth-worktrees/t9-audit` |
| Governing issues | #19 (2026-10-03T00:17:03Z, `46269beafaf9b0a9`), #20 (2026-10-03T00:15:55Z, `d2126c352e5d3b8c`). A live read-only `gh issue view` at 2026-10-03T02:13Z returned the same `updatedAt`, 0 comments, state OPEN and the same body hashes. Context read: #5, #12, #13, #14, #26, #27. |
| Records read | `contracts.md`, `decisions.md` (D-001 to D-010), `status.md`, `tasks/T0.md`; `/workspace/webaudio-tinysynth/IMPLEMENTATION_PLAN.md` (sha256 `9383cb5b…`, matches contracts) and `/workspace/webaudio-tinysynth/AGENTS.md` (sha256 `b1661833…`, matches contracts; read only) |
| Evidence (outside the repo) | `/workspace/webaudio-tinysynth-worktrees/_evidence/t9-audit/`: `results.json` (loads and interaction probes), `results-gesture2.json` (gesture probes), `results-gesture.json` (MIDI permission only, see §3.4), `screenshots/`, `remote/` (snapshots of the remote demo dependencies), `fixtures/`, `scripts/`, `logs/http-server-run-demos.log` |
| Tooling | playwright-core 1.62.1 from `_evidence/T0/tools`, headless shell Chromium 151.0.7922.34, `LD_LIBRARY_PATH=_evidence/T0/tools/libroot/usr/lib/x86_64-linux-gnu`; `python3 -m http.server` bound to 127.0.0.1 serving the worktree; default autoplay policy (no `--autoplay-policy` flag) |

Severity scale used below: **High** = a demo throws, leaves a note sounding, or fails silently, or a statement is wrong in a way a caller would act on. **Medium** = wrong or misleading behavior with a workaround. **Low** = cosmetic, stale wording or hygiene.

Findings fall into three tiers: (A) baseline defects T9 must fix (§1, §3, §4.1–§4.4); (B) documentation that becomes wrong as T2–T12 land (§4.5); (C) decisions for the supervisor or the user (§7).

## 1. Demos: external references and vendored controls

### 1.1 External references per demo

| Demo | Reference (line) | Kind | Versioned | Needed |
| --- | --- | --- | --- | --- |
| `simple.html` | `https://unpkg.com/@webcomponents/custom-elements` (5) | polyfill script | No. A 302 redirect (`cache-control: max-age=60`) resolves today to `@1.6.0/custom-elements.min.js`. No SRI. | No. Every supported engine ships autonomous custom elements v1, and the controls use only autonomous elements. |
| `simple.html` | `https://g200kg.github.io/webaudio-controls/webaudio-controls.js` (6) | control library | No. GitHub Pages, `last-modified` 2025-10-04, ETag `"68e1298e-11c39"`. No SRI. | Yes: `<webaudio-keyboard>` (51) |
| `simple.html` | `./webaudio-tinysynth.js` (7) | local | n/a | Yes |
| `simple.html` | `https://github.com/g200kg/webaudio-tinysynth` (57) | link | n/a | Upstream credit; add a fork link (#20) |
| `jstest.html` | `webaudio-tinysynth.js` (4); `ws.mid` via `loadMIDIUrl` (8) | local | n/a | Yes. jstest has no remote dependency. |
| `soundedit.html` | custom-elements polyfill (5) | polyfill script | No (as above) | No |
| `soundedit.html` | `./webaudio-tinysynth.js` (6) | local | n/a | Yes |
| `soundedit.html` | webaudio-controls from g200kg.github.io (7) | control library | No (as above) | Yes: `<webaudio-knob>` ×2 (370–371), `<webaudio-switch>` (372), `<webaudio-keyboard>` (388) |
| `soundedit.html` | `fonts.googleapis.com` Audiowide (8) and Roboto Condensed (9); these load 2 woff2 files from `fonts.gstatic.com` | stylesheets and fonts | Google Fonts v1 URLs; the font files are versioned (`v22`, `v31`) | Cosmetic only; the CSS fallbacks are `cursive` and `sans-serif` |
| `soundedit.html` | `./g200kg160x80.png` (345); `ws.mid` via `loadMIDIUrl` (81) | local | n/a | Logo; preloaded song |
| `soundedit.html` | `http://www.g200kg.com/` (345), upstream repository links (347, 353) | links | n/a | Upstream credit; add a fork link (#20) |

All three demos load the unminified `webaudio-tinysynth.js`. None exercises `webaudio-tinysynth.min.js`, which is the onchain artifact.

The remote control file was snapshotted to `_evidence/t9-audit/remote/webaudio-controls.js` (72,761 bytes, sha256 `2f780008a1895c3d1b583d99f4f50c35fc2870bf47e117574361465dc5784f65`). It is **byte-identical** to `webaudio-controls.js` at upstream `g200kg/webaudio-controls` master `282610abc14e0ab3c6273a0b977ae5d6677f426c` (2025-10-04, "add event bubbling/cancelable settings"), fetched from `raw.githubusercontent.com` and compared with `cmp`. The repository is Apache-2.0 and has no NOTICE file. The package is not on npm (the registry returns 404), so pinning means vendoring that commit's file or using `cdn.jsdelivr.net/gh/g200kg/webaudio-controls@282610a…/webaudio-controls.js`, which returned HTTP 200. The file contains no `fetch`, `XMLHttpRequest`, `import()`, Worker or WebSocket. It calls `requestMIDIAccess` and uses `localStorage` only when `window.UseWebAudioControlsMidi`, `useMidi` or MIDI-learn options are set, and the demos set none of them.

### 1.2 `bower_components/webaudio-controls/`: used versus unused

No root demo, test or document references any file in it. `grep -rn bower_components` outside the directory matches nothing. The only reference is `.npmignore`, which excludes it from the package.

| Asset | Size | Status |
| --- | --- | --- |
| `webaudio-controls.html` (Polymer 1 `<dom-module>`/`Polymer({is:…})` definitions of knob, slider, switch, param and keyboard) | 40,620 B | **Unused.** It needs Polymer ^1.4 (`bower.json`) and HTML Imports. Neither is vendored, and Chromium removed HTML Imports in M73. |
| `sample1–4.html`, `resizetest.html` | 25 KB | **Unused and broken.** They import `bower_components/webcomponentsjs/…` and `bower_components/polymer/polymer.html`, which do not exist. |
| `img/*.png` (13 files, including `vernier.png` 795 KB and `LittlePhatty.png` 406 KB) | about 1.5 MB | **Unused** by the root demos |
| `README.md`, `bower.json`, `.bower.json` (resolution `07a64d6b5d4a44f675dbfd6d5e93609ff44deb72`) | | Describe the Polymer 1 version, not the remote script the demos use |
| `LICENSE` (Apache-2.0) | 10 KB | Keep with any vendored copy |

The whole directory is 1.6 MB. The active demos use a different, newer, Polymer-free implementation loaded from the network (§1.1). Per the source contract, only #19 may change this directory.

## 2. Demo runs (headless Chromium)

### 2.1 Method and network blocking

- Server: `python3 -m http.server <port> --bind 127.0.0.1 --directory <worktree>`. Pages were opened at `http://127.0.0.1:<port>/<demo>`, as the README documents. Driver: `_evidence/t9-audit/scripts/run.sh` with `run-demos.js` or `run-gesture2.js`.
- **online** mode: no blocking. Every request, failed request, HTTP status of 400 or more, console message and page error was recorded.
- **offline** mode: a Playwright route aborted (`blockedbyclient`) every request whose host was not `127.0.0.1`. This simulates no network. The sandbox itself had network access.
- Failure probes rerouted only `ws.mid`: to a 404 response, or aborted with `connectionrefused`.
- `logs/http-server-run-demos.log` is the server log of the final `run-demos.js` run only. Each run overwrites `http-server.log`.

### 2.2 Load results

| Demo / mode | Console errors | Console warnings | Page errors | Remote requests | AudioContext after load | Screenshot (`_evidence/t9-audit/screenshots/`) |
| --- | ---: | ---: | ---: | --- | --- | --- |
| simple / online | 0 | 5 | 0 | unpkg (302, then the 1.6.0 file), g200kg.github.io | suspended | `simple-online.png` |
| simple / offline | 2 (`ERR_BLOCKED_BY_CLIENT`) | 5 | 0 | 2 blocked | suspended | `simple-offline.png`: **no keyboard, so notes cannot be played; no message** |
| jstest / online | 0 | 5 | 0 | none | suspended | `jstest-online.png` |
| jstest / offline | 0 | 5 | 0 | none | suspended | `jstest-offline.png` (byte-identical to online) |
| soundedit / online | 0 | 6 | 0 | unpkg ×2, g200kg.github.io, fonts.googleapis.com ×2, fonts.gstatic.com ×2 | suspended | `soundedit-online.png`, `soundedit-online-editor.png` |
| soundedit / offline | 4 (`ERR_BLOCKED_BY_CLIENT`) | 6 | 0 | 4 blocked | suspended | `soundedit-offline.png`, `soundedit-offline-editor.png`: **no Vol/Reverb knobs, no Loop switch, no keyboard; fallback fonts; no message** |

- Every warning is Chrome's "The AudioContext was not allowed to start. It must be resumed (or created) after a user gesture on the page." It is logged once at construction and again on each implicit `resume()` inside `send()` (engine lines 1026–1027) before a gesture.
- The core library made no remote request in any mode. Its only local requests were the page, `webaudio-tinysynth.js` and `ws.mid`, the last only when asked. The headless shell made no favicon request.
- In `soundedit-*-editor.png` the editor table overflows the fixed 1000 px `#base`, and the K column is clipped on the right (Low).

### 2.3 Gesture and resume (`results-gesture2.json`)

Playwright's `page.evaluate` runs with a user gesture: `navigator.userActivation.hasBeenActive` was already `true` the first time it was read through `evaluate`. The authoritative gesture probes therefore use an init script that logs state to the console every 500 ms, and they perform actions only through real input events or page-side timers.

| Scenario (default policy, http origin) | Result |
| --- | --- |
| Page-side timers call `loadMIDIUrl("ws.mid")`, then `playMIDI()`, with no gesture | Context `suspended`, `currentTime` 0, and `getPlayStatus()` = `{play:1, curTick:120}` **frozen** for 2.5 s. The status says it is playing, but nothing advances and nothing sounds. This is the README usage snippet's situation. |
| jstest: click Load, then click Play | `running` within 0.5 s of the Play click; `curTick` advances. `playMIDI()` does not resume. The scheduler's later `send()` calls `resume()` outside the click handler, and Chromium accepts that after sticky activation. |
| soundedit: click Play (ws.mid preloaded) | `running`, advancing |
| simple: choose a file (no other gesture) | `running`, advancing |
| jstest: click the C note button | `running` (the `resume()` in `send()` runs inside the gesture) |

**Reconciliation with T0 §2 (for the supervisor).** T0 recorded the context as `running` right after construction in all four launch modes, and concluded that the harness "cannot observe the autoplay restriction". T0 loaded pages through `setContent`/`about:blank` and a `data:` URL. Here, with an `http://127.0.0.1` origin and the same headless shell (151.0.7922.34) under the default policy, the restriction **is** observable. The context stays `suspended` with the warning until a real input event triggers a `resume()`. T6's #12 gesture test can therefore use a local http origin, provided it never calls `page.evaluate` before the gesture step. Commands: `SCRIPT=run-gesture2.js scripts/run.sh` (results in `results-gesture2.json`).

Not established here: engines that require *transient* activation for `resume()`. Safari has historically required it. In those engines the Play button alone may never start audio, because `resume()` runs later in a timer. Only Chromium was available.

## 3. Demo interaction findings

Stuck-note oracle used by every probe: `synth.notetab.filter(nt => nt.e >= 99999)`. These are melodic voices with no scheduled end. A voice is held if `f == 0`, or if `f == 1` while sustain is on. Drum voices are never in `notetab`, so the oracle excludes them by construction. A note counts as stuck if it remains in the oracle after its release action has completed and 500 ms have passed.

### 3.1 Cross-demo

| ID | Sev | Finding | Evidence |
| --- | --- | --- | --- |
| X1 | High | Remote, unversioned, non-SRI third-party scripts execute in two demos. Offline, simple.html loses its only note input, and soundedit.html loses its knobs, switch and keyboard. Neither shows a message. | §2.2, offline screenshots |
| X2 | Medium | The custom-elements polyfill is unnecessary (§1.1) | code reading |
| X3 | Low | soundedit uses Google Fonts: 4 requests to 2 third-party hosts. The fallback fonts work. | §2.2 |
| X4 | Medium | `bower_components/webaudio-controls/` is a 1.6 MB Polymer 1 copy that no demo uses (§1.2) | grep, §1.2 |
| X5 | High | No demo starts audio deliberately. They rely on `send()`'s fire-and-forget `resume()` and on Chromium's sticky activation for Play. Programmatic play before a gesture reports `play:1` with a frozen position. A `resume()` rejection is never observed. | §2.3 |
| X6 | High | No demo shows load or parse errors: there is no `FileReader.onerror`, no `try/catch` around `loadMIDI`, and no error text. Failures are invisible (§3.2–§3.4). | probes |
| X7 | Low | Demos link only to upstream (simple 57; soundedit 347, 353) and use sloppy-mode implicit globals (`synth`, `kb`, `oscs`, `ids`, `id`, `p`). Keep the upstream credit and logo, and add the fork link. | code reading |

### 3.2 `simple.html`

| ID | Sev | Finding | Evidence |
| --- | --- | --- | --- |
| S1 | High | `LoadMidi(files)` (28–35) reads `files[0]` unchecked. An empty FileList raises the page error `Failed to execute 'readAsArrayBuffer' on 'FileReader': parameter 1 is not of type 'Blob'.` | `results.json` "simple: file input set to an empty FileList" |
| S2 | High | A non-MIDI file fails silently, and **the previous song keeps playing**. `loadMIDI` calls `stopMIDI()` (engine 719) and then returns on a bad `MThd` (724–725), and `LoadMidi` then calls `playMIDI()`. Measured: `play:1`, `curTick` 1200 → 1680 after the bad file. | "simple: non-MIDI file after a valid one" |
| S3 | High | QWERTY note stuck when focus leaves the keyboard while the key is held. The control listens for `keyup` only on itself and has no blur handling. Measured: note 48 stays held. The control (focus kept) releases correctly. | "simple: qwerty note held while focus moves away" |
| S4 | Medium | A mouse press followed by window blur with no `mouseup` leaves the note held. Neither the demo nor the control listens for `blur`, `visibilitychange` or `pointercancel`. The control is OK when the mouse is released outside the keyboard, because it listens for `mouseup`, `touchend` and `touchcancel` on `window`. | "simple: mouse press then window blur" (synthetic blur); "…released outside the keyboard" → released |
| S5 | Low | Play before choosing a file is a silent no-op (`playMIDI` returns when no song is loaded) | "simple: Play pressed before any file" (`button:text-is('Play')`) |
| S6 | Low | "Playable with … qwerty-keyboard" works only after the keyboard has focus (its canvas has `tabindex=1`), which the page does not explain. There is no `<title>`. | code reading |

### 3.3 `jstest.html`

| ID | Sev | Finding | Evidence |
| --- | --- | --- | --- |
| J1 | High | The note buttons (74–81) use `onmousedown`/`onmouseup` only. Releasing outside the button leaves the note sounding (note 60 held). Space or Enter on a focused button fires only `click`, so keyboard users cannot play at all. Touch gets only compatibility mouse events on a tap. | "jstest: mouse released outside the C button"; the release-on-button control → released; "keyboard activation (Space)" → nothing held |
| J2 | High | `loadMidi(files)` (10–16): the same empty-FileList TypeError as S1. The file input (56) has no `accept`. | "jstest: file input set to an empty FileList" |
| J3 | High | Load (ws.mid) failures are silent. A 404 or a refused connection leaves the status at `Play:0  Pos:0/0`. The only trace is the browser's resource error in the console. A non-MIDI file is also silent. | "jstest: Load (ws.mid) answered with HTTP 404", "… connection failure", "jstest: non-MIDI file selected" |
| J4 | Low | The ReverbLev slider starts at 50 while the engine's `reverbLev` is 0.3. MasterVol (50/0.5) and Quality agree. | "jstest: UI initial values versus engine state" |
| J5 | Low | No `<meta charset>` and no `<title>`; `Test()` calls `console.log(synth)` (43) | code reading |

### 3.4 `soundedit.html`

| ID | Sev | Finding | Evidence |
| --- | --- | --- | --- |
| E1 | High | The shot button (90–95) uses `mousedown`/`mouseup` only. Releasing outside it leaves the note sounding (note 60 held). | "soundedit: shot button released outside" |
| E2 | High | `KeyIn` computes the note-off with the *current* `curOct`. An octave change between note-on and note-off leaves the original note sounding (note 60 held). `MidiIn` has the same flaw, and it mutates `e.data` in place: the result is a `Uint8Array`, so out-of-range values wrap (120+24 → 144, 0−24 → 232). | "soundedit: octave changed between note-on and note-off" (synthetic `change` events on `kb`) |
| E3 | Medium | Shift-sustain uses document `keydown`/`keyup` with the deprecated `keyCode` (316–327). If focus is lost while Shift is down, sustain stays at 127. | "soundedit: shift sustain then focus/visibility loss" (synthetic blur) |
| E4 | High | MIDI access failure is only `console.log("MIDI is not available.")` (145–147), with no visible text. When `requestMIDIAccess` is missing, nothing happens at all. There is no `statechange` (hot-plug) handling, and `SelectMidi` logs the port array (119). In headless Chromium, access was rejected even with the `midi` permission granted, so the success path could not be exercised. | `results-gesture.json` `soundeditMidiGranted*` / `soundeditMidiDenied*` (console capture only; the `evaluate` gesture issue does not affect it) |
| E5 | Medium | `Edit()` adds one operator too many: `for(i=oscs-len;i>=0;--i)` pushes `oscs−len+1` (220). Choosing 4 operators on a 2-operator program gives **5**. The extra operator is `{t:0, v:0, …, b:0, c:0}`, and the Patch text shows five. | "soundedit: editor oscillator count 2 -> 4" |
| E6 | High (dependency) | The editor writes straight into engine internals: `synth.program[n].p` and `synth.drummap[i].p`, which alias the instance's built-in tables. Measured: `synth.program[0].p === synth.program1[0]`, and editing V1 changed `program1[0][0].v` to 0.9. It never calls `setTimbre`. See §6, T9-8, for the consequences. | "soundedit: editor edits mutate the engine's internal tables" |
| E7 | Medium | `SetQuality` on the drum channel uses `drummap[curNote]` instead of `drummap[curNote-35]` (293). Measured: Electric Snare (note 40) is shown as **Claves** after the quality change. | "soundedit: quality change while on the drum channel" |
| E8 | Medium | Editing on the drum channel with a key outside 35–81 throws `TypeError: Cannot read properties of undefined (reading 'p')`. The keyboard spans notes 35–107 before the ±24 octave shift. | "soundedit: editing on the drum channel above note 81" |
| E9 | Medium | `ProgChange` always sends `[0xc0,p]` to channel 1 (281), whatever the Ch select says. With Ch2 selected, `pg[0]` became 40 and `pg[1]` stayed 0, so the keyboard plays a different program from the one the editor shows. | "soundedit: Prog select while Ch2 selected" |
| E10 | Medium | A failure of the preloaded `loadMIDIUrl("ws.mid")` (81) is silent: the status shows `Stopped 0 / 0`. | "soundedit: initial ws.mid answered with HTTP 404" |
| E11 | Medium | The same empty-FileList TypeError as S1, in `loadMidi` (150–156) | "soundedit: file input set to an empty FileList" |
| E12 | Low | The knobs start at vol 0.5 and rev 0.2, while the engine has 0.3 and 0.3, until a knob is touched. Knob input itself works (0.8 → `out.gain` 0.8). | "soundedit: UI initial values…", "…knob input applies master volume" |
| E13 | Low | The Patch field is output only and is not JSON: unquoted keys and trailing `,}`. It cannot be pasted back. `ViewDef` strips defaults with repeated regular expressions. | code reading, screenshot |
| E14 | Low | The editor table overflows (§2.2). The About text has the typos "webauido" and "algolithmically". | screenshot |

### 3.5 Not checkable headlessly

- Audible output and listening in both quality modes. The probes read engine state; they do not render audio.
- Hardware Web MIDI input and the access-success path: rejected in headless Chromium even with the permission granted.
- A real OS file-dialog cancel. It was simulated with an empty FileList via `setInputFiles([])`. Engines differ: some clear the selection and fire `change` with an empty list, while the current HTML specification fires `cancel` without `change`. The demos must handle both.
- Real window focus loss (alt-tab), a pointer released outside the browser window, and touch hardware. These were simulated with input events or synthetic `blur`.
- Firefox and Safari autoplay semantics, and favicon behavior in headed browsers.

## 4. Documentation and metadata

### 4.1 README: wrong at baseline (fix in T9 regardless of other tasks)

| ID | Sev | README line(s) | Statement | Reality (source) |
| --- | --- | --- | --- | --- |
| R1 | Medium | 13 | "drops from 43,217 to 36,804 bytes" | The committed `min.js` is **37,060** bytes, gzip 9,444 (T0). Size figures must be qualified by revision (§4.5, #5). |
| R2 | Medium | 282–283 | Universal SysEx `F0 F7 xx 04 03 lsb msb F7` / `F0 F7 xx 04 04 00 msb F7` | The code checks `msg[1]==0x7f`, so the bytes are `F0 7F xx 04 03 lsb msb F7` and `F0 7F xx 04 04 lsb msb F7` (coarse uses msb only) |
| R3 | Medium | 286 | GS Master Tuning `F0 41 xx 42 12 40 00 05 xx xx xx xx sum F7` | The code requires address `40 00 00` (`msg[7]==0`, length 14). `40 00 05` is Master Transpose (287, correct). |
| R4 | Low | 272, 274 | "120 all sound off", "123 all note off" | 120, 123 and 124–127 all call `allSoundOff` (an immediate cut, not a release). NRPN 98/99 (which clears the RPN) and `0xFF` system reset are handled but undocumented. |
| R5 | Low | 241–242 | Default 0x100 "means +-200 cent" | 0x100 × 100/127 = **201.57** cents (T0) |
| R6 | Medium | 298–315 | Timbre fields | `f` is an **offset in Hz added to** note×`t`, not a fixed frequency. `g` omits AM routing (`g` > 10 means AM into operator `g−10`) and the rule that FM/AM targets must be earlier operators (1-based). `p`/`q` are the pitch-envelope start ratio and time constant, not "pitch bend". The defaults `setTimbre` fills in (`g:0,w:"sine",t:1,f:0,v:0.5,a:0,h:0.01,d:0.01,s:0,r:0.05,p:1,q:1,k:0`) are undocumented. The built-in keys `b`/`c` are ignored. Missing: the operator-0 lifetime rule and voice pruning, which D-010 Q8/Q10 assign to T9 (§6). |
| R7 | Medium | 25–34, 59–60 | Usage snippet; "confirmed to work with Chrome / Firefox / Edge / Safari" | The snippet starts no audio after a gesture and handles no errors; measured, it can report `play:1` with a frozen position (§2.3). Browser support is unverified for this fork; T6 owns the matrix. |
| R8 | Low | 92–103 | Property table | Omits `debug`, `src` and `internalcontext`. The `src` observer and `loadMIDIfromSrc` are vestigial (nothing calls the observers). |
| R9 | Low | 132–135 | `setQuality(q)` | Does not say that it reinstalls the built-in tables and so discards custom timbres, or that any truthy `q` (including `"0"`) selects quality 1 (T0) |
| R10 | Low | 62–68 | Demo pages | Network needs are not stated (unpkg, g200kg.github.io, Google Fonts). #19 asks for them to be documented separately. |
| R11 | Low | various | Upstream typos: "fucntion", "algolithmically", "implimentation", "bellow", "Fore example", "metalic" | |

The rest of the README matches the code. The property defaults (8 rows), the function list, `ready()`, CommonJS usage, `setLoopEnd`, and the controller list apart from R4 are all correct.

### 4.2 `package.json`

| ID | Sev | Finding | Owner |
| --- | --- | --- | --- |
| P1 | Medium | `repository.url` `git+https://github.com/g200kg/webaudio-tinysynth.git` (lines 19–22), `bugs.url` `…/g200kg/webaudio-tinysynth/issues` (25–27) and `homepage` `…/g200kg/webaudio-tinysynth#readme` (28) point upstream. Proposed: `git+https://github.com/Provable-Games/webaudio-tinysynth.git`, `https://github.com/Provable-Games/webaudio-tinysynth/issues` and `https://github.com/Provable-Games/webaudio-tinysynth#readme`. Keep `"author": "Tatsuya Shinyagaito"`. A `contributors` entry for Provable Games is optional. | The package owner (T1 now; D-008). T9 requests it through the supervisor. |
| P2 | Decision | `name` `webaudio-tinysynth` and `version` `1.1.4` are the same as upstream's published npm package. #20 keeps naming and version publication as a separate release decision. | user |
| P3 | Medium | There is no `files` whitelist. At baseline the package also ships `test-midi/README.md`, and it would ship `docs/improvements/**` (T0 §4). #20 acceptance and D-008 require the library, min.js, map, shipped types, LICENSE, NOTICE and README only. | package owner; T9 verifies with `npm pack --dry-run` |
| P4 | — | The `node-minify` devDependency (#15) | T1 (in progress: the uncommitted `t1/tooling` diff already removes it) |
| P5 | Low | `.npmignore` has no final newline. A root `.npmignore` does not override `files`, so it becomes redundant once a whitelist exists. | package owner |
| P6 | — | `types` (and possibly `exports`) after T7 (#17), additive only | T7, then the package owner |

### 4.3 NOTICE and attribution

| ID | Sev | Finding |
| --- | --- | --- |
| N1 | Low | NOTICE (11–24) is complete for the source changes. It omits minor non-source changes: the `package.json` test script and test directory, `.npmignore` `tests`, and the deleted `tinysynth0.png`/`tinysynth1.png`. "The WebAudioTinySynth JavaScript API is unchanged" glosses over the removed GUI-only members (`width`, `height`, `graph`, `disabledrop`, `perfmon`, `layout`, `toTime`), which the README lists. Suggested wording: "unchanged apart from the removed GUI-only members". |
| N2 | — | Each T2–T12 modification set adds a NOTICE entry (contract), and the source header (`webaudio-tinysynth.js` lines 1–9) keeps a matching summary. Editing the header shifts source lines, so it changes the source map and needs the D-003 rebuild commit even though `min.js` bytes stay the same. |
| N3 | — | If T9 vendors `webaudio-controls.js`, keep its Apache-2.0 header (2013 Eiji Kitamura / Ryoya Kawai / Keisuke Ai / g200kg) and the `LICENSE` beside it, and record the commit and sha256. Upstream has no NOTICE file. A NOTICE line for the demo-only dependency is optional. |
| N4 | Decision | Terser drops the source header, so `min.js` contains no attribution: 0 occurrences of `g200kg` or `Apache`. This does not violate Apache-2.0 §4(c), which binds the Source form, and upstream ships no NOTICE file. It does mean the onchain artifact carries no credit. A `/*! … */` header costs roughly 150 bytes and changes the artifact hash. The user decides; T1 would own the build flag (`--comments`). |

### 4.4 Commands and layout claims (shared with T1)

Today the README says that `npm test` runs the differential, tempo and loopEnd suites (line 22), that `npm run build` produces the minified file (55), and that the demos are served with `python3 -m http.server` (63). All three are accurate at baseline. T1 owns the README command sections while it runs. T9 reconciles them at the end: `npm ci`, `lint`, `test:unit`, `test:node`, `test:regression`, `test:browser`, `verify`, the Node pin, and the full-history requirement for the upstream reference (`fetch-depth: 0` or `TINYSYNTH_REFERENCE`).

### 4.5 Statements that must change as T1–T12 land

| Task / issues (ledger) | README / NOTICE / AGENTS statements affected | Required change |
| --- | --- | --- |
| T1: #5, #15, #22–#25 (L-13) | README 13, 22, 55; NOTICE 22–23; AGENTS "Build, Test…" | Commands; a release table of tag, raw/gzip bytes and min.js sha256 qualified by revision; the pinned Terser and build-reproducibility statement; how to verify a hash (#5) |
| T2: #4, #6 (L-01–L-03) | README 158–159 (`loadMIDI`) | Supported SMF formats 0 and 1 with PPQ divisions; descriptive errors for truncated or incomplete tracks, SMPTE, PPQ 0 and format 2; the previous song is kept; recovery when End-of-Track is missing (#20 "supported SMF formats/divisions") |
| T3: #8, #9, #10, #21 (L-04, L-05, L-06, L-08) | README 143–153 (`setLoop`/`setLoopEnd`), 164–171 (`playMIDI`/`locateMIDI`) | Handling of non-advancing loops; empty songs stay stopped; replaying a completed song equals `locateMIDI(0)` plus play; history-independent seek, manual overrides not kept, and next-event positioning (D-005). The default loop wrap stays upstream-compatible. |
| T4: #11, #12 (L-11) | README 106–107, 112–127, usage 25–34; NOTICE | Constructor injection of context and destination, with caller ownership (never closed by the synth); lazy or explicit start; a `resume()` promise with a failure path; `dispose()` and its idempotency; the old graph cleaned up on `setAudioContext`; the gesture example |
| T5: #13, #14 (L-09, L-10) | README 132–135, 158–162, 182–198 | Validation contract (descriptive errors for API misuse, no-ops for malformed raw MIDI); `setTimbre` copies and normalizes (no caller mutation); quality coercion; `loadMIDIUrl` promise, cancellation and stale-response protection; the fire-and-forget example with `.catch` |
| T7: #17 | README "Files" 53–56; AGENTS structure; `package.json` `types` | Source layout (which files are editable, whether the root script is generated), shipped types, unchanged classic-script/CJS/AMD exports |
| T8: #7, #18 (L-07) | README properties and constructor; NOTICE | `seed` option, fixed default seed, generation version, differences across sample rates; init-cost changes; reverb impulse when `useReverb:0` |
| T11: #26 (L-12) | New README section; timbre `w` field (300–304) | `setHarmonicWave`/`setSampleWave`, the D-006 name grammar and reserved names, limits, persistence across quality changes versus custom-timbre reinstallation, fidelity limits (interpolation, aliasing, loop seams), consumer conversions (`imag[i+1]`, `s/128`) |
| T12: #27 (L-12) | Timbre structure 292–317 | `fl`/`ff`/`fk`/`fq` per D-007: the linear-Q to dB conversion for low/high-pass, the key-tracking basis, the clamp to [10 Hz, 0.45·SR], audio-output operators only, FM/AM paths never filtered |
| T9 itself: #19, #20 | README 62–68 (demos), the fork section 4–36, package metadata | Demo network needs (none once vendored), the fork link, ownership/disposal/resume, asynchronous loading, validation failures, fractional tempo and `loopEnd` together in one accurate "What behaves differently" list |

## 5. AGENTS.md (user-owned; proposals only, not applied)

`/workspace/webaudio-tinysynth/AGENTS.md` is untracked and user-owned. #20 says to preserve it unless the user explicitly incorporates changes. Each row gives the current statement, the reality, the proposed correction, and when the correction becomes true.

| # | Current statement | Reality | Proposed correction | True |
| --- | --- | --- | --- | --- |
| A1 | "`webaudio-tinysynth.js` contains the synthesizer, GM timbre tables, MIDI sequencer, and custom element implementation. It supports both the `WebAudioTinySynth` JavaScript API and the `<webaudio-tinysynth>` element without runtime dependencies." | Element and GUI removed in `dbd648d` | "…contains the synthesizer, GM timbre tables and MIDI sequencer. It exposes only the `WebAudioTinySynth` class (CommonJS, AMD or `window.WebAudioTinySynth`); this fork removed the GUI and the `<webaudio-tinysynth>` element. It must remain a dependency-free classic script that can be inlined in a `data:` URI: no network access, and no `</script`, `<script` or `<!--`." | now (revise after T7) |
| A2 | "`simple.html` demonstrates the custom element" | It uses the JS API plus `<webaudio-keyboard>` | "`simple.html` is a minimal page: timbre select, on-screen keyboard and MIDI file playback." | now |
| A3 | "Root PNG files illustrate the documentation." | `tinysynth0/1.png` deleted in `249a015`; only `g200kg160x80.png` remains | "`g200kg160x80.png` is the upstream logo shown by `soundedit.html`." | now |
| A4 | "`bower_components/webaudio-controls/` contains bundled demo controls; avoid unrelated edits there." | The bundled Polymer 1 copy is unused; demos load the controls remotely | Now: "Demos load webaudio-controls from g200kg.github.io, so they need network access. `bower_components/webaudio-controls/` is an unused Polymer 1 copy." After T9: name the pinned vendored file, its commit and sha256. | now / after T9 |
| A5 | (missing) `tests/` | Differential, tempo and loopEnd suites plus a manual Playwright smoke test exist | "`tests/` holds the differential test against upstream `3d75aee` (needs full git history or `TINYSYNTH_REFERENCE`), the tempo and loopEnd regressions, and a manual Playwright smoke test." | now; extend after T1 |
| A6 | "`npm install`: install development dependencies, including Terser." | T1 commits a lockfile and pins Node (D-008) | "`npm ci` (pinned Node 24 LTS, committed lockfile)." | after T1 |
| A7 | "`npm test` currently prints “Error: no test specified” and exits unsuccessfully; it is a placeholder, not a working test suite." | False: `npm test` runs three suites (≈44 s, passes; T0) | Now: "`npm test` runs the differential, tempo and loopEnd suites." After T1: list `lint`, `test:unit`, `test:node`, `test:regression`, `test:browser`, `verify`. | now / after T1 |
| A8 | "No formatter or linting tool is configured." | ESLint arrives with T1 (#22); a formatter is excluded by contract | "ESLint (`npm run lint`) is configured. There is no formatter; do not add one." | after T1 |
| A9 | "There is no automated test framework or coverage threshold." | Node regression suites exist; Vitest and native Node tests come with T1, browser/audio validation with T6 | Describe the suites and their discovery; "no coverage threshold" stays true unless T1 adds one | now / after T1, T6 |
| A10 | "History uses short, descriptive subjects such as “Fixed RPN Fine Tuning” and “Hide log when debug is disabled”" | Those are upstream commits. Fork commits use imperative subjects, and `main` requires signed commits and PRs (D-002). | "Use short imperative subjects (for example “Add loopEnd for whole-bar looping”). Commits must be signed; changes reach `main` through pull requests." | now |
| A11 | "Update `README.md` when public usage changes." | NOTICE must also be updated (contract) | "…and add a NOTICE entry for each modification set, keeping the source header summary in sync." | now |
| A12 | "Edit the main source rather than the minified output." | D-003: the rebuild goes in its own commit | "Never hand-edit `min.js` or its map. Regenerate them with `npm run build` in a separate commit." After T7, name the editable sources. | now / after T7 |
| A13 | "For audio or MIDI changes, check note playback, affected controllers, and both quality modes." | Accurate; gesture startup is missing | Add: "Pages must start audio from a user gesture (`resume()` after T4); check the default autoplay policy, not only `--autoplay-policy=no-user-gesture-required`." | after T4 |
| A14 | (missing) execution records | `docs/improvements/` holds supervisor and task records | "`docs/improvements/` holds planning and execution records; they are not part of the package." | once merged to `main` |

## 6. Plan for T9

T9 implements after T7 and accepts after T12 (plan, status). Items with no engine dependency can be prepared earlier in T9's exclusive files: the demos, README, NOTICE and `bower_components/`.

| # | Change | Issue | Depends on | Files | Validation |
| --- | --- | --- | --- | --- | --- |
| T9-1 | Vendor `webaudio-controls.js` at `282610a` (sha256 `2f780008…`) with its LICENSE and a short provenance note; delete the unused Polymer 1 assets (dependencies checked in §1.2); remove the custom-elements polyfill; point simple and soundedit at the local file. Decide the location (§7, item 2). | #19 | none | `bower_components/webaudio-controls/**` (or `demo/vendor/`), `simple.html`, `soundedit.html`, NOTICE (optional line) | Offline-mode run: zero blocked requests, all three elements defined, screenshots match online; the vendored file's sha256 recorded |
| T9-2 | Remove or self-host the Google Fonts; keep the visual design with a local font stack | #19 | none | `soundedit.html` | Offline run: no remote request; before and after screenshots |
| T9-3 | Explicit audio start: call `synth.resume()` (or the T4 lazy start) from the first `pointerdown`, `keydown`, `click` or `change` in every demo; show a visible "audio blocked, click to start" state and any `resume()` rejection; ideally create no context before the gesture, which removes the autoplay warnings | #19, #12 | T4 (`resume()` contract, lazy or injected start) | all three demos | Default policy at an http origin, with no `evaluate` before the gesture (§2.3): `suspended` before the gesture, `running` after the first one, no unhandled rejection, no console errors |
| T9-4 | File handling: guard an empty FileList and the `cancel` event; add `FileReader.onerror`; `try/catch` around `loadMIDI`; never `playMIDI()` after a failed load (S2); show errors in a visible status line (`role="status"`); add `accept=".mid,.midi"` everywhere | #19, #4, #6, #13 | Guards: none. Error text: T2 (parser errors), T5 (validation). | all three demos | Empty FileList, non-MIDI file, truncated file (#4 fixture), SMPTE header (#6): a visible message, no page error, the previous song kept (and stopped, if T2 defines that) |
| T9-5 | URL loading: `synth.loadMIDIUrl(url).then(show).catch(show)` in jstest and soundedit; a stale or cancelled load shows nothing misleading | #19, #14 | T5 (promise, cancellation) | `jstest.html`, `soundedit.html` | Routes for 404, connection refused, abort and malformed bytes: a visible message, no unhandled rejection; success path |
| T9-6 | Note release robustness. jstest/shot buttons: pointer events with `setPointerCapture`, plus `pointerup`/`pointercancel`/`lostpointercapture`; Space/Enter keydown/keyup with a repeat guard. A per-demo set of sounding notes keyed by input source, with note-off sent for the stored note (fixes E2 and the `MidiIn` wrap, with notes clamped to 0–127). `blur`, `visibilitychange` and `pagehide` release every tracked note, clear the control display (`kb.setNote(0,n)`), and release Shift-sustain. No edits to the control library. | #19 | none | all three demos | The stuck-note oracle (§3) is empty after each scenario: outside release, pointer cancel, focus loss with a key held, window blur with the mouse down, octave change between on and off, Shift held across blur. Run with sustain on and off. |
| T9-7 | MIDI access: visible text for unsupported, denied and zero-input cases; a `statechange` handler that rebuilds the port list; remove the `console.log(midiPort)` noise | #19 | none | `soundedit.html` | Headless: denied path; unsupported path (an init script deletes `navigator.requestMIDIAccess`); success path with a stubbed `requestMIDIAccess` and a fake input that drives `MidiIn` note tracking. Hardware: manual, recorded. |
| T9-8 | Editor correctness. Build a fresh operator array from the form and call `synth.setTimbre(m,n,p)` rather than mutating `synth.program`/`drummap` (E6); fix the extra operator (E5), the drum index (E7) and the drum range guard (E8); send program change on `curMidi` (E9); after `setQuality`, reapply the edited timbre or say it was reset; show validation errors. Exporting the patch as JSON is optional. | #19, #13 | T5: whether `setTimbre` copies and validates, and **whether it rejects the editor's `b`/`c` keys and zero-volume or `t:0` operators**. T7 if the built-in tables become frozen or shared. | `soundedit.html` | Round trip: an edit installs exactly the form's values; the T0 built-in table hashes are unchanged after edits; both qualities; drum and melodic edits; screenshot |
| T9-9 | Initialize sliders and knobs from engine state (J4, E12) | #19 | none | `jstest.html`, `soundedit.html` | UI values equal engine values at load |
| T9-10 | Add the fork link next to the upstream credit and logo; add `<title>` and `<meta charset>`; optionally a switch to load `min.js` so demos can exercise the onchain artifact | #19, #20 | none | demos | Screenshots; both builds load |
| T9-11 | Tests for #19 acceptance: a demo browser test over a local static server with non-local hosts blocked, under the default autoplay policy. It covers selection cancel, outside and cancelled pointer release, focus loss, key release, octave change, MIDI denied or unsupported, URL and file failures, and zero remote requests. Seed it from `_evidence/t9-audit/scripts/run-demos.js`. | #19, #16 | T9-1 (deterministic offline controls); T6 harness conventions; T1/T1B for the `test:browser` script and CI wiring | test file under T6's harness layout; script and CI entries go through the owners | CI run green; a deliberately reintroduced mouse-only handler fails the test |
| T9-12 | README: fix R1–R11; add the D-010 Q8 operator-0 lifetime rule (melodic voices end 3.5·`r[0]` after note-off, drums stop 3.5·`d[0]` after note-on, so a drum with `d[0]=0` is silent) and the Q10 pruning rule (released voices go first, drum hits prune melodic voices); document every §4.5 row; replace the usage snippet with a gesture-plus-error-handling example; document demo network needs; add the release/size table qualified by revision | #20, #26, #27 | Final APIs from T2–T5, T7, T8, T11, T12; T1 commands | `README.md` | Every README example executed in a browser test (default policy); commands reproduced from a fresh full-history clone; the size/hash table matches `npm run verify` output |
| T9-13 | NOTICE and source-header summaries for every modification set (N1–N3) | #20 | each task's final change list | `NOTICE`, `webaudio-tinysynth.js` header (or the T7 sources) | Rebuild commit per D-003 if the header moves; upstream attribution intact |
| T9-14 | Package metadata P1 and P3 | #20 | the package owner (D-008); P2 is a user decision | `package.json` (by the owner) | `npm pack --dry-run --json` lists only the library, min.js, map, types, LICENSE, NOTICE, README and `package.json` |
| T9-15 | Contribution guidance: give the user the §5 corrections. Either the user applies them to the untracked AGENTS.md, or T9 adds a tracked `CONTRIBUTING.md` or a README "Development" section with the final commands and layout. | #20 | T1 and T7 final layout | the tracked choice only | Commands in the guidance reproduce the CI checks |
| T9-16 | Documentation for the #26/#27 fields and APIs (required). Editor UI support for registered waves and filters is optional (§7, item 6). | #26, #27 | T11, T12 | `README.md` (± `soundedit.html`) | The consumer setup fixture's calls are documented; examples run |

**Status (T9-D3):** T9-10 and the low findings E13, E14, X7 and J5 are done; see `tasks/T9-D3.md` (E13: the Patch field is marked read-only output rather than given an import path). With T9-D and T9-D2, every #19 row except the documentation rows (T9-12 to T9-16, which belong to #20) is done.

Suggested order: T9-1, T9-2, T9-6, T9-7, T9-9, T9-10 and the T9-4 guards first (no engine dependency); then T9-11 once T6's harness exists; T9-3 after T4; T9-5 and T9-8 after T5; the README layout sections after T7; T9-16, the final README size/hash table, NOTICE and T9-14 last, after T12 and the final pinned build.

Screenshots to record for visible changes: each demo online and offline, before and after; the soundedit editor open; the error and status states (blocked audio, file error, URL error, MIDI unavailable).

## 7. Risks and decisions

1. **T0 §2 reconciliation (supervisor).** The autoplay restriction is observable at an `http://127.0.0.1` origin in this headless shell. The earlier "cannot observe" conclusion applied to `setContent`/`data:` pages. `page.evaluate` confers user activation, so gesture tests must not evaluate before the gesture step. This affects how T6 tests #12.
2. **Vendoring location (supervisor).** Option A: keep the path `bower_components/webaudio-controls/webaudio-controls.js` and delete the Polymer 1 files (the least churn; the contract already reserves this directory for #19). Option B: move to `demo/vendor/` and delete `bower_components/` entirely. Either way, until the file is vendored, the demos depend on an unversioned remote file that can change at any time, and the #19 stuck-note tests cannot run deterministically in CI.
3. **Editor and `setTimbre` contract (T5 coordination).** The editor works today only by mutating aliased internal tables. After L-09 and immutable built-in tables it must use `setTimbre`, and quality switches will then reset its edits. T5 should state whether unknown keys (`b`, `c`) and the editor's placeholder operators are accepted.
4. **min.js attribution header (user).** Zero attribution strings in the onchain artifact. A `/*! … */` header costs about 150 bytes and changes the hash. This is a choice, not a license violation.
5. **Package name and version (user).** `webaudio-tinysynth@1.1.4` collides with upstream on npm. P1 (URLs) can land through the package owner without deciding this.
6. **Scope (user or supervisor).** Should the patch field gain an import (parse) path, and should the editor support #26 waves and #27 filters, or should those be documented only?
7. **AGENTS.md (user).** Apply the §5 rows A1–A4, A7, A10–A12 now. A5–A6, A8–A9 and A13–A14 depend on T1, T4 and the `main` merge. Alternatively, move the guidance into a tracked file (T9-15).
8. **Engines.** Only Chromium was exercised. Firefox and WebKit gesture behavior (transient versus sticky activation for the Play path) belongs to T6's matrix.

## 8. Reproduction

```sh
E=/workspace/webaudio-tinysynth-worktrees/_evidence/t9-audit
$E/scripts/run.sh                                   # loads + interaction probes -> results.json, screenshots/
SCRIPT=run-gesture2.js PORT=8767 $E/scripts/run.sh  # gesture probes -> results-gesture2.json
SCRIPT=run-gesture.js  PORT=8766 $E/scripts/run.sh  # MIDI permission console capture -> results-gesture.json
```

`run.sh` serves the worktree with `python3 -m http.server` on 127.0.0.1 and sets `LD_LIBRARY_PATH` and `PLAYWRIGHT_CORE` to the T0 tools. Remote snapshots: `curl` of the three remote URLs into `$E/remote/` (with headers), and `raw.githubusercontent.com/g200kg/webaudio-controls/282610a…/webaudio-controls.js`, which `cmp` reports identical. Read-only network commands: `git ls-remote` and `gh api repos/g200kg/webaudio-controls…` for the upstream commit and license, `npm view webaudio-controls` (404), and `gh issue view 19|20`. No tracked file was modified; `git status` shows only this file.
