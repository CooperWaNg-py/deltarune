(function() {
  var KEY = 'deltarune_speed';

  // wrap requestAnimationFrame
  var origRAF = window.requestAnimationFrame;
  if (typeof origRAF === 'function') {
    var base = null;
    window.requestAnimationFrame = function(cb) {
      return origRAF.call(window, function(t) {
        if (base === null) base = t;
        var s = parseFloat(localStorage.getItem(KEY));
        if (!isFinite(s) || s <= 0) s = 1;
        s = Math.max(0.25, Math.min(5, s));
        cb(base + (t - base) * s);
      });
    };
  }

  // wrap performance.now for engine timers that don't use rAF timestamp
  var origPerf = window.performance.now;
  if (typeof origPerf === 'function') {
    var perfBase = null;
    window.performance.now = function() {
      var real = origPerf.call(window.performance);
      if (perfBase === null) perfBase = real;
      var s = parseFloat(localStorage.getItem(KEY));
      if (!isFinite(s) || s <= 0) s = 1;
      return perfBase + (real - perfBase) * s;
    };
  }
})();
