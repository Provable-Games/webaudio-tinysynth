/*
 * loadMIDI header, format and division checks (issues #4 and #6), and the
 * parsing of valid files: PPQ timing, unknown chunks, longer headers, meta and
 * SysEx events. A failed load must throw an Error with a code and offset
 * (D-013) and change nothing: the song, the sequencer and channel state, and
 * no WebAudio call. Every failing input here has valid track data, so a
 * broken header check loads a song instead of hanging; inputs that reach the
 * track parser are in tests/node/parser.test.cjs, under a deadline.
 */
import { beforeAll, describe, expect, test } from "vitest";
import { H, variants, synthFor, sources, playToEnd } from "./helpers.mjs";

const PPQ = 480;
const { noteOn, noteOff } = H.midi;
const fourNotes = () => [0, 1, 2, 3].flatMap((i) => [noteOn(i * PPQ, 0, 60 + i, 100), noteOff(i * PPQ + 240, 0, 60 + i)]);
const track = () => H.trackBytes(fourNotes());
const valid = H.smf(0, PPQ, [track()]);
/* `valid` with header bytes 8.. replaced by `fields` (format, ntrks, division). */
const withHeader = (fields) => Buffer.concat([valid.subarray(0, 8), Buffer.from(fields), valid.subarray(14)]);
const u16 = (v) => [v >> 8, v & 0xff];

/* The thrown error's code, offset and track, or null if the load succeeded. */
function loadError(synth, bytes) {
  try {
    synth.loadMIDI(H.toArrayBuffer(Buffer.from(bytes)));
  } catch (e) {
    return { code: e.code, offset: e.offset, hasTrack: "track" in e, name: e.name, message: e.message };
  }
  return null;
}

/* The song `bytes` parse to, as plain data. One synth per build does the parsing (construction is slow). */
const parsers = new Map();
function parsed(variant, bytes) {
  if (!parsers.has(variant.name)) parsers.set(variant.name, synthFor(variant).synth);
  const synth = parsers.get(variant.name);
  synth.loadMIDI(H.toArrayBuffer(Buffer.from(bytes)));
  const { ev, timebase, tempo, copyright, text } = JSON.parse(JSON.stringify(synth.song));
  return { ev, timebase, tempo, copyright, text, maxTick: synth.maxTick };
}

const HI = "SMF_INVALID_HEADER", TR = "SMF_TRUNCATED", FMT = "SMF_UNSUPPORTED_FORMAT", DIV = "SMF_UNSUPPORTED_DIVISION";
const headerFailures = [
  { name: "an empty buffer", bytes: [], code: HI, offset: 0 },
  { name: "3 bytes of MThd", bytes: valid.subarray(0, 3), code: HI, offset: 0 },
  { name: "lower-case mthd", bytes: Buffer.concat([Buffer.from("mthd"), valid.subarray(4)]), code: HI, offset: 0 },
  { name: "a RIFF RMID wrapper", bytes: Buffer.concat([Buffer.from("RIFF\0\0\0\0RMIDdata\0\0\0\0"), valid]), code: HI, offset: 0 },
  { name: "header length 0", bytes: [...H.chunk("MThd", []), ...valid.subarray(14)], code: HI, offset: 4 },
  { name: "header length 5", bytes: [...H.chunk("MThd", [0, 0, 0, 1, 1]), ...valid.subarray(13)], code: HI, offset: 4 },
  ...[4, 7, 8, 9, 12, 13].map((cut) => ({ name: "header cut at " + cut + " bytes", bytes: valid.subarray(0, cut), code: TR, offset: 0 })),
  { name: "header length 8 with 6 bytes present", bytes: [...H.chunk("MThd", [0, 0, 0, 1, 0x01, 0xe0], 8)], code: TR, offset: 0 },
  { name: "header length 0xFFFFFFFF (unsigned)", bytes: [...H.chunk("MThd", [0, 0, 0, 1, 0x01, 0xe0], 0xffffffff), ...valid.subarray(14)], code: TR, offset: 0 },
  { name: "header length 0x80000006 (unsigned)", bytes: [...H.chunk("MThd", [0, 0, 0, 1, 0x01, 0xe0], 0x80000006), ...valid.subarray(14)], code: TR, offset: 0 },
  ...[2, 3, 0x100, 0xffff].map((f) => ({ name: "format " + f, bytes: withHeader([...u16(f), 0, 1, ...u16(PPQ)]), code: FMT, offset: 8 })),
  // SMPTE: high byte = -frames per second (two's complement), low byte = ticks per frame.
  ...[[0xe728, "-25 fps, 40 ticks/frame"], [0xe850, "-24 fps, 80"], [0xe350, "-29 fps, 80"], [0xe250, "-30 fps, 80"],
    [0xe204, "-30 fps, 4"], [0xe801, "-24 fps, 1"], [0x8000, "high bit only"], [0xffff, "all bits"]].map(([d, what]) => (
    { name: "SMPTE division 0x" + d.toString(16) + " (" + what + ")", bytes: withHeader([0, 0, 0, 1, ...u16(d)]), code: DIV, offset: 12, message: /SMPTE division/ })),
  { name: "zero PPQ", bytes: withHeader([0, 0, 0, 1, 0, 0]), code: DIV, offset: 12, message: /division 0x0 / },
];

