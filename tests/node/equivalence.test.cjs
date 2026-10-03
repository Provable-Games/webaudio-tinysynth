/*
 * Source and minified builds behave identically on a generated, valid MIDI
 * file that exercises tempo changes, several channels, programs,
 * controllers, RPN, pitch bend, sustain, drums, velocity-0 note-offs and a
 * SysEx master tuning message: the same _note calls and the same WebAudio
 * call trace, for a full pass and after seeking.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const H = require("../harness");

const PPQ = 96;
const cc = (tick, ch, n, v) => ({ tick, bytes: [0xb0 | ch, n, v] });

function song() {
  const ev = [
    H.midi.tempo(0, 455000),
    { tick: 0, bytes: [0xf0, 0x07, 0x7f, 0x7f, 0x04, 0x04, 0x00, 0x42, 0xf7] }, // master coarse tuning +2
    { tick: 0, bytes: [0xc0, 24] }, { tick: 0, bytes: [0xc1, 48] }, { tick: 0, bytes: [0xc2, 80] },
    cc(0, 0, 7, 90), cc(0, 1, 10, 20), cc(0, 2, 11, 70),
    cc(0, 0, 101, 0), cc(0, 0, 100, 0), cc(0, 0, 6, 12), cc(0, 0, 38, 0),     // RPN 0: bend range 12 semitones
    cc(0, 1, 101, 0), cc(0, 1, 100, 1), cc(0, 1, 6, 0x50), cc(0, 1, 38, 0x10), // RPN 1: fine tuning
    H.midi.tempo(8 * PPQ, 470000),
  ];
  for (let i = 0; i < 48; ++i) {
    const tick = i * PPQ / 2 + (i % 3) * 7;
    ev.push(H.midi.noteOn(tick, 0, 48 + (i % 24), 40 + (i % 80)), H.midi.noteOff(tick + 40, 0, 48 + (i % 24)));
    if (i % 2 === 0) ev.push(H.midi.noteOn(tick, 1, 60 + (i % 12), 100), { tick: tick + 30, bytes: [0x91, 60 + (i % 12), 0] });
    if (i % 3 === 0) ev.push(H.midi.noteOn(tick, 2, 55 + (i % 7), 90), H.midi.noteOff(tick + 60, 2, 55 + (i % 7)));
    if (i % 4 === 0) ev.push(H.midi.noteOn(tick, 9, 35 + (i % 47), 110));
    ev.push({ tick, bytes: [0xe0, (i * 4) & 0x7f, 64 + (i % 8)] });
    if (i % 5 === 0) ev.push(cc(tick, 0, 1, (i * 5) & 0x7f));
  }
  ev.push(cc(10 * PPQ, 2, 64, 127), cc(16 * PPQ, 2, 64, 0));
  const noteOns = ev.filter((e) => (e.bytes[0] & 0xf0) === 0x90 && e.bytes[2] > 0).length;
  return { bytes: H.makeMidi(PPQ, ev), noteOns };
}

function play(variant, bytes) {
  const { synth, env, trace, notes } = H.createSynth(variant.source, variant.name);
  synth.loadMIDI(H.toArrayBuffer(bytes));
  synth.setLoop(0);
  synth.playMIDI();
  assert.ok(H.runUntil(env, () => synth.getPlayStatus().play === 0, 10 * 60 * 1000), variant.name + ": song did not finish");
  H.runUntil(env, () => false, 3000);
  const firstPass = { notes: notes.length, status: { ...synth.getPlayStatus() } };
  synth.locateMIDI(12 * PPQ);
  synth.playMIDI();
  H.runUntil(env, () => synth.getPlayStatus().play === 0, 10 * 60 * 1000);
  H.runUntil(env, () => false, 3000);
  // Objects made inside the vm context have its prototypes; compare plain data.
  return { firstPass, notes: notes.map((n) => JSON.stringify(n)), trace, voicesLeft: synth.notetab.length };
}

test("source and minified builds produce identical output on a generated song", () => {
  const { bytes, noteOns } = song();
  const [source, minified] = H.forkVariants().map((variant) => play(variant, bytes));
  // The fixture really exercises the synth: every note-on plays, on four channels, and more after the seek.
  assert.equal(source.firstPass.notes, noteOns);
  assert.deepEqual(new Set(source.notes.map((n) => JSON.parse(n)[1])), new Set([0, 1, 2, 9]));
  assert.ok(source.notes.length > source.firstPass.notes, "no notes after locateMIDI");
  assert.deepEqual(minified.firstPass, source.firstPass);
  assert.deepEqual(minified.notes, source.notes);
  assert.equal(minified.trace.length, source.trace.length);
  assert.deepEqual(minified.trace, source.trace);
  assert.equal(minified.voicesLeft, source.voicesLeft);
});
