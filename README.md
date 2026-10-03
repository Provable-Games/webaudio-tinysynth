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

**What is added:** the `loopEnd` property and `setLoopEnd(ticks)`. When looping, each pass can start on a bar boundary instead of on the song's last event (see `setLoopEnd()` below). Unset, looping works exactly as upstream.

**What is unchanged:** `new WebAudioTinySynth(options)`, every upstream function documented below apart from the `loadMIDI`, `playMIDI` and `locateMIDI` changes above, and the CommonJS / AMD / `window.WebAudioTinySynth` exports.

**Tests:** `npm test` runs the unit tests, the native Node tests and the regression scripts. The differential regression plays every MIDI file in this repository through upstream's file (with the tempo change above applied, and nothing else) and through this one, against a mock WebAudio, and checks that both make exactly the same calls. The others check note timing at fractional tempos (`tests/tempo.js`) and `loopEnd` looping (`tests/loop-end.js`). See [Development](#development) for every command.

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
|**useReverb**      | 1        | disable Reverb if 0 (constructor option). It makes a little save the CPU consumption. |
|**quality**        | 1        | 0: 1osc/note chiptune like<br/> 1: 2 or more oscs/note FM based|
|**loop**           | 0        | loop playMIDI            |
|**loopEnd**        | 0        | loop length in MIDI ticks; 0 = loop on the last event (see `setLoopEnd()`) |
|**tsmode**         | 0        | default timestamp mode   |
|**voices**         | 64       | Max number of simultaneous voices. Large number needs more CPU. |

* Assigning `masterVol`, `reverbLev` or `quality` directly does not apply the change; call `setMasterVol()`, `setReverbLev()` or `setQuality()`.
* The constructor creates an AudioContext. Use `setAudioContext()` to switch to your own.
* The synth is ready as soon as the constructor returns (`isReady` is 1). `ready()` is kept for compatibility: it returns a `Promise` that resolves once the synth is initialized.

## Functions
  These functions are available on a `WebAudioTinySynth` instance.  

**WebAudioTinySynth(options)**  
> Constructor of WebAudioTinySynth. options is a object with members :  

>  **quality** : Specify timbre quality same as setQuality(). default is `1`.  
>  **useReverb** : If zero, disable reverb function.  
>  **voices** : max number of voices.
>
>  For example, `new WebAudioTinySynth({quality:0, useReverb:0, voices:32})`

**getAudioContext()**  
> Get current in-use AudioContext.

**setAudioContext(audioContext, destinationNode)**  
> In default, though audioContext is internally created and used, this function can specify `audioContext` should be used.  
> All sounds are routed to specified `destinationNode`, or audioContext.destination is used if destinationNode is not specified.  
> the audioContext in use currently can be accessed with `getAudioContext()` fucntion.

**getTimbreName(m,n)**
> get name of specified timbre. m=0:normal channel voice,n=prog#. or m=1:drum track,n=note#

**setQuality(q)**
> Switch timbre set.  
> q=0 : chip tune like 1 osc / note.  
> q=1 : FM based 2 (or more) osc / note.

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
> Timing: the rest after the last event is timed at the tempo in effect at the end of the song. The next pass then starts again at the song's starting tempo (120 BPM until its first tempo event), so a rest before the first event, and any music before the first tempo event, keep their length on every pass.

**setVoices(v)**
> set max voices that simultaneous sounds, default is 64.

