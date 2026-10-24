/* =========================================================
   library.js — the song list in memory, plus importing.

   Import steps for one file:
     1. read the picture inside the file (if there is one)
     2. measure its length
     3. make a small thumbnail from the picture
     4. save everything to IndexedDB

   The song name is always the file name without its extension.
   Tags inside the file are not used for the name.
   ========================================================= */
(function () {
  'use strict';

  const AUDIO_MIME = /^audio\//;
  const AUDIO_EXT = /\.(mp3|m4a|m4b|mp4|aac|flac|wav|wave|ogg|oga|opus|weba|webm|aif|aiff)$/i;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  function isAudioFile(file) {
    if (!file) return false;
    return AUDIO_MIME.test(file.type || '') || AUDIO_EXT.test(file.name || '');
  }

  /* Name + size is enough to spot the same file added twice. */
  function fileKey(file) {
    return (file.name || '') + '|' + (file.size || 0);
  }

  function trackKey(track) {
    return (track.fileName || '') + '|' + (track.size || 0);
  }

  /* Only the name and the length can be sorted: the row shows nothing else. */
  const SORTS = {
    'added-desc': (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
    'added-asc': (a, b) => (a.addedAt || 0) - (b.addedAt || 0),
    'title-asc': (a, b) => collator.compare(a.title || '', b.title || ''),
    'title-desc': (a, b) => collator.compare(b.title || '', a.title || ''),
    'duration-asc': (a, b) => (a.duration || 0) - (b.duration || 0),
    'duration-desc': (a, b) => (b.duration || 0) - (a.duration || 0),
  };

  async function buildTrack(file, addedAt) {
    const meta = await Tags.read(file);
    const art = meta.picture || null;
    const duration = await U.probeDuration(file);
    const thumb = art ? await U.makeThumb(art, 96) : null;

    return {
      art,
      track: {
        id: U.uid(),
        title: U.baseName(file.name),
        duration: Math.round(duration * 10) / 10,
        size: file.size || 0,
        mime: file.type || '',
        fileName: file.name || '',
        addedAt,
        favorite: false,
        hasArt: Boolean(art),
        thumb: thumb || null,
      },
    };
  }

  const Library = {
    tracks: [],
    byId: new Map(),
    keys: new Set(),

    async load() {
      const tracks = await DB.allTracks();
      tracks.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
      this.set(tracks);
      return this.tracks;
    },

    set(tracks) {
      this.tracks = tracks;
      this.byId = new Map(tracks.map((track) => [track.id, track]));
      this.keys = new Set(tracks.map(trackKey));
      Player.setLibrary(this.tracks);
    },

    /**
     * Add files. Resolves with a small report.
     * onProgress is called after every file so the UI can show a counter.
     */
    async importFiles(fileList, onProgress) {
      const files = Array.from(fileList || []).filter(isAudioFile);
      const report = { total: files.length, added: 0, skipped: 0, failed: 0, ids: [], quota: false };
      if (!files.length) return report;

      const base = Date.now();
      let counter = 0;

      for (const file of files) {
        const key = fileKey(file);

        if (this.keys.has(key)) {
          report.skipped += 1;
          if (onProgress) onProgress(report);
          continue;
        }

        try {
          const { track, art } = await buildTrack(file, base + counter);
          await DB.insert(track, file, art);

          this.tracks.push(track);
          this.byId.set(track.id, track);
          this.keys.add(key);
          report.added += 1;
          report.ids.push(track.id);
          counter += 1;
        } catch (error) {
          console.warn('Could not import', file.name, error);
          report.failed += 1;
          if (error && (error.name === 'QuotaExceededError' || /quota|storage/i.test(error.message || ''))) {
            report.quota = true;
          }
        }

        if (onProgress) onProgress(report);

        /* Give the browser a moment to paint the progress message. */
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      Player.setLibrary(this.tracks);
      return report;
    },

    async remove(id) {
      const track = this.byId.get(id);
      if (!track) return;

      await DB.remove(id);
      this.tracks = this.tracks.filter((item) => item.id !== id);
      this.byId.delete(id);
      this.keys.delete(trackKey(track));
    },

    async clear() {
      await DB.clear();
      this.tracks = [];
      this.byId.clear();
      this.keys.clear();
      Player.setLibrary(this.tracks);
    },

    async toggleFavorite(id) {
      const track = this.byId.get(id);
      if (!track) return null;
      track.favorite = !track.favorite;
      try {
        await DB.saveTrack(track);
      } catch (error) {
        console.warn('Could not save the favorite flag', error);
      }
      return track.favorite;
    },

    /**
     * The list the user sees right now.
     * view    : 'all' | 'favorites'
     * search  : free text, every word must match
     * sort    : a key of SORTS
     */
    list(options) {
      const opts = options || {};
      const words = String(opts.search || '')
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);

      let items = this.tracks;

      if (opts.view === 'favorites') {
        items = items.filter((track) => track.favorite);
      }

      if (words.length) {
        items = items.filter((track) => {
          /* The name is the file name, so one field is enough. */
          const haystack = String(track.title || track.fileName || '').toLowerCase();
          return words.every((word) => haystack.includes(word));
        });
      }

      const compare = SORTS[opts.sort] || SORTS['added-desc'];
      return items.slice().sort(compare);
    },

    count(view) {
      if (view === 'favorites') return this.tracks.filter((track) => track.favorite).length;
      return this.tracks.length;
    },

    totalDuration() {
      return this.tracks.reduce((sum, track) => sum + (track.duration || 0), 0);
    },
  };

  window.Library = Library;
  window.isAudioFile = isAudioFile;
})();
