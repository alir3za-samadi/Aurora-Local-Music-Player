/* =========================================================
   db.js — storage for the library.

   Why IndexedDB and not localStorage?
   localStorage can only hold about 5 MB of text, so a single
   song would fill it. IndexedDB can store real files (Blobs)
   and keeps them after a reload. localStorage is still used
   for tiny things: settings and the playback position.

   Three stores:
     tracks : song details (title, artist, duration, ...)
     files  : the audio file itself, linked by the same id
     art    : the full size cover image

   They are separate so opening the library stays fast: the
   list only reads "tracks", never the big files.
   ========================================================= */
(function () {
  'use strict';

  const DB_NAME = 'aurora-player';
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('This browser has no IndexedDB.'));
        return;
      }

      let request;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (error) {
        reject(error);
        return;
      }

      /* If the database never answers, tell the user instead of hanging forever. */
      const timer = setTimeout(() => {
        reject(new Error('The database did not open. Another tab may be blocking it.'));
      }, 10000);

      request.onupgradeneeded = () => {
        const db = request.result;

        if (!db.objectStoreNames.contains('tracks')) {
          const tracks = db.createObjectStore('tracks', { keyPath: 'id' });
          tracks.createIndex('addedAt', 'addedAt');
        }
        if (!db.objectStoreNames.contains('files')) {
          db.createObjectStore('files', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('art')) {
          db.createObjectStore('art', { keyPath: 'id' });
        }
      };

      request.onsuccess = () => {
        clearTimeout(timer);
        const db = request.result;
        /* Another tab wants a newer version: close so it can upgrade. */
        db.onversionchange = () => db.close();
        resolve(db);
      };

      request.onerror = () => {
        clearTimeout(timer);
        reject(request.error || new Error('Could not open the database.'));
      };

      request.onblocked = () => {
        clearTimeout(timer);
        reject(new Error('The database is blocked. Close other tabs of this player.'));
      };
    });

    /* A failed open should not be cached forever. */
    dbPromise.catch(() => {
      dbPromise = null;
    });

    return dbPromise;
  }

  /* Run one request and turn it into a promise. */
  function requestOf(store, method, value) {
    return open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(store, 'readonly');
          const request = tx.objectStore(store)[method](value);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        })
    );
  }

  async function allTracks() {
    return (await requestOf('tracks', 'getAll')) || [];
  }

  async function getBlob(store, id) {
    const row = await requestOf(store, 'get', id);
    return row ? row.blob : null;
  }

  /** Save a new song. One transaction, so a failure cannot leave half a song behind. */
  async function insert(track, fileBlob, artBlob) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['tracks', 'files', 'art'], 'readwrite');
      tx.objectStore('tracks').put(track);
      tx.objectStore('files').put({ id: track.id, blob: fileBlob });
      if (artBlob) tx.objectStore('art').put({ id: track.id, blob: artBlob });

      tx.oncomplete = () => resolve(track);
      tx.onerror = () => reject(tx.error || new Error('Could not save the song.'));
      tx.onabort = () => reject(tx.error || new Error('Could not save the song. Is the disk full?'));
    });
  }

  /** Update only the track row (favorite, title, ...). */
  async function saveTrack(track) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('tracks', 'readwrite');
      tx.objectStore('tracks').put(track);
      tx.oncomplete = () => resolve(track);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function remove(id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['tracks', 'files', 'art'], 'readwrite');
      tx.objectStore('tracks').delete(id);
      tx.objectStore('files').delete(id);
      tx.objectStore('art').delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function clear() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['tracks', 'files', 'art'], 'readwrite');
      tx.objectStore('tracks').clear();
      tx.objectStore('files').clear();
      tx.objectStore('art').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  /** How much space the browser allows us. Not every browser answers. */
  async function estimate() {
    try {
      if (!navigator.storage || !navigator.storage.estimate) return null;
      const info = await navigator.storage.estimate();
      return { usage: info.usage || 0, quota: info.quota || 0 };
    } catch (error) {
      return null;
    }
  }

  /* Ask the browser to keep our data when the disk gets tight. */
  async function askToPersist() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        return await navigator.storage.persist();
      }
    } catch (error) {}
    return false;
  }

  window.DB = {
    open,
    allTracks,
    insert,
    saveTrack,
    remove,
    clear,
    estimate,
    askToPersist,
    getFile: (id) => getBlob('files', id),
    getArt: (id) => getBlob('art', id),
  };
})();
