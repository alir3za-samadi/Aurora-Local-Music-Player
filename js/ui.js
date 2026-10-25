/* =========================================================
   ui.js — everything the user can see or click.

   The UI never owns data. It reads from Library and Player,
   then paints the screen. When something changes, the player
   sends an event and only the needed part is repainted.
   ========================================================= */
(function () {
  'use strict';

  const els = {};

  const state = {
    view: 'all',
    search: '',
    sort: 'added-desc',
    visible: [],
    rendered: 0,
    limit: 200,
  };

  let scrubbing = false;
  let vizFrame = 0;
  let vizBars = new Array(56).fill(0);

  /* When a queue drag ends, the browser may still send a click to the row.
     This timestamp lets the click handler ignore that click. */
  let queueDragEndAt = 0;

  /* =========================================================
     Small builders
     ========================================================= */
  /**
   * A cover node. Songs with a picture show it; the rest get a plain
   * gradient built from the song's own hue. Nothing is drawn on top.
   */
  function thumbNode(track, extraClass) {
    const node = U.el('div', { class: (extraClass || 'thumb') + (track.thumb ? '' : ' placeholder') });
    if (track.thumb) {
      node.style.backgroundImage = 'url("' + track.thumb + '")';
    } else {
      node.style.setProperty('--hue', String(U.hue(track.title)));
    }
    return node;
  }

  /** Turn a node into the gradient cover, and drop any old picture. */
  function placeholder(node, label) {
    node.style.removeProperty('background-image');
    node.classList.add('placeholder');
    node.style.setProperty('--hue', String(U.hue(label || 'music')));
    node.textContent = '';
  }

  /* =========================================================
     Row / list rendering
     ========================================================= */
  function rowFor(track, index) {
    const isCurrent = track.id === Player.state.currentId;

    const row = U.el('div', {
      class:
        'row' +
        (isCurrent ? ' is-current' : '') +
        (isCurrent && Player.isPlaying ? ' is-playing' : '') +
        (track.favorite ? ' has-favorite' : ''),
      dataset: { id: track.id },
      role: 'option',
      tabindex: '0',
      'aria-selected': isCurrent ? 'true' : 'false',
      'aria-label': track.title,
    });

    const bars = U.el('span', { class: 'bars', 'aria-hidden': 'true' }, [
      U.el('i'),
      U.el('i'),
      U.el('i'),
    ]);

    const idx = U.el('div', { class: 'cell idx' }, [
      U.el('span', { class: 'idx-num', text: String(index + 1) }),
      bars,
    ]);

    const titleCell = U.el('div', { class: 'cell title-cell' }, [
      thumbNode(track),
      U.el('div', { class: 'title-text' }, [U.el('div', { class: 'title', text: track.title })]),
    ]);

    const time = U.el('div', { class: 'cell time', text: U.fmtTime(track.duration) });

    const fav = U.el(
      'button',
      {
        class: 'icon-btn fav-btn' + (track.favorite ? ' is-on' : ''),
        dataset: { rowAction: 'fav', id: track.id },
        'aria-label': track.favorite ? 'Remove from favorites' : 'Add to favorites',
        'aria-pressed': String(Boolean(track.favorite)),
        title: 'Favorite (F)',
      },
      [U.icon('heart')]
    );

    const remove = U.el(
      'button',
      {
        class: 'icon-btn danger',
        dataset: { rowAction: 'remove', id: track.id },
        'aria-label': 'Remove from library',
        title: 'Remove from library',
      },
      [U.icon('trash')]
    );

    row.appendChild(idx);
    row.appendChild(titleCell);
    row.appendChild(time);
    row.appendChild(U.el('div', { class: 'cell actions' }, [fav, remove]));

    return row;
  }

  function appendRows() {
    const items = state.visible;
    const end = Math.min(items.length, state.rendered + state.limit);
    if (state.rendered >= end) return;

    const fragment = document.createDocumentFragment();
    for (let i = state.rendered; i < end; i++) {
      fragment.appendChild(rowFor(items[i], i));
    }
    els.list.appendChild(fragment);
    state.rendered = end;
  }

  function renderList(preserveScroll) {
    if (state.view === 'queue') {
      renderQueueView();
      return;
    }

    const previousTop = preserveScroll ? els.list.scrollTop : 0;
    const previousCount = state.rendered;

    /* Keep the sort dropdown in sync with the saved preference. */
    if (els.sort && els.sort.value !== state.sort) els.sort.value = state.sort;
    if (els.sort && els.sort.closest('.sort')) els.sort.closest('.sort').hidden = false;

    state.visible = Library.list(state);
    state.rendered = 0;
    state.limit = preserveScroll ? Math.max(200, previousCount) : 200;

    els.list.textContent = '';
    els.list.hidden = state.visible.length === 0;
    els.listHead.hidden = state.visible.length === 0;
    els.empty.hidden = state.visible.length > 0;

    appendRows();
    updateEmpty();
    updateHeader();
    updateNav();
    markCurrentRow();

    els.list.scrollTop = previousTop;
  }

  function updateHeader() {
    const countQueue = U.$('#countQueue');
    if (countQueue) countQueue.textContent = String(Player.state.queue.length);

    if (state.view === 'queue') {
      els.viewTitle.textContent = 'Playing queue';
      const all = Player.state.queue;
      const list = filteredQueue();
      const parts = [];
      if (all.length === 0) parts.push('No songs in the queue');
      else if (list.length === all.length) parts.push(list.length + (list.length === 1 ? ' song' : ' songs'));
      else parts.push(list.length + ' of ' + all.length + ' songs');
      const duration = list.reduce((sum, id) => {
        const t = Library.byId.get(id);
        return sum + (t ? t.duration || 0 : 0);
      }, 0);
      if (duration > 0) parts.push(U.fmtTime(duration));
      els.viewMeta.textContent = parts.join(' · ');
      els.countAll.textContent = String(Library.count('all'));
      els.countFav.textContent = String(Library.count('favorites'));
      return;
    }

    const total = Library.count(state.view);
    const shown = state.visible.length;

    els.countAll.textContent = String(Library.count('all'));
    els.countFav.textContent = String(Library.count('favorites'));

    els.viewTitle.textContent = state.view === 'favorites' ? 'Favorites' : 'All songs';

    const parts = [];
    if (total === 0) {
      parts.push(state.view === 'favorites' ? 'No favorites yet' : 'No songs yet');
    } else if (shown === total) {
      parts.push(total + (total === 1 ? ' song' : ' songs'));
    } else {
      parts.push(shown + ' of ' + total + ' songs');
    }

    const duration = state.visible.reduce((sum, track) => sum + (track.duration || 0), 0);
    if (duration > 0) parts.push(U.fmtTime(duration));

    els.viewMeta.textContent = parts.join(' · ');
  }

  function updateNav() {
    U.$$('.nav-item').forEach((item) => {
      const active = item.dataset.view === state.view;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-current', active ? 'page' : 'false');
    });
  }

  function updateEmpty() {
    const hasSongs = Library.tracks.length > 0;
    const searching = state.search.trim().length > 0;

    if (!hasSongs) {
      els.emptyTitle.textContent = 'Your library is empty';
      els.emptyText.textContent = 'Drop your audio files anywhere on this page.';
      els.emptyActions.hidden = false;
      els.emptyNote.hidden = false;
    } else if (searching) {
      els.emptyTitle.textContent = 'Nothing found';
      els.emptyText.textContent = 'No song matches “' + state.search.trim() + '”.';
      els.emptyActions.hidden = true;
      els.emptyNote.hidden = true;
    } else if (state.view === 'favorites') {
      els.emptyTitle.textContent = 'No favorites yet';
      els.emptyText.textContent = 'Press the heart next to a song to keep it here.';
      els.emptyActions.hidden = true;
      els.emptyNote.hidden = true;
    } else if (state.view === 'queue') {
      els.emptyTitle.textContent = 'The queue is empty';
      els.emptyText.textContent = 'Play a song to fill it.';
      els.emptyActions.hidden = true;
      els.emptyNote.hidden = true;
    } else {
      els.emptyTitle.textContent = 'Nothing here';
      els.emptyText.textContent = 'Try another view.';
      els.emptyActions.hidden = true;
      els.emptyNote.hidden = true;
    }
  }

  function markCurrentRow() {
    const currentId = Player.state.currentId;
    const playing = Player.isPlaying;

    U.$$('.row[data-id]', els.list).forEach((row) => {
      const isCurrent = row.dataset.id === currentId;
      row.classList.toggle('is-current', isCurrent);
      row.classList.toggle('is-playing', isCurrent && playing);
      row.setAttribute('aria-selected', isCurrent ? 'true' : 'false');
    });

    U.$$('[data-qid]').forEach((row) => {
      const isCurrent = row.dataset.qid === currentId;
      row.classList.toggle('is-current', isCurrent);
      row.classList.toggle('is-playing', isCurrent && playing);
      row.setAttribute('aria-selected', isCurrent ? 'true' : 'false');
    });
  }

  /* =========================================================
     Player bar and now playing panel
     ========================================================= */
  function setArtwork(track) {
    if (!track) {
      placeholder(els.npArtInner, 'music');
      placeholder(els.npCoverBigInner, 'music');
      els.npBg.style.backgroundImage = 'none';
      return;
    }

    if (track.thumb) {
      els.npArtInner.classList.remove('placeholder');
      els.npArtInner.style.backgroundImage = 'url("' + track.thumb + '")';
      els.npArtInner.textContent = '';
    } else {
      placeholder(els.npArtInner, track.title);
    }

    const bigCover = (url) => {
      if (Player.state.currentId !== track.id) return;
      els.npCoverBigInner.classList.remove('placeholder');
      els.npCoverBigInner.style.backgroundImage = 'url("' + url + '")';
      els.npCoverBigInner.textContent = '';
      els.npBg.style.backgroundImage = 'url("' + url + '")';
    };

    if (track.thumb) {
      bigCover(track.thumb);
    } else {
      placeholder(els.npCoverBigInner, track.title);
      /* No cover: drop the old one from the background too. */
      els.npBg.style.backgroundImage = 'none';
    }

    if (track.hasArt) {
      Player.artFor(track.id).then((url) => {
        if (url) bigCover(url);
      });
    }
  }

  function renderModes() {
    U.$$('[data-act="shuffle"]').forEach((button) => {
      const on = Player.state.shuffle;
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-pressed', String(on));
      button.title = on ? 'Shuffle: on (S)' : 'Shuffle: off (S)';
    });

    U.$$('[data-act="repeat"]').forEach((button) => {
      const mode = Player.state.repeat;
      const label =
        mode === 'one' ? 'Repeat: one song' : mode === 'all' ? 'Repeat: all songs' : 'Repeat: off';
      button.classList.toggle('is-on', mode !== 'off');
      button.setAttribute('aria-pressed', String(mode !== 'off'));
      button.setAttribute('aria-label', label);
      button.title = label + ' (R)';
    });

    document.body.dataset.repeat = Player.state.repeat;
  }

  function placeVolPct(input) {
    const label = input.parentElement.querySelector('.vol-pct');
    if (!label) return;
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 100;
    const value = Number(input.value);
    const thumb = 11;
    const usable = Math.max(0, input.clientWidth - thumb);
    const ratio = (value - min) / (max - min || 1);
    /* The label lives in .volume, which also holds the mute button. Measure
       the real gap between the two boxes, or the label sits too far left. */
    const parentBox = input.parentElement.getBoundingClientRect();
    const inputBox = input.getBoundingClientRect();
    const x = inputBox.left - parentBox.left + thumb / 2 + ratio * usable;
    label.style.left = (Number.isFinite(x) ? x : 0) + 'px';
  }

  function renderVolume() {
    const percent = Player.state.muted ? 0 : Math.round(Player.state.volume * 100);

    U.$$('.vol').forEach((input) => {
      input.value = String(percent);
      input.style.setProperty('--fill', percent + '%');
      input.setAttribute('aria-valuetext', percent + '%');
    });

    const muted = Player.state.muted || Player.state.volume === 0;
    U.$$('.js-icon-vol > use').forEach((use) => {
      use.setAttribute('href', muted ? '#i-mute' : '#i-volume');
    });
    U.$$('[data-act="mute"]').forEach((button) => {
      button.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
      button.setAttribute('aria-pressed', String(muted));
      button.classList.toggle('is-on', muted);
    });

    U.$$('.vol-pct').forEach((label) => {
      label.textContent = percent + '%';
    });

    requestAnimationFrame(() => {
      U.$$('.vol').forEach((input) => placeVolPct(input));
    });
  }

  function renderPlayer() {
    const track = Player.track;
    const playing = Player.isPlaying;

    U.$$('.js-icon-play > use').forEach((use) => {
      use.setAttribute('href', playing ? '#i-pause' : '#i-play');
    });
    U.$$('[data-act="togglePlay"]').forEach((button) => {
      button.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    });

    els.npTitle.textContent = track ? track.title : 'Nothing playing';
    els.bigTitle.textContent = track ? track.title : 'Nothing playing';

    /* Only the player bar and the now-playing sheet show the current song's
       heart here. Row hearts are owned by the list, so a global .fav-btn
       selector would mark every row as liked. */
    U.$$('[data-act="favorite"]').forEach((button) => {
      const on = Boolean(track && track.favorite);
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-pressed', String(on));
      button.setAttribute('aria-label', on ? 'Remove from favorites' : 'Add to favorites');
    });

    setArtwork(track);
    renderModes();
    renderVolume();
  }

  function renderTime(current, duration) {
    const total = duration || Player.duration || 0;
    const now = Math.min(current || 0, total || 0);

    U.$$('[data-role="timeCur"]').forEach((node) => {
      node.textContent = U.fmtTime(now);
    });
    U.$$('[data-role="timeDur"]').forEach((node) => {
      node.textContent = U.fmtTime(total);
    });

    const percent = total > 0 ? (now / total) * 100 : 0;

    U.$$('.seek').forEach((input) => {
      input.style.setProperty('--fill', percent.toFixed(2) + '%');
      if (!scrubbing) input.value = String(Math.round(percent * 10));
      input.setAttribute('aria-valuetext', U.fmtTime(now) + ' of ' + U.fmtTime(total));
    });
  }

  function renderQueue() {
    const queue = Player.state.queue;
    els.queueMeta.textContent = queue.length + (queue.length === 1 ? ' song' : ' songs');
    els.queueList.textContent = '';
    const countQueue = U.$('#countQueue');
    if (countQueue) countQueue.textContent = String(queue.length);

    if (!queue.length) {
      els.queueList.appendChild(
        U.el('p', { class: 'q-empty', text: 'The queue is empty. Play a song to fill it.' })
      );
      return;
    }

    const fragment = document.createDocumentFragment();

    queue.forEach((id) => {
      const row = queueRowFor(id);
      if (row) fragment.appendChild(row);
    });

    els.queueList.appendChild(fragment);
  }

  /** The queue ids that match the current search. Empty search returns all. */
  function filteredQueue() {
    const all = Player.state.queue;
    const filter = state.search.trim().toLowerCase();
    if (!filter) return all;
    return all.filter((id) => {
      const track = Library.byId.get(id);
      return track && track.title.toLowerCase().indexOf(filter) !== -1;
    });
  }

  function renderQueueView() {
    const all = Player.state.queue;
    const queue = filteredQueue();
    const countQueue = U.$('#countQueue');
    if (countQueue) countQueue.textContent = String(all.length);
    els.countAll.textContent = String(Library.count('all'));
    els.countFav.textContent = String(Library.count('favorites'));

    /* Sort has no meaning for a hand-ordered queue, so hide it here. */
    if (els.sort && els.sort.closest('.sort')) els.sort.closest('.sort').hidden = true;

    els.list.textContent = '';
    els.listHead.hidden = true;
    els.list.hidden = queue.length === 0;
    els.empty.hidden = queue.length > 0;

    if (!all.length) {
      els.emptyTitle.textContent = 'The queue is empty';
      els.emptyText.textContent = 'Play a song to fill it.';
      els.emptyActions.hidden = true;
      els.emptyNote.hidden = true;
      updateNav();
      updateHeader();
      return;
    }

    if (!queue.length) {
      els.emptyTitle.textContent = 'No songs match';
      els.emptyText.textContent = 'Try another search.';
      els.emptyActions.hidden = true;
      els.emptyNote.hidden = true;
      updateNav();
      updateHeader();
      return;
    }

    els.emptyTitle.textContent = 'Nothing here';
    els.emptyText.textContent = 'Try another view.';
    els.emptyActions.hidden = true;
    els.emptyNote.hidden = true;

    /* While a search is active the rows on screen are a subset, so the grip
       is hidden. Dropping a gap in a filtered order would lose songs. */
    const draggable = !state.search.trim();

    const fragment = document.createDocumentFragment();
    queue.forEach((id) => {
      const row = queueRowFor(id, draggable);
      if (row) fragment.appendChild(row);
    });
    els.list.appendChild(fragment);

    const foot = U.el('div', { class: 'queue-view-foot' }, [
      U.el('button', { class: 'btn btn-ghost', dataset: { act: 'shuffleQueue' }, 'aria-label': 'Shuffle queue' }, [U.icon('shuffle'), 'Shuffle queue']),
    ]);
    els.list.appendChild(foot);

    updateNav();
    updateHeader();
  }

  /** Build one queue row. It uses the same grid as the library rows, so the
      Playing queue view and the drawer look like the All songs list. */
  function queueRowFor(id, withGrip) {
    const track = Library.byId.get(id);
    if (!track) return null;
    const isCurrent = id === Player.state.currentId;

    const row = U.el('div', {
      class:
        'row' +
        (isCurrent ? ' is-current' : '') +
        (isCurrent && Player.isPlaying ? ' is-playing' : '') +
        (track.favorite ? ' has-favorite' : ''),
      dataset: { qid: id },
      role: 'option',
      tabindex: '0',
      'aria-selected': isCurrent ? 'true' : 'false',
      'aria-label': 'Play ' + track.title,
    });

    /* The index cell holds the grip. It stays visible, so a drag never
       depends on hover and works on a touch screen too. */
    const idx = U.el('div', { class: 'cell idx' });
    if (withGrip === false) {
      idx.appendChild(U.el('span', { class: 'q-gap', 'aria-hidden': 'true' }));
    } else {
      const handle = U.el('button', { class: 'q-drag', 'aria-label': 'Reorder in queue', title: 'Drag to reorder', dataset: { drag: 'true' } }, [U.icon('grip')]);
      handle.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        const list = row.parentElement;
        if (!list) return;
        const rows = Array.from(list.querySelectorAll('[data-qid]'));
        const index = rows.indexOf(row);
        const target = event.key === 'ArrowUp' ? index - 1 : index + 1;
        if (target < 0 || target >= rows.length) return;
        if (event.key === 'ArrowUp') list.insertBefore(row, rows[target]);
        else list.insertBefore(rows[target], row);
        applyQueueOrder(list);
        handle.focus();
      });
      idx.appendChild(handle);
    }

    const titleCell = U.el('div', { class: 'cell title-cell' }, [
      thumbNode(track),
      U.el('div', { class: 'title-text' }, [U.el('div', { class: 'title', text: track.title })]),
    ]);

    const fav = U.el(
      'button',
      {
        class: 'icon-btn fav-btn' + (track.favorite ? ' is-on' : ''),
        dataset: { rowAction: 'fav', id: track.id },
        'aria-label': track.favorite ? 'Remove from favorites' : 'Add to favorites',
        'aria-pressed': String(Boolean(track.favorite)),
        title: 'Favorite (F)',
      },
      [U.icon('heart')]
    );

    const remove = U.el(
      'button',
      {
        class: 'icon-btn',
        dataset: { rowAction: 'qremove', id: track.id },
        'aria-label': 'Remove from queue',
        title: 'Remove from queue',
      },
      [U.icon('x')]
    );

    row.appendChild(idx);
    row.appendChild(titleCell);
    row.appendChild(U.el('div', { class: 'cell time', text: U.fmtTime(track.duration) }));
    row.appendChild(U.el('div', { class: 'cell actions' }, [fav, remove]));

    return row;
  }

  function applyQueueOrder(list) {
    const ids = Array.from(list.querySelectorAll('[data-qid]')).map((row) => row.dataset.qid);
    if (!ids.length) return;
    Player.setQueue(ids);
  }

  /* Drag a queue row. The picked row follows the pointer, and the rows that
     lose their place slide one slot away. The list order is only written to
     the Player after the small settle animation, so the DOM never jumps. */
  function startQueueDrag(event) {
    const handle = event.target && event.target.closest && event.target.closest('[data-drag]');
    if (!handle) return;
    if (event.button !== undefined && event.button !== 0) return;
    const row = handle.closest('[data-qid]');
    if (!row) return;
    const list = row.parentElement;
    if (!list) return;

    const rows = Array.from(list.querySelectorAll('[data-qid]'));
    const fromIndex = rows.indexOf(row);
    if (fromIndex < 0 || rows.length < 2) return;

    const startY = event.clientY;
    const boxes = rows.map((item) => item.getBoundingClientRect());
    const rowH = Math.max(1, (boxes[1].top - boxes[0].top) || boxes[0].height);
    let targetIndex = fromIndex;
    let done = false;

    event.preventDefault();
    /* Capture keeps the move events on the handle. The document listeners
       below also work when capture is not available (touch, old browsers). */
    try { handle.setPointerCapture(event.pointerId); } catch (e) { /* ignore */ }
    row.classList.add('is-dragging');
    row.style.transition = 'none';

    /* Move one row out of the way. A short transition makes the change
       readable; without it the list would look like it teleports. */
    const shiftRow = (item, offset) => {
      item.style.transition = 'transform 160ms var(--ease)';
      item.style.transform = offset ? 'translateY(' + offset + 'px)' : '';
    };

    const paint = (dy) => {
      row.style.transform = 'translateY(' + dy + 'px)';
      const next = Math.max(0, Math.min(rows.length - 1, fromIndex + Math.round(dy / rowH)));
      if (next === targetIndex) return;
      targetIndex = next;
      rows.forEach((item, index) => {
        if (item === row) return;
        let offset = 0;
        if (fromIndex < targetIndex && index > fromIndex && index <= targetIndex) offset = -rowH;
        else if (targetIndex < fromIndex && index >= targetIndex && index < fromIndex) offset = rowH;
        shiftRow(item, offset);
      });
    };

    const resetRows = () => {
      rows.forEach((item) => {
        item.style.transition = 'none';
        item.style.transform = '';
      });
      row.classList.remove('is-dragging');
    };

    const commit = () => {
      if (targetIndex === fromIndex) {
        resetRows();
        return;
      }
      const ids = rows.map((item) => item.dataset.qid);
      const movedId = ids.splice(fromIndex, 1)[0];
      ids.splice(targetIndex, 0, movedId);
      const byId = new Map(rows.map((item) => [item.dataset.qid, item]));
      const foot = list.querySelector('.queue-view-foot');
      ids.forEach((id) => {
        const node = byId.get(id);
        if (node) list.insertBefore(node, foot || null);
      });
      resetRows();
      applyQueueOrder(list);
    };

    const finish = (keep) => {
      if (done) return;
      done = true;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', end);
      document.removeEventListener('pointercancel', cancel);
      row.classList.remove('is-dragging');
      /* The click that follows a release must not start a song. */
      queueDragEndAt = Date.now();
      row.style.transition = 'transform 180ms var(--ease)';
      row.style.transform = keep
        ? 'translateY(' + (targetIndex - fromIndex) * rowH + 'px)'
        : '';
      window.setTimeout(() => {
        if (keep) commit();
        else resetRows();
      }, 190);
    };

    const move = (pointerEvent) => {
      if (done) return;
      paint(pointerEvent.clientY - startY);
    };

    const end = () => finish(true);
    const cancel = () => finish(false);

    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', end);
    document.addEventListener('pointercancel', cancel);
  }

  /* =========================================================
     Visualizer
     ========================================================= */
  function vizPath(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  function drawViz() {
    const canvas = els.viz;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);

    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const analyser = Player.getVisualizer();

    const count = vizBars.length;
    const gap = Math.max(2, width * 0.005);
    const barWidth = (width - gap * (count - 1)) / count;
    const gradient = ctx.createLinearGradient(0, height, 0, 0);
    gradient.addColorStop(0, 'rgba(139, 92, 246, 0.95)');
    gradient.addColorStop(1, 'rgba(34, 211, 238, 0.9)');

    for (let i = 0; i < count; i++) {
      let target = 0;

      if (analyser) {
        /* Low frequencies look better when they get more bars. */
        const index = Math.min(
          analyser.data.length - 1,
          Math.floor(Math.pow(i / count, 1.5) * analyser.data.length)
        );
        target = analyser.data[index] / 255;
      }

      if (!Player.isPlaying) target *= 0.2;
      vizBars[i] += (target - vizBars[i]) * 0.3;

      const barHeight = Math.max(2, vizBars[i] * (height - 4));
      ctx.fillStyle = gradient;
      vizPath(ctx, i * (barWidth + gap), height - barHeight, barWidth, barHeight, 2.5);
      ctx.fill();
    }
  }

  function startViz() {
    stopViz();
    const loop = () => {
      drawViz();
      vizFrame = requestAnimationFrame(loop);
    };
    loop();
  }

  function stopViz() {
    if (vizFrame) cancelAnimationFrame(vizFrame);
    vizFrame = 0;
  }

  /* =========================================================
     Panels
     ========================================================= */
  function showScrim(scrim) {
    scrim.hidden = false;
    requestAnimationFrame(() => scrim.classList.add('is-open'));
  }

  function hideScrim(scrim) {
    scrim.classList.remove('is-open');
  }

  function openSidebar() {
    els.sidebar.classList.add('is-open');
    showScrim(els.scrimSidebar);
  }

  function closeSidebar() {
    if (!els.sidebar.classList.contains('is-open')) return;
    els.sidebar.classList.remove('is-open');
    hideScrim(els.scrimSidebar);
  }

  function openQueue() {
    renderQueue();
    els.queue.classList.add('is-open');
    els.queue.setAttribute('aria-hidden', 'false');
    showScrim(els.scrim);
    const current = els.queueList.querySelector('[data-qid].is-current');
    if (current) current.scrollIntoView({ block: 'center' });
  }

  function closeQueue() {
    if (!els.queue.classList.contains('is-open')) return;
    els.queue.classList.remove('is-open');
    els.queue.setAttribute('aria-hidden', 'true');
    hideScrim(els.scrim);
  }

  function toggleQueue() {
    if (els.queue.classList.contains('is-open')) closeQueue();
    else openQueue();
  }

  function openNowPlaying() {
    if (!Player.track) return;
    els.nowPlaying.classList.add('is-open');
    els.nowPlaying.setAttribute('aria-hidden', 'false');

    const graph = Player.ensureGraph();
    if (graph.ctx && graph.ctx.state === 'suspended') {
      graph.ctx.resume().catch(() => {});
    }
    startViz();
  }

  function closeNowPlaying() {
    if (!els.nowPlaying.classList.contains('is-open')) return;
    els.nowPlaying.classList.remove('is-open');
    els.nowPlaying.setAttribute('aria-hidden', 'true');
    stopViz();
  }

  function closePanels() {
    closeQueue();
    closeSidebar();
  }

  /* =========================================================
     Toast + confirm
     ========================================================= */
  function toast(message, options) {
    const opts = options || {};
    const iconName = opts.icon || (opts.type === 'error' ? 'x' : 'music');
    const text = U.el('span', { class: 'toast-text', text: message });
    const node = U.el('div', { class: 'toast' + (opts.type ? ' is-' + opts.type : '') }, [
      U.icon(opts.icon || iconName),
      text,
    ]);

    els.toasts.appendChild(node);

    let timer = null;
    const close = () => {
      if (!node.isConnected) return;
      clearTimeout(timer);
      node.classList.add('is-out');
      setTimeout(() => node.remove(), 240);
    };

    if (opts.duration !== 0) timer = setTimeout(close, opts.duration || 2800);

    return {
      node,
      close,
      set(value) {
        text.textContent = value;
      },
    };
  }

  function confirmDialog(title, text, okLabel) {
    els.confirmTitle.textContent = title;
    els.confirmText.textContent = text;
    els.confirmOk.textContent = okLabel || 'Delete';
    els.confirm.showModal();

    return new Promise((resolve) => {
      const finish = (value) => {
        if (els.confirm.open) els.confirm.close();
        resolve(value);
      };
      els.confirmOk.onclick = () => finish(true);
      els.confirmCancel.onclick = () => finish(false);
      els.confirm.oncancel = (event) => {
        event.preventDefault();
        finish(false);
      };
    });
  }

  /* =========================================================
     Actions
     ========================================================= */
  function playRow(id) {
    if (id === Player.state.currentId) {
      Player.toggle();
      return;
    }
    const ids = state.visible.map((track) => track.id);
    if (!ids.includes(id)) ids.push(id);
    Player.playIds(ids, id);
  }

  async function toggleFavorite(id) {
    if (!id) return null;
    const value = await Library.toggleFavorite(id);
    if (value === null) return null;

    if (state.view === 'favorites') {
      renderList(true);
    } else {
      /* The same song can be on screen more than once: in the list, in the
         queue view, and in the drawer. Update every copy. */
      U.$$('[data-row-action="fav"]').forEach((button) => {
        if (button.dataset.id !== id) return;
        button.classList.toggle('is-on', value);
        button.setAttribute('aria-pressed', String(value));
        button.setAttribute('aria-label', value ? 'Remove from favorites' : 'Add to favorites');
        const row = button.closest('.row');
        if (row) row.classList.toggle('has-favorite', value);
      });
      updateHeader();
    }

    if (Player.state.currentId === id) renderPlayer();
    toast(value ? 'Added “' + (Library.byId.get(id) && Library.byId.get(id).title) + '” to favorites' : 'Removed from favorites');
    return value;
  }

  /* =========================================================
     Context menu (right-click on a song)
     ========================================================= */
  /** One row of the menu. Keyboard friendly, so the menu works without a mouse. */
  function contextItem(label, run) {
    const item = U.el('div', { role: 'menuitem', tabindex: '0', text: label });
    item.addEventListener('click', () => {
      run();
      closeContextMenu();
    });
    item.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      item.click();
    });
    return item;
  }

  /**
   * Open the song menu. `source` is 'queue' when the click came from the
   * queue drawer; there the last item removes from the queue, not the library.
   */
  function openContextMenu(event, id, source) {
    event.preventDefault();

    const track = Library.byId.get(id);
    if (!track) return;

    const menu = els.ctxMenu;
    menu.textContent = '';

    menu.appendChild(contextItem('Play next', () => {
      Player.playNext(id);
      toast('“' + track.title + '” will play next');
    }));
    menu.appendChild(
      contextItem(track.favorite ? 'Remove from favorites' : 'Add to favorites', async () => {
        await toggleFavorite(id);
      })
    );
    menu.appendChild(U.el('hr'));
    menu.appendChild(
      source === 'queue'
        ? contextItem('Remove from queue', () => {
            Player.removeFromQueue(id);
            renderQueue();
            markCurrentRow();
            toast('Removed “' + track.title + '” from the queue');
          })
        : contextItem('Remove from library', () => removeTrack(id))
    );

    /* Place the menu at the exact click point, and keep it on screen. */
    menu.hidden = false;
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = Math.min(event.clientX + 4, window.innerWidth - width - 8);
    const top = Math.min(event.clientY + 4, window.innerHeight - height - 8);
    menu.style.left = Math.max(8, left) + 'px';
    menu.style.top = Math.max(8, top) + 'px';

    /* Close on the next click anywhere, or on Escape. */
    document.addEventListener('click', closeContextMenu, { once: true });
    document.addEventListener('keydown', onContextMenuKey);
    const first = menu.querySelector('[role="menuitem"]');
    if (first) first.focus();
  }

  function closeContextMenu() {
    els.ctxMenu.hidden = true;
    document.removeEventListener('keydown', onContextMenuKey);
  }

  function onContextMenuKey(event) {
    if (event.key === 'Escape') closeContextMenu();
  }

  async function removeTrack(id) {
    const track = Library.byId.get(id);
    if (!track) return;

    const wasCurrent = Player.state.currentId === id;
    const wasPlaying = Player.isPlaying;

    try {
      await Library.remove(id);
    } catch (error) {
      toast('Could not remove this song.', { type: 'error' });
      return;
    }

    if (wasCurrent) {
      const remaining = Player.state.queue.filter((queuedId) => queuedId !== id);
      const nextId = remaining[Math.min(Player.state.pos, remaining.length - 1)];
      Player.removeFromQueue(id);
      if (nextId) Player.load(nextId, { autoplay: wasPlaying });
      else Player.stop();
    } else {
      Player.removeFromQueue(id);
    }

    renderList(true);
    renderQueue();
    refreshStorage();
    toast('Removed “' + track.title + '” from the library');
  }

  async function clearLibrary() {
    if (!Library.tracks.length) {
      toast('The library is already empty');
      return;
    }

    const ok = await confirmDialog(
      'Clear the whole library?',
      'This deletes ' +
        Library.tracks.length +
        ' songs from this browser. Your original files on disk are not touched.',
      'Clear library'
    );
    if (!ok) return;

    try {
      await Library.clear();
    } catch (error) {
      toast('Could not clear the library.', { type: 'error' });
      return;
    }

    Player.stop();
    state.search = '';
    els.search.value = '';
    els.searchClear.hidden = true;
    renderList();
    renderQueue();
    refreshStorage();
    toast('Library cleared');
  }

  /* =========================================================
     Import
     ========================================================= */
  async function filesFromDrop(dataTransfer) {
    const items = dataTransfer.items;
    const entries = [];

    if (items && items.length) {
      for (const item of items) {
        if (item.kind !== 'file') continue;
        const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
        if (entry) entries.push(entry);
      }
    }

    if (!entries.length) return Array.from(dataTransfer.files || []);

    const files = [];
    const readEntry = (entry) =>
      new Promise((resolve) => {
        if (entry.isFile) {
          entry.file(
            (file) => {
              files.push(file);
              resolve();
            },
            () => resolve()
          );
        } else if (entry.isDirectory) {
          const reader = entry.createReader();
          const readBatch = () => {
            reader.readEntries(
              async (batch) => {
                if (!batch.length) {
                  resolve();
                  return;
                }
                for (const child of batch) await readEntry(child);
                readBatch();
              },
              () => resolve()
            );
          };
          readBatch();
        } else {
          resolve();
        }
      });

    for (const entry of entries) await readEntry(entry);
    return files;
  }

  async function importFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    if (!files.some(isAudioFile)) {
      toast('No audio files in that drop.', { type: 'error' });
      return;
    }

    const progress = toast('Preparing ' + files.length + ' files…', { duration: 0 });

    let report;
    try {
      report = await Library.importFiles(files, (info) => {
        const done = info.added + info.skipped + info.failed;
        progress.set('Adding ' + Math.min(done, info.total) + ' of ' + info.total + '…');
      });
    } catch (error) {
      console.error(error);
      progress.close();
      toast('Could not add those files.', { type: 'error', duration: 4000 });
      return;
    }

    progress.close();

    if (report.added) {
      renderList();

      /* Nothing was selected yet: show the first song, paused. */
      if (!Player.state.currentId && state.visible.length) {
        Player.restore(
          state.visible.map((track) => track.id),
          state.visible[0].id,
          0
        );
      }

      /* New songs join the end of the queue. */
      Player.appendToQueue(report.ids);
      renderQueue();
    }

    const parts = [];
    if (report.added) parts.push(report.added + (report.added === 1 ? ' song added' : ' songs added'));
    if (report.skipped) parts.push(report.skipped + ' already there');
    if (report.failed) parts.push(report.failed + ' failed');

    if (parts.length) {
      toast(parts.join(' · '), {
        type: report.failed && !report.added ? 'error' : undefined,
        duration: 3400,
      });
    }

    if (report.quota) {
      toast('Browser storage is full. Remove some songs to make room.', {
        type: 'error',
        duration: 7000,
      });
    }

    refreshStorage();
  }

  async function refreshStorage() {
    const info = await DB.estimate();
    if (!info || !info.quota) {
      els.storageText.textContent = '—';
      els.storageFill.style.width = '0%';
      return;
    }
    const percent = Math.min(100, (info.usage / info.quota) * 100);
    els.storageText.textContent = U.fmtBytes(info.usage) + ' of ' + U.fmtBytes(info.quota);
    els.storageFill.style.width = Math.max(1.5, percent).toFixed(1) + '%';
  }

  /* =========================================================
     Theme + prefs
     ========================================================= */
  const META_COLORS = {
    'default-dark': '#08080d',
    'default-light': '#f2f3f9',
    'vercel-dark': '#000000',
    'vercel-light': '#ffffff',
  };

  function applyMetaColor() {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    const root = document.documentElement;
    const key = (root.dataset.palette || 'default') + '-' + (root.dataset.theme || 'dark');
    meta.setAttribute('content', META_COLORS[key] || META_COLORS['default-dark']);
  }

  function updateThemeLabel() {
    if (!els.btnTheme) return;
    const light = document.documentElement.dataset.theme === 'light';
    els.btnTheme.setAttribute('aria-label', light ? 'Switch to dark theme' : 'Switch to light theme');
  }

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    U.store.set('theme', theme);
    applyMetaColor();
    updateThemeLabel();
  }

  function toggleTheme() {
    setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  }

  /** Palette is a second axis: dark or light stays, the colors change. */
  function setPalette(palette) {
    const value = palette === 'vercel' ? 'vercel' : 'default';
    document.documentElement.dataset.palette = value;
    U.store.set('palette', value);
    if (els.palette) els.palette.value = value;
    applyMetaColor();
  }

  function setView(view) {
    if (state.view === view) return;
    state.view = view === 'favorites' || view === 'queue' ? view : 'all';
    if (view === 'all' || view === 'favorites') U.store.set('view', state.view);
    state.search = '';
    els.search.value = '';
    els.searchClear.hidden = true;
    renderList();
  }

  function setSearch(value) {
    state.search = value;
    renderList();
  }

  function setSort(value) {
    state.sort = value;
    U.store.set('sort', value);
    renderList();
  }

  /* =========================================================
     Events
     ========================================================= */
  function handleAction(action) {
    switch (action) {
      case 'togglePlay':
        Player.toggle();
        break;
      case 'play':
        Player.play();
        break;
      case 'pause':
        Player.pause();
        break;
      case 'next':
        Player.next();
        break;
      case 'prev':
        Player.prev();
        break;
      case 'shuffle':
        Player.toggleShuffle();
        break;
      case 'shuffleQueue':
        Player.toggleShuffle();
        renderQueue();
        if (state.view === 'queue') renderQueueView();
        break;
      case 'repeat':
        Player.cycleRepeat();
        break;
      case 'mute':
        Player.toggleMute();
        break;
      case 'favorite':
        toggleFavorite(Player.state.currentId);
        break;
      case 'queue':
        toggleQueue();
        break;
      case 'addFiles':
        els.fileInput.click();
        break;
      case 'addFolder':
        els.folderInput.click();
        break;
      default:
        break;
    }
  }

  function bindEvents() {
    /* One click handler for the whole page. Buttons announce what they do
       with data-act, rows use data-row-action. */
    document.addEventListener('click', (event) => {
      const target = event.target;

      /* A finished queue drag must not also play the row. */
      if (Date.now() - queueDragEndAt < 350) return;

      /* The grip only drags. A plain click on it does nothing. */
      if (target.closest && target.closest('[data-drag]')) return;

      const closer = target.closest && target.closest('[data-close]');
      if (closer) {
        if (closer.dataset.close === 'queue') closeQueue();
        if (closer.dataset.close === 'nowPlaying') closeNowPlaying();
        return;
      }

      if (target.closest && target.closest('[data-close-dialog]')) {
        const dialog = target.closest('dialog');
        if (dialog) dialog.close();
        return;
      }

      const rowAction = target.closest && target.closest('[data-row-action]');
      if (rowAction) {
        event.stopPropagation();
        const action = rowAction.dataset.rowAction;
        const id =
          rowAction.dataset.id ||
          (rowAction.closest('.row') ? rowAction.closest('.row').dataset.id : null);

        if (action === 'fav') toggleFavorite(id);
        else if (action === 'remove') removeTrack(id);
        else if (action === 'qremove') {
          Player.removeFromQueue(id);
          renderQueue();
          markCurrentRow();
        }
        return;
      }

      const actionButton = target.closest && target.closest('[data-act]');
      if (actionButton) {
        handleAction(actionButton.dataset.act);
        return;
      }

      const queueRow = target.closest && target.closest('[data-qid]');
      if (queueRow) {
        Player.load(queueRow.dataset.qid, { autoplay: true });
        return;
      }

      const row = target.closest && target.closest('.row');
      if (row && row.dataset.id) playRow(row.dataset.id);
    });

    /* Dragging a queue row reorders the play order. */
    document.addEventListener('pointerdown', (event) => {
      startQueueDrag(event);
    });

    /* Right-click opens the song menu, in the list and in the queue drawer. */
    document.addEventListener('contextmenu', (event) => {
      const target = event.target;
      const queueRow = target.closest && target.closest('[data-qid]');
      if (queueRow) {
        openContextMenu(event, queueRow.dataset.qid, 'queue');
        return;
      }
      const row = target.closest && target.closest('.row');
      if (row && row.dataset.id) openContextMenu(event, row.dataset.id, 'list');
    });

    /* ---------- sidebar / nav ---------- */
    U.$$('.nav-item').forEach((item) => {
      item.addEventListener('click', () => {
        setView(item.dataset.view);
        closeSidebar();
      });
    });

    els.btnMenu.addEventListener('click', openSidebar);
    els.btnCloseSidebar.addEventListener('click', closeSidebar);
    els.scrim.addEventListener('click', closePanels);
    els.scrimSidebar.addEventListener('click', closeSidebar);

    /* ---------- theme, palette, help, clear ---------- */
    els.btnTheme.addEventListener('click', toggleTheme);
    els.palette.addEventListener('change', () => setPalette(els.palette.value));
    els.btnHelp.addEventListener('click', () => els.helpDialog.showModal());
    els.btnClear.addEventListener('click', clearLibrary);

    /* ---------- search / sort ---------- */
    els.search.addEventListener(
      'input',
      U.debounce(() => {
        const value = els.search.value;
        els.searchClear.hidden = value.length === 0;
        setSearch(value);
      }, 120)
    );

    els.search.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        els.search.value = '';
        els.searchClear.hidden = true;
        setSearch('');
        els.search.blur();
      }
    });

    els.searchClear.addEventListener('click', () => {
      els.search.value = '';
      els.searchClear.hidden = true;
      setSearch('');
      els.search.focus();
    });

    els.sort.addEventListener('change', () => setSort(els.sort.value));

    /* ---------- list scrolling ---------- */
    els.list.addEventListener('scroll', () => {
      if (state.rendered >= state.visible.length) return;
      const { scrollTop, clientHeight, scrollHeight } = els.list;
      if (scrollTop + clientHeight > scrollHeight - 600) appendRows();
    });

    /* Keyboard support for the rows (they are divs, not buttons). */
    els.list.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (event.target.closest('[data-drag]')) return;
      const queueRow = event.target.closest('[data-qid]');
      if (queueRow) {
        event.preventDefault();
        Player.load(queueRow.dataset.qid, { autoplay: true });
        return;
      }
      const row = event.target.closest('.row');
      if (!row || !row.dataset.id) return;
      event.preventDefault();
      playRow(row.dataset.id);
    });

    els.queueList.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (event.target.closest('[data-drag]')) return;
      const row = event.target.closest('[data-qid]');
      if (!row) return;
      event.preventDefault();
      Player.load(row.dataset.qid, { autoplay: true });
    });

    /* ---------- seek and volume ---------- */
    U.$$('.seek').forEach((input) => {
      input.addEventListener('pointerdown', () => {
        scrubbing = true;
      });
      input.addEventListener('input', () => {
        scrubbing = true;
        const ratio = Number(input.value) / 1000;
        input.style.setProperty('--fill', ratio * 100 + '%');
        Player.seekRatio(ratio);
      });
      input.addEventListener('change', () => {
        scrubbing = false;
      });
    });
    window.addEventListener('pointerup', () => {
      scrubbing = false;
    });

    U.$$('.vol').forEach((input) => {
      const volPct = input.parentElement.querySelector('.vol-pct');
      input.addEventListener('input', () => {
        const val = Number(input.value);
        Player.setVolume(val / 100);
        placeVolPct(input);
      });
      input.addEventListener('pointerdown', () => {
        if (input.parentElement) input.parentElement.classList.add('is-dragging');
      });
      window.addEventListener('pointerup', () => {
        if (input.parentElement) input.parentElement.classList.remove('is-dragging');
      });
      input.addEventListener('pointerenter', () => {
        if (volPct) volPct.classList.add('is-visible');
      });
      input.addEventListener('pointerleave', () => {
        if (volPct) volPct.classList.remove('is-visible');
      });
      placeVolPct(input);
    });

    /* ---------- now playing ---------- */
    els.npArt.addEventListener('click', openNowPlaying);
    els.nowPlaying.addEventListener('click', (event) => {
      /* Clicking the dark background closes the panel, but never a control. */
      if (event.target === els.nowPlaying || event.target.classList.contains('np-bg-veil')) {
        closeNowPlaying();
      }
    });

    /* ---------- files ---------- */
    els.fileInput.addEventListener('change', () => {
      const files = Array.from(els.fileInput.files || []);
      els.fileInput.value = '';
      importFiles(files);
    });

    els.folderInput.addEventListener('change', () => {
      const files = Array.from(els.folderInput.files || []);
      els.folderInput.value = '';
      importFiles(files);
    });

    /* ---------- drag and drop ---------- */
    let dragDepth = 0;
    const hasFiles = (event) => {
      const types = event.dataTransfer && event.dataTransfer.types;
      return types ? Array.from(types).includes('Files') : false;
    };

    window.addEventListener('dragenter', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth += 1;
      document.body.classList.add('is-dragging');
    });

    window.addEventListener('dragover', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    });

    window.addEventListener('dragleave', (event) => {
      if (!event.dataTransfer) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) document.body.classList.remove('is-dragging');
    });

    window.addEventListener('drop', async (event) => {
      event.preventDefault();
      dragDepth = 0;
      document.body.classList.remove('is-dragging');
      if (!event.dataTransfer) return;
      const files = await filesFromDrop(event.dataTransfer);
      importFiles(files);
    });

    /* ---------- queue footer ---------- */
    els.btnQueueShuffle.addEventListener('click', () => {
      Player.toggleShuffle();
      renderQueue();
    });

    /* ---------- keyboard ---------- */
    document.addEventListener('keydown', onKeyDown);
  }

  function onKeyDown(event) {
    const target = event.target;
    const typing =
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable);

    if (event.key === 'Escape') {
      if (els.nowPlaying.classList.contains('is-open')) {
        closeNowPlaying();
        return;
      }
      if (els.queue.classList.contains('is-open')) {
        closeQueue();
        return;
      }
      if (els.sidebar.classList.contains('is-open')) {
        closeSidebar();
        return;
      }
      if (typing && target.blur) target.blur();
      return;
    }

    if (typing) return;
    if (document.querySelector('dialog[open]')) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    /* Space on a focused row is "play that row", handled by the list itself. */
    if ((event.key === ' ' || event.key === 'Enter') && target.closest && target.closest('.row')) {
      return;
    }

    /* Let the keyboard activate real buttons instead of toggling music. */
    if (event.key === ' ' && target.closest && target.closest('button, a, [role="button"], select')) {
      return;
    }

    switch (event.key) {
      case ' ':
      case 'k':
      case 'K':
        event.preventDefault();
        Player.toggle();
        break;
      case 'ArrowRight':
        event.preventDefault();
        Player.seek(Player.audio.currentTime + (event.shiftKey ? 20 : 5));
        break;
      case 'ArrowLeft':
        event.preventDefault();
        Player.seek(Player.audio.currentTime - (event.shiftKey ? 20 : 5));
        break;
      case 'ArrowUp':
        event.preventDefault();
        Player.setVolume(Player.state.volume + 0.05);
        break;
      case 'ArrowDown':
        event.preventDefault();
        Player.setVolume(Player.state.volume - 0.05);
        break;
      case 'm':
      case 'M':
        Player.toggleMute();
        break;
      case 'n':
      case 'N':
        Player.next();
        break;
      case 'p':
      case 'P':
        Player.prev();
        break;
      case 'f':
      case 'F':
        toggleFavorite(Player.state.currentId);
        break;
      case 's':
      case 'S':
        Player.toggleShuffle();
        break;
      case 'r':
      case 'R':
        Player.cycleRepeat();
        break;
      case 'q':
      case 'Q':
        toggleQueue();
        break;
      case 't':
      case 'T':
        toggleTheme();
        break;
      case '/':
        event.preventDefault();
        els.search.focus();
        els.search.select();
        break;
      case '?':
        els.helpDialog.showModal();
        break;
      default:
        break;
    }
  }

  /* =========================================================
     Boot
     ========================================================= */
  function cache() {
    els.sidebar = U.$('#sidebar');
    els.scrim = U.$('#scrim');
    els.scrimSidebar = U.$('#scrimSidebar');
    els.search = U.$('#search');
    els.searchClear = U.$('#btnClearSearch');
    els.sort = U.$('#sort');
    els.list = U.$('#list');
    els.listHead = U.$('.list-head');
    els.empty = U.$('#empty');
    els.emptyTitle = U.$('#emptyTitle');
    els.emptyText = U.$('#emptyText');
    els.emptyActions = U.$('.empty-actions');
    els.emptyNote = U.$('.empty-note');
    els.viewTitle = U.$('#viewTitle');
    els.viewMeta = U.$('#viewMeta');
    els.countAll = U.$('#countAll');
    els.countFav = U.$('#countFav');
    els.countQueue = U.$('#countQueue');
    els.storageText = U.$('#storageText');
    els.storageFill = U.$('#storageFill');
    els.npArt = U.$('#npArt');
    els.npArtInner = U.$('#npArtInner');
    els.npTitle = U.$('#npTitle');
    els.bigTitle = U.$('#bigTitle');
    els.ctxMenu = U.$('#ctxMenu');
    els.npCoverBigInner = U.$('#npCoverBigInner');
    els.npBg = U.$('#npBg');
    els.nowPlaying = U.$('#nowPlaying');
    els.queue = U.$('#queue');
    els.queueList = U.$('#queueList');
    els.queueMeta = U.$('#queueMeta');
    els.toasts = U.$('#toasts');
    els.fileInput = U.$('#fileInput');
    els.folderInput = U.$('#folderInput');
    els.helpDialog = U.$('#helpDialog');
    els.confirm = U.$('#confirmDialog');
    els.confirmTitle = U.$('#confirmTitle');
    els.confirmText = U.$('#confirmText');
    els.confirmOk = U.$('#confirmOk');
    els.confirmCancel = U.$('#confirmCancel');
    els.viz = U.$('#viz');
    els.btnMenu = U.$('#btnMenu');
    els.btnCloseSidebar = U.$('#btnCloseSidebar');
    els.btnTheme = U.$('#btnTheme');
    els.palette = U.$('#palette');
    els.btnHelp = U.$('#btnHelp');
    els.btnClear = U.$('#btnClear');
    els.btnQueueShuffle = U.$('#btnQueueShuffle');
  }

  function subscribe() {
    Player.on('state', () => {
      renderPlayer();
      markCurrentRow();
      renderTime(Player.audio.currentTime, Player.duration);
    });

    Player.on('track', (track) => {
      renderPlayer();
      markCurrentRow();
      renderTime(0, track ? track.duration : 0);
    });

    Player.on('time', (info) => {
      renderTime(info.current, info.duration);
    });

    Player.on('queue', () => {
      if (els.queue.classList.contains('is-open')) renderQueue();
      if (state.view === 'queue') renderQueueView();
    });

    Player.on('error', (message) => {
      toast(message, { type: 'error', duration: 4200 });
    });
  }

  function init() {
    cache();

    /* Restore the small preferences before the first paint. */
    const savedView = U.store.get('view', 'all');
    state.view = savedView === 'favorites' ? 'favorites' : 'all';

    const savedSort = U.store.get('sort', 'added-desc');
    state.sort = els.sort.querySelector('option[value="' + savedSort + '"]') ? savedSort : 'added-desc';
    els.sort.value = state.sort;

    const savedPalette = U.store.get('palette', 'default');
    const paletteValue = els.palette.querySelector('option[value="' + savedPalette + '"]')
      ? savedPalette
      : 'default';
    els.palette.value = paletteValue;
    document.documentElement.dataset.palette = paletteValue;

    els.scrim.hidden = false;
    els.scrimSidebar.hidden = false;
    bindEvents();
    subscribe();
    renderList();
    renderPlayer();
    renderQueue();
  }

  /** Called by app.js after the library is read from the database. */
  function afterLibrary() {
    renderList();
    renderQueue();
    renderPlayer();
    updateHeader();
    refreshStorage();
    updateThemeLabel();
    applyMetaColor();
  }

  window.UI = {
    state,
    init,
    afterLibrary,
    renderList,
    renderPlayer,
    renderQueue,
    refreshStorage,
    toast,
    importFiles,
    setTheme,
    setPalette,
    visibleIds: () => state.visible.map((track) => track.id),
  };
})();
