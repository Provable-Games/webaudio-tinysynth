/*
 * Canonical input for generated Web Audio Float32 buffers.
 *
 * Channel arrays are concatenated in planar channel-index order. Every sample
 * is encoded as IEEE-754 binary32, little-endian, with no header or padding.
 * The browser returns these bytes to the Node producer, which computes SHA-256
 * outside the opaque-origin about:blank page. The caller records channel and
 * frame counts beside the digest.
 */
"use strict";

(function install(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.__t6BufferDigest = api;
})(typeof globalThis === "object" ? globalThis : this, function create(root) {
  function planarFloat32Bytes(channels) {
    if (!Array.isArray(channels) || !channels.length || channels.some((channel) => !(channel instanceof Float32Array)))
      throw new TypeError("channels must be a non-empty array of Float32Array values");
    const frames = channels[0].length;
    if (channels.some((channel) => channel.length !== frames))
      throw new RangeError("planar Float32 channels must have equal frame counts");
    const bytes = new Uint8Array(frames * channels.length * 4);
    const view = new DataView(bytes.buffer);
    let offset = 0;
    for (const channel of channels) {
      for (let i = 0; i < channel.length; ++i) {
        view.setFloat32(offset, channel[i], true);
        offset += 4;
      }
    }
    return bytes;
  }

  function base64Planar(channels) {
    const bytes = planarFloat32Bytes(channels);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    if (typeof root.btoa !== "function") throw new Error("base64 encoding is unavailable in this context");
    return root.btoa(binary);
  }

  function sha256Planar(channels) {
    const bytes = planarFloat32Bytes(channels);
    if (typeof module === "object" && module.exports) {
      return Promise.resolve(require("node:crypto").createHash("sha256").update(Buffer.from(bytes)).digest("hex"));
    }
    return Promise.reject(new Error("SHA-256 is computed by the Node producer; browsers return canonical sample bytes"));
  }

  function sha256Base64Planar(bytesBase64, channels, frames) {
    if (typeof module !== "object" || !module.exports)
      throw new Error("SHA-256 byte validation is available only in the Node producer");
    if (typeof bytesBase64 !== "string" || !Number.isSafeInteger(channels) || channels < 1 ||
        !Number.isSafeInteger(frames) || frames < 0)
      throw new TypeError("invalid planar Float32 byte capture metadata");
    const bytes = Buffer.from(bytesBase64, "base64");
    const expectedBytes = channels * frames * 4;
    if (!Number.isSafeInteger(expectedBytes) || bytes.length !== expectedBytes || bytes.toString("base64") !== bytesBase64)
      throw new RangeError("planar Float32 byte capture length or base64 encoding is invalid");
    for (let offset = 0; offset < bytes.length; offset += 4) {
      if (!Number.isFinite(bytes.readFloatLE(offset)))
        throw new RangeError("planar Float32 byte capture contains a non-finite sample at byte " + offset);
    }
    return {
      sha256: require("node:crypto").createHash("sha256").update(bytes).digest("hex"),
      channels,
      frames,
    };
  }

  return { planarFloat32Bytes, base64Planar, sha256Planar, sha256Base64Planar };
});
