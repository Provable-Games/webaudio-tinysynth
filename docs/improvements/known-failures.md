# Known failures retained for later diagnosis

The user authorized D-043: keep these tests and their original failed
results, but allow the documented exceptions to be nonblocking in ordinary
PR CI. These defects remain unresolved. Tests still execute with their
existing tolerances; diagnostic rerenders cannot replace the first attempt.
A dedicated diagnosis lab is deferred.

Ordinary core CI explicitly uses `--accept-known-failures`. Local commands
default to strict behavior; accepting a known render failure requires `--out`
and valid retained Float32 sidecars and first-failure WAVs when applicable.
The strict full-mix qualification mode rejects this option.

| Failure | Accepted ordinary-CI scope | Tracking |
| --- | --- | --- |
| Stereo generated-buffer descriptor contradiction | A final `convBuf` descriptor says one channel, while browser and Node capture traces, independent expected dimensions, retained raw bytes and SHA-256 agree on stereo. Only this descriptor discrepancy and its derived checks are excepted. All three engines, quality 0/1, 44.1/48 kHz. | #79 |
| WebKit noisy-program first PCM mismatch | `render q0 44100`: GM121/125; `render q0 48000`: GM127; `short-notes completed min`: q1/program126. Only the named parity/completed-attack assertion and its valid split-measurement layout are excepted. Other programs, fixtures, assertions and malformed evidence remain blocking. | #91 |
| WebKit full-mix peak overshoot | Historical `ws-mid-default`, q1/48 kHz, first captures. Already outside ordinary PR CI in the manual strict qualification lane; its actual failed/incomplete verdict is retained. | #79, #91 |

## Retained evidence

- ARM browser run `37529210736`, PR head `9ab3af6`: 336/342 core cases
  passed. Five descriptor failures and a WebKit completed-short-note first
  mismatch were recorded; the clean diagnostic did not clear the first
  failure.
- x64 browser run `37553984962`, PR head `346968e`: 339/342 core cases
  passed. Firefox and WebKit q0/44.1 kHz min descriptors still contradicted
  valid stereo captures. All 72 saved generated-buffer artifacts were
  reopened; their captured dimensions and hashes agreed with retained bytes,
  the source/min counterpart and the other engines. ARM is not necessary
  for this reporting defect.
- The same x64 run retained the original WebKit q0/48 kHz GM127 mono WAV
  pair. First divergence is frame 14112. The source capture has 128 zero
  samples at `[14368,14496)` (2.67 ms), while min has audio there. Both remain
  active and different through final frame 76799. Actual maximum absolute
  difference is `0.48989351093769073` at frame 14562. Both are finite and
  within full scale. Source WAV SHA-256:
  `8c9e9a277d2b5e27da844809aaa0221d34634a4dc9772d4312a0a675fb6566cc`;
  min WAV SHA-256:
  `0480f5b62c5d72fc5e84238ede5e8549934d308bc1e713d568c14aa830c0ed83`.
- Earlier WebKit GM121 mono/44.1 kHz evidence in run `37524201138` also
  contains a 128-sample source-side zero interval, but its differing active
  tail ends before both captures become silent. Similar shapes do not prove
  a shared cause. The full-mix evidence recorded peaks near -1.70/-1.73;
  source/min and diagnostic captures retained that spike. No audibility or
  production-device conclusion follows from these fixture measurements.

The downloaded reports, original WAVs, Float32 sidecars and audit receipts
are preserved under `_evidence/p1-supervision/x64-comparison-20261006/` and
`_evidence/p1-noise-path/` outside the repository. GitHub artifacts have
limited retention; these local copies are the evidence for the deferred lab.

## Limits and removal

Acceptance is a project-progress decision, not a passing audio measurement
or a demonstrated runtime cause. A new defect inside an excepted assertion
may also be nonblocking until diagnosis removes the exception. Unknown
checks, required missing/corrupted artifacts, stale provenance, nonfinite
samples and browser/cleanup/timeout failures still block ordinary CI.

Strict qualification and production/device reports keep their actual
verdicts; incomplete inputs or references do not become certified. Remove
an exception after the lab reproduces its cause, validates the fix against
retained first failures and fresh captures, and restores its blocking check.
The user controls merges and release acceptance.
