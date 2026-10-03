/*
 * Baseline behavior the matrix recognizes but does not accept as correct.
 * Each entry names the issue and task expected to remove it; phase B turns
 * the corresponding observation into an assertion (docs/improvements/tasks/T6.md).
 */
"use strict";

/*
 * Unhandled promise rejections caused by the library at baseline. send()
 * calls audioContext.resume() whenever the context is suspended, without
 * handling the promise (#12). With an OfflineAudioContext installed through
 * setAudioContext() (state "suspended" until rendering starts) every send()
 * rejects; closing a realtime context while such a resume() is pending
 * rejects it too. Messages per engine as measured (Chromium 153, Firefox 155,
 * WebKit 26.6).
 */
const KNOWN_REJECTIONS = [
  {
    id: "offline-resume", issue: "#12", task: "T4",
    about: "send() calls resume() on an OfflineAudioContext that has not started rendering",
    match: /cannot resume an offline context that has not started|Can't resume OfflineAudioContext|Cannot resume an offline audio context that has not started/,
  },
  {
    id: "closed-pending-resume", issue: "#12", task: "T4",
    about: "a resume() left pending by send() is rejected when its realtime context is closed",
    match: /^Closed before resume completed$|^AudioDestinationNode is not initialized$/,
  },
];

/* Returns {counts: {id: n}, unknown: [rejection]}. */
function classifyRejections(rejections) {
  const counts = {};
  const unknown = [];
  for (const r of rejections) {
    const k = KNOWN_REJECTIONS.find((x) => x.match.test(r.message));
    if (k) counts[k.id] = (counts[k.id] || 0) + 1;
    else unknown.push(r);
  }
  return { counts, unknown };
}

module.exports = { KNOWN_REJECTIONS, classifyRejections };
