/*
 * Minimal Standard MIDI File reader and writer for the browser matrix,
 * independent of the library's parser. The reader handles valid files only
 * (running status, meta and SysEx events) and is used to derive expected
 * values; the writer builds small fixtures in memory.
 */
"use strict";

function vlq(n) {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
}

/* tracks: [[{dt, bytes}], ...]; an End-of-Track meta is appended to each track. */
function write({ format = 0, division = 480, tracks }) {
  const chunks = [Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, format, 0, tracks.length, division >> 8, division & 0xff])];
  for (const tr of tracks) {
    const body = [];
    for (const e of tr) body.push(...vlq(e.dt), ...e.bytes);
    body.push(0, 0xff, 0x2f, 0);
    const len = body.length;
    chunks.push(Buffer.from([0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff]), Buffer.from(body));
  }
  return Buffer.concat(chunks);
}

/*
 * Returns {format, ntracks, division, tracks: [{endTick, events: [{tick, status, data}]}],
 * endTick (the largest track end), tempos: [{tick, usPerQuarter}]}.
 */
function read(buf) {
  const s = Uint8Array.from(buf);
  const u32 = (i) => ((s[i] << 24) | (s[i + 1] << 16) | (s[i + 2] << 8) | s[i + 3]) >>> 0;
  const u16 = (i) => (s[i] << 8) | s[i + 1];
  if (String.fromCharCode(...s.subarray(0, 4)) !== "MThd") throw new Error("not a MIDI file");
  const hlen = u32(4);
  const r = { format: u16(8), ntracks: u16(10), division: u16(12), tracks: [], tempos: [], endTick: 0 };
  let p = 8 + hlen;
  while (p + 8 <= s.length && r.tracks.length < r.ntracks) {
    const id = String.fromCharCode(...s.subarray(p, p + 4));
    const len = u32(p + 4);
    const end = p + 8 + len;
    if (id === "MTrk") {
      const tr = { endTick: 0, events: [] };
      let i = p + 8, tick = 0, running = 0;
      const readVlq = () => {
        let v = 0, b;
        do { b = s[i++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80);
        return v;
      };
      while (i < end) {
        tick += readVlq();
        let status = s[i];
        if (status & 0x80) ++i; else status = running;
        if (status === 0xff) {
          const type = s[i++];
          const n = readVlq();
          const data = Array.from(s.subarray(i, i + n));
          i += n;
          tr.events.push({ tick, status, type, data });
          if (type === 0x51) r.tempos.push({ tick, usPerQuarter: (data[0] << 16) | (data[1] << 8) | data[2] });
          if (type === 0x2f) break;
        } else if (status === 0xf0 || status === 0xf7) {
          const n = readVlq();
          tr.events.push({ tick, status, data: Array.from(s.subarray(i, i + n)) });
          i += n;
        } else {
          running = status;
          const n = (status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0 ? 1 : 2;
          tr.events.push({ tick, status, data: Array.from(s.subarray(i, i + n)) });
          i += n;
        }
      }
      tr.endTick = tick;
      if (tick > r.endTick) r.endTick = tick;
      r.tracks.push(tr);
    }
    p = end;
  }
  return r;
}

module.exports = { read, write, vlq };
