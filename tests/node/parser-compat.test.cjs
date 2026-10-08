/*
 * Valid files parse exactly as before: both builds against the upstream
 * reference with FORK_PATCHES (tests/harness.js), whose loadMIDI is the
 * baseline parser. For every repository MIDI fixture and generated valid files
 * (running status, SysEx and F7 packets, text and copyright metas, metas the
 * engine ignores, long lengths, longer headers, bytes after End-of-Track),
 * the song, maxTick, play status and the WebAudio calls made by loadMIDI must
 * be identical, also when the load replaces a playing song.
 *
 * The documented differences (tasks/T2.md, ledger L-01 to L-03) are pinned
 * against the same reference. Reference loads run under a vm timeout; none of
 * these inputs made the baseline parser hang.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const H = require("../harness");

const REFERENCE = { name: "upstream@" + H.UPSTREAM_COMMIT.slice(0, 7) + "+patches", source: H.referenceSource() };
const { noteOn, noteOff } = H.midi;
const meta = (tick, type, data) => ({ tick, bytes: [0xff, type, ...H.vlq(data.length), ...data] });
const ascii = (str) => [...Buffer.from(str, "latin1")];
const raw = (tick, ...bytes) => ({ tick, bytes });

/* Like the consumer's beast_consumer example: format 0, PPQ 48, one bar, running status within the track. */
function consumerShaped() {
  return H.smf(0, 48, [[
    0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, 0x00, 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08,
    0x00, 0xc0, 0x50, 0x00, 0xb0, 0x07, 0x64, 0x00, 0x0a, 0x40, 0x00, 0xb9, 0x07, 0x5a,
    0x00, 0x90, 0x48, 0x60, 0x00, 0x99, 0x24, 0x64, 0x0c, 0x24, 0x00, 0x1c, 0x90, 0x48, 0x00,
    0x08, 0x4c, 0x60, 0x00, 0x99, 0x26, 0x64, 0x0c, 0x26, 0x00, 0x1c, 0x90, 0x4c, 0x00,
    0x08, 0xff, 0x2f, 0x00,
  ]]);
}

/* Format 1, three tracks, using every event kind the parser handles. */
function everyEventKind() {
  const conductor = H.trackBytes([
    meta(0, 0x03, ascii("conductor")), meta(0, 0x02, ascii("(c) 2026")), meta(0, 0x58, [3, 2, 24, 8]), meta(0, 0x59, [0xfe, 0]),
    H.midi.tempo(0, 455000), H.midi.tempo(960, 470001), meta(1440, 0x01, ascii("y".repeat(200))), meta(1440, 0x06, ascii("marker")),
    meta(1920, 0x7f, new Array(130).fill(7)), H.midi.tempo(1920, 1),
  ]);
  const lead = [
    ...H.vlq(0), 0xf0, 0x05, 0x7e, 0x7f, 0x09, 0x01, 0xf7,          // GM reset
    ...H.vlq(0), 0xc0, 24, ...H.vlq(0), 0xb0, 7, 100, 0x00, 10, 30, // program, CC7, CC10 by running status
    ...H.vlq(0), 0x90, 60, 100, 0x60, 64, 90, 0x60, 60, 0,           // note-ons and a velocity-0 note-off
    ...H.vlq(0), 0xa0, 64, 20, ...H.vlq(10), 0xd0, 50, 0x0a, 40,     // poly and channel pressure, running status
    ...H.vlq(0), 0xe0, 0x00, 0x50, 0x10, 0x7f, 0x7f,                 // pitch bend, running status
    ...H.vlq(200), 0xf7, 0x03, 0x01, 0x02, 0x03,                     // F7 escape packet
    ...H.vlq(0), 0x80, 64, 0, ...H.vlq(0x0fffff), 0x90, 61, 1,       // 3-byte delta
    ...H.vlq(1000), 0xf0, ...H.vlq(150), ...new Array(149).fill(0x11), 0xf7, // SysEx with a 2-byte length
    0x00, 0xff, 0x2f, 0x00,
  ];
  const drums = H.trackBytes([noteOn(0, 9, 36, 100), noteOff(0, 9, 36), noteOn(96, 9, 38, 90), raw(96, 0xb9, 7, 80), noteOff(192, 9, 38)]);
  return H.smf(1, 96, [conductor, lead, drums]);
}

