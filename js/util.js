/* =========================================================
   util.js — small helpers used by every other file.

   Everything lives on one global object (window.U) because
   the app runs from file:// where ES modules are blocked.
   ========================================================= */
(function () {
  'use strict';

  const U = {};

  /* ---------- DOM ---------- */
  U.$ = (selector, root) => (root || document).querySelector(selector);
  U.$$ = (selector, root) => Array.from((root || document).querySelectorAll(selector));

  /**
   * Create an element.
   * U.el('div', { class: 'row', text: 'Hi' }, [child])
   */
  U.el = function (tag, props, children) {
    const node = document.createElement(tag);

    if (props) {
      Object.keys(props).forEach((key) => {
        const value = props[key];
        if (value === null || value === undefined || value === false) return;

        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key === 'style') {
          Object.keys(value).forEach((prop) => {
            if (prop.startsWith('--')) node.style.setProperty(prop, value[prop]);
            else node.style[prop] = value[prop];
          });
        } else if (key === 'on' && typeof value === 'object') {
          Object.keys(value).forEach((evt) => node.addEventListener(evt, value[evt]));
        } else if (typeof value === 'function') {
          node.addEventListener(key.replace(/^on/, ''), value);
        } else {
          node.setAttribute(key, value === true ? '' : value);
        }
      });
    }

    if (children) {
      (Array.isArray(children) ? children : [children]).forEach((child) => {
        if (child === null || child === undefined || child === false) return;
        node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
      });
    }
    return node;
  };

  /** Inline SVG icon from the sprite in index.html. */
  U.icon = function (name, extraClass) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'icon' + (extraClass ? ' ' + extraClass : ''));
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(NS, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  };

  /* ---------- Numbers and text ---------- */
  U.clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  U.fmtTime = function (seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    return m + ':' + String(s).padStart(2, '0');
  };

  U.fmtBytes = function (bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const value = bytes / Math.pow(1024, i);
    return (value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)) + ' ' + units[i];
  };

  U.uid = function () {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  };

  /* ---------- Timing ---------- */
  U.debounce = function (fn, wait) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
  };

  U.throttle = function (fn, wait) {
    let last = 0;
    let timer = null;
    return function (...args) {
      const now = Date.now();
      const remaining = wait - (now - last);
      if (remaining <= 0) {
        clearTimeout(timer);
        timer = null;
        last = now;
        fn.apply(this, args);
      } else if (!timer) {
        timer = setTimeout(() => {
          last = Date.now();
          timer = null;
          fn.apply(this, args);
        }, remaining);
      }
    };
  };

  /* ---------- Look and feel helpers ---------- */
  /** Stable color for a title, so the same song always gets the same cover color. */
  U.hue = function (text) {
    let hash = 0;
    const value = String(text || '');
    for (let i = 0; i < value.length; i++) {
      hash = (hash * 31 + value.charCodeAt(i)) % 360;
    }
    return hash;
  };

  U.initials = function (text) {
    const words = String(text || '')
      .replace(/\.[a-z0-9]{2,4}$/i, '')
      .split(/[\s\-_]+/)
      .filter(Boolean);
    if (!words.length) return '♪';
    return words
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join('');
  };

  /* ---------- localStorage ---------- */
  const PREFIX = 'aurora.v3.';

  U.store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(PREFIX + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (error) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(PREFIX + key, JSON.stringify(value));
      } catch (error) {
        /* Private mode or a full disk: the app still works, it just forgets. */
      }
    },
    remove(key) {
      try {
        localStorage.removeItem(PREFIX + key);
      } catch (error) {}
    },
  };

  /* ---------- Audio helpers ---------- */

  /**
   * Read the length of an audio file. The file is never decoded fully,
   * only the header, so this is fast even for long songs.
   */
  U.probeDuration = function (file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const audio = new Audio();
      let finished = false;

      const finish = (seconds) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        audio.removeAttribute('src');
        audio.load();
        URL.revokeObjectURL(url);
        resolve(Number.isFinite(seconds) ? seconds : 0);
      };

      const timer = setTimeout(() => finish(0), 10000);

      audio.preload = 'metadata';
      audio.addEventListener('loadedmetadata', () => finish(audio.duration), { once: true });
      audio.addEventListener('error', () => finish(0), { once: true });
      audio.src = url;
    });
  };

  /**
   * Turn cover art into a small square JPEG data URL.
   * The track list then shows covers without loading large images.
   */
  U.makeThumb = async function (blob, size) {
    try {
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      const side = Math.min(bitmap.width, bitmap.height);
      const sx = (bitmap.width - side) / 2;
      const sy = (bitmap.height - side) / 2;
      ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
      if (bitmap.close) bitmap.close();
      return canvas.toDataURL('image/jpeg', 0.82);
    } catch (error) {
      return null;
    }
  };

  window.U = U;
})();
