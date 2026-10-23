/* =========================================================
   tags.js — read title, artist, album and cover art from
   the file itself, so the player does not have to trust the
   file name.

   Supported:
     • MP3  → ID3v2.2 / 2.3 / 2.4  (and ID3v1 as a fallback)
     • FLAC → Vorbis comments + PICTURE block
     • M4A / MP4 → iTunes "ilst" atoms
   Anything else falls back to the file name.

   Only the first few MB are read. Tags sit at the start of
   the file, so there is no reason to load a 40 MB song.
   ========================================================= */
(function () {
  'use strict';

  const MAX_PREFIX = 6 * 1024 * 1024;

  const DEC = {
    latin1: new TextDecoder('windows-1252'),
    utf8: new TextDecoder('utf-8'),
    utf16le: new TextDecoder('utf-16le'),
    utf16be: new TextDecoder('utf-16be'),
  };

  /* ---------- byte helpers ---------- */
  const u32be = (u8, p) =>
    ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0;
  const u32le = (u8, p) =>
    (u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16) | (u8[p + 3] << 24)) >>> 0;
  const syncsafe = (u8, p) =>
    ((u8[p] & 0x7f) << 21) |
    ((u8[p + 1] & 0x7f) << 14) |
    ((u8[p + 2] & 0x7f) << 7) |
    (u8[p + 3] & 0x7f);

  const ascii = (u8, start, end) => DEC.latin1.decode(u8.subarray(start, end));

  function cleanText(value) {
    if (!value) return '';
    return value
      .split('\u0000')
      .map((part) => part.trim())
      .filter(Boolean)
      .join(', ')
      .trim();
  }

  function decodeText(u8, start, end, encoding) {
    if (end <= start) return '';
    const bytes = u8.subarray(start, end);
    let value;
    if (encoding === 0) value = DEC.latin1.decode(bytes);
    else if (encoding === 3) value = DEC.utf8.decode(bytes);
    else if (encoding === 2) value = DEC.utf16be.decode(bytes);
    else if (bytes[0] === 0xff && bytes[1] === 0xfe) value = DEC.utf16le.decode(bytes.subarray(2));
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) value = DEC.utf16be.decode(bytes.subarray(2));
    else value = DEC.utf16le.decode(bytes);
    return cleanText(value);
  }

  /** Find the end of a NUL terminated string inside a frame. */
  function stringEnd(u8, start, encoding) {
    if (encoding === 1 || encoding === 2) {
      for (let i = start; i + 1 < u8.length; i += 2) {
        if (u8[i] === 0 && u8[i + 1] === 0) return { end: i, next: i + 2 };
      }
      return { end: u8.length, next: u8.length };
    }
    for (let i = start; i < u8.length; i++) {
      if (u8[i] === 0) return { end: i, next: i + 1 };
    }
    return { end: u8.length, next: u8.length };
  }

  /* ---------- ID3v2 ---------- */
  function parsePicture(frame, isV22) {
    const encoding = frame[0];
    let p = 1;
    let mime;

    if (isV22) {
      mime = 'image/' + ascii(frame, 1, 4).toLowerCase().replace('jpg', 'jpeg');
      p = 4;
    } else {
      const mimeEnd = stringEnd(frame, 1, 0);
      mime = ascii(frame, 1, mimeEnd.end).toLowerCase();
      p = mimeEnd.next;
    }

    p += 1; // picture type byte (front cover, back cover, artist...)
    const desc = stringEnd(frame, p, encoding);
    p = desc.next;

    const data = frame.subarray(p);
    if (data.length < 16) return null;

    if (!mime || mime === 'image/') {
      if (data[0] === 0xff && data[1] === 0xd8) mime = 'image/jpeg';
      else if (data[0] === 0x89 && data[1] === 0x50) mime = 'image/png';
      else mime = 'image/jpeg';
    }

    try {
      return new Blob([data], { type: mime });
    } catch (error) {
      return null;
    }
  }

  function parseId3(u8) {
    if (!(u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33)) return null;

    const major = u8[3];
    const flags = u8[5];
    const tagSize = syncsafe(u8, 6);
    const end = Math.min(10 + tagSize, u8.length);
    let p = 10;

    /* Extended header: rarely used, but it shifts every frame. */
    if (flags & 0x40 && p + 4 <= end) {
      if (major === 4) p += syncsafe(u8, p);
      else p += u32be(u8, p) + 4;
    }

    const tags = {};
    let picture = null;

    while (p < end) {
      let id;
      let size;
      let frameFlags = 0;

      if (major === 2) {
        id = ascii(u8, p, p + 3);
        if (!/^[A-Z0-9]{3}$/.test(id)) break;
        size = (u8[p + 3] << 16) | (u8[p + 4] << 8) | u8[p + 5];
        p += 6;
      } else {
        id = ascii(u8, p, p + 4);
        if (!/^[A-Z0-9]{4}$/.test(id)) break;
        size = major === 4 ? syncsafe(u8, p + 4) : u32be(u8, p + 4);
        frameFlags = (u8[p + 8] << 8) | u8[p + 9];
        p += 10;
      }

      if (size <= 0 || p + size > end) break;
      const frame = u8.subarray(p, p + size);

      switch (id) {
        case 'TIT2':
        case 'TT2':
          tags.title = decodeText(frame, 1, frame.length, frame[0]);
          break;
        case 'TPE1':
        case 'TP1':
          tags.artist = decodeText(frame, 1, frame.length, frame[0]);
          break;
        case 'TALB':
        case 'TAL':
          tags.album = decodeText(frame, 1, frame.length, frame[0]);
          break;
        case 'TYER':
        case 'TYE':
        case 'TDRC':
          tags.year = decodeText(frame, 1, frame.length, frame[0]).slice(0, 4);
          break;
        case 'TRCK':
        case 'TRK':
          tags.trackNo = parseInt(decodeText(frame, 1, frame.length, frame[0]), 10) || 0;
          break;
        case 'TCON':
        case 'TCO':
          tags.genre = decodeText(frame, 1, frame.length, frame[0]);
          break;
        case 'APIC':
        case 'PIC':
          if (!picture) picture = parsePicture(frame, id === 'PIC');
          break;
        default:
          break;
      }

      /* frameFlags tells if a frame is compressed or encrypted.
         Such frames are simply ignored: the next one is still valid. */
      void frameFlags;

      p += size;
    }

    return { tags, picture };
  }

  function parseId3v1(u8) {
    if (ascii(u8, 0, 3) !== 'TAG') return null;
    const tags = {};
    const title = decodeText(u8, 3, 33, 0);
    const artist = decodeText(u8, 33, 63, 0);
    const album = decodeText(u8, 63, 93, 0);
    const year = decodeText(u8, 93, 97, 0);
    const comment = decodeText(u8, 97, 127, 0);
    const track = u8[125] === 0 && u8[126] > 0 ? u8[126] : 0;
    if (title) tags.title = title;
    if (artist) tags.artist = artist;
    if (album) tags.album = album;
    if (year) tags.year = year;
    if (comment) tags.comment = comment;
    if (track) tags.trackNo = track;
    return { tags, picture: null };
  }

  /* ---------- FLAC ---------- */
  function flacPicture(u8) {
    if (u8.length < 32) return null;
    let p = 4; // picture type (front cover, ...)
    const mimeLen = u32be(u8, p);
    p += 4;
    const mime = ascii(u8, p, p + mimeLen);
    p += mimeLen;
    const descLen = u32be(u8, p);
    p += 4 + descLen;
    p += 16; // width, height, color depth, palette size
    const dataLen = u32be(u8, p);
    p += 4;
    if (dataLen <= 0 || p + dataLen > u8.length) return null;
    try {
      return new Blob([u8.subarray(p, p + dataLen)], { type: mime || 'image/jpeg' });
    } catch (error) {
      return null;
    }
  }

  function base64ToBytes(value) {
    const binary = atob(value.replace(/\s+/g, ''));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  function parseVorbisComment(body, out) {
    let p = 0;
    const vendorLength = u32le(body, p);
    p += 4 + vendorLength;
    if (p + 4 > body.length) return;

    const count = u32le(body, p);
    p += 4;

    for (let i = 0; i < count && p + 4 <= body.length; i++) {
      const length = u32le(body, p);
      p += 4;
      if (length <= 0 || p + length > body.length) break;

      const entry = DEC.utf8.decode(body.subarray(p, p + length));
      p += length;

      const eq = entry.indexOf('=');
      if (eq < 0) continue;
      const key = entry.slice(0, eq).toUpperCase();
      const value = entry.slice(eq + 1).trim();
      if (!value) continue;

      switch (key) {
        case 'TITLE':
          out.tags.title = out.tags.title || value;
          break;
        case 'ARTIST':
          out.tags.artist = out.tags.artist || value;
          break;
        case 'ALBUM':
          out.tags.album = out.tags.album || value;
          break;
        case 'DATE':
        case 'YEAR':
          out.tags.year = out.tags.year || value.slice(0, 4);
          break;
        case 'TRACKNUMBER':
          out.tags.trackNo = out.tags.trackNo || parseInt(value, 10) || 0;
          break;
        case 'GENRE':
          out.tags.genre = out.tags.genre || value;
          break;
        case 'METADATA_BLOCK_PICTURE':
          if (!out.picture) {
            try {
              out.picture = flacPicture(base64ToBytes(value));
            } catch (error) {}
          }
          break;
        default:
          break;
      }
    }
  }

  function parseFlac(u8) {
    if (ascii(u8, 0, 4) !== 'fLaC') return null;

    const out = { tags: {}, picture: null };
    let p = 4;

    while (p + 4 <= u8.length) {
      const header = u8[p];
      const last = (header & 0x80) !== 0;
      const type = header & 0x7f;
      const length = (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3];
      const start = p + 4;

      if (start + length > u8.length) break;
      const body = u8.subarray(start, start + length);

      if (type === 4) parseVorbisComment(body, out);
      else if (type === 6 && !out.picture) out.picture = flacPicture(body);

      p = start + length;
      if (last) break;
    }

    return out;
  }

  /* ---------- MP4 / M4A ---------- */
  function childBoxes(u8, start, end) {
    const boxes = [];
    let p = start;
    while (p + 8 <= end) {
      let size = u32be(u8, p);
      const type = ascii(u8, p + 4, p + 8);
      if (size === 1) {
        /* 64-bit size: the real value starts 8 bytes later. */
        size = u32be(u8, p + 8) * 4294967296 + u32be(u8, p + 12);
      }
      if (size === 0) size = end - p;
      if (size < 8 || p + size > end) break;
      boxes.push({ type, start: p + 8, end: p + size });
      p += size;
    }
    return boxes;
  }

  function parseMp4(u8) {
    const top = childBoxes(u8, 0, u8.length);
    const moov = top.find((box) => box.type === 'moov');
    if (!moov) return null;

    const moovKids = childBoxes(u8, moov.start, moov.end);
    const udta = moovKids.find((box) => box.type === 'udta');
    let meta = null;

    if (udta) meta = childBoxes(u8, udta.start, udta.end).find((box) => box.type === 'meta');
    if (!meta) meta = moovKids.find((box) => box.type === 'meta');
    if (!meta) return null;

    /* "meta" is a full box: skip its 4 bytes of version and flags. */
    const metaKids = childBoxes(u8, meta.start + 4, meta.end);
    const ilst = metaKids.find((box) => box.type === 'ilst');
    if (!ilst) return null;

    const out = { tags: {}, picture: null };
    const items = childBoxes(u8, ilst.start, ilst.end);

    items.forEach((item) => {
      const data = childBoxes(u8, item.start, item.end).find((box) => box.type === 'data');
      if (!data) return;

      const dataType = u32be(u8, data.start) & 0x00ffffff;
      const payloadStart = data.start + 8; // 4 bytes type/flags + 4 bytes locale
      if (payloadStart >= data.end) return;

      const key = item.type;

      if (key === 'covr') {
        if (out.picture) return;
        const bytes = u8.subarray(payloadStart, data.end);
        let mime = 'image/jpeg';
        if (dataType === 14) mime = 'image/png';
        else if (dataType === 13) mime = 'image/jpeg';
        else if (bytes[0] === 0x89 && bytes[1] === 0x50) mime = 'image/png';
        try {
          out.picture = new Blob([bytes], { type: mime });
        } catch (error) {}
        return;
      }

      /* Text atoms. Type 2 means UTF-16, everything else is UTF-8. */
      let value = '';
      if (dataType === 1) value = DEC.utf8.decode(u8.subarray(payloadStart, data.end));
      else if (dataType === 2) value = DEC.utf16be.decode(u8.subarray(payloadStart, data.end));
      else if (dataType === 0) value = DEC.utf8.decode(u8.subarray(payloadStart, data.end));

      value = cleanText(value);
      if (!value) return;

      if (key === '\u00a9nam') out.tags.title = out.tags.title || value;
      else if (key === '\u00a9ART' || key === 'aART') out.tags.artist = out.tags.artist || value;
      else if (key === '\u00a9alb') out.tags.album = out.tags.album || value;
      else if (key === '\u00a9day') out.tags.year = out.tags.year || value.slice(0, 4);
      else if (key === '\u00a9gen' || key === 'gnre') out.tags.genre = out.tags.genre || value;
      else if (key === 'trkn') {
        const raw = u8.subarray(payloadStart, data.end);
        if (raw.length >= 4) out.tags.trackNo = (raw[2] << 8) | raw[3];
      }
    });

    return out;
  }

  /* ---------- public API ---------- */

  /**
   * Read tags from a File.
   * Always resolves. Missing data simply means "use the file name".
   */
  async function read(file) {
    try {
      const headSize = Math.min(file.size, MAX_PREFIX);
      const headBuffer = await file.slice(0, headSize).arrayBuffer();
      const head = new Uint8Array(headBuffer);

      let result = parseId3(head) || parseFlac(head) || parseMp4(head);

      const hasText = result && Object.keys(result.tags).some((key) => result.tags[key]);
      if (!hasText && file.size > 128) {
        const tailBuffer = await file.slice(file.size - 128).arrayBuffer();
        const v1 = parseId3v1(new Uint8Array(tailBuffer));
        if (v1 && Object.keys(v1.tags).length) {
          result = {
            tags: Object.assign({}, result ? result.tags : {}, v1.tags),
            picture: result ? result.picture : null,
          };
        }
      }

      if (!result) return { tags: {}, picture: null };
      return result;
    } catch (error) {
      console.warn('Could not read tags:', error);
      return { tags: {}, picture: null };
    }
  }

  /** "Artist - Title.mp3" → { artist, title } */
  function fromFileName(fileName) {
    const base = String(fileName || '')
      .replace(/\.[^.]+$/, '')
      .replace(/_/g, ' ')
      .trim();
    const parts = base.split(/\s+-\s+/);
    if (parts.length >= 2 && parts[0].length <= 60) {
      return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
    }
    return { title: base || 'Untitled', artist: '' };
  }

  window.Tags = { read, fromFileName };
})();