describe.each(variants)("$name: loadMIDI rejects bad headers without side effects", (variant) => {
  let s;
  beforeAll(() => {
    // A song is playing, with a manual program change on top of the song's state.
    s = synthFor(variant);
    s.synth.loadMIDI(H.toArrayBuffer(H.smf(0, PPQ, [H.trackBytes([H.midi.tempo(0, 455000), ...fourNotes(), noteOn(1700, 0, 70, 90)])])));
    s.synth.setLoop(0);
    s.synth.playMIDI();
    H.runUntil(s.env, () => false, 500);
    s.synth.setProgram(1, 33);
  });

  test("the song is playing before the bad loads", () => {
    expect(s.synth.getPlayStatus()).toMatchObject({ play: 1, maxTick: 1700 });
    expect(s.notes.length).toBeGreaterThan(0);
  });

  test.each(headerFailures)("$name: $code at byte $offset", (c) => {
    const before = H.playbackState(s.synth), song = s.synth.song, traceLength = s.trace.length, notes = s.notes.length;
    const error = loadError(s.synth, c.bytes);
    expect(error).toMatchObject({ code: c.code, offset: c.offset, hasTrack: false, name: "Error" });
    expect(error.message).toMatch(new RegExp("^" + c.code + ": .* \\(byte " + c.offset + "\\)$"));
    if (c.message) expect(error.message).toMatch(c.message);
    expect(s.synth.song).toBe(song);
    expect(H.playbackState(s.synth)).toEqual(before);
    expect(s.trace.length).toBe(traceLength);
    expect(s.notes.length).toBe(notes);
  });

  test("the song plays on to its end after the failed loads", () => {
    const notes = s.notes.length;
    expect(H.runUntil(s.env, () => s.synth.getPlayStatus().play === 0, 60000)).toBe(true);
    expect(s.notes.length).toBeGreaterThan(notes);
    expect(s.synth.getPlayStatus()).toEqual({ play: 0, maxTick: 1700, curTick: 1700 });
    expect(s.synth.pg[1]).toBe(33);
  });

  test("a valid load after a failed one installs the new song as before: stop, reset, locate to 0", () => {
    s.synth.playMIDI();
    H.runUntil(s.env, () => false, 300);
    expect(loadError(s.synth, withHeader([0, 0, 0, 1, 0xe7, 0x28]))).toMatchObject({ code: DIV });
    expect(s.synth.getPlayStatus().play).toBe(1);
    expect(loadError(s.synth, H.smf(0, 96, [H.trackBytes([noteOn(96, 2, 64, 100), noteOff(192, 2, 64)])]))).toBe(null);
    expect(s.synth.getPlayStatus()).toEqual({ play: 0, maxTick: 192, curTick: 96 });
    expect(s.synth.song.timebase).toBe(4 * 96);
    expect(s.synth.pg[1]).toBe(0);
    expect(s.synth.notetab).toHaveLength(0);
  });
});

