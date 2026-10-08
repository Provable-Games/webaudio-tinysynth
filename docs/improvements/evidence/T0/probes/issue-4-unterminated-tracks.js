#!/usr/bin/env node
/*
 * T0 probe for issue #4: loadMIDI on tracks without End-of-Track and on
 * truncated files. Each loadMIDI call runs under a 150 ms vm timeout; run the
 * whole probe under an external deadline (run-all.sh uses timeout -s KILL).
 *
 * Cases (format 0 unless noted, PPQ 480, notes on channel 0):
 *   valid-control         complete generated file
 *   ws.mid-control        repository fixture
 *   eot-removed-len-kept  final 4 bytes (00 FF 2F 00) removed, MTrk length unchanged
 *                         (file is 4 bytes shorter than declared)
 *   eot-removed-len-fixed same, with MTrk length corrected (well-formed chunk, no EOT)
 *   cut-at-40             generated file truncated to its first 40 bytes
 *   ws.mid-cut-at-40      ws.mid truncated to its first 40 bytes
 *   fmt1-no-eot-then-valid format 1: track 1 lacks EOT (length exact), track 2 valid
 * Expected at b70ba90 per the issue: the no-EOT and truncated cases hang.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const C = require("./_common");
const { H } = C;

const TIMEOUT_MS = 150;

function notesEvents() {
  const ev = [];
  for (let i = 0; i < 4; ++i) {
    ev.push(H.midi.noteOn(i * 480, 0, 60 + i, 100));
    ev.push(H.midi.noteOff(i * 480 + 240, 0, 60 + i));
  }
  return ev;
}

function cases() {
  const valid = C.smf(0, 480, [C.trackBytes(notesEvents(), true)]);
  const noEot = C.trackBytes(notesEvents(), false);
  const ws = fs.readFileSync(path.join(C.ROOT, "ws.mid"));
  const t2 = C.trackBytes([H.midi.noteOn(0, 1, 72, 100), H.midi.noteOff(480, 1, 72)], true);
  return [
    { name: "valid-control", bytes: valid },
    { name: "ws.mid-control", bytes: ws },
    { name: "eot-removed-len-kept", bytes: valid.subarray(0, valid.length - 4) },
    { name: "eot-removed-len-fixed", bytes: C.smf(0, 480, [noEot]) },
    { name: "cut-at-40", bytes: valid.subarray(0, 40) },
    { name: "ws.mid-cut-at-40", bytes: ws.subarray(0, 40) },
    { name: "fmt1-no-eot-then-valid", bytes: C.smf(1, 480, [noEot, t2]) },
  ];
}

C.emit(C.header("issue-4"));
for (const build of C.BUILDS) {
  for (const c of cases()) {
    const { synth } = H.createSynth(C.source(build), build + " " + c.name);
    const buf = H.toArrayBuffer(Buffer.from(c.bytes));
    const r = C.guarded("synth.loadMIDI(buf)", { synth, buf }, TIMEOUT_MS);
    const ev = synth.song ? synth.song.ev : null;
    C.emit({
      build, case: c.name, fileBytes: c.bytes.length, outcome: r.outcome, ms: C.round(r.ms, 1), error: r.error,
      eventsAtEnd: ev ? ev.length : null,
      maxTick: C.round(synth.maxTick, 3),
      firstEvents: ev ? ev.slice(0, 3).map((e) => ({ t: C.round(e.t, 3), m: e.m.slice(0, 4).map((x) => (x === undefined ? "undefined" : x)) })) : null,
      lastEvent: ev && ev.length ? { t: C.round(ev[ev.length - 1].t, 3), m: ev[ev.length - 1].m.slice(0, 4).map((x) => (x === undefined ? "undefined" : x)) } : null,
      noteOnCount: ev && r.outcome === "returned" ? ev.filter((e) => (e.m[0] & 0xf0) === 0x90).length : null,
    });
  }
}
