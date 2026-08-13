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

// ── Save storage host API (window.oprt.gameStorage) ─────────────────────────
// The GameMaker runner mounts /_savedata through GXMFS when window.oprt.gameStorage
// exists, and reads/writes every save through it. The launcher's save manager also
// uses this same IndexedDB (/_savedata → object store FILE_DATA) with full-path
// keys (/_savedata/filech4_3) and {timestamp, mode, contents} values, so providing
// gameStorage here makes the runner and the launcher share one store. Without this,
// the host that actually loads the game supplies its own gameStorage with a different
// scheme and the launcher's imported/edited saves are never seen by the game.
(function() {
  if (typeof indexedDB === 'undefined') return;
  var SAVE_DB = '/_savedata';
  var STORE = 'FILE_DATA';

  function openDB() {
    return new Promise(function(resolve, reject) {
      var req = indexedDB.open(SAVE_DB);
      req.onerror = function() { reject(req.error); };
      req.onsuccess = function() {
        var db = req.result;
        if (db.objectStoreNames.contains(STORE)) { resolve(db); return; }
        db.close();
        var up = indexedDB.open(SAVE_DB, db.version + 1);
        up.onupgradeneeded = function(e) {
          var s = e.target.result;
          var store = s.objectStoreNames.contains(STORE)
            ? e.target.transaction.objectStore(STORE)
            : s.createObjectStore(STORE);
          if (!store.indexNames.contains('timestamp')) {
            store.createIndex('timestamp', 'timestamp', { unique: false });
          }
        };
        up.onsuccess = function() { resolve(up.result); };
        up.onerror = function() { reject(up.error); };
      };
    });
  }

  function store(mode) {
    return openDB().then(function(db) {
      return new Promise(function(resolve, reject) {
        var t = db.transaction(STORE, mode);
        var s = t.objectStore(STORE);
        t.oncomplete = function() { db.close(); };
        t.onabort = t.onerror = function() { db.close(); reject(t.error); };
        resolve(s);
      });
    });
  }

  function list() {
    return store('readonly').then(function(s) {
      return new Promise(function(resolve, reject) {
        var out = {};
        var req = s.openCursor();
        req.onsuccess = function() {
          var c = req.result;
          if (!c) { resolve(out); return; }
          out[c.primaryKey] = { timestamp: c.value && c.value.timestamp };
          c.continue();
        };
        req.onerror = function() { reject(req.error); };
      });
    });
  }

  function get(key) {
    return store('readonly').then(function(s) {
      return new Promise(function(resolve, reject) {
        var req = s.get(key);
        req.onsuccess = function() { resolve(req.result || null); };
        req.onerror = function() { reject(req.error); };
      });
    });
  }

  function put(value, key) {
    return store('readwrite').then(function(s) {
      return new Promise(function(resolve, reject) {
        var req = s.put(value, key);
        req.onsuccess = function() { resolve(); };
        req.onerror = function() { reject(req.error); };
      });
    });
  }

  function del(key) {
    return store('readwrite').then(function(s) {
      return new Promise(function(resolve, reject) {
        var req = s.delete(key);
        req.onsuccess = function() { resolve(); };
        req.onerror = function() { reject(req.error); };
      });
    });
  }

  var gameStorage = { open: function() { return { list: list, get: get, put: put, delete: del }; } };

  window.oprt = window.oprt || {};
  window.oprt.gameStorage = gameStorage;

  // The runner also calls the rest of the oprt host API; provide no-op stubs if
  // the host page didn't (the launcher handles fullscreen/close itself).
  var noop = function() {};
  ['closeTab', 'enterFullscreen', 'exitFullscreen', 'lockPortraitOrientation', 'lockLandscapeOrientation']
    .forEach(function(m) { if (typeof window.oprt[m] !== 'function') window.oprt[m] = noop; });
})();

