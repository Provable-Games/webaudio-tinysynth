"use strict";

/* Resolve browser identity from the Playwright package selected by the runner.
 * Engine-reported versions alone are insufficient: distinct WebKit bundles can
 * report the same version. */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ENGINES = ["chromium", "firefox", "webkit"];

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}

function packageRoot(entry) {
  let dir = path.dirname(entry);
  while (dir !== path.dirname(dir)) {
    const file = path.join(dir, "package.json");
    if (fs.existsSync(file)) {
      const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
      if (pkg.name === "playwright-core") return { dir, pkg };
    }
    dir = path.dirname(dir);
  }
  throw new Error("resolved Playwright Core entry has no playwright-core package.json");
}

function resolveBrowserToolchain(env = process.env, root = path.resolve(__dirname, "..")) {
  const specifier = env.PLAYWRIGHT_CORE || "playwright-core";
  const entry = require.resolve(specifier, { paths: [root] });
  const resolved = packageRoot(entry);
  const manifestFile = path.join(resolved.dir, "browsers.json");
  const manifestBytes = fs.readFileSync(manifestFile);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const playwright = require(entry);
  const browsers = {};
  const browsersManifestSha256 = sha256(manifestBytes);
  for (const engine of ENGINES) {
    /* EngineSession.launch always uses headless:true. Chromium's pinned default
     * headless path is the separate shell bundle, not the full Chrome bundle
     * returned by chromium.executablePath(). CI installs this exact manifest
     * entry with `playwright-core install --only-shell chromium`. */
    const manifestName = engine === "chromium" ? "chromium-headless-shell" : engine;
    const browser = (manifest.browsers || []).find((item) => item.name === manifestName);
    if (!browser || !Number.isSafeInteger(Number(browser.revision)) || !browser.browserVersion)
      throw new Error("resolved Playwright browsers.json has no valid " + manifestName + " revision/version");
    const revision = String(browser.revision);
    const bundleId = manifestName.replace(/-/g, "_") + "-" + revision;
    if (engine !== "chromium") {
      const executable = playwright[engine].executablePath();
      const parts = path.resolve(executable).split(path.sep);
      if (!parts.includes(bundleId))
        throw new Error("resolved Playwright " + engine + " executable path does not identify expected bundle " + bundleId);
    }
    const bundle = {
      schemaVersion: 1, engine, playwrightCoreVersion: resolved.pkg.version,
      browsersManifestSha256, revision, bundleId, browserVersion: browser.browserVersion,
    };
    bundle.identitySha256 = sha256(Buffer.from(canonical(bundle)));
    browsers[engine] = { revision, bundleId, browserVersion: browser.browserVersion, identitySha256: bundle.identitySha256 };
  }
  const identity = {
    schemaVersion: 1,
    playwrightCoreVersion: resolved.pkg.version,
    browsersManifestSha256,
    browsers,
  };
  identity.identitySha256 = sha256(Buffer.from(canonical(identity)));
  return identity;
}

function engineBundle(toolchain, engine) {
  const browser = toolchain && toolchain.browsers && toolchain.browsers[engine];
  if (!browser) throw new Error("browser toolchain is missing " + engine);
  const identity = {
    schemaVersion: 1,
    engine,
    playwrightCoreVersion: toolchain.playwrightCoreVersion,
    browsersManifestSha256: toolchain.browsersManifestSha256,
    revision: browser.revision,
    bundleId: browser.bundleId,
    browserVersion: browser.browserVersion,
  };
  identity.identitySha256 = browser.identitySha256;
  return identity;
}

module.exports = { ENGINES, resolveBrowserToolchain, engineBundle, canonical };
