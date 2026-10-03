# T1 tooling: lint, tests, build verification and CI

| Item | Value |
| --- | --- |
| Task | T1-tooling: remove unused dependencies (#15); reproducible, verifiable build (#5); ESLint (#22); Vitest (#23); native Node tests and retained regressions (#24); CI with the offline Chromium smoke test (#5, initial #16). No synth behavior changes. |
| Base commit | `1e6184c37c0d2cdb8b493d59718c9c7281787a9e` on `improve/integration` |
| Branch / worktree | `t1/tooling` in `/workspace/webaudio-tinysynth-worktrees/t1-tooling` |
| Owned files | `package.json`, `package-lock.json`, `.gitignore`, `.npmignore` (removed), `.nvmrc`, `eslint.config.mjs`, `vitest.config.mjs`, `tests/unit/**`, `tests/node/**`, `scripts/**`, `.github/workflows/ci.yml`, `.github/dependabot.yml`, README development sections, this record |
| Evidence outside the repo | `/workspace/webaudio-tinysynth-worktrees/_evidence/t1-tooling/`: `commands.tsv` (every logged command with exit status and duration), `logs/`, `scratch/` (clean clones, demos), `tools/` (Node 24.21.0, actionlint, shellcheck), `ms-playwright/` (Chromium headless shell 1243), `issues-live/` |
| Local toolchain | Node v24.21.0 and npm 11.19.0 from the nodejs.org tarball (SHASUMS256 verified), extracted to `_evidence/t1-tooling/tools` and put first on `PATH`; nothing installed system-wide or into asdf. Chromium ran with T0's extracted libraries (`LD_LIBRARY_PATH=_evidence/T0/tools/libroot/usr/lib/x86_64-linux-gnu`) and `PLAYWRIGHT_BROWSERS_PATH=_evidence/t1-tooling/ms-playwright`. Host: Ubuntu 24.04 x86_64. |

## Issue revisions

Snapshot values from the assignment, rechecked live at 2026-10-03T02:42Z with `gh issue view` (raw JSON in `_evidence/t1-tooling/issues-live/`): all open, no comments, unchanged.

| Issue | updatedAt | sha256(body)[:16] |
| --- | --- | --- |
| #5 | 2026-10-03T00:44:54Z | `9b1dbcb728bbb29a` |
| #15 | 2026-10-03T00:15:36Z | `e6673c872937c7db` |
| #16 | 2026-10-03T00:44:59Z | `47baf5dfecc4346c` |
| #22 | 2026-10-03T00:43:50Z | `440cf0e5f0f1ff8b` |
| #23 | 2026-10-03T00:43:54Z | `591cea541a27db93` |
| #24 | 2026-10-03T00:43:59Z | `ae4a37d537f91e93` |

## 1. Commits

All commits are GPG-signed (no `--no-gpg-sign` fallback was needed).

| Commit | Issue | Subject | Files |
| --- | --- | --- | --- |
| `df4b6e2` | #15 | Remove unused node-minify development dependency | `package.json` |
| `0b906be` | #5 | Pin Node, npm and Terser and commit the lockfile | `.gitignore`, `.nvmrc`, `package.json`, `package-lock.json` |
| `a307c5f` | #5 | Add explicit build, artifact verification and size report | `scripts/build.js`, `scripts/verify-dist.js`, `scripts/size.js`, `package.json` |
| `e582405` | #5 | Whitelist package files and check the packed package | `scripts/check-pack.js`, `package.json`, `.npmignore` (deleted) |
| `e0ff12c` | #22 | Add ESLint with the recommended rules | `eslint.config.mjs`, `package.json`, lockfile, `webaudio-tinysynth.js` (lint fixes, §3), `tests/harness.js`, `tests/browser-smoke.js` |
| `36f50ad` | #23 | Add Vitest with initial unit tests | `vitest.config.mjs`, `tests/unit/*`, `package.json`, lockfile |
| `efd0740` | #24 | Add native Node tests and a deadline-bounded regression runner | `tests/node/**`, `scripts/run-with-deadline.js`, `scripts/run-regressions.js`, `tests/harness.js`, `package.json` |
| `f096ba5` | #16 | Pin Playwright and run the browser smoke test from npm | `package.json`, lockfile, `tests/browser-smoke.js` (comment only) |
| `25675ea` | #5, #16 | Add the CI workflow and Dependabot configuration | `.github/workflows/ci.yml`, `.github/dependabot.yml` |
| `008f99a` | #5 | Mangle local names and keep the license header in the build | `scripts/build.js` |
| `d66b076` | #5, #22–#24 | Document the development, test and verification commands | `README.md` |
| `fec2e6c` | supervisor note | Exclude .github/scripts from lint and add its Dependabot entry | `eslint.config.mjs`, `.github/dependabot.yml` |
| `c5f9ec1` | | Record T1 tooling execution | `docs/improvements/tasks/T1-tooling.md` |
| `c76bb81` | #5 (D-003) | Rebuild webaudio-tinysynth.min.js and source map | `webaudio-tinysynth.min.js`, `webaudio-tinysynth.min.js.map` |
| supervisor fixup | #5 | Relax engines, keep artifact line endings, note verify constraints | `package.json`, `.gitattributes` (assigned for this change), this record |

The source (`e0ff12c`) and the build options (`008f99a`) changed, so the branch ends with the regeneration commit made by the pinned `npm run build`, after this record (D-003). Between `e0ff12c` and that commit, `npm run verify` fails by design because the committed distribution is stale. The regenerated files must have the hashes in §4; they are the bytes two independent clean clones built (§7).

## 2. Decisions

1. **Node and npm.** `.nvmrc` pins `24.21.0`, the newest Node 24 LTS patch in `https://nodejs.org/dist/index.json` at 2026-10-03T02:00Z (released 2026-09-07, bundles npm 11.19.0; v24 is the active LTS line, "Krypton"). `engines` says `node >=24.11.0 <25` (the Node 24 LTS line) and `npm >=11 <12`. This was relaxed at supervisor request from `>=24.21.0`/`>=11.19.0`, so that supported LTS patches do not warn. With the user's Node 24.19.0 / npm 11.17.0, `npm ci` now gives no `EBADENGINE` warning; the earlier range did warn. `engines` is published metadata, nothing enforces it (no `engine-strict`), and CI uses the exact `.nvmrc` pin. `devEngines` and `packageManager` were not added: `devEngines` with `onFail: "error"` would break `npm ci` on other patches, and `packageManager` brings corepack into play. `package-lock.json`'s root-package `engines` copy was then synced with `npm install --package-lock-only --ignore-scripts` under Node 24.21.0. Only that root entry changed: no dependency versions or integrity values.
2. **Terser and the build script.** Terser is pinned to exactly `5.51.2`, the version that reproduces the T0 artifact. `scripts/build.js` calls the Terser API with every option written out, including values equal to Terser's defaults, and stops unless the installed Terser equals the version pinned in `package.json`. Before any option changed, it reproduced the previous CLI command (`terser … --compress --source-map`) byte for byte (`5aa3edbc…`/`fd7f6419…`). `ascii_only: true` was added then; it changes no bytes, because the source has no non-ASCII text. `npm run build` and `npm run verify` share this one function.
3. **Identifier mangling: enabled.** Local variable, parameter and function names only, with `keep_classnames: true`, `toplevel: false`, `properties: false` and no reserved names. On the lint-fixed source it saves 1,032 bytes raw (−2.78 %) and 236 bytes gzip (−2.50 %); T0 measured −3.0 % without `keep_classnames`. Without `keep_classnames` the class would be named `s`. All of the conditions were met on the mangled output before the option was committed: the differential, tempo and loop-end regressions, the 30 unit and 24 native tests, the browser smoke test on both fixtures, and T0's inline `data:` URI probe. The native tests compare the source and minified builds' exports (global, CommonJS, AMD, Node `require`), class name, own-member names, types and arities, documented property defaults, detached-method WebAudio traces, and a full generated song including a seek. They all match.
4. **License header: kept.** A `format.comments` filter keeps the source's header comment (the block comment that contains "Apache License"): author, upstream URL, licence name, the fork's change summary and a pointer to NOTICE. Reason: the onchain consumer embeds the minified bytes on their own, without LICENSE or NOTICE beside them, and Apache-2.0 §4 asks distributors to keep attribution notices. Upstream's own minified file has no header, so this is a deliberate fork choice. It costs 347 bytes raw and about 218 bytes gzip (measured with and without mangling). It also adds 9 line breaks to a file that was a single line. The build normalizes the source to LF before minifying, and a CRLF copy of the source was shown to build identical bytes. A Windows checkout with `core.autocrlf=true` would still convert the committed minified file's line breaks and fail `verify`; see §10.
5. **Source map.** The map now has `"file": "webaudio-tinysynth.min.js"`; `sources` stays `["webaudio-tinysynth.js"]`, which resolves to the source next to the map. The minified file still has no `sourceMappingURL`: a relative URL cannot resolve from a `data:` page, and every byte is stored onchain. `sourcesContent` is not included, because the package ships the source. With mangling, the map's `names` give the original identifiers.
6. **`verify` checks (a constraint for later tasks).** `npm run verify` requires the library source `webaudio-tinysynth.js` and `webaudio-tinysynth.min.js` to be pure ASCII and to contain no `</script`, `<script` or `<!--` in any letter case, comments included. An em-dash, a curly quote or `<!--` in a source comment fails CI. It rebuilds into `os.tmpdir()`, compares the minified file and the map byte for byte, and reports sizes, both SHA-256 values and the first differing byte with context. It also fails if the minified file or the source contains `</script`, `<script` or `<!--` in any letter case, or a non-ASCII byte. The contract calls both builds inline-embeddable, so the source is checked too. Terser's `inline_script` already escapes such sequences inside strings in the minified output.
7. **Package contents.** A `files` whitelist (`webaudio-tinysynth.js`, `.min.js`, `.min.js.map`, `LICENSE`, `NOTICE`, `README.md`) replaces `.npmignore`, which is deleted. `npm run pack:check` fails on any missing or extra file. It installs the tarball offline into a scratch consumer under `os.tmpdir()` and checks that the directory is outside the repository. It `require()`s the package and `webaudio-tinysynth/webaudio-tinysynth.min.js`, which must be functions named `WebAudioTinySynth` that set no global. It also checks that the installed files equal the repository's byte for byte.
8. **ESLint.** The flat config is `@eslint/js` recommended for every linted file. The library is a `sourceType: "script"` file with exactly the globals it uses: `AudioContext`, `XMLHttpRequest`, `console`, `performance`, `setInterval`, `clearInterval`, `define`, `exports` and `module`. `globals.browser` is not used, because it declares names like `name`, `status` and `event` that would hide real `no-undef` errors. Tests, scripts and `*.cjs` files are CommonJS with Node globals, and `*.mjs` files are modules. Ignored: `node_modules`, the minified file, maps, `bower_components`, `docs/improvements/evidence/**` and `.github/scripts/**` (the last at the supervisor's request). The library's only rule option is `no-unused-vars` with `caughtErrors: "none"`: it keeps ES2015 syntax, which needs catch bindings. Every other exception is inline, with a reason (§3).
9. **Vitest.** Vitest runs with `environment: "node"`, `include: ["tests/unit/**/*.test.mjs"]` and `watch: false`. `npm run test:unit` is `vitest run`. The tests load `tests/harness.js` through Node's `createRequire`, so the regression scripts, which run at import and call `process.exit`, are never imported. The tests never call `upstreamSource()`, so they need no git history. Every case runs against both builds. Timbres are installed through the public `setTimbre()`, and results are read back from the mock WebAudio calls: source type, frequency, and start, stop and release times. Expected values come from the MIDI specification, the README or independent arithmetic, such as tick-to-seconds and `440·2^((n−69)/12)·t + f`.
10. **Native tests and deadlines.** I checked empirically whether `node --test --test-timeout=3000` stops a test file stuck in `for(;;){}`. It does not: its timeouts are timers, and the run hung until an outer kill at 60 s. So `scripts/run-with-deadline.js` runs a command as the leader of its own process group. At the deadline it SIGKILLs the whole group and exits 124. It also kills leftover group members when the command exits, and passes SIGINT and SIGTERM on to the group. `npm run test:node` runs `node --test --test-timeout=120000 "tests/node/**/*.test.cjs"` under a 600 s deadline. `scripts/run-regressions.js` runs each regression script in its own process with a 300 s deadline, continues after failures, and exits 1 if any script failed, crashed or timed out. The test commands therefore need POSIX process groups (Linux, macOS).
11. **Aggregate `npm test`.** It runs `test:unit && test:node && test:regression`, so it exits non-zero at the first failing suite. CI runs the three suites as separate steps with `if: !cancelled() && steps.build.outcome == 'success'`, so each suite reports even after an earlier one fails. Lint, verify and the browser test are separate commands.
12. **Playwright.** `playwright-core` is pinned to exactly `1.63.0`, released 2026-09-04, not the 1.62.1 the smoke script used to suggest. Its Chromium is published for linux-arm64; 1.62.1's is not (§9). `playwright-core` has no install scripts and no test runner, and `tests/browser-smoke.js` already requires it. `npm run test:browser` runs the unchanged smoke test on `ws.mid` and `test-midi/all-gm-sounds.mid`, and each run checks both builds. Each run has a 180 s deadline whose process-group kill also stops Chromium.
13. **CI.** The four jobs, `lint`, `build-verify`, `test` and `browser-smoke`, all run on `ubuntu-24.04-arm` (D-008), and no x64 exception was needed. Triggers: `pull_request` to any base branch, `push` to `main`, and `workflow_dispatch`. The workflow has `permissions: contents: read`. Concurrency is grouped per workflow and pull request or ref, and cancels superseded runs only for pull requests, so every push to `main` keeps its own result. Timeouts are 10, 10, 20 and 20 minutes. Every job checks out with `fetch-depth: 0` and `persist-credentials: false`, and uses setup-node with `node-version-file: .nvmrc`, `cache: npm` and `cache-dependency-path: package-lock.json`, then runs `npm ci`. setup-node v7 caches nothing unless `cache` is given or `packageManager` names npm. The `test` and `browser-smoke` jobs rebuild and run `git diff --exit-code` on the distribution before testing it. `build-verify` runs `verify`, the same rebuild-and-diff, `pack:check`, and writes the size report to the job summary.
14. **Dependabot.** Monthly grouped updates for `github-actions` at `/` and npm development dependencies at `/`. Terser is excluded from the npm group, so its updates get their own PRs: a new Terser can change the minified bytes, `verify` then fails until someone rebuilds and the supervisor records the new hash. A separate, grouped, monthly npm entry covers `/.github/scripts/codex-cli` (supervisor request; nothing under `.github/scripts` was created or edited).

## 3. Edits to existing files outside the new tooling

`webaudio-tinysynth.js` (`e0ff12c`). All are behavior-preserving lint fixes. The regressions passed on the edited source before the commit.

| Line (after edit) | Rule | Change |
| --- | --- | --- |
| 604 | `no-unused-vars` | `xhr.onload=function(e){` → `function(){` (the event argument was never read) |
| 695 | `no-redeclare` | second `var len = Delta(...)` in `loadMIDI`'s `Msg` → `len = Delta(...)` (same function-scoped binding) |
| 722 | `no-useless-assignment` | `var idx = 0;` → `var idx;` (assigned before first use) |
| 727 | `no-unused-vars` | inline exception: the SMF format field is read but not validated yet (#4 will validate it) |
| 778 | `no-prototype-builtins` | inline exception on `p[n].hasOwnProperty(k)`: changing it would alter behavior for objects with their own `hasOwnProperty` or a null prototype, and #13 reworks timbre validation |
| 804, 889 | `no-empty` | the two empty `catch` blocks get a comment saying why the error is ignored |
| 809 | `no-unused-vars` | inline exception on `_limitVoices:(ch,n)`: callers pass the new note; the limit is global |

The edits change the minified output by 3 bytes on their own (§4, row "lint-fixed source, old options").

`tests/harness.js`:
- `e0ff12c`: optional catch binding in `upstreamSource()`'s git fallback (lint).
- `efd0740`: `TINYSYNTH_REFERENCE` pointing at an unreadable file now gives `FAIL: cannot read TINYSYNTH_REFERENCE=<path> (<error>)` and exit status 1, instead of an uncaught ENOENT stack trace. Valid and tampered references behave as before.

`tests/browser-smoke.js`:
- `e0ff12c`: inline `no-undef` exception for the page-side `window.smoke()` callback.
- `f096ba5`: the header comment now describes `npm run test:browser` and the browser install, says a missing browser fails, and records the autoplay limitation.

No assertion or expectation of the existing regression scripts changed. The demo HTML files, `bower_components/`, `.github/review-agents.json`, `.github/prompts/**`, `.github/scripts/**`, `.github/workflows/*review*.yml` and the supervisor records are untouched.

## 4. Artifact sizes and hashes

gzip is GNU `gzip -9 -n`, as in T0. `npm run size` prints both that and Node zlib level 9: 9,502 for the final minified file, which differs from GNU gzip by the deflate implementation.

| State | File | Bytes | gzip -9 -n | sha256 |
| --- | --- | ---: | ---: | --- |
| T0 baseline | `webaudio-tinysynth.js` | 54,000 | 11,765 | `abb2d0fb828ada86b692547560102035cf486fc1fac60ca190b5851235c1ee23` |
| T0 baseline | `webaudio-tinysynth.min.js` | 37,060 | 9,444 | `5aa3edbc13371694a83ec0f285a5d39d4e4a31b18a259c0bbdcbd5969f710c2c` |
| T0 baseline | `webaudio-tinysynth.min.js.map` | 59,637 | 11,423 | `fd7f64190db2152660f4c414b2f4afa4d5392c0483de2b9be3d670bf07995e2d` |
| lint-fixed source, old options (not committed) | `.min.js` | 37,057 | 9,441 | `b5b72d58d288a57d2257de545b8b7c646300cbc243d66d432ae61f591f663e35` |
| **final** | `webaudio-tinysynth.js` | 54,398 | 11,944 | `ae367b90699b51b2fc88e7e63e4b64201bed88b65a943767af779a3d88935e3f` |
| **final** | `webaudio-tinysynth.min.js` | **36,372** | **9,422** | **`782e9b92a8f26f383fc0f8830a6a1e5d4e7dce2d0ab23bf29ab48e06814301b2`** |
| **final** | `webaudio-tinysynth.min.js.map` | 59,671 | 11,478 | `e8c2c34dc27bf51611d932f6521b77092a4ff1636f2e10fb0a42dc846cc8f62d` |

Option measurements on the lint-fixed source (`scratch/artifact-options/`):

| Variant | Raw | gzip -9 -n |
| --- | ---: | ---: |
| A: old options (no mangle, no header) | 37,057 | 9,441 |
| B: A + license header | 37,404 | 9,659 |
| C: mangle with `keep_classnames` | 36,025 | 9,205 |
| C2: mangle without `keep_classnames` (class renamed to `s`; rejected) | 35,961 | 9,202 |
| D: mangle + header (final; the map `file` field adds 35 bytes to the map only) | 36,372 | 9,422 |

Final against T0: the minified file is 688 bytes (−1.86 %) smaller raw and 22 bytes (−0.23 %) smaller gzip; the map is 34 bytes larger. The minified file now starts with the 9-line header, then `!function(t){"use strict";…`, and ends with `}(this);` with no trailing newline. It contains no `</script`, `<script`, `<!--` or non-ASCII bytes, and no `sourceMappingURL`. In T0's inline `data:` URI probe, the minified build's data URL went from 55,730 to 54,810 bytes, and the source build's from 78,314 to 78,846. The minified file's hash changes from `5aa3edbc…` to `782e9b92…`, for ledger entry L-13.

## 5. npm audit

| State | Packages in lock | Findings |
| --- | ---: | --- |
| Before #15 (scratch lock, `node-minify` present) | 269 | 22 (8 critical, 9 high, 5 moderate), all through `node-minify@3.6.0` (including its nested `terser <4.8.1`); `npm audit` exit 1 |
| After #15 (Terser only) | 11 | 0 |
| Final committed lock (`package-lock.json` sha256 `48b0ab0b708efe46…`) | 146 entries (121 installed on linux-x64; 27 optional platform binaries for rolldown, lightningcss and fsevents) | 0, `npm audit` exit 0 |

So no findings remain, and none has any reachability: everything is a development dependency, and the published package has no dependencies. The lockfile contains the `linux-arm64-gnu` bindings of rolldown and lightningcss with integrity hashes. A simulated `npm ci --cpu=arm64 --os=linux --libc=glibc` from it installs them.

## 6. Package contents (`npm run pack:check`)

`webaudio-tinysynth-1.1.4.tgz`: 46,352 bytes packed, 186,008 unpacked, 7 files:

| Size | File |
| ---: | --- |
| 11,357 | `LICENSE` |
| 1,215 | `NOTICE` |
| 21,300 | `README.md` |
| 1,695 | `package.json` |
| 54,398 | `webaudio-tinysynth.js` |
| 36,372 | `webaudio-tinysynth.min.js` |
| 59,671 | `webaudio-tinysynth.min.js.map` |

`test-midi/README.md` (leaked at T0), tests, scripts, `docs/` (including `docs/improvements/**`), plans, configs, the demo pages, `bower_components` and `.github/**` are excluded. A planted `.github/scripts/**` tree was not packed. The scratch consumer `require()`d both entry points and got `class WebAudioTinySynth`, and the installed min.js sha256 equals the committed one. `package.json` still carries upstream's name, version and URLs; that is #20/T9's scope.

## 7. Validation

### Clean state

Fresh `git clone` of the worktree at `fec2e6c` (`scratch/clean-3`), with the pinned Node 24.21.0 and npm 11.19.0. `build` runs before `verify`, so the clone regenerates the distribution from source and `verify` compares that output.

| Command | Exit | Duration |
| --- | ---: | ---: |
| `npm ci` | 0 | 0.57 s (121 packages, 0 vulnerabilities) |
| `npm run lint` | 0 | 0.36 s |
| `npm run build` | 0 | 0.21 s |
| `npm run verify` | 0 | 0.25 s |
| `npm run size` | 0 | 0.12 s |
| `npm run pack:check` | 0 | 0.48 s |
| `npm run test:unit` | 0 | 10.81 s (30 tests) |
| `npm run test:node` | 0 | 6.29 s (24 tests) |
| `npm run test:regression` | 0 | 44.17 s (3 of 3) |
| `npm test` | 0 | 61.89 s |
| `npm run test:browser` | 0 | 4.90 s |

Three clean clones (`clean-1` at `d66b076`, `clean-2` and `clean-3` at `fec2e6c`; the source and build options are the same in both) each ran `npm ci` and then `npm run build`. All three produced `782e9b92…` and `e8c2c34d…`, the same bytes as the worktree build that the final commit contains. Counts: Vitest 30 tests (3 files × 2 builds); node:test 24 tests in 5 suites; regressions 3 of 3; the browser smoke test 9 of 9 checks for each build and fixture.

### Failure propagation (scratch copies only; nothing broken was committed)

| Demonstration | Command | Result |
| --- | --- | --- |
| Stale distribution | `npm run verify` in a clean clone before rebuilding (committed min.js is T0's) | exit 1: both files differ, first difference at byte 0 (fresh starts with the header) |
| Hand-edited minified byte | one letter changed in min.js, `npm run verify` | exit 1, first difference at byte 869 with context |
| Inline-unsafe bytes | `</SCRIPT>`, `<!--` and `é` injected into min.js, `npm run verify` | exit 1: mismatch plus `"</SCRIPT" at byte 878; "<!--" at byte 888; non-ASCII byte 0xc3 at byte 899` |
| Distribution drift during development | `npm run verify` after the lint fixes | exit 1, 37,060 vs 37,057 bytes, first difference at `xhr.onload=function(e)` |
| Undefined variable in the library | `this.loop=fl;` in `setLoop`, `npm run lint` | exit 1: `'fl' is not defined (no-undef)` |
| Syntax error | `this.loopEnd=t;;)`, `npm run lint` | exit 1: `Parsing error: Unexpected token )` |
| Undefined variable in a test file | `undefinedHelper()` in a new `tests/*.js`, `npm run lint` | exit 1 (`no-undef`) |
| `.github/scripts` excluded | undefined names and `*.test.mjs` and `*.test.cjs` files planted under `.github/scripts/` | `lint` exit 0; `vitest list` shows only the 3 unit files; the `node --test` glob matches only `tests/node/*`; the pack list is unchanged |
| Mutation: velocity-0 note-on treated as note-on | `if(v==0)` → `if(v<0)` in `noteOn` of a scratch source, `npm run test:unit` | exit 1, the 3 velocity-0 tests fail for `webaudio-tinysynth.js` only |
| Mutation: tempo floored again | `Math.floor(60000000 / Get3(...))`, `npm run test:unit` | exit 1: fractional tempo map, `expected 0.22900763358778628 to be close to 0.2275` |
| Failing node test | a test asserting `1 + 1 === 3` added, `npm run test:node` | exit 1 (24 pass, 1 fail) |
| Failing node suite inside `npm test` | same, `npm test` | exit 1 after `test:node`; the regressions did not run |
| Hung node test file | a `for(;;){}` test file, `run-with-deadline.js 15 node --test …` (the `test:node` command with 15 s instead of 600 s) | exit 124 after 15.0 s: "timed out after 15 s; its process group was killed"; no test process left |
| Regression-only failure | `TOLERANCE = 0` in `tests/tempo.js`, `npm test` | unit and node pass; regressions "2 of 3 passed"; exit 1 |
| Hung regression script | `for(;;){}` at the top of `tests/tempo.js`, `run-regressions.js --deadline=10 tests/tempo.js tests/differential.js` | exit 1. tempo.js was killed at 10 s. differential.js, which needs about 14 s, was also killed at the short demo deadline, and the runner reported both. |
| Runner fixtures (permanent tests) | `tests/node/runner.test.cjs` | failing, throwing and hanging children fail the runner; a hung child's own child is killed (checked through `/proc`, zombies count as dead); the wrapper passes exit status 3 through and returns 124 on timeout |
| Missing browser | `PLAYWRIGHT_BROWSERS_PATH=<empty>` `npm run test:browser` | exit 1: `Executable doesn't exist …chromium_headless_shell-1243…` |
| Missing system library | `npm run test:browser` without the extracted libraries | exit 1: `libnspr4.so: cannot open shared object file` |

## 8. CI action pins and checks

Resolved at about 2026-10-03T02:01Z with `gh api repos/<repo>/releases/latest`, then `git/ref/tags/<tag>`. Both tags point directly at commit objects, not annotated tags. I read each action's `action.yml` at that tag for inputs and runtime.

| Action | Release | Commit | Runtime | Inputs used |
| --- | --- | --- | --- | --- |
| [actions/checkout](https://github.com/actions/checkout/releases/tag/v7.0.1) | v7.0.1 (2026-07-20) | `3d3c42e5aac5ba805825da76410c181273ba90b1` | node24 | `fetch-depth: 0`, `persist-credentials: false` |
| [actions/setup-node](https://github.com/actions/setup-node/releases/tag/v7.0.0) | v7.0.0 (2026-07-14) | `820762786026740c76f36085b0efc47a31fe5020` | node24 | `node-version-file: .nvmrc`, `cache: npm`, `cache-dependency-path: package-lock.json` |

- **actionlint** [v1.7.12](https://github.com/rhysd/actionlint/releases/tag/v1.7.12), the latest release, ran from `actionlint_1.7.12_linux_amd64.tar.gz` (checked against the release's checksums file) with shellcheck [v0.11.0](https://github.com/koalaman/shellcheck/releases/tag/v0.11.0) (tarball sha256 `8c3be12b05d5c177…`; the release publishes no checksum file). Result: 0 errors. A copy with the label `ubuntu-24.04-armx` was rejected as unknown, and actionlint's list of known hosted labels includes `ubuntu-24.04-arm`.
- `.github/dependabot.yml` parses as YAML with three update entries. It has not been validated by GitHub.

## 9. Browser smoke and arm64

- **Local.** Chromium headless shell 153.0.8010.12 (Playwright revision 1243, linux64) ran with T0's extracted noble libraries; no additional library was needed. Both fixtures passed for both builds: zero requests, no page or console errors, AudioContext running, and `curTick` advancing (0 → 1200 on `ws.mid`, 96 → 336 on `all-gm-sounds.mid`). T0's inline `data:` URI probe on the final build passed launch A (autoplay bypass): playback with zero requests. Launches B and D showed no requests or errors. Launch C needs the full Chromium build, which is not installed, so it did not run.
- **arm64 evidence (availability, not execution).** On the Playwright CDN, which redirects to `storage.googleapis.com/chrome-for-testing-public`:

  | Build | 153.0.8010.12 (Playwright 1.63.0) | 151.0.7922.34 (Playwright 1.62.1) |
  | --- | --- | --- |
  | `linux-arm64/chrome-headless-shell-linux-arm64.zip` | HTTP 200 (120,278,638 bytes) | HTTP 404 |
  | full `linux-arm64/chrome-linux-arm64.zip` | HTTP 200 | HTTP 404 |

  Playwright 1.63.0's registry maps `ubuntu24.04-arm64` to those builds, and its `--with-deps` package list for arm64 copies the x64 list. Nothing was executed on arm64 here.
- **Limitation (#16).** The smoke test launches Chromium with `--autoplay-policy=no-user-gesture-required` and loads the page with `setContent`, so passing does not show that audio starts after a normal user gesture. T0 found that the AudioContext was already running under every launch policy. Gesture tests remain T6 scope.

## 10. Open risks and decisions for the supervisor

1. **No real Actions run.** I could not run the workflow. Only a run on GitHub can confirm:
   - the `ubuntu-24.04-arm` runner is available to this repository;
   - setup-node installs Node 24.21.0 for arm64;
   - npm caching works;
   - `npx playwright-core install --with-deps --only-shell chromium` installs Chromium 153 and its libraries on arm64;
   - Chromium starts there;
   - the job timeouts and durations are adequate. Locally: `npm test` takes about 62 s on x64, and synth construction takes about 0.44 s under the mock, which is #18's initialization cost.

   If Chromium fails on arm64, D-008 allows a recorded x64 exception for `browser-smoke` only.
2. **Ledger L-13.** The minified file's hash changes from `5aa3edbc…` to `782e9b92a8f26f383fc0f8830a6a1e5d4e7dce2d0ab23bf29ab48e06814301b2` (36,372 bytes) because of mangling, the kept header, the map `file` field and the lint fixes. The consumer's pinned hash must follow at release time.
3. **Line endings (resolved).** The minified file now has line breaks (the kept header). `.gitattributes` keeps `* text=auto` and now marks `webaudio-tinysynth.min.js` and `webaudio-tinysynth.min.js.map` `-text`, so no checkout converts their line endings (`git check-attr`: `text: unset`). `git add --renormalize .` produced no changes, and `npm run verify` passes. The build itself is line-ending independent (§2.4). The README's `-c core.autocrlf=false` advice remains harmless for the source.
4. **Local Node (resolved).** The user's `/workspace/.tool-versions` pins Node 24.19.0 (npm 11.17.0), which the relaxed `engines` accepts without a warning. CI still uses the exact 24.21.0 pin in `.nvmrc`.
5. **Test commands are POSIX-only**, because they rely on process-group kill. Windows is not supported for `test:node`, `test:regression` or `test:browser`.
6. **`npm test` locally stops at the first failing suite.** CI runs the suites as separate steps.
7. **Dependabot.** A Terser update PR fails `verify` by design until someone rebuilds and records the new hash. A Playwright update changes the Chromium revision, which CI installs to match.
8. **Fresh dependency.** `eslint@10.12.0` was released on the day it was pinned (2026-10-02). The lockfile pins it and it passed every check, but a patch release may follow.
9. **Stale text outside my sections.** These are for #20/T9:
   - README's "About this fork" still says the minified file is 36,804 bytes; it is now 36,372.
   - `package.json` keeps upstream's name, version and URLs.
   - `/workspace/webaudio-tinysynth/AGENTS.md` still calls `npm test` a placeholder and describes the custom element.
10. **Not done.** No release tags, no README release hashes, nothing published, nothing pushed. `.github/scripts/**`, the review workflows and the supervisor records were not touched.
