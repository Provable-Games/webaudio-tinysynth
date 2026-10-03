/*
 * loadMIDI on malformed, truncated and unterminated Standard MIDI Files
 * (issue #4), run in child processes with an external deadline.
 *
 * At the T0 baseline several of these inputs hung loadMIDI in a synchronous
 * loop, which no in-process timeout can stop. So each build's cases run in a
 * child process (this file, started with TINYSYNTH_PARSER_CHILD set) that is
 * killed after DEADLINE_MS. The child prints a line before each case, so a
 * hang names its case.
 *
 * In the child, one synth plays a valid song. Each failing case must throw an
 * Error with the expected code, track and offset, leave the song object, the
 * sequencer and channel state (H.playbackState) unchanged, and make no
 * WebAudio call and no note. The song must then play on to its end. Cases
 * that load (the documented missing End-of-Track recovery) run afterwards.
 */
"use strict";
const path = require("node:path");
const H = require("../harness");

if (process.env.TINYSYNTH_PARSER_CHILD) {
  child(process.env.TINYSYNTH_PARSER_CHILD);
} else {
  parent();
}

/* ---------- child: runs the cases given on stdin against one build ---------- */

function child(build) {
  const fs = require("node:fs");
  const variant = H.forkVariants().find((v) => v.name === build);
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  const bytesOf = (c) => H.toArrayBuffer(Buffer.from(c.b64, "base64"));
  const report = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  const errorInfo = (e) => (e && typeof e === "object" ?
    { code: e.code, message: e.message, name: e.name, hasTrack: "track" in e, track: e.track, offset: e.offset } :
    { thrown: String(e) });

  const s = H.createSynth(variant.source, build);
  s.synth.loadMIDI(H.toArrayBuffer(Buffer.from(input.previous, "base64")));
  s.synth.setLoop(0);
  s.synth.playMIDI();
  H.runUntil(s.env, () => false, 2000);
  report({ previous: { status: { ...s.synth.getPlayStatus() }, notes: s.notes.length } });

  for (const c of input.failures) {
    report({ start: c.name });
    const before = JSON.stringify(H.playbackState(s.synth));
    const song = s.synth.song, traceLength = s.trace.length, notes = s.notes.length;
    let error = null;
    try {
      s.synth.loadMIDI(bytesOf(c));
    } catch (e) {
      error = errorInfo(e);
    }
    report({
      name: c.name, error, sameSong: s.synth.song === song,
      stateUnchanged: JSON.stringify(H.playbackState(s.synth)) === before,
      webAudioCalls: s.trace.length - traceLength, notes: s.notes.length - notes,
    });
  }

  // Every proper prefix of a valid file must fail with a code, and change nothing.
  for (const c of input.sweeps) {
    report({ start: c.name });
    const full = Buffer.from(c.b64, "base64");
    const song = s.synth.song, traceLength = s.trace.length, before = JSON.stringify(H.playbackState(s.synth));
    const codes = {}, anomalies = [];
    for (let cut = 0; cut < full.length; ++cut) {
      try {
        s.synth.loadMIDI(H.toArrayBuffer(full.subarray(0, cut)));
        anomalies.push({ cut, loaded: true });
      } catch (e) {
        const code = e && e.code;
        codes[code] = (codes[code] || 0) + 1;
        if (!code || typeof e.offset !== "number") anomalies.push({ cut, error: errorInfo(e) });
      }
      if (s.synth.song !== song) anomalies.push({ cut, songReplaced: true });
    }
    report({
      name: c.name, prefixes: full.length, codes, anomalies: anomalies.slice(0, 5),
      stateUnchanged: JSON.stringify(H.playbackState(s.synth)) === before, webAudioCalls: s.trace.length - traceLength,
    });
  }

  // The previous song plays on to its end.
  const notesBefore = s.notes.length;
  const finished = H.runUntil(s.env, () => s.synth.getPlayStatus().play === 0, 60000);
  report({ playedOn: { finished, notes: s.notes.length - notesBefore, status: { ...s.synth.getPlayStatus() } } });

  for (const c of input.loads) {
    report({ start: c.name });
    let error = null;
    try {
      s.synth.loadMIDI(bytesOf(c));
    } catch (e) {
      error = errorInfo(e);
    }
    const song = s.synth.song;
    report({
      name: c.name, error, maxTick: s.synth.maxTick, status: { ...s.synth.getPlayStatus() },
      song: { timebase: song.timebase, tempo: song.tempo, ev: JSON.parse(JSON.stringify(song.ev)) },
    });
  }
  report({ done: true });
}

