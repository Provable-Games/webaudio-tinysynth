/*
 * Seeded expectations for the built-in buffers (#7, D-004, ledger L-07),
 * kept apart from the upstream compatibility fixtures (tests/differential.js
 * and the regressions compare against upstream and are unchanged).
 *
 * Generation version 1: convBuf, n0 and n1 each come from their own
 * mulberry32 stream, stream k (convBuf 0, n0 1, n1 2) seeded with
 * (fmix32(seed) + k * 2^30) mod 2^32, where fmix32 is murmur3's finalizer
 * and fmix32(0) = 0 (see the comment above mulberry32() in
 * webaudio-tinysynth.js). Each value is the SHA-256 of the buffer's Float32
 * sample data, little-endian, channels in order (convBuf: left, then right).
 * The data depends on the sample rate (the buffers are 0.5 s long).
 *
 * The values were computed by an independent reference (BigInt uint32
 * mulberry32 and the documented formulas; tests/unit/seed.test.mjs holds it),
 * not read back from the library. Used by tests/unit/seed.test.mjs,
 * tests/node/seed.test.cjs and the browser spec specs/seed.js. A change to the
 * generated data needs a new bufferVersion and a new table.
 */
"use strict";

const SEED_EXPECTED = {
  bufferVersion: 1,
  defaultSeed: 0,
  hashes: {
    44100: {
      0: {
        convBuf: "568ec5af82edc750bac5a4ccbe5d7bf0b387087af473b679a954257e8f0448cf",
        n0: "0421a211b484bd5ddc91a962edb4dbc410cf05987bde6b9a7eba52d63e206641",
        n1: "e4ff95d4e406ca64e26904749a4e800b064e32f47ab5f7edf3c36f91e6389d21",
      },
      1: {
        convBuf: "f446d5f48609c90c4a0f009cfaf7735290403452951028256826f802898f9e39",
        n0: "24f284e6d0106569310e2e62c081332756e97030c193c767e3fd84671e6214f0",
        n1: "69b90b676a17d1e4d0aef2cda32455398e137b93d67a39671961e327f671e0e8",
      },
      0x5eed0001: {
        convBuf: "6b14a5aaeda60acf4cb070b50793f5e8cd1ba6c1643302bc7ec0c7ee2f1b6a9f",
        n0: "66c190fde8a16f381d08f0b61b62c3ae7537ef85360f9d2469550d5491205c8a",
        n1: "2c388dcbd16d976b53a16c239f78410b5373665b096f7fdfe079100d649b9079",
      },
      0xffffffff: {
        convBuf: "2506dbc9ff40440ba8efdae7c3c2c77ecd3bbd03d9c9d1927a233d8d09382ef1",
        n0: "8ec7d2892661bea180da8684992842d775e5a220cd5b7265b45173b3db2c1211",
        n1: "686ca26720336e35b519a5037bda842b21498c5c1133ef8f2dcdc136b8fe440f",
      },
    },
    48000: {
      0: {
        convBuf: "1701f8b601236bb5b18b613606a73b5da0f3891573e60f7c56ade018907bed7a",
        n0: "32c62ee579dc5118464b6346d16ee6322f1c328d729bf380cd56239b82b89ad7",
        n1: "d9cee503e9ad32a5c4c1de0844c04a73e499a6f2a61458aabac7f6f17cd75fce",
      },
      1: {
        convBuf: "50e81125e98097f8b50ea5ed88ab750146d09205e35b3bc0577ce75a79d8b019",
        n0: "64582d22e21fd8d1b0df08004f369a1b0c06c8ca1a2ba870f562ec814f8a7470",
        n1: "854d1dfdcd2bf1cc9506e6dd05fd570ec44fd8726106d5df31cb93eacfc6bb45",
      },
      0x5eed0001: {
        convBuf: "4e41b0b5d26b97209e775dc9050bae9887239c70090eff7cc1bb879d86c989ff",
        n0: "a94e91f857eb4f848e68f408acd4d236810d4d502161e53574d6a2a8b9751fc2",
        n1: "38bd0499b94fedaee90d5a3b057919c83fa6a2cb2d051ba8d91781dfe094e723",
      },
      0xffffffff: {
        convBuf: "7dba2560bfa2ac4416045e80943799d8198740c8fce961e99762f574390e9f4f",
        n0: "cb5383397b798c007612cb71d602ae7c6c87ff818f52eab7bda24c07baaea742",
        n1: "dd16f5ec82d1e7647b77adb92bcbc4be16a32e7e012c0dd53f3e552059352c5d",
      },
    },
  },
};

module.exports = { SEED_EXPECTED };
