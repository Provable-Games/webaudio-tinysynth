# webaudio-tinysynth (Provable Games fork)
WebAudio Tiny GM mapped Synthesizer [JavaScript], with the GUI removed.

## About this fork

This is [g200kg/webaudio-tinysynth](https://github.com/g200kg/webaudio-tinysynth) by Tatsuya Shinyagaito (g200kg), based on upstream commit [`3d75aee`](https://github.com/g200kg/webaudio-tinysynth/commit/3d75aee4b3f43cbd932265e7d60201fd5b770397). The synthesizer, the timbres and the MIDI sequencer are all upstream's work.

**What is removed:**
- the `<webaudio-tinysynth>` custom element and its HTML attributes;
- its canvas panel: play/stop, seek bar, volume, note and channel indicators, and MIDI file drag-and-drop;
- the GUI-only members `width`, `height`, `graph`, `disabledrop`, `perfmon`, `layout`, `toTime` and the pointer and drag handlers.

**Why:** Provable Games stores this synth onchain and embeds it in NFT `animation_url` pages. Those pages only use the JavaScript API, so every byte of GUI code would be paid for in storage. Without it, `webaudio-tinysynth.min.js` drops from 43,217 to 36,804 bytes.

**What behaves differently:**
- MIDI tempo is kept fractional. Upstream rounds the BPM down to a whole number (`Math.floor(60000000 / microsecondsPerQuarter)`), so 455,000 µs per quarter note (131.868 BPM) plays at 131 BPM, 0.66% slow.
- `loadMIDI` checks the file before installing it, and throws an `Error` when it cannot use it:
  - an invalid `MThd` header: `SMF_INVALID_HEADER`;
  - format 2 or an unknown format: `SMF_UNSUPPORTED_FORMAT`;
  - an SMPTE or zero time division: `SMF_UNSUPPORTED_DIVISION`;
  - data that ends inside a header, chunk or event, or fewer track chunks than declared: `SMF_TRUNCATED`;
  - invalid event data: `SMF_MALFORMED`.

  The error has a `code`, an `offset` (byte offset) and, inside a track, a `track` (0-based track chunk index). A failed load changes nothing: the previous song, playback and channel state are kept. Some irregular files still load, as before: a track without End-of-Track that ends on an event boundary, bytes after End-of-Track, or a header that declares no tracks. So a successful load does not prove a file is strictly valid. Upstream returned silently or loaded what it could read, and some truncated files made it hang.

- Playback no longer hangs or depends on what happened before:
  - Looping a song that cannot advance, for example with every event on one tick and `loopEnd` unset, plays it once and stops. Upstream hung the page. Each timer callback handles at most 1000 events, and the rest follow in order.
  - A song with no playable events, only tempo or metadata, stays stopped: `playMIDI()` does nothing. Upstream reported `play: 1` forever.
  - `playMIDI()` on a finished song starts a new pass at the song's initial tempo and channel state, as `locateMIDI(0)` does. Upstream replayed the opening at the tempo the song ended on. Notes still sounding from the previous pass are not cut.
  - `locateMIDI(tick)` rebuilds tempo and channel state from the song up to `tick`: programs, controllers, bend and bend range, RPN and SysEx tuning. A seek gives the same result whatever happened before. Upstream kept earlier programs and tempo and replayed only some controllers. Channel changes you made with `setProgram`, `send()` and similar, and controller changes scheduled for later, are replaced. Engine settings (volume, reverb, quality, voices, loop, `loopEnd`, timbres) are kept. Seeking with no song loaded does nothing.
  - With `loopEnd` set, the first pass keeps the rest before the song's first event, as every later pass already did: `playMIDI()` from the start (after `loadMIDI()` or `locateMIDI(0)`, or on a finished song) sounds tick 0 0.1 s later and each event at its own tick's time. Upstream, and this fork with `loopEnd` unset, plays the first event at once. A seek to a later tick still resumes at the next event.
- `stopMIDI()` now also stops drums and queued controller changes: every drum hit, sounding or already scheduled, stops, and channel volume, pan and modulation changes scheduled for later are cancelled. A seek (`locateMIDI()`) stops the same way. Upstream let drum hits scheduled up to 0.2 s ahead, and queued controller changes, play on after a stop.
- An instance can start from a user gesture and release everything it uses: the constructor options `context`, `destination` and `lazy`, `resume()` and `dispose()` are new (see [Functions](#functions)). `setAudioContext()` now stops and disconnects the previous graph, and closes the previous context if the synth created it. Ended voices are disconnected, `send()` no longer leaves unhandled promise rejections, and on an `OfflineAudioContext`, `playMIDI()` throws an `Error` with `code` `AUDIO_CONTEXT_OFFLINE` (schedule notes with explicit times instead). Upstream kept every context, graph and timer alive.
- Public functions check their arguments before changing anything. Channels are 0–15; notes, programs, velocities and controller values 0–127 (`setProgram` also selects a program slot you added to `synth.program` yourself; a slot that does not exist throws a `RangeError`); bends and bend ranges 0–16383; times finite and ≥ 0 (or omitted); `setQuality` 0 or 1; `setVoices` a whole number ≥ 1; `setLoopEnd` whole ticks ≥ 0; volumes and reverb levels ≥ 0, within the float32 range AudioParams use. Numeric strings such as `"64"` are accepted. Anything else throws a `TypeError` or `RangeError` and changes nothing; `setQuality("0")` now selects quality 0 (upstream selected 1), and an out-of-range `setTimbre` slot throws instead of being ignored. A malformed raw message passed to `send()` (too short for its status byte, or a data byte above 127) is ignored.
- `setTimbre()` checks the timbre (known or registered waveform, routing only into an earlier operator, finite values, times ≥ 0, valid filter fields) and stores a copy with the defaults filled in: your objects are no longer modified, and the built-in tables are no longer changed by edits to the installed timbre. An invalid timbre throws a `TypeError` or `RangeError` and changes nothing. Times (`a`, `h`, `d`, `r`, `q`) must also be finite as 32-bit floats (up to about 3.4e38), the range Web Audio uses. A note is not played if one of its computed values is outside that range. This can happen at a high note or tuning, for example with a long FM chain or a large `k`. The note makes no sound, creates nothing and takes no voice. Upstream threw part-way through the note in every browser, and Firefox could then render invalid samples.
- `loadMIDIUrl()` returns a promise and accepts `{signal}` to cancel. It resolves once the song is installed and rejects with a coded error otherwise; a newer load or a direct `loadMIDI()` wins over a pending one; `dispose()` cancels it. Ignoring the result never leaves an unhandled rejection.
- A note released before its attack has ended now sounds. Each operator follows its attack up to the note-off and is released from the level it has reached, its level times the elapsed time over its attack time (`v·(T − t)/a`). Upstream cancelled the unfinished attack, so the operator stayed silent until the note-off, and it took every operator's release level from the last operator's attack time instead of its own. For example, at quality 1, a 0.07 s note on the violin, viola, cello, contrabass or tremolo strings (programs 40–44) was silent, and programs 119 (Reverse Cymbal) and 125 (Helicopter) were silent even at 0.3 s. In realtime playback, where `playMIDI()` sends each note-off about 0.2 s ahead, upstream also cut a slow attack to silence from that moment on; now it plays on to the note-off. Notes whose attacks have all ended when they are released sound exactly as before. A zero-length note (note-off at its note-on time) now plays the release of its operators that have no attack (`a = 0`), as most synths do; upstream dropped it whenever the timbre's last operator had an attack.
- The reverb and noise sounds are the same on every load. The reverb impulse and the two noise buffers (`n0`, used by most drums, and `n1`, the metallic noise of cymbals and hi-hats) are generated from a seed instead of `Math.random`, so a given seed, sample rate and library version always produce the same buffer data. The default seed is `0`; pass `seed` to the constructor to choose another. Compared with upstream, the reverb and noise texture changes once and then stays fixed. Upstream drew new random buffers each time an AudioContext was installed. Rendered audio can still differ slightly between browsers and between sample rates.
- Installing an AudioContext is much cheaper, and the cost of the metallic noise moves to first use. Upstream spent nearly all of an install generating `n1` (64 passes of sine products, the noise of cymbals and hi-hats), and also made the reverb impulse when `useReverb` was 0. Now `n1` is generated once per context installation (a `setAudioContext()` with the same object counts), by the first `playMIDI()`, by `prewarm()`, or by the first note that plays it, and the impulse only with reverb on. The data is the same as before for every seed, and `convBuf` is `null` with `useReverb: 0`. Constructing a synth on an `OfflineAudioContext` and playing a first melodic note takes 2–5 ms warm and 9–14 ms in a fresh page in Chromium 153 (44–50 ms and 55–62 ms before), 0.6–4 and 3–8 ms in Firefox 155 (28–35 and 32–49 ms before), and 8–15 and 12–21 ms in WebKit 26.6 (29–52 and 41–55 ms before). The generation takes 41–47 ms in Chromium, 26–29 ms in Firefox and 20–29 ms in WebKit on the machine measured, and every song pays it once per installation: the first `playMIDI()` waits that long before it sets the start, so the song starts slightly later and nothing within it shifts (`startTime` stays exact). A live note you send before that, without `prewarm()`, starts after the generation with its full envelope: in Chromium 153 on a real `AudioContext` the call takes 43 ms and the first `n1` note starts 46 ms after it. Its note-off and sustain-pedal release still match it, whenever they were timed. After `await synth.resume(); synth.prewarm();` live notes start on time. See [tasks/T8.md](docs/improvements/tasks/T8.md) for the measurements.

**What is added:** the `loopEnd` property and `setLoopEnd(ticks)`. When looping, each pass can start on a bar boundary instead of on the song's last event (see `setLoopEnd()` below). Unset, looping works exactly as upstream. `getPlayStatus()` has a fourth field, `startTime`: when tick 0 of the current pass sounds, for syncing visuals to the music. Custom waveforms: `setSampleWave(name, samples)` registers a single-cycle table (for example a 4-bit stepped triangle, a 12.5 % pulse or an LFSR noise table) and `setHarmonicWave(name, real, imag)` a harmonic wave; a timbre operator uses one through its `w` field. Registered waves survive `setQuality()` (custom timbres still need reinstalling) and context changes. Optional fixed filters on an operator's output: the timbre fields `fl`, `ff`, `fq` and `fk` (see [Timbre Object Structure](#timbre-object-structure)); a timbre without `fl` builds exactly the same graph as before.

**What is unchanged:** `new WebAudioTinySynth(options)`, every upstream function documented below apart from the changes above, and the CommonJS / AMD / `window.WebAudioTinySynth` exports.

**Tests:** `npm test` runs the unit tests, the native Node tests and the regression scripts. The differential regression plays every MIDI file in this repository through upstream's file (with the tempo and short-note changes above applied, and nothing else) and through this one, against a mock WebAudio, and checks that both make exactly the same calls. The others check note timing at fractional tempos (`tests/tempo.js`) and `loopEnd` looping (`tests/loop-end.js`). See [Development](#development) for every command.

**Usage:**
```html
<script src="webaudio-tinysynth.min.js"></script>
<script>
  const synth = new WebAudioTinySynth({quality: 1, voices: 64});
  synth.loadMIDI(midiArrayBuffer);   // the bytes of a .mid file
  synth.setLoop(1);
  synth.playMIDI();
  // or play notes directly: synth.send([0x90, 60, 100]);
</script>
```

**License:** Apache License 2.0, unchanged ([LICENSE](./LICENSE)). [NOTICE](./NOTICE) lists the changes.

The rest of this README is upstream's documentation, with the GUI parts removed.

## Overview

**webaudio-tinysynth** is a small synthesizer written in JavaScript with GM like timbre map.
All timbres are generated by the combinations of Oscillator and dynamically generated BufferSource algolithmically without any PCM samples.

- This fork is the JavaScript library only. The synthesizer instance is created like this: `synth = new WebAudioTinySynth()`, and everything is controlled by function calls. (Upstream also provides a `<webaudio-tinysynth>` custom element with a small GUI; it is removed here.)

- The APIs are MIDI like. Function  `send([midi-message],timestamp)` receives MIDI message and generate sounds.

- Two timbre set are supported. These are switched by `quality` option. `quality=0` mode is light-weight chip-tune like sounds that use 1 osc per 1 note. `quality=1` mode is FM based sounds and use 2 or more osc per 1 note.

- webaudio-tinysynth has a built-in MIDI-SMF (.mid file) sequencer, driven by function calls (`loadMIDI()`, `playMIDI()`, `stopMIDI()`, `locateMIDI()`).

## Files
  **webaudio-tinysynth.js** : JavaScript library  
  **webaudio-tinysynth.min.js** : JavaScript library minified version (`npm run build`)  
  Each one works with only one file, there are no dependencies.

## Environment
 Webaudio-tinysynth is confirmed to work with the following browsers
  * Chrome / Firefox / Edge / Safari

## Demo pages
Serve the repository root (for example `python3 -m http.server`) and open:  
 **soundedit.html**  (playable demo with timbre editor / MIDI keyboard via WebMIDI API)  
 **simple.html**  (minimal page: timbre select, on-screen keyboard, MIDI file playback)  
 **jstest.html**  (JavaScript API test page)

- No AudioContext exists until your first click, tap or key press on the page, which starts audio with `resume()` (the demos use `lazy: true`). A Web MIDI note played before that creates one that stays blocked until then. Each page says whether audio is off, blocked by the browser, on, or failed to start, with the error.
- A failed URL load shows the error's `code`, for example `HTTP_STATUS 404`, `NETWORK_ERROR` or `SMF_INVALID_HEADER`. A load replaced by a newer one, or cancelled by choosing a file, shows nothing. In soundedit.html, **Play** plays a song that is still loading once it is installed, and loads the sample song `ws.mid` when no song is loaded or loading. Installing a song creates the AudioContext and resets every channel, so the sample song is not loaded with the page. Choosing another file while a Play waits for a song cancels that Play, so the newest file wins whichever read finishes first: press Play again to play it.
- soundedit.html's Timbre Editor installs each edit with `setTimbre()` and shows a value it rejects. A quality change reinstalls the built-in timbres, and the editor then installs its edited timbres again. The Patch text is a read-only JavaScript array literal for `setTimbre()`, not JSON, and cannot be pasted back into the editor.
- soundedit.html's sustain pedal (the Sustain checkbox or Shift) and a MIDI input's pedal each hold a channel: a channel stays sustained until both are up, including across a channel change.
- The demos make no network request: the page, `webaudio-tinysynth.js`, `ws.mid`, the logo and the vendored `bower_components/webaudio-controls/webaudio-controls.js` all come from the repository. Each page has a title, declares UTF-8 and links to this fork as well as to upstream.

Upstream's hosted demos at [g200kg.github.io/webaudio-tinysynth](https://g200kg.github.io/webaudio-tinysynth/soundedit.html) use the original build with the GUI.

## Usage

### Load this Library

* Necessary file is a `webaudio-tinysynth.js` ( or minified `webaudio-tinysynth.min.js` ) only. Deploy it appropriately and load library:
  * `<script src='webaudio-tinysynth.js'></script>`
  * Or with CommonJS:  
  `var WebAudioTinySynth = require('./webaudio-tinysynth.js');`
* The CDN copies (`g200kg.github.io`, jsDelivr) and the `webaudio-tinysynth` npm package are upstream's build, which still includes the GUI.

### Create a synthesizer

* To make the instance of synthesizer, use following command :  
`synth = new WebAudioTinySynth();`  
  Some options are acceptable. For example :
  * `synth = new WebAudioTinySynth({quality:0, useReverb:0});`

* Then use the function calls described later for that instance. For example...  
 `synth.send([0x90, 60, 100]); // NoteOn:ch1 Note#:60 Velocity:100 `

## Properties

Settings are changed with the functions below (`setMasterVol()`, `setReverbLev()`, `setQuality()`, `setLoop()`, `setVoices()`, `setTsMode()`) or with constructor options. The instance also keeps them as plain properties:

|Property           |Default   |Description               |
|-------------------|----------|--------------------------|
|**masterVol**      | 0.5      | master volume            |
|**reverbLev**      | 0.3      | reverb level             |
|**useReverb**      | 1        | disable Reverb if 0 (constructor option). With 0 the reverb impulse is not generated (`convBuf` is `null`) and no convolver is made, which saves its 0.4–0.5 ms and half of the install's buffer memory (172 of 344 KiB at 44.1 kHz). Like the other settings it is read when a context is installed: set it before `setAudioContext()` or the lazy start. |
|**quality**        | 1        | 0: 1osc/note chiptune like<br/> 1: 2 or more oscs/note FM based|
|**loop**           | 0        | loop playMIDI            |
|**loopEnd**        | 0        | loop length in MIDI ticks; 0 = loop on the last event (see `setLoopEnd()`) |
|**tsmode**         | 0        | default timestamp mode   |
|**voices**         | 64       | Max number of simultaneous voices. Large number needs more CPU. |
|**seed**           | 0        | seed of the reverb and noise buffers (constructor option, read-only) |
|**bufferVersion**  | 1        | version of the buffer generation (read-only). A library change that alters the generated buffers increments it. |

* Assigning `masterVol`, `reverbLev` or `quality` directly does not apply the change; call `setMasterVol()`, `setReverbLev()` or `setQuality()`.
* The constructor creates an AudioContext. Use `setAudioContext()` to switch to your own.
* The synth is ready as soon as the constructor returns (`isReady` is 1). `ready()` is kept for compatibility: it returns a `Promise` that resolves once the synth is initialized.
* `n1` (the metallic noise of cymbals and hi-hats) is generated once per context installation, when it is first needed: by `playMIDI()` (before it reads the clock), by `prewarm()`, or by the first note that plays it. Until then the install does not pay for it, and disposing or replacing the context first never generates it.
* The buffers are generated with mulberry32. The seed is first mixed with murmur3's `fmix32`, then each buffer gets its own stream, starting at `fmix32(seed) + k·2^30` (k = 0 reverb, 1 `n0`, 2 `n1`). So changing or skipping one buffer never changes another.

## Functions
  These functions are available on a `WebAudioTinySynth` instance.  

**WebAudioTinySynth(options)**  
> Constructor of WebAudioTinySynth. options is a object with members :  

>  **quality** : Specify timbre quality same as setQuality(). default is `1`.  
>  **useReverb** : If zero, disable reverb function.  
>  **voices** : max number of voices.  
>  **context** : an AudioContext or OfflineAudioContext to use instead of creating one. It stays yours: the synth never closes it.  
>  **destination** : with `context`, the AudioNode to play into. default is `context.destination`.  
>  **lazy** : if `true`, no AudioContext is created until `resume()`, or until the first call that plays a note or sets MIDI state: `send()`, `noteOn()`, the channel `set...` functions, `reset()`, `loadMIDI()`, `locateMIDI()` or `playMIDI()`. Other calls do not create it, and `getAudioContext()` returns `null` until then. Call `resume()` from the click that starts audio, and call `loadMIDI()` and `reset()` in that click handler or after `resume()`: called earlier, they create the AudioContext outside the gesture (it then starts suspended until `resume()`).  
>  **seed** : an integer from `0` to `4294967295` that fixes the reverb impulse and the noise buffers (`n0`, `n1`). default is `0` (also for `null`). The same seed, `bufferVersion` and sample rate give the same buffer data on every load and in every instance; the data differs between sample rates (the buffers are 0.5 s long).  
>  On an OfflineAudioContext, schedule notes with explicit times; `playMIDI()` throws there. Every note scheduled before the render counts against `voices`, so call `setVoices()` with at least the number of notes, or the earliest ones are dropped.
>
>  For example, `new WebAudioTinySynth({quality:0, useReverb:0, voices:32})`  
>  An invalid `context`, `destination` or `lazy` throws a `TypeError`, and an invalid `seed` a `TypeError` (not a number) or a `RangeError` (not an integer from 0 to 4294967295), before anything is created.

**getAudioContext()**  
> Get current in-use AudioContext.

**setAudioContext(audioContext, destinationNode)**  
> In default, though audioContext is internally created and used, this function can specify `audioContext` should be used.  
> All sounds are routed to specified `destinationNode`, or audioContext.destination is used if destinationNode is not specified.  
> the audioContext in use currently can be accessed with `getAudioContext()` fucntion.
> The previous context's sounds stop, and the synth closes it if it created it. Call `stopMIDI()` before switching contexts during playback: the sequencer keeps the old context's clock, as upstream, so playback on a new context waits until that context's clock catches up.

**prewarm()**  
> Generates the metallic noise `n1` now (20–47 ms on a desktop, once per context installation) instead of at the first `n1` note, so live notes start on time: `await synth.resume(); synth.prewarm();` before sending notes. It is synchronous, returns `undefined`, plays nothing and neither creates nor resumes a context: it does nothing before a lazy synth has one, after `dispose()`, or when `n1` is already built. `playMIDI()` calls it itself, before it reads the clock. It removes this deferred generation only, not other first-use or scheduling costs.

**resume()**  
> Returns a `Promise` that resolves once the AudioContext is running. Browsers start audio only after a user gesture, so call it from a click, key or pointer handler. With `lazy`, it creates the AudioContext first. It rejects with the browser's error, or with an `Error` whose `code` is `AUDIO_CONTEXT_CLOSED` (the context is closed) or `SYNTH_DISPOSED`. On an OfflineAudioContext it resolves at once.
>
> `button.onclick = () => synth.resume().then(() => synth.playMIDI(), (e) => console.error(e));`

**dispose()**  
> Releases the synth: stops every sound, disconnects its nodes, clears its timers, and closes the AudioContext if the synth created it (a context you passed in stays open). Returns a `Promise` that resolves when that is done; calling it again returns the same `Promise`. Afterwards the synth cannot be used again: functions that play or change MIDI state do nothing, `getAudioContext()` returns `null`, `ready()` resolves and `resume()` rejects.

**getTimbreName(m,n)**
> get name of specified timbre. m=0:normal channel voice,n=prog#. or m=1:drum track,n=note#

**setQuality(q)**
> Switch timbre set.  
> q=0 : chip tune like 1 osc / note.  
> q=1 : FM based 2 (or more) osc / note.  
> `q` is 0 or 1 (a numeric string is accepted). Reinstalls the built-in timbres, so custom timbres must be set again afterwards.

**setMasterVol(lev)**
> Master volume setting. default=0.5.

**setReverbLev(lev)**
> Reverb Level setting. default=0.3.

**setLoop(f)**
> if non zero, MIDI play is looped.

**setLoopEnd(ticks)**
> Where a looped song wraps, in MIDI ticks from the start of the song (the same unit as `getPlayStatus().maxTick`). Only matters while `setLoop()` is on.
> - `0` (default): the next pass starts on the song's last event, as upstream does. Any rest after that event is dropped.
> - Non-zero: each pass starts `max(ticks, tick of the last event)` ticks after the previous one. A value below the last event's tick never cuts the song short.
>
> For whole-bar looping, use `bars × quarter notes per bar × ppq`, where ppq is the file's ticks per quarter note. For example, 4 bars of 4/4 at ppq 480 is `setLoopEnd(7680)`. `setLoopEnd(synth.getPlayStatus().maxTick)` loops at the file's end-of-track marker.
>
> Timing: the rest after the last event is timed at the tempo in effect at the end of the song. The next pass then starts again at the song's starting tempo (120 BPM until its first tempo event), so a rest before the first event, and any music before the first tempo event, keep their length on every pass. The first pass keeps that rest too when it starts from tick 0 (after loadMIDI(), locateMIDI(0), or on a finished song).

**setVoices(v)**
> set max voices that simultaneous sounds, default is 64.

**loadMIDI(mididata)**
> load MIDI data to built-in sequencer. mididata is a arraybuffer of SMF (.mid file contents).  
> Throws an `Error` with an `SMF_*` `code` when it cannot parse or does not support the data (see [What behaves differently](#about-this-fork)); the previous song is kept. Some irregular files still load, so it is not a strict validator. Use `try`/`catch` for files you did not create.

**loadMIDIUrl(url, opts)**
> Loads a Standard MIDI File from `url` and returns a promise that resolves with the response's `ArrayBuffer` once the song is installed. It rejects, leaving the current song, with an `Error` whose `code` is `HTTP_STATUS` (with `status`; statuses 200–299 succeed), `NETWORK_ERROR`, `LOAD_SUPERSEDED` (a newer `loadMIDIUrl()` or a direct `loadMIDI()` came first), `SYNTH_DISPOSED`, or an `SMF_*` code from `loadMIDI()`; with `opts.signal`'s reason when that `AbortSignal` aborts (an `AbortError` if the reason is missing or falsy); or with a `TypeError` for a missing `url` or an `opts.signal` that is not an `AbortSignal` (for example an `AbortController` passed instead of its `.signal`). It never throws (an `opts` whose `signal` cannot be read rejects with that error). Fire and forget is safe: `synth.loadMIDIUrl("song.mid")` leaves no unhandled rejection. To show errors: `synth.loadMIDIUrl(url).then(() => synth.playMIDI(), (e) => show(e.code || e.name))`.

**playMIDI()**
> play loaded MIDI data. On a finished song, starts again from the beginning at the song's initial tempo and channel state. Does nothing for a song with no playable events. The first `playMIDI()` on each context installation first generates the metallic noise (see `prewarm()`, 20–47 ms on a desktop) and only then reads the clock, so the song starts slightly later and nothing within it shifts.

**stopMIDI()**
> stop playing MIDI data. Every sounding or scheduled note and drum hit stops, and channel volume, pan and modulation changes scheduled for later are cancelled, so nothing changes after the stop. When `playMIDI()` resumes, it first gives every channel its latest volume, expression, pan and modulation: the values the song had set up to the resume position (including changes it had sent ahead of the stop) and your own, including a change you had scheduled for later with a time. Notes that were due in the 0.2 s after the stop are not replayed, as upstream.

**locateMIDI(tick)**
> locate current playing position in tick. Playback resumes at the first event at or after `tick`. Tempo and channel state are rebuilt from the song up to `tick`, replacing manual channel changes (see [What behaves differently](#about-this-fork)).

**getPlayStatus()**
> get current MIDI sequence play status.
> return value is a object `{play:playstatus, maxTick:maxtick, curTick:currenttick, startTime:time}`. `startTime` is new in this fork.
> `startTime` is the AudioContext time at which tick 0 of the current pass sounds, or `null` when not playing. With `loopEnd` set, an event at tick T of any pass sounds at `startTime` plus the time from tick 0 to T under the song's tempo map (120 BPM until its first tempo event). With `loopEnd` unset this holds only in the first pass: a later pass keeps the tempo the previous one ended on until its first tempo event (as upstream), so `startTime` is extrapolated at that tempo. Use `loopEnd` for exact sync. With `loopEnd` set and play from tick 0, tick 0 sounds 0.1 s after `playMIDI()`. Otherwise (`loopEnd` unset, after a seek or a resume) the next event plays 0.1 s after `playMIDI()`, and `startTime` is when tick 0 would have sounded, which can be in the past. Like `curTick`, it moves to the next pass when the sequencer reaches the end of the current one, up to 0.2 s before the last event sounds and before any rest up to `loopEnd`, so it can be later than `currentTime`: while it is, the previous pass is still sounding.
> To start visuals with the music: `const st = synth.getPlayStatus().startTime; setTimeout(start, (st - ctx.currentTime + (ctx.outputLatency || 0)) * 1000);`

**setTsMode(mode)**
> Set time stamp mode that is used in send() or Channel message functions.  
> If `mode=0` timestamp is a time of in-use audioContext's currentTime timeline.
> If `mode=1` timestamp is HighResolutionTime timeline.  
> With `mode=1`, a time that converts to before the context's current time (for example a `performance.now()` value taken before the context was created) is processed at once.

**setSampleWave(name, samples)**
> Registers a single-cycle sample table under `name` (`n` followed by a letter or `_`, then up to 30 letters, digits or `_`; `n0`, `n1` and other names with a digit second are reserved). `samples` is an array or typed array of one or more numbers in −1..1, copied. Each sample is held for `k = max(1, round(sampleRate/(440·N)))` frames, so the wave plays near its stored rate with sharp steps, and the table's home pitch is `sampleRate/(N·k)`: an operator's frequency (`note × t + f`) is the frequency of one whole cycle, for playback, the pitch envelope and FM. Steps are exact at the home pitch; at other pitches the browser resamples, so edges are interpolated (Chromium and Safari linearly, Firefox band-limited). Long tables (for example a 32,767-step LFSR) are accepted; at a literal `t` they play at very high rates, which Firefox renders slowly, so set `t`/`f` for the cycle rate you want. Registering a name again replaces it for later notes. A one-sample table plays as a constant (DC). Throws `TypeError` for an invalid name or a non-array, `RangeError` for other invalid data.

**setHarmonicWave(name, real, imag)**
> Registers a periodic wave under `name` (`w` followed by a letter or `_`, then up to 30 letters, digits or `_`; `w9999` and other names with a digit second are reserved), built with `createPeriodicWave(real, imag)`: element `i` is harmonic `i` (cosine in `real`, sine in `imag`), element 0 (DC) is ignored, and the peak is normalized to 1. `real` and `imag` are arrays or typed arrays of equal length, at least 2, of numbers that are finite as 32-bit floats; they are copied. Only the coefficients' ratios matter: very large or very small sets are rescaled before use.

**setTimbre(m,n,p)**
> Even webaudio-tinysynth has defaultly GM mapped timbre set, This function can overwrite with user-definable timbre.  
> `m=0` : timbre for normal channel.  
> `m=1` : timbre for rhythm channel (ch=9).  
> `n` : program number for normal channel or notenumber for rhythm channel.  
> `p` : timbre, a non-empty array of operator objects (see [Timbre Object Structure](#timbre-object-structure)); soundedit.html can create one.  
> `setTimbre` checks every operator before changing anything. `w` must be a built-in waveform (`sine`, `square`, `sawtooth`, `triangle`, `w9999`, `n0`, `n1`) or a registered name. `g` must be 0 (output), `n` (FM into operator `n−1`, `n` ≤ 10) or `10+n` (AM into operator `n−1`), where operator `n−1` comes earlier in the array. `a`, `h`, `d`, `r` and `q` must be ≥ 0 and finite as 32-bit floats (up to about 3.4e38); `t`, `f`, `v`, `s`, `p` and `k` finite; filter fields as described there. Numeric strings are read with `Number()`, and missing fields take their defaults. `p` is copied: unknown keys are kept and ignored, and later changes to your objects do not reach the synth. An invalid `p`, an `m` other than 0 or 1, or an `n` out of range (0–127 for `m=0`, 35–81 for `m=1`) throws a `TypeError` or `RangeError` and changes nothing. A note whose computed pitch, pitch-envelope target, level or sustain level is outside the 32-bit float range is not played. For compatibility, a name that code has written into the synth's internal `noiseBuf` or `wave` objects is still accepted and plays as before. This is unsupported: those objects are rebuilt whenever the AudioContext changes, and they do not exist before a lazy synth's first use. Register waves with `setSampleWave()` or `setHarmonicWave()` instead.

**reset()**
> Reset all channel to initial state. Including all controllers, program, chVol, pan and bendRange.

**send([midi-message], t)**
> midi-message is an array of midi data-bytes for one message. For example,  
> `send([0x90, 60, 100], t)` is for NoteOn ch=1 note#=60 velocity=100.  
> `t` is a timestamp that this message should be processed.  
> The timeline of `t` is depends on timestampmode that is set by setTsMode() function.
> If timestampmode == 0 (default), `t` is a time (sec) in timeline of the in use audioContext.currentTime.  If timestampmode == 1, `t` is a time (msec) in HighResolutionTime (performance.now()) timeline.  
> In both timestamp mode, this message will be immediately processed if `t`=0 or omitted.
> If timestampmode is omitted, the mode depends on the `tsmode` property (default 0, see `setTsMode()`).  
> A message that is too short for its status byte (an array-like message with `length` 0 included), or has a data byte that is not 0–127, is ignored. `t` must be omitted, 0 or a finite time ≥ 0.

#### Channel Message Functions

Followings are voicing functions that controls each note directly. Each function is almost equivalent to corresponding `send([MIDI-message],t)` but prepared for human readability.  

In these functions, the `ch` parameter specify the MIDI channel. Each channel has individual timbre and set of control parameters, for example bend, modulation, expression, and so on. `ch` range is 0-15. (In MIDI spec., called 'channel 1-16')  
`ch`==9 is a special channel for rhythm. In this channel, each note number is assigned to individual percussive instruments according to GM drummap (Note number 35-81).

Almost function has the timestamp, `t` parameter. That specify accurate timing of the effect occur. Refer `send()` function for details of timestamp. Anyway the command is immediately processed if `t` is 0 or omitted.

**noteOn(ch, note, velo, t)**
> Generate a note in specified channel. `note` is the note number that specify pitch. `60` is middle 'C'. `velo` is velocity that control the volume of the note. velocity range is 0-127. this function is processed same as noteOff() if `velo` is `0`.

**noteOff(ch, note, t)**
> stop the note that is generated by noteOn(). One noteOff() (or equivalent noteOn with velo=0) should be called corresponding to one noteOn() call.

**setModulation(ch, val, t)**
> set modulation (vibrato) depth. `val` range is 0-127. +- 100 cent depth if val=127.

**setChVol(ch, val, t)**
> set volume of the channel. `val` range is 0-127. Default value is 100.

**setPan(ch, val, t)**
> Set pan of the channel. `val` range is 0-127. Default value=64.  
>  0:left  
> 64:center  
> 127:right.

**setExpression(ch, val, t)**
> Set expression level. `val` range is 0-127. Both Expression and ChVol are control the Channel volume, but Expression is mainly used as note's articulation.  

**setSustain(ch, val, t)**
> Set sustain pedal state. While sustain is on, generated notes in that channel are sustained even corresponding noteOff() is called. Note that `val` is judged as 'on' if `val>=64`. Usually use `0` and `127` as a value.

**setProgram(ch, pg)**
> Set timbre for that channel. `pg` range is 0-127 that is timbre number in GM map, or a slot you added to `synth.program` yourself (an unsupported compatibility path, as TinyChip uses); a program that does not exist throws a `RangeError` and changes nothing. A MIDI program change through `send()` is 0–127.

**setBend(ch, val, t)**
> Set pitch bend state. Notes in this channel are all affected to this pitch modification. `val` range is 0 to 16383 and the center with no bend is 8192. sensitivity is depends on `setBendRange()` setting. Default state is `8192`.

**setBendRange(ch, val)**
> Set bend sensitivity for that channel. `val` unit is 100/127 cent. That means +-1 octave if 0x600, +-1 semitone if 0x80.
 Default value is 0x100 that means +-200 cent (2 semitone) range.

**allSoundOff(ch)**
> Stop all sound of specified ch immediately. All notes initiated by noteOn() go to noteOff state.

**resetAllControllers(ch)**
> Control parameters of specified ch are reset. It includes Bend / Modulation / Expression / Sustain.

## MIDI implimentation chart

|                        |Recognized|Description                     |
|------------------------|----------|--------------------------------|
|**Basic Channel**       | Yes      | 1-16. ch10 = drum track        |
|**NoteOn / NoteOff**    | Yes      | note# 0-127 / velocity 0-127   |
|**Polyphonic Pressure** | No       |                                |
|**Control Change**      | Yes      | see bellow                     |
|**Program Change**      | Yes      | program 0-127                  |
|**Channel Pressure**    | No       |                                |
|**Pitch Bend**          | Yes      | -8192 - +8191                  |
|------------------------|----------|--------------------------------|
|**Control Number**      |          |                                |
|**1**                   | Yes      | Modulation                     |
|**6 / 38**              | Yes      | Data Entry                     |
|**7**                   | Yes      | Channel Volume                 |
|**10**                  | Yes      | Pan                            |
|**11**                  | Yes      | Expression                     |
|**64**                  | Yes      | Sustain                        |
|**100/101**             | Yes      | RPN Index                      |
|------------------------|----------|--------------------------------|
|**Channel Mode Message**|          |                                |
|**120**                 | Yes      | all sound off                  |
|**121**                 | Yes      | reset all controller           |
|**123**                 | Yes      | all note off                   |
|------------------------|----------|--------------------------------|
|**RPN**                 |          |                                |
|**0**                   | Yes      | Bend Range                     |
|**1**                   | Yes      | Channel Fine Tuning            |
|**2**                   | Yes      | Channel Coarse Tuning          |
|------------------------|----------|--------------------------------|
|**Universal SysEx**     |          |                                |
|**F0 F7 xx 04 03 lsb msb F7** | Yes | Master Fine Tuning            |
|**F0 F7 xx 04 04 00 msb F7** | Yes | Master Coarse Tuning           |
|------------------------|----------|--------------------------------|
|**GS Exclusive**        |          |                                |
|**F0 41 xx 42 12 40 00 05 xx xx xx xx sum F7** | Yes |Master Tuning |
|**F0 41 xx 42 12 40 00 05 xx sum F7** | Yes    |Master Transpose    |
|**F0 41 xx 42 12 40 1x 15 xx sum F7** | Yes    |Use For Rhythm Part |
|**F0 41 xx 42 12 40 1x 4x xx sum F7** | Yes    |Scale Tuning        |
|------------------------|----------|--------------------------------|

## Timbre Object Structure
As you can see that in source code, each timbre is represented as a object array. Fore example the program# 1 "Acoustic Grand Piano" is like this :

```
[{w:"sine",v:.4,d:0.7,r:0.1,},{w:"triangle",v:3,d:0.7,s:0.1,g:1,a:0.01,k:-1.2}]
```
Each element of the array means a oscillator and object member means :  
* g: output destination 0=final output / n=FM to specified osc
* w: waveform  
     "sine"/"sawtooth"/"square"/"triangle" (basic waveforms)  
     "w9999" (summing 1-4 harmonics)  
     "n0" (white noise)  
     "n1" (metalic noise)  
     "n…" (a wave registered with `setSampleWave`)  
     "w…" (a wave registered with `setHarmonicWave`)  
* v: volume  
* t: tune factor according to note#
* f: fixed frequency in Hz
* a: attack time
* h: hold time
* d: decay time
* s: sustain level
* r: release time  (5 params make AHDSR envelope)
* p: pitch bend
* q: pitch bend speed factor
* k: volume key tracking factor
* fl: optional fixed filter on this operator's output, `"lowpass"`, `"highpass"` or `"bandpass"`. Only on an operator with `g:0`. Without `fl` there is no filter.
* ff: cutoff (low- and high-pass) or centre (band-pass) frequency, a normal positive 32-bit float (at least 2^-126): Hz, or with `fk:1` a multiple of the note's frequency (including master, channel and scale tuning; not the operator's `t` or `f`, bend or pitch envelope). Required with `fl`. Clamped to 0.45 × the sample rate.
* fq: resonance as a linear Q, a normal positive 32-bit float (at least 2^-126), default 0.7071 (`Math.SQRT1_2`). Low- and high-pass are given `20·log10(fq)` dB, band-pass `fq`.
* fk: 1 to track the note frequency, 0 (default) for fixed Hz.

Like the other numeric fields, `ff`, `fq` and `fk` also accept a numeric string such as `"1000"`, read with `Number()`.

The filter is fixed for the life of the note, and is released with the voice. Example, a hi-hat through a 3 kHz high-pass: `[{w:"n1",t:0,f:440,v:0.3,d:0.04,fl:"highpass",ff:3000}]`.

You can test how these parameter work with 'Timbre Editor' panel in 'soundedit.html'.  And the created timbre can be used with `setTimbre()` function.

## Development

Use Node 24.21.0 (`.nvmrc`), which comes with npm 11.19.0, and install the locked development tools with `npm ci`. The library itself has no dependencies.

| Command | What it does |
| --- | --- |
| `npm run lint` | ESLint with the recommended rules (`eslint.config.mjs`). |
| `npm run build` | Minifies `webaudio-tinysynth.js` into `webaudio-tinysynth.min.js` and its source map with the pinned Terser. Every option is in `scripts/build.js`. `npm run build -- DIR` writes them to `DIR` instead of the repository root. CI runs this build after each merge; see below. |
| `npm run verify` | Rebuilds into a temporary directory and fails if the committed `webaudio-tinysynth.min.js` or its map differ. Also fails if the minified file or the source contains `</script`, `<script` or `<!--` in any letter case, or a non-ASCII byte. Prints sizes and SHA-256. |
| `npm run size` | Raw size, gzip size and SHA-256 of the source and of a fresh build of it (minified file and map). |
| `npm run bench -- node` / `npm run bench -- browser` | Initialization cost (#18): constructor, `setAudioContext()` parts, first-note readiness, graph size and a dense chord. `node` uses the mock WebAudio for the breakdown; `browser` drives Chromium, Firefox and WebKit through Playwright, cold and warm, for both qualities, reverb on and off, and 44.1 and 48 kHz. `--src=FILE` measures another copy of the library, such as the base commit's source; see the header of `scripts/bench-init.js`. Results: [tasks/T8.md](docs/improvements/tasks/T8.md). |
| `npm run pack:check` | Checks the files `npm pack` would publish, then packs them with a fresh build of the minified file and map, installs the tarball in a scratch project outside the repository and `require()`s it there. |
| `npm test` | `test:unit`, `test:node` and `test:regression`, in that order. It stops at the first failing suite. |
| `npm run test:unit` | Vitest unit tests, `tests/unit/**/*.test.mjs` (`scripts/run-unit-tests.js` runs `vitest run`). |
| `npm run test:node` | `node:test` tests, `tests/node/**/*.test.cjs` (`scripts/run-node-tests.js`), killed after 600 s. |
| `npm run test:regression` | `tests/differential.js`, `tests/tempo.js` and `tests/loop-end.js`, each killed after 300 s. |
| `npm run test:browser` | Offline smoke test of both builds in headless Chromium. Install the browser first with `npx playwright-core install --with-deps --only-shell chromium`. A missing browser fails the test. Chromium runs with autoplay allowed, so the test does not show that audio starts after a user gesture. |

- The regressions compare against upstream commit `3d75aee`, read from git history. Clone with full history (a shallow clone fails), or set `TINYSYNTH_REFERENCE` to upstream's `webaudio-tinysynth.js` at that commit.
- Pull requests do not change `webaudio-tinysynth.min.js` or its map, except a release pull request (see "Releases" below), and nobody edits them by hand. After each merge into `improve/integration`, CI (`.github/workflows/dist.yml`) rebuilds both with the pinned build, runs the tests against the new bytes and commits them as `github-actions[bot]`, titled `Rebuild webaudio-tinysynth.min.js for <commit>`. The `build-verify` check fails a pull request that changes either file, unless its branch is `improve/integration` or `release/*` and both equal a fresh build. Restore them with `git checkout origin/<base branch> -- webaudio-tinysynth.min.js webaudio-tinysynth.min.js.map` and commit. `node scripts/check-dist.js --unchanged-from=origin/<base branch>` runs the same check locally.
- The test commands, `pack:check` and `size` build the current source into the ignored `.build/` directory first and test that, never the committed `webaudio-tinysynth.min.js`, so they leave tracked files unchanged. To test another copy, set `TINYSYNTH_MIN=path/to/file.min.js`. A test file run on its own reads `.build/`; refresh it with `node scripts/test-build.js`.
- The test commands fail closed. `test:unit` and `test:node` fail when no test file matches, when a file passes no test, when a `node:test` file exits before its tests finish, or when fewer files ran or fewer tests passed than the floors committed in `package.json` (`--min-files`, `--min-tests`). When you add tests, raise the floors to the new counts printed at the end of the run. `test:regression` and `test:browser` require each script to exit 0 and print a final `PASS:` line.
- The test commands use POSIX process groups to stop hung tests, so they run on Linux and macOS.
- CI (`.github/workflows/ci.yml`) runs the `lint`, `build-verify`, `test` and `browser-smoke` jobs on pull requests and on pushes to `main`. On pushes to `main` they build and test the current source but do not compare the committed minified file with it: between releases it may be older than the source.
- The browser matrix (`.github/workflows/browser-matrix.yml`) runs on pull requests. Each engine's pre-existing assert specs are split across three `browser (ENGINE, K/3)` jobs, balanced by the measured seconds in `tests/browser/matrix.js` (`--shard=K/N`; `--list --shard=K/N` prints the layout). A `demos (ENGINE)` job runs `npm run test:browser:demos`. The `browser matrix` job rebuilds the aggregate checkout and checks every shard, demo job and case (`node scripts/browser-matrix.js --merge=DIR --expected-context=github`). It binds artifacts to the independently expected GitHub run, checked-out source/min hashes, matrix configuration, exact shard selection, and the resolved Playwright Core version plus `browsers.json` hash and exact browser revision bundle IDs (including the Chromium headless-shell bundle selected by `{ headless: true }` and `PLAYWRIGHT_CORE` overrides). Schema-v3 reports bind full-mix reference provenance as either a present reference content hash or an explicit absent marker, checked against the aggregate checkout. The resolver recognizes a unique manifest macOS WebKit revision override from the resolved executable path; native macOS runtime version and behavior remain unverified. These checks catch stale or misidentified reports, but report metadata is not a cryptographic producer attestation, and pull-request workflows remain PR-owned. The ordinary check retains the pre-existing assert matrix and does not require the unfinished full-mix reference set. The separate `workflow_dispatch` choice `mode: full-mix-qualification` runs the existing `render` and `full-mix` specs through the same runner and aggregate in a distinct `full-mix qualification aggregate` check. That strict lane includes render-matrix GM per-slot peak headroom and first-attempt full-mix/raw-reference requirements; its slot peaks retain measured precision for the full-scale check, while existing RMS formatting and ordinary-lane assertions remain unchanged. Missing or incomplete references and failed first captures keep it red. The qualification artifact is staged under `full-mix-qualification/browser-matrix/` so its uploaded `results.json` matches the aggregate's expected path. The fixture uses the pinned TinyChip regression input and synthetic `ws.mid` profile, not Casey's production MIDI/settings or composer approval. A new spec needs a `seconds` entry. To change the shard count, change the shard list, `SHARD` and the job name together. The organization must separately require the `browser matrix` check and enforce current-base/freshness rules; this change does not alter repository rulesets.

- The browser workflow uses Ubuntu 24.04 x64 runners (`ubuntu-24.04`) for the user-authorized PR #95 comparison with the retained ARM failures. Node, Playwright/browser pins, matrix membership and tolerances are unchanged. This runner change does not establish an ARM cause or qualify the release; historical first-attempt failures remain evidence.

- The pull-request browser workflow opts into the exact exceptions in [the known-failures inventory](docs/improvements/known-failures.md). These include WebKit q1/program120 completed-short-note, q0/48 kHz/drum58 source/min and held-source q1/program119 at 0.0700 s failures documented in [issue #97](https://github.com/Provable-Games/webaudio-tinysynth/issues/97); their original assertions and tolerances still run. The gate rechecks provenance and raw Float32/WAV artifacts, recomputes each accepted GM/drum first-WAV comparison against its recorded difference and first-divergence index, verifies retained drum-repeat roles and kept-source identity, preserves failed raw statuses and checks in reports, and uses a separate validated view for core cross-engine comparisons. Unknown failures, malformed diagnostics, stale provenance, corrupt artifacts, launch/timeouts, and full-mix qualification remain blocking; the `--accept-known-failures` option is core-only.
- When a `render` comparison fails on its first attempt, the runner can retain both original Float32 WAVs for up to six failed comparison pairs per case under `browser-matrix/<engine>/first-attempt-pcm/`. The ordinary shard artifact uploads these bounded files for diagnosis. Diagnostic rerenders are recorded separately and never replace the retained first attempt.
- The strict full-mix lane independently checks fixture note/probe identities against the decoded manifest and derives first-attempt eligibility from the retained measurements, native creation/pruning evidence, page/rejection state and recomputed fault checks. The offline reference exporter rejects failed execution/cleanup assertions and fatal/launch-error engine state, worker timeouts/signals and unexpected worker exits, while allowing an otherwise clean first capture to bootstrap missing references. It reopens first-attempt WAVs and independently rechecks those conditions; prior-method captures or captures without page/abort diagnostics remain inspectable but cannot qualify under the current method. Original capture-method and tolerance hashes must also equal the current fixture contract, and both source/min first-capture method hashes must match it; internally consistent prior identities remain readable but unqualified. A producer's summary status alone cannot qualify a capture. It binds first and captured diagnostic WAVs to the exact fixture/rate/build/attempt path before opening them, then checks their saved status, raw bytes, digest and PCM hash. The exporter requires the observation-level and both source/min build-level first PCM comparisons to exactly match its comparison recomputed from the retained first-WAV pair. Original comparison values/digests and the recomputed digest remain visible; missing, null, malformed or contradictory comparisons are ineligible. A producer-shaped incomplete diagnostic repeat must retain its role, matching first verdict and nonempty error, but may omit its WAV without changing eligible attempt-1 status. Captured-repeat metric and comparison summaries are matched to recomputed raw-WAV observations under the current method; prior-method summaries and recomputed digests are retained separately without qualifying as current evidence. A diagnostic mismatch never replaces or promotes attempt 1, and a failed first attempt remains failed. For a manifest-declared WebKit revision override, the expected runtime version is null, but the observed runtime version must still be nonempty; default browser bundles retain exact version pins. Native macOS runtime and behavior are unverified.
- A local render diagnostic can use a non-default seed without artifact output, for example `npm run test:browser:chromium -- --specs=render --seed=1`. The producer validates against the requested seed and records browser-declared and Node-validated generated-buffer dimensions, lengths and digest at their separate stages. Without `--out`, local checks do not claim sidecar retention; uploaded CI reports must retain the Float32 sidecars, which the aggregate reopens and validates against its independent manifest. On generated-buffer integrity failures only, the producer records fixed digest-descriptor snapshots and map-entry identity/channel observations from digest creation through renderReturn and single-part combine to the existing save/row/comparison stages, including identity checks against the created digest. Runtime details are sanitized and the diagnostic context is capped at 4,096 characters. Successful reports, schema, and integrity verdicts are unchanged; this evidence does not establish a cause or use an external hook.
- Full-mix fixture eligibility and reference use require the pinned `MATRIX.seed`, which is included in the fixture settings hash and retained capture metadata. For the current method, each reported attempt-1 metric object must match metrics recomputed from that build's retained WAV; missing, null or contradictory metrics cannot qualify. Prior-method metrics remain inspectable but do not qualify under the current method.

## Verifying the minified build

The onchain player embeds the exact bytes of `webaudio-tinysynth.min.js` and publishes their SHA-256. To check that a copy was built from this source:

1. Check out a release tag (`vX.Y.Z`) or a `Rebuild webaudio-tinysynth.min.js for …` commit by `github-actions[bot]` on `improve/integration`, with full history and LF line endings (on Windows, `git clone -c core.autocrlf=false`). Use the Node version in `.nvmrc`, and run `npm ci`.
2. Run `npm run verify`. It rebuilds the minified file and its map with the pinned Terser, requires both to equal the committed files byte for byte, and prints their SHA-256.
3. Hash your copy (`sha256sum webaudio-tinysynth.min.js`, or `shasum -a 256` on macOS) and compare.

Elsewhere on `main`, the committed minified file may be older than the source, and `npm run verify` fails there. So does `improve/integration` right after a merge, until CI's rebuild commit lands (about ten minutes).

The minified file starts with the source's license header and has no `sourceMappingURL` comment; to debug it, load `webaudio-tinysynth.min.js.map` next to it. Minification renames local variables only: the class, its methods, options and properties keep their names.

### Releases

On `main`, the minified file and its map change only in a release, made by hand. The steps for the first release, `v2.0.0`, cut once `improve/integration` has been merged into `main`:

1. From `main`, create `release/v2.0.0`. Set the version in `package.json` and `package-lock.json` if it is not already the release's (`npm version 2.0.0 --no-git-tag-version`), run `npm run build`, and commit both generated files.
2. Open a pull request into `main`; `build-verify` requires both files to equal a fresh build. After it is squash-merged, tag the merge commit and push the tag: `git tag -s v2.0.0 <merge sha>` and `git push origin v2.0.0`.
3. Run `gh release create v2.0.0 webaudio-tinysynth.min.js webaudio-tinysynth.min.js.map` from a checkout of the tag, with the SHA-256 and sizes from `npm run size` in the notes.

## License

Licensed under the Apache License, Version 2.0

This fork's modifications are listed in [NOTICE](./NOTICE).
