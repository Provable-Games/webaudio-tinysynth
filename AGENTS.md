# Repository Guidelines

## Project Structure & Module Organization

`webaudio-tinysynth.js` contains the synthesizer, timbres, MIDI parser, and sequencer. This Provable Games fork exposes the JavaScript API with the upstream GUI removed. `webaudio-tinysynth.min.js` and its `.map` are generated distribution files.

`tests/` contains regression scripts and the shared mock WebAudio harness. `ws.mid` is a playback fixture; `test-midi/` documents additional MIDI fixtures. The demos are `simple.html`, `soundedit.html`, and `jstest.html`. Vendored demo controls and image assets live in `bower_components/webaudio-controls/`.

## Agent Skills (Core Responsibility)

Agent skills are part of this project's tooling. Keeping them correct is a core responsibility of every agent working here, not optional cleanup.

- **Find them first.** Before starting a task, check for skills that cover it: the skills listed in your session, any `.claude/skills/` directory, and the shared [Provable-Games/agent-skills](https://github.com/Provable-Games/agent-skills) repository (for example, `github-ci` for CI and AI review workflows). Read the relevant ones and follow them.
- **Treat their correctness as vital.** Other agents act on skills without re-deriving them. Verify the commands, versions, flags, APIs, and claims you rely on. When the code, a tool, or a measured result contradicts a skill, the skill is wrong until it is fixed.
- **Fix what you learn.** When your work reveals an error, gap, outdated pin, or a better verified technique, update the skill as part of the task. Update it here directly, or open a focused PR to the skills repository and follow its `CONTRIBUTING.md`. Cite the evidence (PR, run, issue, or measurement). Keep secrets and private project details out of shared skills.
- **Close the loop.** Record skill follow-ups in your task notes. Complete them, or hand them off explicitly, before reporting the task done.

## Build, Test, and Development Commands

- `npm install`: install development tools; the library has no runtime dependencies.
- `npm run build`: use Terser to regenerate the minified library and source map. Include both generated files with source changes.
- `npm test`: run differential playback, fractional-tempo, and loop-end regression scripts against both library builds.
- `python3 -m http.server 8000`: serve the repository; open `http://localhost:8000/simple.html` or another demo.
- `PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node tests/browser-smoke.js`: run the optional offline browser check. Install Playwright Core and matching Chromium separately; this script is outside `npm test`.

## Coding Style & Naming Conventions

Use two-space indentation, double-quoted strings, and semicolons. Match the compact surrounding style in the library; tests use modern Node.js JavaScript. Use camelCase for functions and properties, retaining established API names such as `loadMIDI` and `setLoopEnd`. Name test scripts descriptively, for example `tests/loop-end.js`.

No formatter or linter is configured. Edit the source and regenerate distribution files. Preserve browser, CommonJS, and AMD exports and keep the library self-contained.

## Testing Guidelines

Tests use custom Node.js scripts and `tests/harness.js`, without a testing framework or numerical coverage threshold. Add focused regression cases for playback changes and reuse the deterministic clock and MIDI generator.

Differential tests require upstream commit `3d75aee` in local Git history. Use a full checkout or set `TINYSYNTH_REFERENCE` to that commit's original source; the harness verifies its SHA-256. Rebuild before testing source changes.

## Commit & Pull Request Guidelines

Recent commits use concise imperative subjects, such as `Fix loopEnd timing when the song changes tempo`. Follow that style and keep changes focused.

Pull requests should describe the behavior change, link relevant issues, and report validation. Include screenshots for visible demo changes. Update `README.md`, `NOTICE`, and the source header when documenting fork behavior changes, while preserving Apache-2.0 attribution.