**loadMIDI(mididata)**
> load MIDI data to built-in sequencer. mididata is a arraybuffer of SMF (.mid file contents).  
> Throws an `Error` with an `SMF_*` `code` when it cannot parse or does not support the data (see [What behaves differently](#about-this-fork)); the previous song is kept. Some irregular files still load, so it is not a strict validator. Use `try`/`catch` for files you did not create.

**loadMIDIUrl(url)**
> load MIDI data from specified url

**playMIDI()**
> play loaded MIDI data. On a finished song, starts again from the beginning at the song's initial tempo and channel state. Does nothing for a song with no playable events.

**stopMIDI()**
> stop playing MIDI data.

**locateMIDI(tick)**
> locate current playing position in tick. Playback resumes at the first event at or after `tick`. Tempo and channel state are rebuilt from the song up to `tick`, replacing manual channel changes (see [What behaves differently](#about-this-fork)).

**getPlayStatus()**
> get current MIDI sequence play status.
> return value is a object `{play:playstatus, curTick:currenttick, maxTick:maxtick}`

**setTsMode(mode)**
> Set time stamp mode that is used in send() or Channel message functions.  
> If `mode=0` timestamp is a time of in-use audioContext's currentTime timeline.
> If `mode=1` timestamp is HighResolutionTime timeline.

**setTimbre(m,n,p)**
> Even webaudio-tinysynth has defaultly GM mapped timbre set, This function can overwrite with user-definable timbre.  
> `m=0` : timbre for normal channel.  
> `m=1` : timbre for rhythm channel (ch=9).  
> `n` : program number for normal channel or notenumber for rhythm channel.  
> `p` : timbre object. Source of this object can be created by soundedit.html **(Details are not yet documented)**

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
> Set timbre for that channel. `pg` range is 0-127 that is timbre number in GM map.

**setBend(ch, val, t)**
> Set pitch bend state. Notes in this channel are all affected to this pitch modification. `val` range is 0 to 16384 and the center with no bend is 8192. sensitivity is depends on `setBendRange()` setting. Default state is `8192`.

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

You can test how these parameter work with 'Timbre Editor' panel in 'soundedit.html'.  And the created timbre can be used with `setTimbre()` function.

## Development

Use Node 24.21.0 (`.nvmrc`), which comes with npm 11.19.0, and install the locked development tools with `npm ci`. The library itself has no dependencies.

| Command | What it does |
| --- | --- |
| `npm run lint` | ESLint with the recommended rules (`eslint.config.mjs`). |
| `npm run build` | Minifies `webaudio-tinysynth.js` into `webaudio-tinysynth.min.js` and its source map with the pinned Terser. Every option is in `scripts/build.js`. |
| `npm run verify` | Rebuilds into a temporary directory and fails if the committed `webaudio-tinysynth.min.js` or its map differ. Also fails if the minified file or the source contains `</script`, `<script` or `<!--` in any letter case, or a non-ASCII byte. Prints sizes and SHA-256. |
| `npm run size` | Raw size, gzip size and SHA-256 of the source, the minified file and the map. |
| `npm run pack:check` | Checks the files `npm pack` would publish, installs the tarball in a scratch project outside the repository and `require()`s it there. |
| `npm test` | `test:unit`, `test:node` and `test:regression`, in that order. It stops at the first failing suite. |
| `npm run test:unit` | Vitest unit tests, `tests/unit/**/*.test.mjs` (`scripts/run-unit-tests.js` runs `vitest run`). |
| `npm run test:node` | `node:test` tests, `tests/node/**/*.test.cjs` (`scripts/run-node-tests.js`), killed after 600 s. |
| `npm run test:regression` | `tests/differential.js`, `tests/tempo.js` and `tests/loop-end.js`, each killed after 300 s. |
| `npm run test:browser` | Offline smoke test of both builds in headless Chromium. Install the browser first with `npx playwright-core install --with-deps --only-shell chromium`. A missing browser fails the test. Chromium runs with autoplay allowed, so the test does not show that audio starts after a user gesture. |

- The regressions compare against upstream commit `3d75aee`, read from git history. Clone with full history (a shallow clone fails), or set `TINYSYNTH_REFERENCE` to upstream's `webaudio-tinysynth.js` at that commit.
- Never edit `webaudio-tinysynth.min.js` or its map by hand. After changing the source, run `npm run build` and commit both files. CI fails if they differ from a fresh build.
- The test commands fail closed. `test:unit` and `test:node` fail when no test file matches, when a file passes no test, when a `node:test` file exits before its tests finish, or when fewer files ran or fewer tests passed than the floors committed in `package.json` (`--min-files`, `--min-tests`). When you add tests, raise the floors to the new counts printed at the end of the run. `test:regression` and `test:browser` require each script to exit 0 and print a final `PASS:` line.
- The test commands use POSIX process groups to stop hung tests, so they run on Linux and macOS.
- CI (`.github/workflows/ci.yml`) runs the `lint`, `build-verify`, `test` and `browser-smoke` jobs on pull requests and on pushes to `main`.

## Verifying the minified build

The onchain player embeds the exact bytes of `webaudio-tinysynth.min.js` and publishes their SHA-256. To check that a copy was built from this source:

1. Check out the commit with full history and LF line endings (on Windows, `git clone -c core.autocrlf=false`), use the Node version in `.nvmrc`, and run `npm ci`.
2. Run `npm run verify`. It rebuilds the minified file and its map with the pinned Terser, requires both to equal the committed files byte for byte, and prints their SHA-256.
3. Hash your copy (`sha256sum webaudio-tinysynth.min.js`, or `shasum -a 256` on macOS) and compare.

The minified file starts with the source's license header and has no `sourceMappingURL` comment; to debug it, load `webaudio-tinysynth.min.js.map` next to it. Minification renames local variables only: the class, its methods, options and properties keep their names.

## License

Licensed under the Apache License, Version 2.0

This fork's modifications are listed in [NOTICE](./NOTICE).
