/*
 * The independent reference for the buffers of generation version 1 (#7, D-004),
 * written from the algorithm's description in BigInt arithmetic, not from the
 * library's code. Shared by seed.test.mjs and init-cost.test.mjs.
 */
import crypto from "node:crypto";

/* mulberry32 in BigInt uint32 arithmetic, after Tommy Ettinger's C reference: a draw is an integer / 2^32. */
export function mulberry32(seed) {
  const M = 0xffffffffn;
  let s = BigInt(seed) & M;
  return () => {
    s = (s + 0x6d2b79f5n) & M;
    let z = s;
    z = ((z ^ (z >> 15n)) * (z | 1n)) & M;
    z = (z ^ ((z + (((z ^ (z >> 7n)) * (z | 61n)) & M)) & M)) & M;
    return Number(z ^ (z >> 14n)) / 4294967296;
  };
}

/* murmur3's fmix32 in BigInt uint32 arithmetic: the seed mix. */
export function fmix32(x) {
  const M = 0xffffffffn;
  let h = BigInt(x) & M;
  h = ((h ^ (h >> 16n)) * 0x85ebca6bn) & M;
  h = ((h ^ (h >> 13n)) * 0xc2b2ae35n) & M;
  return h ^ (h >> 16n);
}

/* Stream k (convBuf 0, n0 1, n1 2) starts at (fmix32(seed) + k * 2^30) mod 2^32. Each buffer is generated alone from its stream. */
export const stream = (seed, k) => mulberry32((fmix32(seed) + BigInt(k) * 0x40000000n) & 0xffffffffn);
export const reference = {
  convBuf(seed, sr) {
    const blen = Math.floor(sr / 2), r = stream(seed, 0), d1 = new Float32Array(blen), d2 = new Float32Array(blen);
    for (let i = 0; i < blen; ++i) {
      if (i / blen < r()) {
        d1[i] = Math.exp(-3 * i / blen) * (r() - 0.5) * 0.5;
        d2[i] = Math.exp(-3 * i / blen) * (r() - 0.5) * 0.5;
      }
    }
    return [d1, d2];
  },
  n0(seed, sr) {
    const blen = Math.floor(sr / 2), r = stream(seed, 1), d = new Float32Array(blen);
    for (let i = 0; i < blen; ++i) d[i] = r() * 2 - 1;
    return [d];
  },
  n1(seed, sr) {
    const blen = Math.floor(sr / 2), r = stream(seed, 2), d = new Float32Array(blen);
    for (let j = 0; j < 64; ++j) {
      const r1 = r() * 10 + 1, r2 = r() * 10 + 1;
      for (let i = 0; i < blen; ++i) d[i] += Math.sin((i / blen) * 2 * Math.PI * 440 * r1) * Math.sin((i / blen) * 2 * Math.PI * 440 * r2) / 8;
    }
    return [d];
  },
};

/* SHA-256 of Float32 channel data, little-endian, channels in order (the seed-expected.js format). */
export function sha(chs) {
  const h = crypto.createHash("sha256");
  for (const c of chs) h.update(Buffer.from(c.buffer, c.byteOffset, c.byteLength));
  return h.digest("hex");
}
