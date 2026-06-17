(function() {
  var KEY = 'deltarune_speed';
  var orig = window.requestAnimationFrame;
  if (typeof orig !== 'function') return;

  var base = null;
  window.requestAnimationFrame = function(cb) {
    return orig.call(window, function(t) {
      if (base === null) base = t;
      var s = parseFloat(localStorage.getItem(KEY)) || 1;
      cb(base + (t - base) * s);
    });
  };
})();
