/* =========================================================
   app.js — startup.

   Order matters here:
     1. theme   (so the first paint has the right colors)
     2. UI      (so any error has somewhere to show up)
     3. database → library
     4. saved player settings → queue → last song
     5. start saving the state while the app runs
   ========================================================= */
(function () {
  'use strict';

  const PERSIST_DELAY = 1500;

  /** Theme and palette, applied before the first paint so nothing flashes. */
  function restoreLook() {
    const root = document.documentElement;
    const saved = U.store.get('theme', null);
    const prefersLight =
      window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    root.dataset.theme = saved || (prefersLight ? 'light' : 'dark');

    const savedPalette = U.store.get('palette', 'default');
    root.dataset.palette = savedPalette === 'vercel' ? 'vercel' : 'default';
  }

  async function loadLibrary() {
    try {
      await DB.open();
    } catch (error) {
      console.error(error);
      UI.toast(
        'This browser blocked local storage. Open index.html in Chrome or Edge to keep your songs.',
        { type: 'error', duration: 9000 }
      );
      return false;
    }

    try {
      await Library.load();
      return true;
    } catch (error) {
      console.error(error);
      UI.toast('Could not read the library. Reload the page and try again.', {
        type: 'error',
        duration: 8000,
      });
      return false;
    }
  }

  function restorePlayer(saved) {
    Player.hydrate({
      volume: typeof saved.volume === 'number' ? saved.volume : 1,
      muted: Boolean(saved.muted),
      repeat: saved.repeat || 'off',
      shuffle: Boolean(saved.shuffle),
    });

    if (!Library.tracks.length) return;

    const sortedIds = Library.list({
      view: 'all',
      sort: UI.state.sort,
      search: '',
    }).map((track) => track.id);

    const savedQueue = Array.isArray(saved.queue)
      ? saved.queue.filter((id) => Library.byId.has(id))
      : [];

    if (savedQueue.length) {
      const currentId = Library.byId.has(saved.trackId) ? saved.trackId : savedQueue[0];
      Player.restore(savedQueue, currentId, Number(saved.position) || 0);
    } else {
      /* First visit with songs: select the first one, but stay paused. */
      Player.restore(sortedIds, sortedIds[0], 0);
    }
  }

  function startSaving() {
    const persist = () => {
      U.store.set('state', {
        trackId: Player.state.currentId,
        position: Number(Player.audio.currentTime) || 0,
        volume: Player.state.volume,
        muted: Player.state.muted,
        repeat: Player.state.repeat,
        shuffle: Player.state.shuffle,
        queue: Player.state.queue.slice(0, 1000),
      });
    };

    const persistSoon = U.throttle(persist, PERSIST_DELAY);

    Player.on('time', persistSoon);
    Player.on('track', persistSoon);
    Player.on('state', persistSoon);
    Player.on('queue', persistSoon);

    /* Last chance to save before the page goes away. */
    window.addEventListener('pagehide', persist);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) persist();
    });
  }

  async function boot() {
    restoreLook();
    UI.init();

    const storageOk = await loadLibrary();
    UI.afterLibrary();

    const saved = U.store.get('state', null) || {};
    restorePlayer(saved);

    UI.renderQueue();
    UI.renderPlayer();
    startSaving();

    if (storageOk) {
      DB.askToPersist()
        .then((granted) => {
          if (!granted) console.info('The browser did not promise to keep the files. They still work.');
        })
        .catch(() => {});
      UI.refreshStorage();
    }

    /* One useful hint for a first visit. */
    if (storageOk && !Library.tracks.length) {
      setTimeout(() => {
        UI.toast('Add a few songs, then reopen this page. They stay here.', { duration: 4200 });
      }, 900);
    }
  }

  boot().catch((error) => {
    console.error(error);
    try {
      UI.toast('Something broke while starting. Open the console for details.', {
        type: 'error',
        duration: 12000,
      });
    } catch (ignored) {}
  });
})();
