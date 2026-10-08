/* global window, OfflineAudioContext, WebAudioTinySynth */
/*
 * One first-attempt stereo render. The isolated fixture-timbre probes and
 * parsed MIDI song use the same synth, compressor, reverb, master gain and
 * destination. MIDI note instances are observed at the engine's native voice
 * creation boundary; scheduled messages alone are not counted as voices.
 */
(function () {
  "use strict";
  function b64(f32) {
    var u8 = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
    var out = "";
    for (var i = 0; i < u8.length; i += 0x8000) out += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(out);
  }
  window.__t6FullMix = async function (o) {
    var t6 = window.__t6;
    t6.seed(o.seed);
    var bin = atob(o.midiBase64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; ++i) bytes[i] = bin.charCodeAt(i);
    var RealAudioContext = window.AudioContext;
    window.AudioContext = function () { return new OfflineAudioContext(2, 128, o.sampleRate); };
    var synth;
    try {
      synth = new WebAudioTinySynth({ quality: o.quality, useReverb: o.reverbLev > 0 ? 1 : 0, voices: o.offlineVoices, seed: o.seed });
    } finally {
      window.AudioContext = RealAudioContext;
    }
    var schedulers = t6.intervals.filter(function (x) { return x.active; });
    schedulers.forEach(function (x) { window.clearInterval(x.id); });
    var internal = synth.getAudioContext();
    var ctx = new OfflineAudioContext(2, Math.ceil(o.sampleRate * o.renderDurationSec), o.sampleRate);
    synth.setAudioContext(ctx);
    if (internal && internal.close) await internal.close().catch(function () {});
    synth.setQuality(o.quality);
    synth.setMasterVol(o.masterVol);
    synth.setReverbLev(o.reverbLev);
    synth.setVoices(o.offlineVoices);
    for (var w = 0; w < o.waves.length; ++w) synth[o.waves[w][0]].apply(null, o.waves[w].slice(1));
    for (var t = 0; t < o.timbres.length; ++t) synth.setTimbre(o.timbres[t][0], o.timbres[t][1], o.timbres[t][2]);
    synth.loadMIDI(bytes.buffer);
    var events = synth.song && synth.song.ev;
    if (!Array.isArray(events)) throw new Error("the pinned fixture did not load as a MIDI song");

    /* Observe actual sources created by _note, including percussion _src items. */
    var noteCreations = [], prunedInstances = [], originalNote = synth._note, originalPrune = synth._pruneNote;
    synth._pruneNote = function (nt, time) {
      prunedInstances.push({ channel: nt.ch, pitch: nt.n, timeSec: nt.t, program: this.pg[nt.ch] });
      return originalPrune.call(this, nt, time);
    };
    synth._note = function (time, channel, pitch, velocity, patch) {
      var beforeVoices = this.notetab.length, beforeSources = this._src.length;
      var result = originalNote.call(this, time, channel, pitch, velocity, patch);
      var created = this.rhythm[channel]
        ? this._src.slice(beforeSources).some(function (x) { return x.ch === channel && x.t === time; })
        : !!result && this.notetab.indexOf(result) >= 0;
      if (time > 0.0001) noteCreations.push({ channel: channel, pitch: pitch, velocity: velocity, timeSec: time,
        program: this.pg[channel], created: created,
        sourceCount: this.rhythm[channel] ? this._src.length - beforeSources : created ? result.o.length : 0,
        voiceCountBefore: beforeVoices, percussion: !!this.rhythm[channel] });
      return result;
    };

    var timebase = synth.song.timebase, tick = 0, at = 0, secondsPerTick = 2 / timebase, sentMessages = 0;
    for (var e = 0; e < events.length; ++e) {
      var event = events[e];
      at += (event.t - tick) * secondsPerTick;
      tick = event.t;
      if (event.m[0] === 0xff51) secondsPerTick = 240 / event.m[1] / timebase;
      else {
        /* Match playMIDI: every non-tempo event is sent, including parsed SysEx. */
        synth.send(event.m, at + o.playbackOriginSec);
        ++sentMessages;
      }
    }
    /* Isolated probes are scheduled after the song and its explicit tail.
       Restore only their otherwise-unused channel to standard tuning; no prior
       voice or the song's cold first sample is changed. */
    var probeMessages = 0;
    synth.masterTuningC = 0;
    synth.masterTuningF = 0;
    for (var p = 0; p < o.probes.length; ++p) {
      var probe = o.probes[p], channel = probe.channel, status = channel;
      if (channel < 0 || channel > 15) throw new Error("invalid isolated-probe MIDI channel");
      synth.tuningC[channel] = 0;
      synth.tuningF[channel] = 0;
      synth.scaleTuning[channel].fill(0);
      /* Distinct fixture-reserved channels avoid immediate allSoundOff on a
         future scheduled probe voice; no cleanup controller can erase audio. */
      synth.send([0xc0 | status, probe.program], probe.startSec); ++probeMessages;
      synth.send([0x90 | status, probe.pitch, probe.velocity], probe.startSec); ++probeMessages;
      synth.send([0x80 | status, probe.pitch, 0], probe.startSec + probe.durationSec); ++probeMessages;
    }
    var rendered = await ctx.startRendering();
    var channels = [rendered.getChannelData(0), rendered.getChannelData(1)];
    var rejections = t6.rejections.slice();
    var nativePrunes = prunedInstances.slice();
    await synth.dispose();
    return {
      sampleRate: rendered.sampleRate,
      length: rendered.length,
      seconds: rendered.length / rendered.sampleRate,
      midiMessagesSent: sentMessages,
      probeMessagesSent: probeMessages,
      eventCount: events.length,
      noteCreations: noteCreations,
      prunedInstances: nativePrunes,
      intervalCount: schedulers.length,
      rejections: rejections,
      pcm: channels.map(b64),
    };
  };
})();