const fixtureFiles = ["ws.mid"].concat(fs.readdirSync(path.join(H.ROOT, "test-midi")).filter((f) => /\.midi?$/i.test(f)).sort().map((f) => "test-midi/" + f));
const simple = H.trackBytes([noteOn(0, 0, 60, 100), noteOff(240, 0, 60), noteOn(480, 1, 62, 100), noteOff(720, 1, 62)]);
const parityFiles = [
  ...fixtureFiles.map((f) => ({ name: f, bytes: fs.readFileSync(path.join(H.ROOT, f)) })),
  { name: "consumer-shaped format 0, PPQ 48, running status", bytes: consumerShaped() },
  { name: "format 1 with every event kind", bytes: everyEventKind() },
  { name: "header length 10", bytes: H.smf(0, 480, [simple], { headerExtra: [0, 0, 0, 0] }) },
  { name: "bytes after End-of-Track inside the chunk", bytes: H.smf(0, 480, [[...simple, 0x00, 0x90, 1, 1, 0xff]]) },
  { name: "bytes after the last declared track", bytes: Buffer.concat([H.smf(0, 480, [simple]), Buffer.from("MTrk\0\0\0\x05\0\x90", "latin1")]) },
  { name: "4-byte delta-times", bytes: H.smf(0, 96, [H.trackBytes([noteOn(0x0fffff00, 0, 60, 100), noteOff(0x0fffff00 + 0x0fffffff, 0, 60)])]) },
  { name: "a track holding only End-of-Track", bytes: H.smf(1, 480, [[0x00, 0xff, 0x2f, 0x00], simple]) },
  { name: "ntrks 0", bytes: H.smf(0, 480, [], { ntrks: 0 }) },
];

/* Load `bytes` into `s.synth` under a vm timeout; return what loadMIDI produced and the WebAudio calls it made. */
function load(s, bytes) {
  const from = s.trace.length;
  const buf = H.toArrayBuffer(Buffer.from(bytes));
  let error = null;
  try {
    vm.runInNewContext("synth.loadMIDI(buf)", { synth: s.synth, buf }, { timeout: 2000 });
  } catch (e) {
    error = e.code || e.message;
  }
  const song = s.synth.song && JSON.parse(JSON.stringify(s.synth.song));
  return { error, song, maxTick: s.synth.maxTick, status: H.statusOf(s.synth), playIndex: s.synth.playIndex, calls: s.trace.slice(from) };
}

function playing(variant) {
  const s = H.createSynth(variant.source, variant.name);
  s.synth.loadMIDI(H.toArrayBuffer(fs.readFileSync(path.join(H.ROOT, "ws.mid"))));
  s.synth.playMIDI();
  H.runUntil(s.env, () => false, 3000);
  return s;
}

const builds = H.forkVariants();
const all = [REFERENCE, ...builds];
/* One idle synth per variant parses the files that need no playing song (construction is slow). */
const idle = new Map();
const idleSynth = (v) => idle.get(v.name) || idle.set(v.name, H.createSynth(v.source, v.name)).get(v.name);

test.describe("valid files parse exactly as the baseline parser", () => {
  for (const file of parityFiles) {
    test(file.name, () => {
      const [ref, ...forks] = all.map((v) => load(idleSynth(v), file.bytes));
      assert.equal(ref.error, null, "the reference failed on " + file.name);
      for (const [i, r] of forks.entries()) assert.deepEqual(r, ref, builds[i].name + ": " + file.name);
    });
  }

  test("replacing a playing song makes the same WebAudio calls and state", () => {
    for (const file of [parityFiles[0], parityFiles.find((f) => f.name.startsWith("consumer"))]) {
      const [ref, ...forks] = all.map((v) => {
        const s = playing(v);
        const r = { load: load(s, file.bytes), state: H.playbackState(s.synth) };
        delete r.state.loopEnd; // a fork property (setLoopEnd) that upstream lacks
        return r;
      });
      assert.ok(ref.load.calls.length > 0, "the reference made no WebAudio call");
      for (const [i, r] of forks.entries()) assert.deepEqual(r, ref, builds[i].name + ": " + file.name);
    }
  });
});

