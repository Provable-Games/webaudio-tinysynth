/*
 * Case execution for one engine (the worker half of scripts/browser-matrix.js).
 *
 * A case is {id, spec, kind, dims, deadline, run(t)}. run() gets a
 * context `t` with check(), observe(), newPage(), the browser and the shared
 * server. Every case runs under an external deadline enforced from Node: a
 * page stuck in a synchronous loop cannot stop Node's timer. At the deadline
 * the case fails, its pages and contexts are closed, and if the browser does
 * not respond it is closed and relaunched for the next case. Results recorded
 * by the abandoned run() after that are ignored. (Hang observations arm their
 * own deadline around the hanging operation: specs/hang.js.)
 */
"use strict";
const fs = require("fs");
const path = require("path");

const CLOSE_TIMEOUT_MS = 5000;
// How long a case's cleanup waits for resources still being created (a browser
// launch times out after 60 s), so that one created late is closed before the
// next case starts.
const LATE_WAIT_MS = 65000;
const ENDED = "the case has ended (deadline or finish); no new pages or browsers";

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).then((v) => ({ ok: true, value: v }), (e) => ({ ok: false, error: e })),
    new Promise((r) => { timer = setTimeout(() => r({ ok: false, timedOut: true }), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function short(e) {
  return String(e && e.message ? e.message : e).split("\n")[0];
}

class EngineSession {
  constructor({ engine, playwright, launchOptions = {}, out = null, log = console.log }) {
    this.engine = engine;
    this.playwright = playwright;
    this.launchOptions = launchOptions;
    this.out = out;
    this.log = log;
    this.browser = null;
    this.version = null;
    this.relaunches = 0;
  }

  async launch() {
    this.browser = await this.playwright[this.engine].launch(Object.assign({ headless: true, timeout: 60000 }, this.launchOptions));
    this.version = this.browser.version();
    return this.browser;
  }

  async closeBrowser() {
    if (!this.browser) return true;
    const b = this.browser;
    this.browser = null;
    const r = await withTimeout(b.close(), 15000);
    return r.ok;
  }

  /* Runs one case; returns its result record. */
  async run(c, shared) {
    const started = Date.now();
    const result = {
      id: c.id, spec: c.spec, kind: c.kind, dims: c.dims || {}, status: null,
      checks: [], observations: {}, notes: [], seconds: 0,
    };
    const opened = [];
    const extraBrowsers = [];
    let abandoned = false;
    /*
     * Creates a context, page or browser for the case. If the case has ended
     * (deadline or finish) before the creation starts, nothing is created;
     * if it ends while the creation is in flight, the new resource is closed
     * as soon as it exists. Either way the caller gets an error, so an
     * abandoned run() cannot continue with it. Cleanup waits for creations
     * in flight (pending), so a late resource is closed before the next case.
     */
    const pending = new Set();
    let lateClosed = 0;
    const create = (make, close) => {
      if (abandoned) return Promise.reject(new Error(ENDED));
      const p = (async () => {
        const x = await make();
        if (abandoned) {
          ++lateClosed;
          await withTimeout(close(x), CLOSE_TIMEOUT_MS);
          throw new Error(ENDED);
        }
        return x;
      })();
      pending.add(p);
      p.then(() => pending.delete(p), () => pending.delete(p));
      return p;
    };
    const record = {
      check: (name, ok, detail) => {
        const rec = { name, ok: !!ok, detail: detail === undefined ? "" : String(detail) };
        result.checks.push(rec);
        this.log("  " + (rec.ok ? "ok  " : "FAIL") + " " + c.id + ": " + name + (rec.detail ? " (" + rec.detail + ")" : ""));
        return rec.ok;
      },
      observe: (name, value) => {
        result.observations[name] = value;
        const text = JSON.stringify(value);
        this.log("  obs  " + c.id + ": " + name + " = " + (text.length > 400 ? text.slice(0, 400) + "... (" + text.length + " chars, full value in the results JSON)" : text));
      },
    };
    const t = {
      engine: this.engine,
      version: this.version,
      browser: this.browser,
      shared,
      out: this.out,
      // After the deadline the abandoned run() may still finish (for example when
      // closing its page rejects a pending evaluate); its late results are ignored.
      check: (name, ok, detail) => {
        if (abandoned) return false;
        return record.check(name, ok, detail);
      },
      observe: (name, value) => {
        if (!abandoned) record.observe(name, value);
      },
      note: (text) => { if (!abandoned) { result.notes.push(text); this.log("  note " + c.id + ": " + text); } },
      /* True once the case has reached its deadline: long operations check it before starting. */
      isAbandoned: () => abandoned,

      /*
       * A new context and page. offline: abort every request (and count it).
       * Returns {page, context, requests, pageErrors, consoleErrors, console}.
       */
      newPage: async ({ offline = false, contextOptions = {}, browser = null } = {}) => {
        const target = browser || this.browser;
        const context = await create(() => target.newContext(contextOptions), (x) => x.close());
        const rec = { context, page: null, requests: [], aborted: [], pageErrors: [], consoleErrors: [], console: [] };
        opened.push(rec);
        if (offline) await context.route("**/*", (route) => { rec.aborted.push(route.request().url()); return route.abort(); });
        const page = await create(() => context.newPage(), (x) => x.close({ runBeforeUnload: false }));
        rec.page = page;
        page.on("request", (r) => rec.requests.push(r.url()));
        page.on("pageerror", (e) => rec.pageErrors.push(short(e)));
        page.on("console", (m) => {
          rec.console.push({ type: m.type(), text: m.text(), at: Date.now() });
          if (m.type() === "error") rec.consoleErrors.push(m.text());
        });
        return rec;
      },
      /* A separate browser instance of the same engine, closed when the case ends. */
      launchBrowser: async () => {
        const b = await create(() => this.playwright[this.engine].launch(Object.assign({ headless: true, timeout: 60000 }, this.launchOptions)), (x) => x.close());
        extraBrowsers.push(b);
        return b;
      },
      save: (rel, data) => {
        if (!this.out) return null;
        const file = path.join(this.out, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, data);
        return file;
      },
    };

    const deadline = c.deadline * 1000;
    const r = await withTimeout(Promise.resolve().then(() => c.run(t)), deadline);
    if (r.timedOut) {
      abandoned = true;
      result.status = "fail";
      record.check("finished before the " + c.deadline + " s deadline", false, "deadline exceeded; page closed from Node");
    } else if (!r.ok) {
      result.status = "fail";
      record.check("ran without an exception", false, short(r.error));
    }
    abandoned = true;
    // Let creations still in flight finish (each closes its own resource,
    // since the case has ended), then close everything the case opened. A
    // context that does not close in time means the browser is wedged: close
    // it and relaunch.
    const late = await withTimeout(Promise.allSettled([...pending]), LATE_WAIT_MS);
    if (late.timedOut) record.observe("cleanup: resources still being created", pending.size + " creation(s) did not settle within " + LATE_WAIT_MS / 1000 + " s");
    if (lateClosed) record.observe("cleanup: resources created after the case ended, closed", lateClosed);
    let wedged = false;
    for (const rec of opened) {
      if (rec.page) await withTimeout(rec.page.close({ runBeforeUnload: false }), CLOSE_TIMEOUT_MS);
      const cr = await withTimeout(rec.context.close(), CLOSE_TIMEOUT_MS);
      if (!cr.ok && !cr.error) wedged = true;
    }
    for (const b of extraBrowsers) await withTimeout(b.close(), 15000);
    if (r.timedOut) record.observe("cleanup", wedged ? "context did not close; browser relaunched" : "pages and contexts closed");
    if (wedged) {
      await this.closeBrowser();
      await this.launch();
      ++this.relaunches;
    }
    if (!result.status) {
      const failed = result.checks.filter((k) => !k.ok).length;
      result.status = failed ? "fail" : c.kind === "observe" && !result.checks.length ? "observed" : "pass";
    }
    result.seconds = (Date.now() - started) / 1000;
    this.log((result.status === "fail" ? "FAIL " : result.status === "observed" ? "obs  " : "ok   ") + c.id +
      " [" + result.checks.filter((k) => k.ok).length + "/" + result.checks.length + " checks, " + result.seconds.toFixed(1) + " s]");
    return result;
  }
}

module.exports = { EngineSession, withTimeout, short };