/* ---------- parent: the cases and their expected results ---------- */

function parent() {
  const test = require("node:test");
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const { spawnSync } = require("node:child_process");

  const DEADLINE_MS = 30000;
  const PPQ = 480;
  const TRACK0 = 22; // first track's data, after the 14-byte MThd chunk and the MTrk chunk header
  const { noteOn, noteOff } = H.midi;

  /* Four notes on channel 0: on at i*480, off 240 ticks later (last event at tick 1680). */
  const fourNotes = () => [0, 1, 2, 3].flatMap((i) => [noteOn(i * PPQ, 0, 60 + i, 100), noteOff(i * PPQ + 240, 0, 60 + i)]);
  const fourNotesBytes = (eot) => H.trackBytes(fourNotes(), eot);
  const secondTrack = () => H.trackBytes([noteOn(0, 1, 72, 100), noteOff(480, 1, 72)]);
  const valid = H.smf(0, PPQ, [fourNotesBytes()]);
  const n4 = fourNotesBytes(false).length; // bytes of the four notes without End-of-Track
  const on = [0x00, 0x90, 60, 100]; // a note-on at delta 0
  /* A single-track fixture whose MTrk length leaves out its last `cut` bytes, which stay in the file after the chunk. */
  const understated = (file, cut) => {
    const b = Buffer.from(fs.readFileSync(path.join(H.ROOT, file)));
    b.writeUInt32BE(b.readUInt32BE(18) - cut, 18);
    return b;
  };
  /* A format-1 file whose track 0 is `t0` (followed by a valid track 1), so a read past track 0 would reach track 1. */
  const withNext = (t0) => H.smf(1, PPQ, [t0, secondTrack()]);

  const previousSong = () => {
    const ev = [H.midi.tempo(0, 455000), { tick: 0, bytes: [0xc0, 5] }, { tick: 0, bytes: [0xb0, 7, 90] }];
    for (let i = 0; i < 32; ++i) ev.push(noteOn(i * 240, 0, 48 + (i % 24), 100), noteOff(i * 240 + 200, 0, 48 + (i % 24)));
    ev.push(H.midi.tempo(16 * 240, 400000), { tick: 1000, bytes: [0xe0, 0, 80] });
    return H.makeMidi(PPQ, ev);
  };

  const T = "SMF_TRUNCATED", M = "SMF_MALFORMED";
  const failures = [
    // Truncated files (each was a hang or a bleed at T0).
    { name: "final End-of-Track bytes removed, chunk length kept", bytes: valid.subarray(0, valid.length - 4), code: T, track: 0, offset: 14 },
    { name: "file cut at 40 bytes", bytes: valid.subarray(0, 40), code: T, track: 0, offset: 14 },
    { name: "ws.mid cut at 40 bytes", bytes: fs.readFileSync(path.join(H.ROOT, "ws.mid")).subarray(0, 40), code: T, track: 0, offset: 14 },
    { name: "fewer track chunks than declared", bytes: H.smf(1, PPQ, [fourNotesBytes()], { ntrks: 2 }), code: T, track: 1, offset: valid.length },
    { name: "second chunk header cut", bytes: Buffer.concat([H.smf(1, PPQ, [fourNotesBytes()], { ntrks: 2 }), Buffer.from("MTr\0\0")]), code: T, track: 1, offset: valid.length },
    { name: "chunk length 0xFFFFFFFF", bytes: H.smf(0, PPQ, [{ raw: H.chunk("MTrk", fourNotesBytes(), 0xffffffff) }], { ntrks: 1 }), code: T, track: 0, offset: 14 },
    { name: "unknown chunk longer than the file", bytes: H.smf(0, PPQ, [{ raw: H.chunk("XFIH", [1, 2, 3], 1000) }, fourNotesBytes()]), code: T, track: 0, offset: 14 },
    // Chunks that fit the file but end inside an event; the next track must not be read.
    { name: "delta-time cut by the chunk end", bytes: withNext([...fourNotesBytes(false), 0x83]), code: T, track: 0, offset: TRACK0 + n4 },
    { name: "event missing after its delta-time", bytes: withNext([...fourNotesBytes(false), 0x00]), code: T, track: 0, offset: TRACK0 + n4 + 1 },
    { name: "channel message cut by the chunk end", bytes: withNext([...fourNotesBytes(false), 0x00, 0x90, 60]), code: T, track: 0, offset: TRACK0 + n4 + 1 },
    { name: "running-status message cut by the chunk end", bytes: withNext([...fourNotesBytes(false), 0x00, 60]), code: T, track: 0, offset: TRACK0 + n4 + 1 },
    { name: "meta event type cut by the chunk end", bytes: withNext([...fourNotesBytes(false), 0x00, 0xff]), code: T, track: 0, offset: TRACK0 + n4 + 1 },
    { name: "meta length cut by the chunk end", bytes: withNext([...fourNotesBytes(false), 0x00, 0xff, 0x01, 0x85]), code: T, track: 0, offset: TRACK0 + n4 + 3 },
    { name: "meta data cut by the chunk end", bytes: withNext([...fourNotesBytes(false), 0x00, 0xff, 0x01, 0x05, 0x41, 0x42]), code: T, track: 0, offset: TRACK0 + n4 + 1 },
    { name: "SysEx data cut by the chunk end", bytes: withNext([...fourNotesBytes(false), 0x00, 0xf0, 0x05, 0x7e, 0x7f]), code: T, track: 0, offset: TRACK0 + n4 + 1 },
    { name: "End-of-Track cut by the chunk end", bytes: withNext([...fourNotesBytes(false), 0x00, 0xff, 0x2f]), code: T, track: 0, offset: TRACK0 + n4 + 3 },
    // A track without End-of-Track must be followed by the end of the file or an MTrk chunk (review F5).
    { name: "missing End-of-Track before trailing bytes", bytes: Buffer.concat([H.smf(0, PPQ, [fourNotesBytes(false)]), Buffer.from([0, 0, 0])]), code: M, track: 0, offset: TRACK0 + n4 },
    { name: "missing End-of-Track before an unknown chunk", bytes: H.smf(1, PPQ, [fourNotesBytes(false), { raw: H.chunk("XFIH", [1]) }, secondTrack()]), code: M, track: 0, offset: TRACK0 + n4 },
    { name: "track length understated to the first event boundary", bytes: H.smf(0, PPQ, [{ raw: H.chunk("MTrk", fourNotesBytes(), 4) }], { ntrks: 1 }), code: M, track: 0, offset: TRACK0 + 4 },
    { name: "all-gm-sounds.mid with its End-of-Track outside the track length", bytes: understated("test-midi/all-gm-sounds.mid", 4), code: M, track: 0, offset: fs.readFileSync(path.join(H.ROOT, "test-midi/all-gm-sounds.mid")).length - 4 },
    { name: "missing End-of-Track in the second of two tracks, before an unknown chunk", bytes: H.smf(1, PPQ, [fourNotesBytes(), secondTrack().slice(0, -4), { raw: H.chunk("XFIH", [1]) }]), code: M, track: 1, offset: valid.length + 8 + secondTrack().length - 4 },
    // Malformed events.
    { name: "delta-time longer than 4 bytes", bytes: H.smf(0, PPQ, [[0x81, 0x80, 0x80, 0x80, 0x00, 0x90, 60, 100, 0x00, 0xff, 0x2f, 0x00]]), code: M, track: 0, offset: TRACK0 },
    { name: "meta length longer than 4 bytes", bytes: H.smf(0, PPQ, [[...on, 0x00, 0xff, 0x01, 0x80, 0x80, 0x80, 0x80, 0x01, 0x41, 0x00, 0xff, 0x2f, 0x00]]), code: M, track: 0, offset: TRACK0 + 7 },
    { name: "SysEx length longer than 4 bytes", bytes: H.smf(0, PPQ, [[...on, 0x00, 0xf0, 0x80, 0x80, 0x80, 0x80, 0x01, 0xf7, 0x00, 0xff, 0x2f, 0x00]]), code: M, track: 0, offset: TRACK0 + 6 },
    { name: "data byte first in a track (no running status)", bytes: H.smf(0, PPQ, [[0x00, 60, 100, ...fourNotesBytes()]]), code: M, track: 0, offset: TRACK0 + 1 },
    { name: "running status after a meta event", bytes: H.smf(0, PPQ, [[...on, 0x00, 0xff, 0x01, 0x01, 0x41, 0x10, 60, 0, 0x00, 0xff, 0x2f, 0x00]]), code: M, track: 0, offset: TRACK0 + 10 },
    { name: "running status after a SysEx event", bytes: H.smf(0, PPQ, [[...on, 0x00, 0xf0, 0x01, 0xf7, 0x10, 60, 0, 0x00, 0xff, 0x2f, 0x00]]), code: M, track: 0, offset: TRACK0 + 9 },
    // Track 0 ends after a note-on without End-of-Track (accepted), so only the per-track reset stops track 1 using its status.
    { name: "running status carried into the next track", bytes: H.smf(1, PPQ, [on, [0x00, 61, 100, 0x00, 0xff, 0x2f, 0x00]]), code: M, track: 1, offset: TRACK0 + 4 + 8 + 1 },
    ...[0xf1, 0xf2, 0xf4, 0xf8, 0xfe].map((st) => (
      { name: "system status 0x" + st.toString(16) + " in a track", bytes: H.smf(0, PPQ, [[...on, 0x00, st, 0x00, 0xff, 0x2f, 0x00]]), code: M, track: 0, offset: TRACK0 + 5 })),
    { name: "status byte as note-on velocity", bytes: H.smf(0, PPQ, [[0x00, 0x90, 60, 0xff, 0x00, 0xff, 0x2f, 0x00]]), code: M, track: 0, offset: TRACK0 + 3 },
    { name: "status byte as program number", bytes: H.smf(0, PPQ, [[0x00, 0xc0, 0x90, 0x00, 0xff, 0x2f, 0x00]]), code: M, track: 0, offset: TRACK0 + 2 },
    ...[[], [0x07], [0x07, 0xa1], [0x07, 0xa1, 0x20, 0x00]].map((data) => (
      { name: "tempo with " + data.length + " data bytes", bytes: H.smf(0, PPQ, [[0x00, 0xff, 0x51, data.length, ...data, ...fourNotesBytes()]]), code: M, track: 0, offset: TRACK0 + 1 })),
    { name: "tempo of 0 microseconds", bytes: H.smf(0, PPQ, [[0x00, 0xff, 0x51, 0x03, 0, 0, 0, ...fourNotesBytes()]]), code: M, track: 0, offset: TRACK0 + 1 },
    { name: "End-of-Track with a data byte", bytes: H.smf(0, PPQ, [[...on, 0x00, 0xff, 0x2f, 0x01, 0x00]]), code: M, track: 0, offset: TRACK0 + 5 },
  ];

  const sweeps = [
    { name: "every prefix of a generated format-1 file", bytes: withNext(H.trackBytes([H.midi.tempo(0, 455000), { tick: 0, bytes: [0xf0, 0x03, 0x7e, 0x7f, 0xf7] }, ...fourNotes()])) },
    { name: "every prefix of ws.mid", bytes: fs.readFileSync(path.join(H.ROOT, "ws.mid")) },
  ];

  /* Expected events for the four notes (plus any others) as {t, m}. */
  const fourNoteEvents = () => fourNotes().map((e) => ({ t: e.tick, m: e.bytes }));
  const loads = [
    { name: "missing End-of-Track in an otherwise complete chunk", bytes: H.smf(0, PPQ, [fourNotesBytes(false)]), maxTick: 1680, ev: fourNoteEvents() },
    {
      name: "missing End-of-Track followed by a second track", bytes: withNext(fourNotesBytes(false)), maxTick: 1680,
      ev: [...fourNoteEvents(), { t: 0, m: [0x91, 72, 100] }, { t: 480, m: [0x81, 72, 0] }].map((e, i) => ({ e, i })).sort((a, b) => a.e.t - b.e.t || a.i - b.i).map((x) => x.e),
    },
    { name: "missing End-of-Track after a final meta event", bytes: H.smf(0, PPQ, [[...fourNotesBytes(false), 0x83, 0x60, 0xff, 0x01, 0x01, 0x41]]), maxTick: 1680 + 480, ev: fourNoteEvents() },
    { name: "missing End-of-Track in an empty chunk", bytes: H.smf(0, PPQ, [[]]), maxTick: 0, ev: [] },
    { name: "missing End-of-Track alone: a single event", bytes: H.smf(0, PPQ, [[0x83, 0x60, 0x90, 60, 100]]), maxTick: 480, ev: [{ t: 480, m: [0x90, 60, 100] }] },
    { name: "missing End-of-Track before an MTrk chunk beyond ntrks", bytes: H.smf(0, PPQ, [fourNotesBytes(false), secondTrack()], { ntrks: 1 }), maxTick: 1680, ev: fourNoteEvents() },
  ];

  const encode = (list) => list.map((c) => ({ name: c.name, b64: Buffer.from(c.bytes).toString("base64") }));
  const input = JSON.stringify({
    previous: previousSong().toString("base64"), failures: encode(failures), sweeps: encode(sweeps), loads: encode(loads),
  });

  /* Run one build's cases in a child process that is killed at the deadline. */
  function runChild(build) {
    const env = Object.assign({}, process.env, { TINYSYNTH_PARSER_CHILD: build });
    delete env.NODE_TEST_CONTEXT;
    const started = Date.now();
    const r = spawnSync(process.execPath, [__filename], {
      input, env, encoding: "utf8", timeout: DEADLINE_MS, killSignal: "SIGKILL", maxBuffer: 1 << 26,
    });
    const lines = r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const starts = lines.filter((l) => l.start);
    if (r.error || r.status !== 0) {
      const last = starts.length ? starts[starts.length - 1].start : "(setup)";
      assert.fail(build + ": child " + (r.error ? r.error.code : "exited " + r.status + " " + r.signal) +
        " after " + (Date.now() - started) + " ms, in case: " + last + "\n" + r.stderr);
    }
    const results = new Map(lines.filter((l) => l.name).map((l) => [l.name, l]));
    return { lines, results, get: (key) => lines.find((l) => key in l)[key] };
  }

  for (const build of ["webaudio-tinysynth.js", "webaudio-tinysynth.min.js"]) {
    test.describe(build + ": malformed input (child process, " + DEADLINE_MS / 1000 + " s deadline)", () => {
      let run;
      test.before(() => {
        run = runChild(build);
      });

      test("the previous song was playing when the bad loads ran", () => {
        const previous = run.get("previous");
        assert.equal(previous.status.play, 1);
        assert.ok(previous.notes > 0 && previous.status.curTick > 0, JSON.stringify(previous));
        assert.ok(run.get("done"), "the child did not finish");
      });

      test("each failing load throws the expected code, track and offset", () => {
        for (const c of failures) {
          const r = run.results.get(c.name);
          assert.ok(r && r.error, c.name + ": loaded without an error");
          assert.deepEqual({ code: r.error.code, track: r.error.track, offset: r.error.offset },
            { code: c.code, track: c.track, offset: c.offset }, c.name + ": " + r.error.message);
          assert.equal(r.error.name, "Error", c.name);
          assert.match(r.error.message, new RegExp("^" + c.code + ": .*\\(track " + c.track + ", byte " + c.offset + "\\)$"), c.name);
        }
      });

      test("each failing load leaves the song, playback and channel state untouched", () => {
        for (const c of failures) {
          const r = run.results.get(c.name);
          assert.deepEqual({ sameSong: r.sameSong, stateUnchanged: r.stateUnchanged, webAudioCalls: r.webAudioCalls, notes: r.notes },
            { sameSong: true, stateUnchanged: true, webAudioCalls: 0, notes: 0 }, c.name);
        }
      });

      test("every truncated prefix of a valid file fails with a code and changes nothing", () => {
        for (const c of sweeps) {
          const r = run.results.get(c.name);
          assert.deepEqual(r.anomalies, [], c.name);
          assert.equal(r.stateUnchanged, true, c.name);
          assert.equal(r.webAudioCalls, 0, c.name);
          // Fewer than 4 bytes cannot hold "MThd"; anything longer but incomplete is truncated.
          assert.deepEqual(r.codes, { SMF_INVALID_HEADER: 4, SMF_TRUNCATED: c.bytes.length - 4 }, c.name);
        }
      });

      test("the previous song then plays on to its end", () => {
        const played = run.get("playedOn");
        assert.equal(played.finished, true);
        assert.ok(played.notes > 0, "no notes after the failed loads");
        assert.equal(played.status.curTick, played.status.maxTick);
        assert.equal(played.status.maxTick, 32 * 240 - 240 + 200);
      });

      test("a track without End-of-Track loads when its chunk ends on an event boundary", () => {
        for (const c of loads) {
          const r = run.results.get(c.name);
          assert.equal(r.error, null, c.name + ": " + (r.error && r.error.message));
          assert.equal(r.maxTick, c.maxTick, c.name);
          assert.deepEqual(r.song.ev, c.ev, c.name);
          assert.equal(r.song.timebase, 4 * PPQ, c.name);
          assert.deepEqual(r.status, { play: 0, maxTick: c.maxTick, curTick: c.ev.length ? c.ev[0].t : c.maxTick }, c.name);
        }
      });
    });
  }
}
