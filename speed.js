(function() {
  var KEY = 'deltarune_speed';

  function getSpeed() {
    var s = parseFloat(localStorage.getItem(KEY));
    if (!isFinite(s) || s <= 0) s = 1;
    return Math.max(0.25, Math.min(5, s));
  }

  // Monotonic wrapper for requestAnimationFrame
  // Tracks (realLast, virtLast) to keep time monotonic across speed changes
  var origRAF = window.requestAnimationFrame;
  if (typeof origRAF === 'function') {
    var rafReal = null, rafVirt = null;
    window.requestAnimationFrame = function(cb) {
      return origRAF.call(window, function(t) {
        if (rafReal === null) { rafReal = t; rafVirt = t; cb(t); return; }
        rafVirt += (t - rafReal) * getSpeed();
        rafReal = t;
        cb(rafVirt);
      });
    };
  }

  // Monotonic wrapper for performance.now
  var origPerf = window.performance.now;
  if (typeof origPerf === 'function') {
    var pnReal = null, pnVirt = null;
    window.performance.now = function() {
      var real = origPerf.call(window.performance);
      if (pnReal === null) { pnReal = real; pnVirt = real; return real; }
      pnVirt += (real - pnReal) * getSpeed();
      pnReal = real;
      return pnVirt;
    };
  }

  // Wrap Date.now
  var origDateNow = Date.now;
  if (typeof origDateNow === 'function') {
    var dnReal = null, dnVirt = null;
    Date.now = function() {
      var real = origDateNow();
      if (dnReal === null) { dnReal = real; dnVirt = real; return real; }
      dnVirt += (real - dnReal) * getSpeed();
      dnReal = real;
      return Math.floor(dnVirt);
    };
  }

  // Wrap setTimeout / setInterval — divide delay by speed
  window.setTimeout = (function(orig) {
    return function(cb, delay) {
      var args = Array.prototype.slice.call(arguments, 2);
      return orig.apply(window, [cb, delay / getSpeed()].concat(args));
    };
  })(window.setTimeout);

  window.setInterval = (function(orig) {
    return function(cb, delay) {
      var args = Array.prototype.slice.call(arguments, 2);
      return orig.apply(window, [cb, delay / getSpeed()].concat(args));
    };
  })(window.setInterval);
})();
