/* global window */
/*
 * XMLHttpRequest completion records for test pages, inlined after the
 * library. open/send are wrapped (behavior and return values unchanged) to
 * record each request's "loadend". loadend is dispatched after "load", whose
 * handlers (the library's onload, which parses and installs the song) have
 * then returned, also when such a handler throws; a recorded loadend means
 * the library has finished with that response. window.__t6.xhr.done(url)
 * returns {url, outcome, status} or null.
 */
(function () {
  "use strict";
  var done = [];
  var XHR = window.XMLHttpRequest.prototype;
  var realOpen = XHR.open, realSend = XHR.send;
  XHR.open = function (method, url) {
    this.__t6url = String(url);
    return realOpen.apply(this, arguments);
  };
  XHR.send = function () {
    var xhr = this;
    var outcome = "pending";
    ["load", "error", "abort", "timeout"].forEach(function (type) { xhr.addEventListener(type, function () { outcome = type; }); });
    xhr.addEventListener("loadend", function () { done.push({ url: xhr.__t6url, outcome: outcome, status: xhr.status }); });
    return realSend.apply(this, arguments);
  };
  window.__t6.xhr = {
    done: function (url) {
      for (var i = 0; i < done.length; ++i) if (done[i].url === url) return done[i];
      return null;
    },
  };
})();
