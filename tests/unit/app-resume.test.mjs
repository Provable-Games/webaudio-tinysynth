import vm from "node:vm";
import { describe, expect, test } from "vitest";
import { H, variants } from "./helpers.mjs";

for (const variant of variants) describe(variant.name + " app-controlled resume", () => {
  function setup(options = {}) {
    const trace = [], env = H.createEnvironment(trace);
    vm.runInContext(variant.source, env.sandbox);
    const synth = new env.sandbox.WebAudioTinySynth(options);
    return { synth, env, trace };
  }
  const resumes = trace => trace.map(JSON.parse).filter(x => x[0] === "resume").length;
  test("default and explicit true retain send's auto-wake", async () => {
    for (const options of [{}, { autoResume: true }]) {
      const { synth, trace } = setup(options);
      synth.getAudioContext().state = "suspended";
      synth.send([0x90, 60, 90]);
      expect(resumes(trace)).toBe(1);
      await Promise.resolve();
    }
  });
  test("false gates eager/lazy MIDI wake but preserves explicit public resume and prewarm", async () => {
    for (const lazy of [false, true]) {
      const { synth, trace } = setup({ lazy, autoResume: false });
      if (lazy) expect(synth.getAudioContext()).toBe(null);
      synth.send([0x90, 60, 90]);
      const ctx = synth.getAudioContext();
      ctx.state = "suspended";
      synth.prewarm();
      const noise = synth.noiseBuf.n1;
      for (const state of ["suspended", "interrupted"]) {
        ctx.state = state;
        synth.send([0x90, 61, 90]);
        expect(resumes(trace)).toBe(0);
      }
      await synth.resume();
      expect(resumes(trace)).toBe(1);
      expect(synth.getAudioContext()).toBe(ctx);
      expect(synth.noiseBuf.n1).toBe(noise);
    }
  });
  test("scheduler does no work while externally suspended, then schedules each event once", async () => {
    const { synth, env, trace } = setup({ autoResume: false });
    const midi = H.makeMidi(480, [H.midi.noteOn(0, 0, 60, 90), H.midi.noteOff(480, 0, 60), H.midi.noteOn(960, 0, 64, 90), H.midi.noteOff(1440, 0, 64)]);
    synth.loadMIDI(H.toArrayBuffer(midi)); synth.setLoopEnd(1920); synth.playMIDI();
    const ctx = synth.getAudioContext(), song = synth.song;
    Object.defineProperty(ctx, "currentTime", { configurable: true, value: 0 });
    ctx.state = "suspended";
    const before = synth.getPlayStatus(), count = trace.length;
    for (let i = 0; i < 30; i++) env.step();
    expect(synth.getPlayStatus()).toEqual(before);
    expect(trace.length).toBe(count);
    await synth.resume(); ctx.state = "running";
    env.step();
    const scheduled = synth.getPlayStatus(), voice = synth.notetab[0];
    expect(scheduled.curTick).toBe(480);
    ctx.state = "interrupted";
    const after = trace.length;
    for (let i = 0; i < 30; i++) env.step();
    expect(trace.length).toBe(after);
    expect(synth.notetab[0]).toBe(voice);
    await synth.resume(); ctx.state = "running"; env.step();
    expect(synth.getPlayStatus()).toEqual(scheduled);
    expect(synth.song).toBe(song);
    expect(synth.notetab[0]).toBe(voice);
    expect(resumes(trace)).toBe(2);
  });
  test("invalid option rejects before audio construction", () => {
    for (const value of [0, 1, "false", {}, []]) {
      const trace = [], env = H.createEnvironment(trace);
      vm.runInContext(variant.source, env.sandbox);
      expect(() => new env.sandbox.WebAudioTinySynth({ autoResume: value })).toThrow("autoResume");
      expect(trace).toEqual([]);
    }
  });
});
