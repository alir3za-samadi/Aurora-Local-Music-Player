/* =========================================================
   player.js — the audio engine.

   There is exactly one <audio> element for the whole app.
   Switching songs means giving it a new src. The engine also
   owns the play order (queue), shuffle and repeat, the cover
   art cache, and the OS media controls.
   ========================================================= */
(function () {
  'use strict';

  const audio = new Audio();
  audio.preload = 'metadata';

  const listeners = Object.create(null);
  const byId = new Map();

  const state = {
    queue: [],
    order: [],
    pos: -1,
    currentId: null,
    repeat: 'off', // 'off' | 'all' | 'one'
    shuffle: false,
    volume: 1,
    muted: false,
    speed: 1,
    loading: false,
  };

  let objectUrl = null;
  let loadToken = 0;
  let pendingPosition = 0;
  let graph = { ctx: null, analyser: null, data: null };
  let currentArtUrl = null;
  const artCache = new Map();

  /* ---------- tiny event bus ---------- */
  function on(event, fn) {
    (listeners[event] || (listeners[event] = [])).push(fn);
    return () => {
      listeners[event] = (listeners[event] || []).filter((item) => item !== fn);
    };
  }

  function emit(event, payload) {
    (listeners[event] || []).forEach((fn) => {
      try {
        fn(payload);
      } catch (error) {
        console.error('[player]', event, error);
      }
    });
  }

  /* ---------- helpers ---------- */
  function shuffle(items) {
    const list = items.slice();
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }

  function currentTrack() {
    return byId.get(state.currentId) || null;
  }

  /* ---------- artwork ---------- */
  async function loadArt(id) {
    if (artCache.has(id)) return artCache.get(id);
    try {
      const blob = await DB.getArt(id);
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      artCache.set(id, url);

      /* Keep memory small: drop old covers, but never the one on screen. */
      if (artCache.size > 12) {
        for (const [key, value] of artCache) {
          if (artCache.size <= 12) break;
          if (value === currentArtUrl) continue;
          URL.revokeObjectURL(value);
          artCache.delete(key);
        }
      }
      return url;
    } catch (error) {
      return null;
    }
  }

  /* ---------- OS media controls ---------- */
  function setSessionMetadata(track) {
    if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
    const info = { title: track.title };
    if (currentArtUrl) {
      info.artwork = [{ src: currentArtUrl, sizes: '512x512' }];
    }
    try {
      navigator.mediaSession.metadata = new MediaMetadata(info);
    } catch (error) {}
  }

  function updateSessionState() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
    } catch (error) {}
  }

  function setupMediaSession() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setActionHandler) return;

    const handlers = {
      play: () => play(),
      pause: () => pause(),
      nexttrack: () => next(),
      previoustrack: () => prev(),
      seekbackward: (details) => seek(audio.currentTime - (details.seekOffset || 10)),
      seekforward: (details) => seek(audio.currentTime + (details.seekOffset || 10)),
      seekto: (details) => {
        if (typeof details.seekTime === 'number') seek(details.seekTime);
      },
      stop: () => {
        pause();
        seek(0);
      },
    };

    Object.keys(handlers).forEach((action) => {
      try {
        navigator.mediaSession.setActionHandler(action, handlers[action]);
      } catch (error) {
        /* Not every action is supported everywhere. */
      }
    });
  }

  /* ---------- audio graph (visualizer) ---------- */
  function ensureGraph() {
    if (graph.ctx || !window.AudioContext) return graph;
    try {
      const ctx = new window.AudioContext();
      const source = ctx.createMediaElementSource(audio);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.82;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      graph = { ctx, analyser, data: new Uint8Array(analyser.frequencyBinCount) };
    } catch (error) {
      graph = { ctx: null, analyser: null, data: null };
    }
    return graph;
  }

  /* ---------- loading a track ---------- */
  async function load(id, options) {
    const opts = options || {};
    const track = byId.get(id);
    if (!track) {
      emit('error', 'That song is no longer in the library.');
      return;
    }

    const token = ++loadToken;
    state.currentId = id;
    state.pos = state.queue.indexOf(id);
    if (state.pos < 0) {
      state.queue.push(id);
      state.pos = state.queue.length - 1;
      emit('queue');
    }

    state.loading = true;
    pendingPosition = Math.max(0, opts.position || 0);
    emit('track', track);
    emit('loading', true);
    emit('state');

    let blob = null;
    try {
      blob = await DB.getFile(id);
    } catch (error) {
      blob = null;
    }

    /* The user clicked another song while this one was reading. Stop here. */
    if (token !== loadToken) return;

    state.loading = false;

    if (!blob) {
      emit('loading', false);
      emit('state');
      emit('error', 'The audio file is missing. Add the song again.');
      return;
    }

    const url = URL.createObjectURL(blob);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = url;

    audio.src = url;
    audio.playbackRate = state.speed;
    audio.load();

    emit('loading', false);

    setSessionMetadata(track);
    loadArt(id).then((artUrl) => {
      if (token !== loadToken) return;
      if (artUrl) {
        currentArtUrl = artUrl;
        setSessionMetadata(track);
        emit('art', artUrl);
      }
    });

    if (opts.autoplay) {
      const start = () => {
        if (token !== loadToken) return;
        play().catch(() => {});
      };
      if (audio.readyState >= 1) start();
      else audio.addEventListener('loadedmetadata', start, { once: true });
    }
  }

  /* ---------- play control ---------- */
  async function play() {
    if (!state.currentId) {
      if (state.queue.length) await load(state.queue[0], { autoplay: true });
      return;
    }
    ensureGraph();
    if (graph.ctx && graph.ctx.state === 'suspended') {
      try {
        await graph.ctx.resume();
      } catch (error) {}
    }
    try {
      await audio.play();
    } catch (error) {
      /* The browser may block the first play without a click. */
      emit('error', 'Press play once more to start the sound.');
      emit('state');
    }
  }

  function pause() {
    audio.pause();
  }

  function toggle() {
    if (audio.paused) play();
    else pause();
  }

  function next(auto) {
    if (!state.queue.length) return;

    if (auto && state.repeat === 'one') {
      audio.currentTime = 0;
      play();
      return;
    }

    let target = state.pos + 1;
    if (target >= state.queue.length) {
      if (state.repeat === 'all') target = 0;
      else {
        if (auto) {
          audio.pause();
          audio.currentTime = 0;
          emit('state');
        }
        return;
      }
    }
    load(state.queue[target], { autoplay: true });
  }

  function prev() {
    if (!state.queue.length) return;

    /* A common player rule: restart the song if we are past 3 seconds. */
    if (audio.currentTime > 3) {
      seek(0);
      return;
    }

    let target = state.pos - 1;
    if (target < 0) {
      if (state.repeat === 'all') target = state.queue.length - 1;
      else {
        seek(0);
        return;
      }
    }
    load(state.queue[target], { autoplay: true });
  }

  function seek(seconds) {
    if (!Number.isFinite(audio.duration)) return;
    audio.currentTime = Math.min(Math.max(0, seconds), Math.max(0, audio.duration - 0.15));
  }

  function seekRatio(ratio) {
    if (!Number.isFinite(audio.duration)) return;
    seek(audio.duration * Math.min(Math.max(ratio, 0), 1));
  }

  /* ---------- sound settings ---------- */
  function applyVolume() {
    audio.volume = state.volume;
    audio.muted = state.muted;
  }

  function setVolume(value) {
    state.volume = Math.min(1, Math.max(0, value));
    if (state.volume > 0 && state.muted) state.muted = false;
    applyVolume();
    emit('state');
  }

  function setMuted(value) {
    state.muted = Boolean(value);
    applyVolume();
    emit('state');
  }

  function toggleMute() {
    setMuted(!state.muted);
  }

  function setSpeed(value) {
    const speed = Math.min(3, Math.max(0.25, Number(value) || 1));
    state.speed = speed;
    audio.playbackRate = speed;
    emit('state');
  }

  /** Apply saved settings without touching the queue. Used at startup. */
  function hydrate(settings) {
    const s = settings || {};
    if (typeof s.volume === 'number') state.volume = Math.min(1, Math.max(0, s.volume));
    if (typeof s.muted === 'boolean') state.muted = s.muted;
    if (typeof s.speed === 'number') state.speed = Math.min(3, Math.max(0.25, s.speed));
    if (s.repeat === 'all' || s.repeat === 'one' || s.repeat === 'off') state.repeat = s.repeat;
    if (typeof s.shuffle === 'boolean') state.shuffle = s.shuffle;

    audio.volume = state.volume;
    audio.muted = state.muted;
    audio.playbackRate = state.speed;
    emit('state');
  }

  /* ---------- queue ---------- */
  function setLibrary(tracks) {
    byId.clear();
    tracks.forEach((track) => byId.set(track.id, track));
  }

  /** Build the play order from a visible list and start one song. */
  function playIds(ids, id, options) {
    const opts = options || {};
    state.order = ids.slice();
    let queue = ids.slice();

    if (state.shuffle) {
      queue = [id].concat(shuffle(queue.filter((item) => item !== id)));
    }

    state.queue = queue;
    load(id, { autoplay: opts.autoplay !== false, position: opts.position || 0 });
    emit('queue');
  }

  function setQueue(ids) {
    state.order = ids.slice();
    state.queue = ids.slice();
    state.pos = state.currentId ? state.queue.indexOf(state.currentId) : -1;
    emit('queue');
  }

  /** Put back the queue and the song the user listened to last time. */
  function restore(ids, currentId, position) {
    state.order = ids.slice();
    state.queue = ids.slice();
    state.currentId = ids.includes(currentId) ? currentId : ids[0] || null;
    state.pos = state.currentId ? state.queue.indexOf(state.currentId) : -1;
    emit('queue');

    if (state.currentId) {
      load(state.currentId, { autoplay: false, position: position || 0 });
    }
  }

  function toggleShuffle() {
    state.shuffle = !state.shuffle;

    if (state.shuffle) {
      /* Keep what is playing, mix everything that comes after it. */
      const head = state.queue.slice(0, state.pos + 1);
      const tail = shuffle(state.queue.slice(state.pos + 1));
      state.queue = head.concat(tail);
    } else {
      /* Back to the order of the list the user started from. */
      const head = state.queue.slice(0, state.pos + 1);
      const known = new Map(state.order.map((id, index) => [id, index]));
      const tail = state.queue
        .slice(state.pos + 1)
        .sort((a, b) => (known.has(a) ? known.get(a) : 1e9) - (known.has(b) ? known.get(b) : 1e9));
      state.queue = head.concat(tail);
    }

    emit('state');
    emit('queue');
  }

  function cycleRepeat() {
    state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
    emit('state');
  }

  function removeFromQueue(id) {
    const index = state.queue.indexOf(id);
    if (index < 0) return;

    state.queue.splice(index, 1);
    state.order = state.order.filter((item) => item !== id);
    if (index < state.pos) state.pos -= 1;
    else if (index === state.pos) {
      /* The playing song stays in the player, it just leaves the list. */
      state.pos = Math.min(state.pos, state.queue.length - 1);
    }
    emit('queue');
  }

  /** New songs go to the end of the queue, so the play order never jumps. */
  function appendToQueue(ids) {
    let changed = false;
    ids.forEach((id) => {
      if (!state.queue.includes(id)) {
        state.queue.push(id);
        changed = true;
      }
      if (!state.order.includes(id)) state.order.push(id);
    });
    if (changed) emit('queue');
  }

  /** Move one song to a new place in the queue. Never duplicates it. */
  function moveInQueue(id, toIndex) {
    const from = state.queue.indexOf(id);
    if (from < 0) return false;
    const to = Math.max(0, Math.min(state.queue.length - 1, toIndex));
    if (from === to) return false;

    state.queue.splice(from, 1);
    state.queue.splice(to, 0, id);

    if (!state.order.includes(id)) state.order.push(id);
    if (state.currentId) state.pos = state.queue.indexOf(state.currentId);
    emit('queue');
    return true;
  }

  /**
   * Put one song right after the song that is playing now.
   * If it is already in the queue it moves, it is not duplicated.
   */
  function playNext(id) {
    if (!byId.has(id)) return false;

    const queue = state.queue.filter((item) => item !== id);
    const currentIndex = queue.indexOf(state.currentId);
    const at = currentIndex === -1 ? queue.length : currentIndex + 1;
    queue.splice(at, 0, id);

    state.queue = queue;
    if (!state.order.includes(id)) state.order.push(id);
    state.pos = state.currentId ? queue.indexOf(state.currentId) : -1;
    emit('queue');
    return true;
  }

  function stop() {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    state.currentId = null;
    state.queue = [];
    state.order = [];
    state.pos = -1;
    loadToken++;
    emit('track', null);
    emit('queue');
    emit('state');
    emit('time', { current: 0, duration: 0 });
  }

  /* ---------- audio element events ---------- */
  audio.addEventListener('play', () => {
    updateSessionState();
    emit('state');
  });

  audio.addEventListener('pause', () => {
    updateSessionState();
    emit('state');
  });

  audio.addEventListener('loadedmetadata', () => {
    if (pendingPosition > 0) {
      const max = Number.isFinite(audio.duration) ? Math.max(0, audio.duration - 1) : pendingPosition;
      audio.currentTime = Math.min(pendingPosition, max);
      pendingPosition = 0;
    }
    emit('time', { current: audio.currentTime, duration: audio.duration });
  });

  audio.addEventListener('timeupdate', () => {
    emit('time', { current: audio.currentTime, duration: audio.duration });
  });

  audio.addEventListener('durationchange', () => {
    emit('time', { current: audio.currentTime, duration: audio.duration });
  });

  audio.addEventListener('ended', () => {
    next(true);
  });

  audio.addEventListener('error', () => {
    if (!audio.src) return;
    emit('error', 'This file cannot be played in this browser.');
    emit('state');
  });

  audio.addEventListener('ratechange', () => {
    if (audio.playbackRate !== state.speed) audio.playbackRate = state.speed;
  });

  applyVolume();
  setupMediaSession();

  window.Player = {
    audio,
    state,
    on,
    emit,
    get track() {
      return currentTrack();
    },
    get isPlaying() {
      return !audio.paused && !audio.ended;
    },
    get isShuffling() {
      return state.shuffle;
    },
    get duration() {
      if (Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration;
      const track = currentTrack();
      return track ? track.duration || 0 : 0;
    },
    load,
    play,
    pause,
    toggle,
    next,
    prev,
    seek,
    seekRatio,
    setVolume,
    toggleMute,
    setMuted,
    setSpeed,
    hydrate,
    setLibrary,
    playIds,
    setQueue,
    restore,
    toggleShuffle,
    cycleRepeat,
    removeFromQueue,
    appendToQueue,
    playNext,
    moveInQueue,
    stop,
    artFor: loadArt,
    ensureGraph,
    /** Frequency data for the visualizer, or null when there is no graph. */
    getVisualizer() {
      return graph.analyser ? { analyser: graph.analyser, data: graph.data } : null;
    },
    getCurrentArtUrl() {
      return currentArtUrl;
    },
  };
})();
