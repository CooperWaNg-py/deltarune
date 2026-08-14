// ── IndexedDB version + schema reconciliation ───────────────────────────────
// Several clients share the game's databases: the runner's IDBFS (which always
// asks for /_savedata at version 21) and its asset cache (emscripten_filesystem
// at fixed version 1), the launcher's save manager (unversioned) and the
// multi-chapter build's in-page manager. IndexedDB rejects any open() whose
// fixed version is below the version already on disk, and both callers swallow
// that error — so once a client pushed a version up (the chapter-5 build used
// to force /_savedata past 2048, and emscripten_filesystem with it), chapters
// booted with an EMPTY /_savedata and no asset cache, while the launcher still
// listed every save.
// This is the only place in the project allowed to touch indexedDB.open.
(function() {
  if (typeof indexedDB === 'undefined' || typeof IDBFactory === 'undefined') return;

  var SAVE_DB = '/_savedata';
  var STORE = 'FILE_DATA';
  var BASE_VERSION = 21;              // the version IDBFS itself requests
  var CACHE_DB = 'emscripten_filesystem';   // the runner's asset cache
  var VERSION_HINT_KEY = 'deltarune_idb_versions';

  var nativeOpen = IDBFactory.prototype.open;
  if (!nativeOpen || nativeOpen.deltaruneSavePatch) return;

  // Seeded synchronously so the very first open of the page — even one that
  // beats the async probe below — already knows not to ask for a version below
  // what is on disk.
  var known = {};
  known[SAVE_DB] = 0;
  known[CACHE_DB] = 0;
  try {
    var hint = JSON.parse(localStorage.getItem(VERSION_HINT_KEY) || '{}');
    Object.keys(known).forEach(function(name) {
      var v = parseInt(hint[name], 10);
      if (isFinite(v) && v > 0) known[name] = v;
    });
  } catch (e) {}

  function remember(name, version) {
    if (!(name in known) || !(version > known[name])) return;
    known[name] = version;
    try { localStorage.setItem(VERSION_HINT_KEY, JSON.stringify(known)); } catch (e) {}
  }

  function track(name, db) {
    if (!db) return db;
    remember(name, db.version);
    // Never keep a connection that would block another client's upgrade —
    // a blocked upgrade hangs chapter boot behind the loading spinner.
    db.addEventListener('versionchange', function() { try { db.close(); } catch (e) {} });
    return db;
  }

  function patchedOpen(name, version) {
    var watched = (name in known);
    if (watched && typeof version === 'number' && isFinite(version) && version < known[name]) {
      version = known[name];
    }
    var req = nativeOpen.call(this, name, version);
    if (watched) {
      req.addEventListener('success', function() { track(name, req.result); });
      req.addEventListener('error', function() {
        var err = req.error;
        if (err && err.name === 'VersionError') {
          console.warn('[saves] ' + name + ' is newer than this client expected; reload the page.');
        }
      });
    }
    return req;
  }
  patchedOpen.deltaruneSavePatch = true;

  try {
    Object.defineProperty(IDBFactory.prototype, 'open', {
      configurable: true, writable: true, value: patchedOpen
    });
  } catch (e) { return; }

  // Learn each database's on-disk version before the runner opens it, and make
  // sure FILE_DATA and its timestamp index exist: IDBFS enumerates the remote
  // file set through that index, and a store without it fails every sync with
  // NotFoundError. Only upgrades when something is actually missing — it never
  // bumps a version for its own sake.
  function probe(name, onOpen) {
    var req;
    try { req = nativeOpen.call(indexedDB, name); } catch (e) { return; }
    req.onsuccess = function() { onOpen(track(name, req.result)); };
    req.onerror = function() {};
  }

  probe(CACHE_DB, function(db) { db.close(); });

  probe(SAVE_DB, function(db) {
    var needsStore = !db.objectStoreNames.contains(STORE);
    var needsIndex = false;
    if (!needsStore) {
      try {
        needsIndex = !db.transaction(STORE, 'readonly').objectStore(STORE).indexNames.contains('timestamp');
      } catch (e) {}
    }
    if (!needsStore && !needsIndex && db.version >= BASE_VERSION) { db.close(); return; }
    var target = Math.max(db.version + 1, BASE_VERSION);
    db.close();
    var up;
    try { up = nativeOpen.call(indexedDB, SAVE_DB, target); } catch (e) { return; }
    up.onupgradeneeded = function(e) {
      var idb = e.target.result;
      var store = idb.objectStoreNames.contains(STORE)
        ? e.target.transaction.objectStore(STORE)
        : idb.createObjectStore(STORE);
      if (!store.indexNames.contains('timestamp')) {
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
    up.onsuccess = function() { track(SAVE_DB, up.result).close(); };
    up.onerror = function() {};      // the runner's own upgrade path still runs
    up.onblocked = function() {};    // another tab holds it; that tab repairs it
  });
})();

(function() {
  var KEY = 'deltarune_speed';

  function getSpeed() {
    var s = parseFloat(localStorage.getItem(KEY));
    if (!isFinite(s) || s <= 0) s = 1;
    return Math.max(0.25, Math.min(5, s));
  }

  // ONE virtual clock behind both performance.now and requestAnimationFrame.
  // rAF timestamps are specified to be performance.now values, so two separate
  // accumulators (with epochs set seconds apart, since the first frame only
  // happens after the runner has loaded ~30 MB) drifted apart in proportion to
  // load time and made every `performance.now() - lastFrameTime` delta garbage.
  var origPerf = (window.performance && window.performance.now) ? window.performance.now : null;
  var realLast = null, virtLast = null;

  function virtualTime(real) {
    if (realLast === null) { realLast = real; virtLast = real; return real; }
    if (real <= realLast) return virtLast;          // stay monotonic
    virtLast += (real - realLast) * getSpeed();
    realLast = real;
    return virtLast;
  }

  var origRAF = window.requestAnimationFrame;
  if (typeof origRAF === 'function') {
    window.requestAnimationFrame = function(cb) {
      return origRAF.call(window, function(t) { cb(virtualTime(t)); });
    };
  }

  if (typeof origPerf === 'function') {
    window.performance.now = function() { return virtualTime(origPerf.call(window.performance)); };
  }

  // Date.now is deliberately NOT wrapped: it is wall clock, and IDBFS stamps
  // every save file's mtime with it. Scaling it wrote times that never happened
  // into the save metadata the launcher displays and sorts by. GameMaker drives
  // its own clock from performance.now/rAF, both already scaled above.

  // Wrap setTimeout / setInterval — divide delay by speed.
  // Note: the delay is scaled at scheduling time, so timers already in flight
  // keep the pacing they were created with until they are re-armed.
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

// ── Launcher key bridge ─────────────────────────────────────────────────────
// Once the game canvas has focus the launcher document stops receiving keys, so
// Escape (back to menu) and the [ ] \ speed shortcuts were unreachable during
// play. Forward exactly those four keys up to the launcher without consuming
// them, so the game still sees the keystroke.
(function() {
  if (window.parent === window) return;
  var FORWARD = { 'Escape': 1, '[': 1, ']': 1, '\\': 1 };
  window.addEventListener('keydown', function(e) {
    if (!FORWARD[e.key]) return;
    try {
      window.parent.postMessage({ type: 'launcher-key', key: e.key }, window.location.origin);
    } catch (err) {}
  }, true);

  // Clicking anywhere in the game area must leave the keyboard pointing at the
  // game: the launcher chrome (settings, save manager, back button) takes focus
  // away from this frame, and GameMaker only sees keys that reach this window.
  window.addEventListener('pointerdown', function() {
    try { window.focus(); } catch (err) {}
  }, true);

  // NOTE: the launcher-quit route deliberately does NOT go through
  // window.oprt. Defining that object at all changes how the runner behaves
  // (it treats it as the Opera GX host API: GXMFS instead of IDBFS for saves,
  // and a host-driven input/fullscreen model), so the chapter pages post
  // `launcher-quit` themselves from quitIfSupported().
})();

// ── Volume control ────────────────────────────────────────────────────────
// Routes every audio node that connects to the AudioContext destination through
// a per-context master GainNode, then exposes that gain to the parent launcher
// via postMessage({type:'volume', volume:0..1}) and the localStorage 'storage'
// event. This never shadows `destination`, so it can't break the game's audio
// graph — if creating or wiring a master throws, that one call falls through to
// the original connect/disconnect (the prototypes stay patched).
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
        if (this !== master) {
          // Keep any output/input port arguments: dropping them silently
          // rerouted multi-output nodes (splitters) to output 0.
          var rest = Array.prototype.slice.call(arguments, 1);
          realConnect.apply(this, [master].concat(rest));
          return target;
        }
      }
    } catch (e) {}
    return realConnect.apply(this, arguments);
  };

  AudioNode.prototype.disconnect = function(target) {
    try {
      if (target instanceof AudioDestinationNode) {
        var master = masters && masters.get(target.context);
        if (master && this !== master) {
          var rest = Array.prototype.slice.call(arguments, 1);
          realDisconnect.apply(this, [master].concat(rest));
          return;
        }
      }
    } catch (e) {}
    return realDisconnect.apply(this, arguments);
  };

  function applyVolume() {
    var g = getVol();
    for (var i = allMasters.length - 1; i >= 0; i--) {
      var m = allMasters[i];
      // Drop gains whose context is gone instead of holding them for the
      // lifetime of the page.
      if (m.context && m.context.state === 'closed') { allMasters.splice(i, 1); continue; }
      try { m.gain.value = g; } catch (e) {}
    }
  }

  window.addEventListener('message', function(e) {
    // Only the launcher that framed us may change the volume.
    if (e.origin !== window.location.origin) return;
    if (e.data && e.data.type === 'volume') {
      var vol = typeof e.data.volume === 'number' ? e.data.volume : 1;
      try { localStorage.setItem(VKEY, String(Math.round(Math.max(0, Math.min(1, vol)) * 100))); } catch (er) {}
      applyVolume();
    }
  });
  window.addEventListener('storage', function(e) {
    if (e.key === VKEY) applyVolume();
  });
})();
