/*
 * Seeded expectations for the built-in buffers (#7, D-004, ledger L-07),
 * kept apart from the upstream compatibility fixtures (tests/differential.js
 * and the regressions compare against upstream and are unchanged).
 *
 * Generation version 1: convBuf, n0 and n1 each come from their own
 * mulberry32 stream, stream k (convBuf 0, n0 1, n1 2) seeded with
 * (seed + k * 2^30) mod 2^32 (see the comment above mulberry32() in
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
        convBuf: "7b42349da3d95c6a306997310e92c94fafec7293a921010b0da657345e69b81b",
        n0: "a8297643d75fa6abbdff5efd6c7eadfb937be8f18bbd43ff755efe07230d3d83",
        n1: "82e1110724341dde4b9566897b6b599f3f468ccb3d95318ac163fd9edac56d18",
      },
      0x5eed0001: {
        convBuf: "a9e354d667c6f28fa2764574c508f0798157b35b459b70951e173787b907a30e",
        n0: "550b553c3c5fe56883a923205521f0f83015b5fa602d9c10090af58b651dfc7d",
        n1: "cd651f5c0bc02eb1510918b8ea0a404572a4ba4a7ddb65c5e14b2d9c541ceb2d",
      },
      0xffffffff: {
        convBuf: "74f41279333feb4f76817afcbf985644a23f5323e60bac2145cc44d30f171002",
        n0: "b2862f9123f133b0270002969468f397836246786aa630acb6a88a8a6c139d05",
        n1: "4c0421f82004f01b1524a99351732610f98f09a1682a52b422c32771acabfaaf",
      },
    },
    48000: {
      0: {
        convBuf: "1701f8b601236bb5b18b613606a73b5da0f3891573e60f7c56ade018907bed7a",
        n0: "32c62ee579dc5118464b6346d16ee6322f1c328d729bf380cd56239b82b89ad7",
        n1: "d9cee503e9ad32a5c4c1de0844c04a73e499a6f2a61458aabac7f6f17cd75fce",
      },
      1: {
        convBuf: "d41c7d1f3703bd27bfa1ce1ae39be31f6984295231e2cc3ca01c9ac99bf4d7c5",
        n0: "cb0b1cac1cfadd85243666be94efff857c27475de548f5e7db69068ace7f9729",
        n1: "096c889a3704067615b54cc40f286e657ff88fba089655d3fa4f5da6a1202bfb",
      },
      0x5eed0001: {
        convBuf: "3ae12f7d0ae1d5bac3300456b8db505af495da33f06d3efb481c35d2da0fdfd8",
        n0: "5e4f7ca5df344f5f7d3d1e3f3f4ece78bc92fd5d6d159ef7c59ec2c96eb00e82",
        n1: "3e9e3f2982e41b334be59b84aa06611b6b6c16ae4890251766912696176f2118",
      },
      0xffffffff: {
        convBuf: "8c40085f3bb64a708e043de17e3dea5132ed6ea6c4462959c09692b8dbd309ed",
        n0: "248d4a263deecba5dbee58bc73e3d267e632b0d213a4cf795e36f95896fc6287",
        n1: "14f295ce435b39752a470458b3a4415d5f99ba368c045427103a1bcc9111d0cd",
      },
    },
  },
};

module.exports = { SEED_EXPECTED };
