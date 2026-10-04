/*
 * Loading paths and public surface of both builds: the classic-script
 * global, CommonJS and AMD exports of the (function(window){...})(this)
 * wrapper, Node's require(), the documented methods, and detached method
 * calls. The minified build must match the source in all of them.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const H = require("../harness");

/* Methods documented in README.md (T0 inventory), plus ready(). */
const DOCUMENTED = [
  "allSoundOff", "getAudioContext", "getPlayStatus", "getTimbreName", "loadMIDI", "loadMIDIUrl", "locateMIDI",
  "noteOff", "noteOn", "playMIDI", "ready", "reset", "resetAllControllers", "send", "setAudioContext", "setBend",
  "setBendRange", "setChVol", "setExpression", "setLoop", "setLoopEnd", "setMasterVol", "setModulation", "setPan",
  "setProgram", "setQuality", "setReverbLev", "setSustain", "setTimbre", "setTsMode", "setVoices", "stopMIDI",
];
const PROPERTIES = { masterVol: 0.5, reverbLev: 0.3, quality: 1, loop: 0, loopEnd: 0, tsmode: 0, voices: 64, useReverb: 1 };

/* Run `variant` in a fresh mock environment whose global object also has `extra`. */
function load(variant, extra) {
  const env = H.createEnvironment([]);
  Object.assign(env.sandbox, extra);
  vm.runInContext(variant.source, env.sandbox, { filename: variant.name });
  return env.sandbox;
}

/* Name, type and arity of every own member of a new instance, and the documented property values. */
function surface(variant) {
  const { synth } = H.createSynth(variant.source, variant.name);
  const members = Object.keys(synth).sort().map((k) => [k, typeof synth[k], typeof synth[k] === "function" ? synth[k].length : null]);
  const values = Object.fromEntries(Object.keys(PROPERTIES).map((k) => [k, synth[k]]));
  return { members, values };
}

/* WebAudio calls made through methods taken off the instance and called without it. */
function detachedCalls(variant) {
  const { synth, env, trace } = H.createSynth(variant.source, variant.name);
  const { setProgram, noteOn, noteOff, send, setMasterVol, setBend, loadMIDI, playMIDI, getPlayStatus, stopMIDI } = synth;
  const from = trace.length;
  setProgram(0, 5);
  noteOn(0, 60, 100, 1);
  setBend(0, 9000, 1.2);
  noteOff(0, 60, 1.5);
  send([0x91, 64, 90], 2);
  setMasterVol(0.25);
  loadMIDI(H.toArrayBuffer(H.makeMidi(480, [H.midi.noteOn(0, 0, 67, 100), H.midi.noteOff(480, 0, 67)])));
  playMIDI();
  assert.equal(getPlayStatus().play, 1);
  H.runUntil(env, () => false, 300);
  stopMIDI();
  assert.equal(getPlayStatus().play, 0);
  return trace.slice(from);
}

const variants = H.forkVariants();

for (const variant of variants) {
  test.describe(variant.name, () => {
    test("classic script: sets window.WebAudioTinySynth", () => {
      const global = load(variant, {});
      assert.equal(typeof global.WebAudioTinySynth, "function");
      assert.equal(global.WebAudioTinySynth.name, "WebAudioTinySynth");
      assert.equal(typeof new global.WebAudioTinySynth().noteOn, "function");
    });

    test("CommonJS: assigns module.exports and sets no global", () => {
      const module = { exports: {} };
      const global = load(variant, { module, exports: module.exports });
      assert.equal(typeof module.exports, "function");
      assert.equal(module.exports.name, "WebAudioTinySynth");
      assert.equal(global.WebAudioTinySynth, undefined);
      assert.equal(typeof new module.exports().noteOn, "function");
    });

    test("AMD: calls define() once with a factory and sets no global", () => {
      const factories = [];
      const define = Object.assign((factory) => factories.push(factory), { amd: {} });
      const global = load(variant, { define });
      assert.equal(factories.length, 1);
      const Synth = factories[0]();
      assert.equal(Synth.name, "WebAudioTinySynth");
      assert.equal(global.WebAudioTinySynth, undefined);
      assert.equal(typeof new Synth().noteOn, "function");
    });

    test("Node require(): exports the class and sets no global", () => {
      const file = variant.file;
      delete require.cache[file];
      const Synth = require(file);
      assert.equal(typeof Synth, "function");
      assert.equal(Synth.name, "WebAudioTinySynth");
      assert.equal(globalThis.WebAudioTinySynth, undefined);
    });

    test("has the documented methods and property defaults", () => {
      const { members, values } = surface(variant);
      const methods = new Set(members.filter(([, type]) => type === "function").map(([name]) => name));
      for (const name of DOCUMENTED) assert.ok(methods.has(name), "missing method " + name);
      assert.deepEqual(values, PROPERTIES);
    });

    test("methods work when called without the instance", () => {
      const calls = detachedCalls(variant);
      assert.ok(calls.some((c) => c.startsWith('["start"')), "no sound source was started");
    });
  });
}

test("the minified build has the same surface and detached behavior as the source", () => {
  const [source, minified] = variants;
  assert.deepEqual(surface(minified), surface(source));
  assert.deepEqual(detachedCalls(minified), detachedCalls(source));
});
