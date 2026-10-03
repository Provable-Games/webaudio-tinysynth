/* global window, AudioContext, OfflineAudioContext, BaseAudioContext, AudioNode, AudioParam, AudioScheduledSourceNode */
/*
 * Lifecycle instrumentation for test pages (#11), inlined after the prelude
 * and before the library when a page is built with {instrument: true}.
 *
 * It wraps, without changing behavior or return values:
 *   - the AudioContext constructor (a subclass, so `new AudioContext()` in the
 *     library is recorded) and AudioContext.prototype.close;
 *   - every BaseAudioContext.prototype.create*() factory that returns an
 *     AudioNode (node id, type, context);
 *   - AudioNode.prototype.connect/disconnect (live edges to nodes and to
 *     AudioParams, which are mapped back to their node and name);
 *   - AudioScheduledSourceNode.prototype.start/stop, plus an "ended" listener
 *     added with addEventListener (the library's onended property is untouched).
 * Interval timers are recorded by the prelude.
 *
 * window.__t6.lifecycle.snapshot() returns counts per context and overall;
 * mark(name) stores a snapshot under a name. Nodes are held only through
 * WeakMaps, so the instrumentation does not keep them alive.
 */
(function () {
  "use strict";
  var t6 = window.__t6;
  var nextId = 1;
  var contexts = [];
  var nodeInfo = new WeakMap();
  var paramInfo = new WeakMap();
  var records = [];
  var edges = new Map();

  function contextRecord(ctx) {
    for (var i = 0; i < contexts.length; ++i) if (contexts[i].ctx === ctx) return contexts[i];
    var rec = { id: "c" + contexts.length, ctx: ctx, kind: ctx instanceof OfflineAudioContext ? "offline" : "realtime", closeCalls: 0 };
    contexts.push(rec);
    return rec;
  }

  function registerNode(node, type, ctx) {
    var rec = { id: nextId++, type: type, context: contextRecord(ctx).id, started: false, stopCalls: 0, ended: false };
    nodeInfo.set(node, rec);
    records.push(rec);
    for (var k in node) {
      try {
        if (node[k] instanceof AudioParam) paramInfo.set(node[k], { node: rec.id, name: k });
      } catch { /* a getter that throws is not an AudioParam */ }
    }
    return rec;
  }

  if (typeof AudioContext === "function") {
    var RealAudioContext = AudioContext;
    var Tracked = class extends RealAudioContext {
      constructor() {
        super(...arguments);
        contextRecord(this).createdBy = "constructor";
      }
    };
    window.AudioContext = Tracked;
    var realClose = RealAudioContext.prototype.close;
    RealAudioContext.prototype.close = function () {
      contextRecord(this).closeCalls++;
      return realClose.apply(this, arguments);
    };
  }

  Object.getOwnPropertyNames(BaseAudioContext.prototype).forEach(function (name) {
    if (!/^create/.test(name)) return;
    var real = BaseAudioContext.prototype[name];
    if (typeof real !== "function") return;
    BaseAudioContext.prototype[name] = function () {
      var r = real.apply(this, arguments);
      if (r instanceof AudioNode) registerNode(r, name.slice(6), this);
      return r;
    };
  });

  function edgeKey(from, to, out, inp) {
    return from + ">" + to + ":" + (out || 0) + ":" + (inp || 0);
  }
  function targetId(dest) {
    var n = nodeInfo.get(dest);
    if (n) return "n" + n.id;
    var p = paramInfo.get(dest);
    if (p) return "n" + p.node + "." + p.name;
    if (dest && dest.context && dest === dest.context.destination) return contextRecord(dest.context).id + ".destination";
    return "unknown";
  }

  var realConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, output, input) {
    var r = realConnect.apply(this, arguments);
    var from = nodeInfo.get(this);
    if (from) {
      var key = edgeKey(from.id, targetId(dest), output, dest instanceof AudioParam ? 0 : input);
      edges.set(key, (edges.get(key) || 0) + 1);
    }
    return r;
  };
  var realDisconnect = AudioNode.prototype.disconnect;
  AudioNode.prototype.disconnect = function (dest, output) {
    var r = realDisconnect.apply(this, arguments);
    var from = nodeInfo.get(this);
    if (from) {
      var prefix = from.id + ">";
      var target = arguments.length && typeof dest === "object" ? targetId(dest) + ":" : null;
      var outIndex = arguments.length && typeof dest === "number" ? dest : arguments.length > 1 ? output : null;
      Array.from(edges.keys()).forEach(function (k) {
        if (k.indexOf(prefix) !== 0) return;
        var rest = k.slice(prefix.length);
        if (target && rest.indexOf(target) !== 0) return;
        if (outIndex !== null && outIndex !== undefined && rest.split(":")[1] !== String(outIndex)) return;
        edges.delete(k);
      });
    }
    return r;
  };

  var realStart = AudioScheduledSourceNode.prototype.start;
  AudioScheduledSourceNode.prototype.start = function () {
    var rec = nodeInfo.get(this);
    if (rec && !rec.started) {
      rec.started = true;
      this.addEventListener("ended", function () { rec.ended = true; });
    }
    return realStart.apply(this, arguments);
  };
  var realStop = AudioScheduledSourceNode.prototype.stop;
  AudioScheduledSourceNode.prototype.stop = function () {
    var rec = nodeInfo.get(this);
    if (rec) rec.stopCalls++;
    return realStop.apply(this, arguments);
  };

  function snapshot() {
    var byContext = {};
    contexts.forEach(function (c) {
      byContext[c.id] = { kind: c.kind, state: c.ctx.state, closeCalls: c.closeCalls, nodes: {}, sources: { started: 0, ended: 0, active: 0, stopCalls: 0 }, liveEdges: 0, paramEdges: 0 };
    });
    var idToContext = {};
    records.forEach(function (n) {
      var c = byContext[n.context];
      idToContext[n.id] = n.context;
      c.nodes[n.type] = (c.nodes[n.type] || 0) + 1;
      if (n.started) {
        c.sources.started++;
        if (n.ended) c.sources.ended++; else c.sources.active++;
      }
      c.sources.stopCalls += n.stopCalls;
    });
    edges.forEach(function (count, key) {
      var c = byContext[idToContext[key.split(">")[0]]];
      if (!c) return;
      c.liveEdges += count;
      if (/^n\d+\.[a-zA-Z]+:/.test(key.split(">")[1])) c.paramEdges += count;
    });
    var intervals = t6.intervals.filter(function (r) { return r.active; });
    return { contexts: byContext, activeIntervals: intervals.length, intervalPeriods: intervals.map(function (r) { return r.ms; }) };
  }

  t6.lifecycle = {
    snapshot: snapshot,
    marks: {},
    mark: function (name) { this.marks[name] = snapshot(); return this.marks[name]; },
    contexts: function () { return contexts.map(function (c) { return c.ctx; }); },
  };
})();