test.describe("documented differences from the baseline parser (ledger L-01 to L-03)", () => {
  /* load() of `bytes` into a fresh synth of each build playing ws.mid, with whether the playback state stayed the same. */
  function rejected(bytes) {
    return builds.map(playing).map((s) => {
      const before = JSON.stringify(H.playbackState(s.synth));
      return Object.assign(load(s, bytes), { unchanged: JSON.stringify(H.playbackState(s.synth)) === before });
    });
  }
  const parse = (bytes) => all.map((v) => load(idleSynth(v), bytes).song);
  const fourNotes = H.trackBytes([0, 1, 2, 3].flatMap((i) => [noteOn(i * 480, 0, 60 + i, 100), noteOff(i * 480 + 240, 0, 60 + i)]));

  test("a non-MThd input: the baseline stopped playback and returned; now SMF_INVALID_HEADER and playback continues", () => {
    const ref = playing(REFERENCE);
    assert.deepEqual([load(ref, Buffer.from("RIFF0000RMID")).error, ref.synth.getPlayStatus().play], [null, 0]);
    for (const r of rejected(Buffer.from("RIFF0000RMID"))) assert.deepEqual([r.error, r.status.play, r.unchanged, r.calls], ["SMF_INVALID_HEADER", 1, true, []]);
  });

  test("an unknown chunk: the baseline counted it as a track and dropped the last track; now it is skipped", () => {
    const second = H.trackBytes([noteOn(0, 1, 72, 100), noteOff(480, 1, 72)]);
    const [ref, ...forks] = parse(H.smf(1, 480, [fourNotes, { raw: H.chunk("XFIH", [1, 2]) }, second]));
    assert.equal(ref.ev.length, 8);
    for (const song of forks) assert.equal(song.ev.length, 10);
  });

  test("a copyright text of 128 bytes or more: the baseline appended one byte past the text; now the text is exact", () => {
    const text = "c".repeat(200);
    const [ref, ...forks] = parse(H.smf(0, 480, [H.trackBytes([meta(0, 0x02, ascii(text)), noteOn(0, 0, 60, 100)])]));
    assert.equal(ref.copyright, text + "\x00"); // the next event's delta-time byte
    for (const song of forks) assert.equal(song.copyright, text);
  });

  for (const [name, bytes, code] of [
    ["a first event using the baseline's file-wide 0x90 running status", H.smf(0, 480, [[0x00, 60, 100, ...fourNotes]]), "SMF_MALFORMED"],
    ["a chunk declared longer than the file, though End-of-Track is present", H.smf(0, 480, [{ raw: H.chunk("MTrk", fourNotes, fourNotes.length + 10) }], { ntrks: 1 }), "SMF_TRUNCATED"],
    ["fewer track chunks than declared", H.smf(1, 480, [fourNotes], { ntrks: 3 }), "SMF_TRUNCATED"],
    ["format 2", H.smf(2, 480, [fourNotes, fourNotes]), "SMF_UNSUPPORTED_FORMAT"],
    ["a system real-time byte (0xF8) in a track", H.smf(0, 480, [[0x00, 0xf8, ...fourNotes]]), "SMF_MALFORMED"],
    ["a status byte as a note-on velocity", H.smf(0, 480, [[0x00, 0x90, 60, 0x80, ...fourNotes]]), "SMF_MALFORMED"],
    ["a 2-byte tempo", H.smf(0, 480, [[0x00, 0xff, 0x51, 0x02, 0x07, 0xa1, ...fourNotes]]), "SMF_MALFORMED"],
    ["End-of-Track with a data byte", H.smf(0, 480, [[...fourNotes.slice(0, -1), 0x01, 0x00]]), "SMF_MALFORMED"],
    ["SMPTE division 0xE728", H.smf(0, 0xe728, [fourNotes]), "SMF_UNSUPPORTED_DIVISION"],
    // Review F5: the baseline read to End-of-Track whatever the length said; a missing End-of-Track is now accepted only at the end of the file or before an MTrk chunk.
    ["all-gm-sounds.mid with a track length that leaves out its End-of-Track", (() => {
      const b = Buffer.from(fs.readFileSync(path.join(H.ROOT, "test-midi/all-gm-sounds.mid")));
      b.writeUInt32BE(b.readUInt32BE(18) - 4, 18);
      return b;
    })(), "SMF_MALFORMED"],
  ]) {
    test(name + ": the baseline loaded it; now " + code + " and the playing song is kept", () => {
      assert.equal(load(idleSynth(REFERENCE), bytes).error, null);
      for (const r of rejected(bytes)) assert.deepEqual([r.error, r.status.play, r.unchanged, r.calls], [code, 1, true, []]);
    });
  }
});
