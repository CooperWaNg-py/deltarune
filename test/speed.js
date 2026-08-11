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

// ── Volume control ────────────────────────────────────────────────────────
// Routes every audio node that connects to the AudioContext destination through
// a per-context master GainNode, then exposes that gain to the parent launcher
// via postMessage({type:'volume', volume:0..1}) and the localStorage 'storage'
// event. This never shadows `destination`, so it can't break the game's audio
// graph — on any error it falls back to the original connect/disconnect.
(function() {
  var VKEY = 'deltarune_volume';
  function getVol() {
    var v = parseFloat(localStorage.getItem(VKEY));
    if (!isFinite(v)) v = 100;
    return Math.max(0, Math.min(100, v)) / 100;
  }
  if (typeof AudioNode === 'undefined' || typeof AudioDestinationNode === 'undefined') return;

  var realConnect = AudioNode.prototype.connect;
  var realDisconnect = AudioNode.prototype.disconnect;
  var masters = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;
  var allMasters = [];

  function getMaster(ctx) {
    var m = masters && masters.get(ctx);
    if (!m) {
      m = ctx.createGain();
      m.gain.value = getVol();
      realConnect.call(m, ctx.destination); // master -> real destination (original connect)
      if (masters) masters.set(ctx, m);
      allMasters.push(m);
    }
    return m;
  }

  AudioNode.prototype.connect = function(target) {
    try {
      if (target instanceof AudioDestinationNode) {
        var master = getMaster(target.context);
        if (this !== master) { realConnect.call(this, master); return target; }
      }
    } catch (e) {}
    return realConnect.apply(this, arguments);
  };

  AudioNode.prototype.disconnect = function(target) {
    try {
      if (target instanceof AudioDestinationNode) {
        var master = masters && masters.get(target.context);
        if (master && this !== master) { realDisconnect.call(this, master); return; }
      }
    } catch (e) {}
    return realDisconnect.apply(this, arguments);
  };

  function applyVolume() {
    var g = getVol();
    for (var i = 0; i < allMasters.length; i++) {
      try { allMasters[i].gain.value = g; } catch (e) {}
    }
  }

  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'volume') {
      var vol = typeof e.data.volume === 'number' ? e.data.volume : 1;
      try { localStorage.setItem(VKEY, String(Math.round(vol * 100))); } catch (er) {}
      applyVolume();
    }
  });
  window.addEventListener('storage', function(e) {
    if (e.key === VKEY) applyVolume();
  });
})();