describe.each(variants)("$name: loadMIDI on valid files", (variant) => {
  test.each([1, 96, 480, 0x7fff])("PPQ %i: timebase 4 x PPQ, quarter notes 0.5 s apart at the default 120 BPM", (ppq) => {
    const s = synthFor(variant);
    s.synth.setTimbre(0, 0, [{ w: "sine", t: 1, f: 0, v: 0.5, d: 0.1, s: 0.5, r: 0.1 }]);
    const from = s.trace.length;
    const bytes = H.smf(0, ppq, [H.trackBytes([0, 1, 2, 3].flatMap((i) => [noteOn(i * ppq, 0, 60, 100), noteOff(i * ppq + 1, 0, 60)]))]);
    playToEnd(s, bytes);
    expect(s.synth.song.timebase).toBe(4 * ppq);
    const starts = sources(s.trace, from).map((src) => src.start);
    expect(starts.slice(1).map((t, i) => t - starts[i])).toEqual([0.5, 0.5, 0.5].map((x) => expect.closeTo(x, 9)));
  });

  const twoTracks = [track(), H.trackBytes([noteOn(0, 1, 72, 100), noteOff(960, 1, 72)])];
  const plain = H.smf(1, PPQ, twoTracks);
  test.each([
    ["a header longer than 6 bytes", H.smf(1, PPQ, twoTracks, { headerExtra: [1, 2, 3, 4] })],
    ["unknown chunks before, between and after the tracks", H.smf(1, PPQ, [
      { raw: H.chunk("XFIH", [1, 2, 3]) }, twoTracks[0], { raw: H.chunk("MTrX", []) }, twoTracks[1], { raw: H.chunk("junk", [0xff, 0xff]) }])],
    ["bytes after the last declared track", Buffer.concat([plain, Buffer.from([0x4d, 0x54, 0x72, 0x6b, 0xff, 0x00, 0x01])])],
    ["a third track chunk beyond ntrks", H.smf(1, PPQ, [...twoTracks, H.trackBytes([noteOn(0, 2, 50, 100)])], { ntrks: 2 })],
    ["bytes after End-of-Track inside a chunk", H.smf(1, PPQ, [[...twoTracks[0], 0x00, 0x90, 1, 1], twoTracks[1]])],
  ])("%s: parsed like the plain file", (name, bytes) => {
    expect(parsed(variant, bytes)).toEqual(parsed(variant, plain));
    expect(parsed(variant, plain)).toMatchObject({ maxTick: 1680, timebase: 4 * PPQ });
    expect(parsed(variant, plain).ev).toHaveLength(10);
  });

  test("maxTick is the latest End-of-Track tick, including its delta-time", () => {
    const bytes = H.smf(1, PPQ, [H.trackBytes([noteOn(0, 0, 60, 100), noteOff(240, 0, 60), { tick: 960, bytes: [0xff, 0x2f, 0x00] }], false),
      H.trackBytes([noteOn(0, 1, 60, 100), noteOff(480, 1, 60)])]);
    expect(parsed(variant, bytes).maxTick).toBe(960);
  });

  test("format 0 with two tracks and ntrks 0 load as before", () => {
    expect(parsed(variant, H.smf(0, PPQ, twoTracks)).ev).toHaveLength(10);
    expect(parsed(variant, H.smf(1, PPQ, [], { ntrks: 0 }))).toMatchObject({ ev: [], maxTick: 0 });
  });

  test("meta and SysEx events: tempo, text, copyright, ignored metas, F0 and F7, long lengths", () => {
    const meta = (tick, type, data) => ({ tick, bytes: [0xff, type, ...H.vlq(data.length), ...data] });
    const ascii = (str) => [...Buffer.from(str, "latin1")];
    const longText = "x".repeat(100000), longCopyright = "c".repeat(200);
    const ev = [
      meta(0, 0x02, ascii("(c) A")), meta(0, 0x03, ascii("Title")), meta(0, 0x01, ascii("first")),
      meta(0, 0x58, [4, 2, 24, 8]), meta(0, 0x59, [0, 0]), meta(0, 0x7f, [0, 0, 0x41, 1, 2, 3]), meta(0, 0x60, [9]),
      H.midi.tempo(0, 455000), { tick: 0, bytes: [0xf0, 0x05, 0x7e, 0x7f, 0x09, 0x01, 0xf7] },
      { tick: 10, bytes: [0xf7, 0x02, 0x43, 0x10] }, meta(10, 0x02, ascii(", B")),
      meta(20, 0x09, ascii(longText)), meta(20, 0x02, ascii(longCopyright)),
      { tick: 0x0fffffff, bytes: [0x90, 60, 1] },
    ];
    const p = parsed(variant, H.smf(0, PPQ, [H.trackBytes(ev)]));
    expect(p.ev).toEqual([
      { t: 0, m: [0xff51, 60000000 / 455000] }, { t: 0, m: [0xf0, 0x7e, 0x7f, 0x09, 0x01, 0xf7] },
      { t: 10, m: [0xf0, 0x43, 0x10] }, { t: 0x0fffffff, m: [0x90, 60, 1] },
    ]);
    expect(p.copyright).toBe("(c) A, B" + longCopyright);
    expect(p.text).toBe(longText);
    expect(p.maxTick).toBe(0x0fffffff);
  });
});
