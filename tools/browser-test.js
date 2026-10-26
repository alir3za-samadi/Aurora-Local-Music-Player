/* Headless browser test for the Aurora player.

   It drives Chrome through the DevTools protocol, so it needs
   no packages at all. Run it with:

     node tools/browser-test.js

   The test owns its own Chrome profile, so it never touches the
   songs in your normal browser. Everything it writes goes into
   tools/.tmp, which you can delete at any time.

   Set the CHROME environment variable if Chrome is installed in
   a different place:
     set CHROME=D:\chrome.exe && node tools/browser-test.js
*/

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TMP = path.join(__dirname, '.tmp');
const PROFILE = path.join(TMP, 'profile');
const PORT = 9333;
const APP =
  'file:///' +
  path
    .join(__dirname, '..', 'index.html')
    .replace(/\\/g, '/')
    .replace(/ /g, '%20');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  [' + detail + ']' : ''));
}

function makeWav(seconds, freq) {
  const rate = 44100;
  const count = rate * seconds;
  const data = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 8000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/* --- a tiny mp3 file with a real ID3v2.3 tag and a 1x1 png cover --- */
function makeTaggedMp3() {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const frame = (id, body) => {
    const head = Buffer.alloc(10);
    head.write(id, 0, 'latin1');
    head.writeUInt32BE(body.length, 4);
    return Buffer.concat([head, body]);
  };
  const textFrame = (id, text) =>
    frame(id, Buffer.concat([Buffer.from([1]), Buffer.from('\uFEFF' + text, 'utf16le')]));

  const frames = Buffer.concat([
    textFrame('TIT2', 'Midnight Drive'),
    textFrame('TPE1', 'The Testers'),
    textFrame('TALB', 'Night Sessions'),
    textFrame('TYER', '2024'),
    textFrame('TRCK', '3/10'),
    frame(
      'APIC',
      Buffer.concat([
        Buffer.from([0]),
        Buffer.from('image/png\0', 'latin1'),
        Buffer.from([3]),
        Buffer.from('\0', 'latin1'),
        png,
      ])
    ),
  ]);

  const header = Buffer.alloc(10);
  header.write('ID3', 0, 'latin1');
  header[3] = 3;
  header[4] = 0;
  header[5] = 0;
  const size = frames.length;
  header[6] = (size >> 21) & 0x7f;
  header[7] = (size >> 14) & 0x7f;
  header[8] = (size >> 7) & 0x7f;
  header[9] = size & 0x7f;

  return Buffer.concat([header, frames]);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------- synthetic FLAC + M4A so the parsers can be tested ---------- */
function makeFlac() {
  const be32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n, 0);
    return b;
  };
  const le32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n, 0);
    return b;
  };
  const block = (type, body, last) => {
    const head = Buffer.alloc(4);
    head[0] = type | (last ? 0x80 : 0);
    head.writeUIntBE(body.length, 1, 3);
    return Buffer.concat([head, body]);
  };
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );

  const comments = [
    'TITLE=Flac Song',
    'ARTIST=Flac Band',
    'ALBUM=Flac Album',
    'DATE=2019-05-01',
    'TRACKNUMBER=7',
  ];
  const vendor = Buffer.from('aurora-test');
  const vc = Buffer.concat([
    le32(vendor.length),
    vendor,
    le32(comments.length),
    ...comments.map((c) => {
      const b = Buffer.from(c, 'utf8');
      return Buffer.concat([le32(b.length), b]);
    }),
  ]);

  const mime = Buffer.from('image/png', 'latin1');
  const picture = Buffer.concat([
    be32(3),
    be32(mime.length),
    mime,
    be32(0),
    be32(1),
    be32(1),
    be32(24),
    be32(0),
    be32(png.length),
    png,
  ]);

  return Buffer.concat([
    Buffer.from('fLaC', 'latin1'),
    block(0, Buffer.alloc(34), false),
    block(4, vc, false),
    block(6, picture, true),
  ]);
}

function makeM4a() {
  const box = (type, ...children) => {
    const payload = Buffer.concat(children);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(payload.length + 8, 0);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, payload]);
  };
  const dataText = (text) =>
    box('data', Buffer.from([0, 0, 0, 1]), Buffer.from([0, 0, 0, 0]), Buffer.from(text, 'utf8'));
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );

  const ilst = box(
    'ilst',
    box('\u00a9nam', dataText('M4A Song')),
    box('\u00a9ART', dataText('M4A Artist')),
    box('\u00a9alb', dataText('M4A Album')),
    box('\u00a9day', dataText('2021')),
    box('trkn', box('data', Buffer.from([0, 0, 0, 0]), Buffer.from([0, 0, 0, 0]), Buffer.from([0, 0, 0, 9, 0, 10, 0, 0]))),
    box('covr', box('data', Buffer.from([0, 0, 0, 14]), Buffer.from([0, 0, 0, 0]), png))
  );

  const meta = box('meta', Buffer.from([0, 0, 0, 0]), ilst);
  return Buffer.concat([box('ftyp', Buffer.from('M4A ', 'latin1')), box('moov', box('udta', meta))]);
}


async function main() {
  fs.mkdirSync(TMP, { recursive: true });
  fs.rmSync(PROFILE, { recursive: true, force: true });

  const wavPath = path.join(TMP, 'Test Song.wav');
  const secondPath = path.join(TMP, 'Another Track.wav');
  fs.writeFileSync(wavPath, makeWav(2, 440));
  fs.writeFileSync(secondPath, makeWav(3, 330));
  const tagged = makeTaggedMp3();
  const taggedB64 = tagged.toString('base64');

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1440,900',
      '--remote-debugging-port=' + PORT,
      '--user-data-dir=' + PROFILE,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const page = list.find((t) => t.type === 'page');
      if (page) {
        wsUrl = page.webSocketDebuggerUrl;
        break;
      }
    } catch (e) {}
    await sleep(250);
  }
  if (!wsUrl) throw new Error('Chrome did not start');

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let msgId = 0;
  const waiting = new Map();
  const consoleErrors = [];

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && waiting.has(msg.id)) {
      const entry = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.method + ' ' + JSON.stringify(msg.error)));
      else entry.resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('EXCEPTION: ' + JSON.stringify(msg.params.exceptionDetails.exception && msg.params.exceptionDetails.exception.description || msg.params.exceptionDetails.text));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push('CONSOLE: ' + msg.params.args.map((a) => a.value || a.description || a.type).join(' '));
    }
  });

  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++msgId;
      waiting.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        'eval failed: ' +
          (res.exceptionDetails.exception
            ? res.exceptionDetails.exception.description
            : res.exceptionDetails.text) +
          '\n---\n' +
          expression.slice(0, 300)
      );
    }
    return res.result.value;
  };

  const waitFor = async (expression, timeout = 15000, label) => {
    const start = Date.now();
    let last;
    while (Date.now() - start < timeout) {
      last = await evaluate(expression);
      if (last) return last;
      await sleep(120);
    }
    throw new Error('timeout waiting for ' + (label || expression) + ' last=' + JSON.stringify(last));
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.navigate', { url: APP });
  await waitFor('document.readyState === "complete" && !!window.UI && !!window.Library', 20000, 'app boot');

  await sleep(800);

  /* ---------- 1. boot ---------- */
  const boot = await evaluate(`({
    title: document.title,
    hasPlayer: typeof Player === 'object',
    hasTags: typeof Tags === 'object',
    theme: document.documentElement.dataset.theme,
    emptyShown: !document.getElementById('empty').hidden,
    rows: document.querySelectorAll('#list .row').length,
    fontLoaded: document.fonts.check('16px Inter'),
    fontStatus: document.fonts.status,
    storageText: document.getElementById('storageText').textContent,
    countAll: document.getElementById('countAll').textContent,
    bodyText: document.getElementById('viewMeta').textContent
  })`);
  check('page booted', boot.hasPlayer && boot.hasTags, JSON.stringify(boot));
  check('empty state visible on first run', boot.emptyShown);
  check('no rows yet', boot.rows === 0);
  check('Inter font loaded', boot.fontLoaded, boot.fontStatus);
  check(
    'volume slider keeps its size',
    (await evaluate(`document.querySelector('.player input.vol').getBoundingClientRect().width`)) < 110,
    await evaluate(`document.querySelector('.player input.vol').getBoundingClientRect().width`)
  );

  /* ---------- 2. tag parser ---------- */
  const tags = await evaluate(`(async () => {
    const bin = atob(${JSON.stringify(taggedB64)});
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const file = new File([u8], 'tagged.mp3', { type: 'audio/mpeg' });
    const r = await Tags.read(file);
    return { tags: r.tags, picType: r.picture && r.picture.type, picSize: r.picture && r.picture.size };
  })()`);
  check(
    'ID3v2 text tags parsed',
    tags.tags.title === 'Midnight Drive' &&
      tags.tags.artist === 'The Testers' &&
      tags.tags.album === 'Night Sessions' &&
      tags.tags.year === '2024' &&
      tags.tags.trackNo === 3,
    JSON.stringify(tags.tags)
  );
  check('ID3v2 cover detected', tags.picType === 'image/png' && tags.picSize > 50, tags.picType + ' ' + tags.picSize);

  const flacTags = await evaluate(`(async () => {
    const bin = atob(${JSON.stringify(makeFlac().toString('base64'))});
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const r = await Tags.read(new File([u8], 'song.flac', { type: 'audio/flac' }));
    return { tags: r.tags, pic: r.picture && r.picture.type };
  })()`);
  check(
    'FLAC vorbis comments parsed',
    flacTags.tags.title === 'Flac Song' &&
      flacTags.tags.artist === 'Flac Band' &&
      flacTags.tags.album === 'Flac Album' &&
      flacTags.tags.year === '2019' &&
      flacTags.tags.trackNo === 7,
    JSON.stringify(flacTags.tags)
  );
  check('FLAC picture parsed', flacTags.pic === 'image/png', flacTags.pic);

  const mp4Tags = await evaluate(`(async () => {
    const bin = atob(${JSON.stringify(makeM4a().toString('base64'))});
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const r = await Tags.read(new File([u8], 'song.m4a', { type: 'audio/mp4' }));
    return { tags: r.tags, pic: r.picture && r.picture.type };
  })()`);
  check(
    'M4A atoms parsed',
    mp4Tags.tags.title === 'M4A Song' &&
      mp4Tags.tags.artist === 'M4A Artist' &&
      mp4Tags.tags.album === 'M4A Album' &&
      mp4Tags.tags.year === '2021' &&
      mp4Tags.tags.trackNo === 9,
    JSON.stringify(mp4Tags.tags)
  );
  check('M4A cover parsed', mp4Tags.pic === 'image/png', mp4Tags.pic);

  const nameTag = await evaluate(`U.baseName('03 - Daft Punk - Get Lucky.mp3')`);
  check('song name comes from the file name, tags ignored', nameTag === '03 - Daft Punk - Get Lucky', nameTag);

  /* ---------- 3. import a file through the file input ---------- */
  const doc = await send('DOM.getDocument', { depth: -1 });
  const input = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fileInput' });
  await send('DOM.setFileInputFiles', { files: [wavPath], nodeId: input.nodeId });

  await waitFor('Library.tracks.length === 1', 20000, 'first import');
  await waitFor('document.querySelectorAll("#list .row").length === 1', 5000, 'first row');

  const afterImport = await evaluate(`({
    count: Library.tracks.length,
    title: Library.tracks[0].title,
    fileName: Library.tracks[0].fileName,
    hasTagFields: 'artist' in Library.tracks[0] || 'album' in Library.tracks[0] || 'year' in Library.tracks[0],
    duration: Library.tracks[0].duration,
    thumb: Library.tracks[0].thumb,
    rowTitle: document.querySelector('#list .row .title').textContent,
    rowChildren: document.querySelector('#list .row').children.length,
    rowHasArtist: !!document.querySelector('#list .row .artist'),
    rowHasAlbum: !!document.querySelector('#list .row .album'),
    placeholder: (() => {
      const t = document.querySelector('#list .row .thumb');
      return {
        cls: t.className,
        text: t.textContent,
        kids: t.children.length,
        image: getComputedStyle(t).backgroundImage.slice(0, 24)
      };
    })(),
    viewMeta: document.getElementById('viewMeta').textContent,
    countAll: document.getElementById('countAll').textContent,
    hasListFoot: !!document.getElementById('listFoot'),
    current: Player.state.currentId,
    barTitle: document.getElementById('npTitle').textContent
  })`);
  check('file imported', afterImport.count === 1, afterImport.title);
  check('title is the file name without extension', afterImport.title === 'Test Song', afterImport.title);
  check('track record has no tag fields', afterImport.hasTagFields === false);
  check('duration measured', afterImport.duration > 1.8 && afterImport.duration < 2.2, afterImport.duration);
  check('row has four cells and no artist or album', afterImport.rowChildren === 4 && !afterImport.rowHasArtist && !afterImport.rowHasAlbum, afterImport.rowChildren);
  check('row rendered', afterImport.rowTitle === 'Test Song', afterImport.rowTitle);
  check('no "showing N of M" line', afterImport.hasListFoot === false);
  check(
    'cover placeholder is a gradient with nothing on top',
    afterImport.placeholder.cls.indexOf('placeholder') >= 0 &&
      afterImport.placeholder.text === '' &&
      afterImport.placeholder.kids === 0 &&
      afterImport.placeholder.image.indexOf('gradient') >= 0,
    JSON.stringify(afterImport.placeholder)
  );
  check('first song selected after import', !!afterImport.current, afterImport.barTitle);

  /* ---------- 4. playback ---------- */
  await evaluate(`document.querySelector('[data-act="togglePlay"]').click()`);
  await sleep(900);
  const playing = await evaluate(`({
    paused: Player.audio.paused,
    time: Player.audio.currentTime,
    duration: Player.audio.duration,
    state: Player.isPlaying,
    icon: document.querySelector('.js-icon-play use').getAttribute('href')
  })`);
  check('audio plays', !playing.paused && playing.time > 0.2, JSON.stringify(playing));
  check('pause icon shown while playing', playing.icon === '#i-pause', playing.icon);

  await evaluate(`Player.seek(1.2)`);
  await sleep(200);
  check('seek works', (await evaluate('Player.audio.currentTime')) > 1.0);

  const timeLabel = await evaluate(`document.querySelector('[data-role="timeCur"]').textContent`);
  check('time label updates', /0:0[12]/.test(timeLabel), timeLabel);

  await evaluate(`document.querySelector('[data-act="togglePlay"]').click()`);
  await sleep(250);
  check('pause works', await evaluate('Player.audio.paused'));

  /* ---------- 4b. no speed control, volume percent ---------- */
  check(
    'playback speed control is gone',
    (await evaluate(`document.querySelector('.speed-select') === null && !('speed' in Player.state)`)) === true
  );

  const volPctAway = await evaluate(`getComputedStyle(document.querySelector('.player .vol-pct')).opacity`);
  await evaluate(
    `document.querySelector('.player input.vol').dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }))`
  );
  await sleep(300);
  const volPctOver = await evaluate(`({
    text: document.querySelector('.player .vol-pct').textContent,
    opacity: getComputedStyle(document.querySelector('.player .vol-pct')).opacity
  })`);
  await evaluate(
    `document.querySelector('.player input.vol').dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }))`
  );
  check(
    'volume percent appears on hover',
    /^\d+%$/.test(volPctOver.text) && volPctAway === '0' && volPctOver.opacity === '1',
    JSON.stringify({ away: volPctAway, over: volPctOver })
  );
  await sleep(250);
  check(
    'volume percent hides again',
    (await evaluate(`getComputedStyle(document.querySelector('.player .vol-pct')).opacity`)) === '0'
  );

  /* The label must sit on the white thumb, not on the middle of the bar. */
  const volAlign = await evaluate(`(async () => {
    const input = document.querySelector('.player input.vol');
    input.value = '65';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    const label = document.querySelector('.player .vol-pct');
    const box = input.getBoundingClientRect();
    const group = document.querySelector('.player .volume').getBoundingClientRect();
    const thumb = 11;
    const want = box.left - group.left + thumb / 2 + 0.65 * (input.clientWidth - thumb);
    const have = parseFloat(label.style.left);
    return { want: Math.round(want * 10) / 10, have: Math.round(have * 10) / 10, text: label.textContent };
  })()`);
  check(
    'volume percent sits on the thumb',
    Math.abs(volAlign.want - volAlign.have) < 0.6 && volAlign.text === '65%',
    JSON.stringify(volAlign)
  );
  await evaluate(`(() => {
    const input = document.querySelector('.player input.vol');
    input.value = '100';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(80);

  /* ---------- 5. favorites ---------- */
  await evaluate(`document.querySelector('[data-row-action="fav"]').click()`);
  await waitFor('Library.tracks[0].favorite === true', 3000, 'favorite');
  check('favorite toggles', await evaluate('Library.tracks[0].favorite === true'));

  /* ---------- 6. search / sort / views ---------- */
  await evaluate(`(() => { const s = document.getElementById('search'); s.value = 'zzz'; s.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await sleep(300);
  const searchEmpty = await evaluate(`({ rows: document.querySelectorAll('#list .row').length, empty: !document.getElementById('empty').hidden, title: document.getElementById('emptyTitle').textContent })`);
  check('search filters everything out', searchEmpty.rows === 0 && searchEmpty.empty, searchEmpty.title);

  await evaluate(`document.getElementById('btnClearSearch').click()`);
  await sleep(300);
  check('clear search restores rows', (await evaluate('document.querySelectorAll("#list .row").length')) === 1);

  await evaluate(`(() => { const s = document.getElementById('sort'); s.value = 'title-asc'; s.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  await sleep(200);
  check('sort preference saved', (await evaluate(`JSON.parse(localStorage.getItem('aurora.v3.sort'))`)) === 'title-asc');

  /* ---------- 7. second import + persistence of metadata ---------- */
  await send('DOM.setFileInputFiles', { files: [secondPath], nodeId: input.nodeId });
  await waitFor('Library.tracks.length === 2', 20000, 'second import');
  await sleep(300);
  check('two rows after second import', (await evaluate('document.querySelectorAll("#list .row").length')) === 2);
  check('new song appended to the queue', (await evaluate('Player.state.queue.length')) === 2);

  /* adding the same file twice is ignored */
  await send('DOM.setFileInputFiles', { files: [secondPath], nodeId: input.nodeId });
  await sleep(1200);
  check('duplicate file is skipped', (await evaluate('Library.tracks.length')) === 2);

  /* ---------- 7b. right-click menu in the song list ---------- */
  const rowIds = await evaluate(`Array.from(document.querySelectorAll('#list .row')).map((r) => r.dataset.id)`);
  const menuTarget = rowIds[0];
  const menuCurrent = rowIds[1];
  /* The target sits first and the current song second, so the target is
     not "next" yet and moving it is a real change. */
  await evaluate(
    `Player.playIds(${JSON.stringify([menuTarget, menuCurrent])}, ${JSON.stringify(menuCurrent)}, { autoplay: false })`
  );
  await sleep(300);

  /* The heart and the delete button are always visible, with no hover step. */
  const favVis = await evaluate(`(async () => {
    const rows = Array.from(document.querySelectorAll('#list .row'));
    const row = rows.find((r) => !r.classList.contains('is-current'));
    if (!row) return { ok: false };
    row.querySelector('[data-row-action="fav"]').click();
    await new Promise((r) => setTimeout(r, 400));
    const live = document.querySelector('#list .row[data-id="' + row.dataset.id + '"]') || row;
    const fav = live.querySelector('[data-row-action="fav"]');
    const trash = live.querySelector('[data-row-action="remove"]');
    const out = {
      ok: true,
      heart: getComputedStyle(fav).opacity,
      trash: getComputedStyle(trash).opacity,
      on: fav.classList.contains('is-on')
    };
    /* Put the song back so later checks see the same data. */
    fav.click();
    await new Promise((r) => setTimeout(r, 300));
    return out;
  })()`);
  check(
    'row actions stay visible without hover',
    favVis.ok && favVis.heart === '1' && favVis.trash === '1' && favVis.on,
    JSON.stringify(favVis)
  );

  /* Liking one row must not mark the rest. The player bar heart was once
     written into every .fav-btn element, so all rows looked liked. */
  const favScope = await evaluate(`(async () => {
    const before = Library.tracks.filter((t) => t.favorite).map((t) => t.id).sort();
    const rows = Array.from(document.querySelectorAll('#list .row'));
    const target = rows.find((r) => !r.querySelector('[data-row-action="fav"]').classList.contains('is-on'));
    if (!target) return { ok: false };
    target.querySelector('[data-row-action="fav"]').click();
    await new Promise((r) => setTimeout(r, 400));
    const wantOn = before.concat(target.dataset.id).sort();
    const on = Array.from(document.querySelectorAll('#list .row'))
      .filter((r) => r.querySelector('[data-row-action="fav"]').classList.contains('is-on'))
      .map((r) => r.dataset.id)
      .sort();
    const data = Library.tracks.filter((t) => t.favorite).map((t) => t.id).sort();
    const live = document.querySelector('#list .row[data-id="' + target.dataset.id + '"]');
    if (live) live.querySelector('[data-row-action="fav"]').click();
    await new Promise((r) => setTimeout(r, 300));
    return { ok: true, on: on, data: data, wantOn: wantOn };
  })()`);
  check(
    'liking one row does not mark the others',
    favScope.ok && JSON.stringify(favScope.on) === JSON.stringify(favScope.wantOn) && JSON.stringify(favScope.data) === JSON.stringify(favScope.wantOn),
    JSON.stringify(favScope)
  );

  await evaluate(`(() => {
    const row = document.querySelectorAll('#list .row')[0];
    const box = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
      clientX: box.left + 40, clientY: box.top + 12
    }));
    return true;
  })()`);
  await sleep(200);

  const ctxList = await evaluate(`({
    open: !document.getElementById('ctxMenu').hidden,
    items: Array.from(document.querySelectorAll('#ctxMenu > div')).map((n) => n.textContent),
    onScreen: (() => {
      const r = document.getElementById('ctxMenu').getBoundingClientRect();
      return r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
    })()
  })`);
  check('right-click opens the song menu', ctxList.open === true, JSON.stringify(ctxList.items));
  check(
    'menu has play next, favorite and remove',
    ctxList.items.length === 3 &&
      ctxList.items[0] === 'Play next' &&
      /favorite/i.test(ctxList.items[1]) &&
      ctxList.items[2] === 'Remove from library',
    JSON.stringify(ctxList.items)
  );
  check('menu stays inside the window', ctxList.onScreen);

  const beforeNext = await evaluate(
    `Player.state.queue.indexOf(${JSON.stringify(menuTarget)}) === Player.state.queue.indexOf(Player.state.currentId) + 1`
  );
  await evaluate(`document.querySelectorAll('#ctxMenu > div')[0].click()`);
  await sleep(250);
  const afterNext = await evaluate(`({
    moved: Player.state.queue.indexOf(${JSON.stringify(menuTarget)}) === Player.state.queue.indexOf(Player.state.currentId) + 1,
    hidden: document.getElementById('ctxMenu').hidden,
    order: Player.state.queue.join()
  })`);
  check('play next had something to move', beforeNext === false);
  check('play next puts the song right after the current one', afterNext.moved, afterNext.order);
  check('menu closes after a choice', afterNext.hidden === true);

  /* The current song is already next. The move used to drop it from the queue. */
  const currentNext = await evaluate(`(async () => {
    const id = Player.state.currentId;
    const row = document.querySelector('#list .row[data-id="' + id + '"]');
    if (!row) return { missing: true };
    const box = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
      clientX: box.left + 40, clientY: box.top + 12
    }));
    await new Promise((r) => setTimeout(r, 140));
    const before = Player.state.queue.join() + '|' + Player.state.pos;
    document.querySelectorAll('#ctxMenu > div')[0].click();
    await new Promise((r) => setTimeout(r, 220));
    return {
      same: Player.state.queue.join() + '|' + Player.state.pos === before,
      current: Player.state.currentId === id,
      inside: Player.state.queue.indexOf(id) === Player.state.pos,
      toast: document.getElementById('toasts').textContent
    };
  })()`);
  check(
    'play next on the current song keeps the queue',
    currentNext.same === true && currentNext.current === true && currentNext.inside === true,
    JSON.stringify(currentNext)
  );

  /* ---------- 8. queue + now playing + theme ---------- */
  await evaluate(`document.querySelector('.player [data-act="queue"]').click()`);
  await sleep(350);
  const queueOpen = await evaluate(`({
    open: document.getElementById('queue').classList.contains('is-open'),
    rows: document.querySelectorAll('#queue [data-qid]').length,
    meta: document.getElementById('queueMeta').textContent,
    scrim: document.getElementById('scrim').classList.contains('is-open')
  })`);
  check('queue drawer opens', queueOpen.open && queueOpen.rows === 2, queueOpen.meta);
  check('scrim shown with drawer', queueOpen.scrim);

  /* The drawer rows use the same grid as the list, and the shuffle button is
     small with a small gap under it. */
  const drawerLook = await evaluate(`(() => {
    const row = document.querySelector('#queue [data-qid]');
    const listRow = document.querySelector('#list .row');
    const btn = document.getElementById('btnQueueShuffle');
    const drawer = document.getElementById('queue');
    return {
      height: row ? Math.round(row.getBoundingClientRect().height) : 0,
      listHeight: listRow ? Math.round(listRow.getBoundingClientRect().height) : 0,
      heart: !!(row && row.querySelector('[data-row-action="fav"]')),
      btnHeight: Math.round(btn.getBoundingClientRect().height),
      gap: Math.round(drawer.getBoundingClientRect().bottom - btn.getBoundingClientRect().bottom)
    };
  })()`);
  check(
    'queue drawer rows match the list',
    drawerLook.height > 0 && drawerLook.height === drawerLook.listHeight && drawerLook.heart,
    JSON.stringify(drawerLook)
  );
  check(
    'queue shuffle is small and near the bottom',
    drawerLook.btnHeight <= 34 && drawerLook.gap >= 5 && drawerLook.gap <= 9,
    JSON.stringify(drawerLook)
  );
  /* keyboard reorder of a queue row */
  const kbResult = await evaluate(`(async () => {
    const drawer = document.querySelector('#queue');
    if (!drawer.classList.contains('is-open')) document.querySelector('.player [data-act="queue"]').click();
    await new Promise((r) => setTimeout(r, 300));
    const handle = document.querySelector('#queue .q-drag');
    if (!handle) return { ok: false, reason: 'no handle' };
    const before = Player.state.queue.slice();
    handle.focus();
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 200));
    const after = Player.state.queue.slice();
    return { ok: true, before: before, after: after, moved: before.join() !== after.join() };
  })()`);
  check('keyboard reorder moves a queue row', kbResult.ok && kbResult.moved, JSON.stringify(kbResult.after));
  /* dragging a queue row reorders the play order */
  const dragResult = await evaluate(`(async () => {
    const handle = document.querySelector('#queue .q-drag');
    const rows = Array.from(document.querySelectorAll('#queue [data-qid]'));
    if (!handle || rows.length < 2) return { ok: false, reason: 'no rows' };
    const r0 = rows[0].getBoundingClientRect();
    const r1 = rows[1].getBoundingClientRect();
    const cx = r0.left + r0.width / 2;
    const cy0 = r0.top + r0.height / 2;
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, clientX: cx, clientY: cy0 }));
    await new Promise((r) => setTimeout(r, 60));
    const midY = r1.top + r1.height / 2 + 40;
    handle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1, clientX: cx, clientY: midY }));
    await new Promise((r) => setTimeout(r, 60));
    const live = document.querySelector('#queue [data-qid].is-dragging');
    const animation = {
      dragging: !!live,
      follows: live ? /translateY\\(\\d+(\\.\\d+)?px\\)/.test(live.style.transform || '') : false,
      shifted: Array.from(document.querySelectorAll('#queue [data-qid]')).filter((r) => r !== live && r.style.transform).length
    };
    handle.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1, clientX: cx, clientY: midY }));
    await new Promise((r) => setTimeout(r, 420));
    return { ok: true, animation: animation, queue: Player.state.queue.slice(), ids: rows.map((r) => r.dataset.qid) };
  })()`);
  const dragMoved = dragResult.ok && dragResult.queue.length === 2 && dragResult.queue[0] !== dragResult.ids[0];
  check('drag reorders the queue', dragMoved, JSON.stringify(dragResult.queue));
  check(
    'dragging animates the row and the shift',
    dragResult.ok && dragResult.animation.dragging && dragResult.animation.follows && dragResult.animation.shifted > 0,
    JSON.stringify(dragResult.animation)
  );
  await evaluate('document.activeElement && document.activeElement.blur && document.activeElement.blur(); document.body.focus(); true');
  await sleep(200);



  /* the same menu works inside the queue drawer */
  await evaluate(`(() => {
    const row = document.querySelector('#queue [data-qid]');
    const box = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
      clientX: box.left + 30, clientY: box.top + 10
    }));
    return true;
  })()`);
  await sleep(200);
  const ctxQueue = await evaluate(`({
    open: !document.getElementById('ctxMenu').hidden,
    items: Array.from(document.querySelectorAll('#ctxMenu > div')).map((n) => n.textContent)
  })`);
  check(
    'right-click works in the queue drawer too',
    ctxQueue.open === true && ctxQueue.items[2] === 'Remove from queue',
    JSON.stringify(ctxQueue.items)
  );
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(150);
  check('escape closes the menu', await evaluate(`document.getElementById('ctxMenu').hidden === true`));

  await evaluate(`document.querySelector('#queue [data-close="queue"]').click()`);
  await sleep(300);

  /* The Playing queue tab must look like All songs: same row height,
     same cover size, a heart, and the drag grip must be a real icon. */
  const queueView = await evaluate(`(async () => {
    document.querySelector('[data-view="queue"]').click();
    await new Promise((r) => setTimeout(r, 400));
    const row = document.querySelector('#list [data-qid]');
    const grip = row && row.querySelector('.q-drag use');
    const info = {
      title: document.getElementById('viewTitle').textContent,
      rows: document.querySelectorAll('#list [data-qid]').length,
      height: row ? Math.round(row.getBoundingClientRect().height) : 0,
      thumb: row ? Math.round(row.querySelector('.thumb').getBoundingClientRect().width) : 0,
      grip: grip ? grip.getAttribute('href') : null,
      heart: !!(row && row.querySelector('[data-row-action="fav"]')),
      cells: row ? row.children.length : 0,
      headHidden: document.querySelector('.list-head').hidden,
      sortHidden: document.querySelector('.sort').hidden
    };
    const input = document.getElementById('search');
    input.value = 'zzz';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 360));
    info.filtered = document.querySelectorAll('#list [data-qid]').length;
    info.filteredEmpty = !document.getElementById('empty').hidden;
    info.gripWhileFiltered = !!document.querySelector('#list .q-drag');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 360));
    info.restored = document.querySelectorAll('#list [data-qid]').length;
    document.querySelector('[data-view="all"]').click();
    await new Promise((r) => setTimeout(r, 350));
    info.rowHeight = Math.round(document.querySelector('#list .row').getBoundingClientRect().height);
    return info;
  })()`);
  check(
    'playing queue rows match all songs rows',
    queueView.title === 'Playing queue' &&
      queueView.rows === 2 &&
      queueView.height > 0 &&
      queueView.height === queueView.rowHeight &&
      queueView.thumb === 40 &&
      queueView.heart === true &&
      queueView.cells === 4,
    JSON.stringify(queueView)
  );
  check('queue drag grip uses the real icon', queueView.grip === '#i-grip', queueView.grip);
  check(
    'queue view hides sort and filters with search',
    queueView.sortHidden === true &&
      queueView.filtered === 0 &&
      queueView.filteredEmpty === true &&
      queueView.gripWhileFiltered === false &&
      queueView.restored === 2,
    JSON.stringify(queueView)
  );

  await evaluate(`Player.play()`);
  await sleep(700);
  await evaluate(`document.getElementById('npArt').click()`);
  await sleep(900);
  const npOpen = await evaluate(`({
    open: document.getElementById('nowPlaying').classList.contains('is-open'),
    bigTitle: document.getElementById('bigTitle').textContent
  })`);
  check('now playing opens', npOpen.open, npOpen.bigTitle);

  const vizInfo = await evaluate(`(() => {
    const c = document.getElementById('viz');
    const ctx = c.getContext('2d');
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 10) lit++;
    return { width: c.width, height: c.height, lit };
  })()`);
  check('visualizer paints pixels', vizInfo.width > 0 && vizInfo.height > 0 && vizInfo.lit > 0, JSON.stringify(vizInfo));

  await evaluate(`document.querySelector('#nowPlaying [data-close="nowPlaying"]').click()`);
  await sleep(300);
  await evaluate(`Player.pause()`);

  const themeBefore = await evaluate(`document.documentElement.dataset.theme`);
  await evaluate(`document.getElementById('btnTheme').click()`);
  await sleep(150);
  const themeAfter = await evaluate(`document.documentElement.dataset.theme`);
  check('theme toggles', themeBefore !== themeAfter, themeBefore + ' -> ' + themeAfter);
  /* Native dropdowns (sort, speed) follow color-scheme, so it must match. */
  const schemeLight = await evaluate(`({
    scheme: getComputedStyle(document.documentElement).colorScheme,
    theme: document.documentElement.dataset.theme,
    selectColor: getComputedStyle(document.getElementById('sort')).color
  })`);
  check(
    'color-scheme follows the theme',
    schemeLight.theme === 'light' && schemeLight.scheme === 'light',
    JSON.stringify(schemeLight)
  );
  await evaluate(`document.getElementById('btnTheme').click()`);
  await sleep(150);
  const schemeDark = await evaluate(`({
    scheme: getComputedStyle(document.documentElement).colorScheme,
    theme: document.documentElement.dataset.theme
  })`);
  check(
    'dark theme asks for dark native controls',
    schemeDark.theme === 'dark' && schemeDark.scheme === 'dark',
    JSON.stringify(schemeDark)
  );

  /* ---------- 8b. palette ---------- */
  const paletteInfo = await evaluate(`(async () => {
    const select = document.getElementById('palette');
    const root = document.documentElement;
    const before = {
      attr: root.dataset.palette || '',
      bg: getComputedStyle(document.body).backgroundColor,
      accent: getComputedStyle(root).getPropertyValue('--accent').trim()
    };
    select.value = 'vercel';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 140));
    const after = {
      attr: root.dataset.palette,
      bg: getComputedStyle(document.body).backgroundColor,
      accent: getComputedStyle(root).getPropertyValue('--accent').trim(),
      saved: JSON.parse(localStorage.getItem('aurora.v3.palette')),
      theme: root.dataset.theme
    };
    select.value = 'default';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 140));
    return { before: before, after: after, back: root.dataset.palette, options: select.options.length };
  })()`);
  check(
    'palette select switches to vercel and back',
    paletteInfo.options === 10 &&
      paletteInfo.before.attr === 'default' &&
      paletteInfo.after.attr === 'vercel' &&
      paletteInfo.after.saved === 'vercel' &&
      paletteInfo.after.theme === 'dark' &&
      paletteInfo.after.accent === '#e5e5e5' &&
      paletteInfo.after.bg === 'rgb(0, 0, 0)' &&
      paletteInfo.before.bg !== paletteInfo.after.bg &&
      paletteInfo.back === 'default',
    JSON.stringify(paletteInfo)
  );

  /* Every palette but Vercel follows the theme. */
  const paletteLight = await evaluate(`(async () => {
    const select = document.getElementById('palette');
    const names = ['amber', 'one-dark', 'one-dark-flat', 'night-owl', 'monokai', 'dracula', 'nord', 'gruvbox'];
    const out = [];
    for (const name of names) {
      select.value = name;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      UI.setTheme('light');
      await new Promise((r) => setTimeout(r, 70));
      const rgb = (getComputedStyle(document.body).backgroundColor.match(/\\d+/g) || []).map(Number);
      out.push({
        name: name,
        theme: document.documentElement.dataset.theme,
        scheme: getComputedStyle(document.documentElement).colorScheme,
        light: rgb[0] > 190 && rgb[1] > 190 && rgb[2] > 180,
        disabled: document.getElementById('btnTheme').disabled
      });
      UI.setTheme('dark');
      await new Promise((r) => setTimeout(r, 70));
    }
    select.value = 'default';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return out;
  })()`);
  check(
    'every palette but Vercel follows the theme',
    paletteLight.every(
      (p) => p.theme === 'light' && p.scheme === 'light' && p.light === true && p.disabled === false
    ),
    JSON.stringify(paletteLight)
  );

  /* Vercel stays dark even when the saved theme is light. */
  const vercelDark = await evaluate(`(async () => {
    UI.setTheme('light');
    await new Promise((r) => setTimeout(r, 90));
    const select = document.getElementById('palette');
    select.value = 'vercel';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 90));
    const out = {
      theme: document.documentElement.dataset.theme,
      disabled: document.getElementById('btnTheme').disabled,
      scheme: getComputedStyle(document.documentElement).colorScheme,
      bg: getComputedStyle(document.body).backgroundColor,
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    };
    select.value = 'default';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    UI.setTheme('dark');
    await new Promise((r) => setTimeout(r, 90));
    return out;
  })()`);
  check(
    'vercel ignores the light theme',
    vercelDark.theme === 'light' &&
      vercelDark.disabled === true &&
      vercelDark.scheme === 'dark' &&
      vercelDark.bg === 'rgb(0, 0, 0)' &&
      vercelDark.accent === '#e5e5e5',
    JSON.stringify(vercelDark)
  );

  /* A theme switch must not animate any color. */
  const motionGuard = await evaluate(`(async () => {
    const root = document.documentElement;
    document.getElementById('btnTheme').click();
    const during = root.classList.contains('no-motion');
    await new Promise((r) => setTimeout(r, 160));
    const after = root.classList.contains('no-motion');
    document.getElementById('btnTheme').click();
    await new Promise((r) => setTimeout(r, 160));
    return { during: during, after: after, theme: root.dataset.theme };
  })()`);
  check(
    'theme switch turns motion off for one frame',
    motionGuard.during === true && motionGuard.after === false && motionGuard.theme === 'dark',
    JSON.stringify(motionGuard)
  );

  /* ---------- 9. keyboard shortcuts ---------- */
  await send('Page.bringToFront');
  await evaluate(`document.activeElement && document.activeElement.blur && document.activeElement.blur(); true`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, text: ' ' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
  await sleep(700);
  check('space starts playback', await evaluate('!Player.audio.paused'));
  await evaluate(`Player.pause()`);

  /* ---------- 10. reload: does everything stay? ---------- */
  const positionBefore = await evaluate('Player.audio.currentTime');
  await evaluate(`Player.seek(1.1)`);
  await sleep(400);
  await send('Page.reload', { ignoreCache: false });
  await waitFor('document.readyState === "complete" && !!window.Library && Library && Library.tracks.length >= 0', 20000, 'reload');
  await waitFor('Library.tracks.length === 2', 15000, 'library after reload');
  await sleep(1200);

  const afterReload = await evaluate(`({
    tracks: Library.tracks.length,
    favorite: Library.byId.get(Object.keys(Object.fromEntries(Library.byId))[0]).favorite,
    current: Player.state.currentId,
    barTitle: document.getElementById('npTitle').textContent,
    rows: document.querySelectorAll('#list .row').length,
    sort: document.getElementById('sort').value,
    theme: document.documentElement.dataset.theme,
    paused: Player.audio.paused,
    position: Player.audio.currentTime,
    volume: Player.state.volume,
    queueLength: Player.state.queue.length
  })`);
  check('library survives reload', afterReload.tracks === 2, afterReload.tracks);
  check('rows rebuilt after reload', afterReload.rows === 2);
  check('sort preference restored', afterReload.sort === 'title-asc', afterReload.sort);
  check('last song restored and paused', !!afterReload.current && afterReload.paused, afterReload.barTitle);
  check('position restored', afterReload.position > 0.8, afterReload.position);

  /* ---------- 11. remove + clear ---------- */
  await evaluate(`document.querySelector('#list .row [data-row-action="remove"]').click()`);
  await waitFor('Library.tracks.length === 1', 8000, 'remove');
  check('remove deletes a song', (await evaluate('Library.tracks.length')) === 1);

  const storagePersisted = await evaluate(`(async () => {
    const rows = await DB.allTracks();
    return rows.length;
  })()`);
  check('database matches UI after removal', storagePersisted === 1, storagePersisted);

  /* ---------- 12. screenshots ---------- */
  await evaluate(`document.getElementById('toasts').textContent = ''`);
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(500);
  const desktopChrome = await evaluate(`({
    close: getComputedStyle(document.getElementById('btnCloseSidebar')).display,
    menu: getComputedStyle(document.getElementById('btnMenu')).display,
    sidebar: getComputedStyle(document.getElementById('sidebar')).visibility
  })`);
  check(
    'desktop hides the sidebar close button',
    desktopChrome.close === 'none' && desktopChrome.menu === 'none' && desktopChrome.sidebar === 'visible',
    JSON.stringify(desktopChrome)
  );
  let shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(TMP, 'desktop.png'), Buffer.from(shot.data, 'base64'));

  /* the same view in the light theme, mainly to see the lighter covers */
  await evaluate(`document.getElementById('btnTheme').click()`);
  await sleep(450);
  const lightScheme = await evaluate(`({
    theme: document.documentElement.dataset.theme,
    scheme: getComputedStyle(document.documentElement).colorScheme
  })`);
  check(
    'light theme renders with light native controls',
    lightScheme.theme === 'light' && lightScheme.scheme === 'light',
    JSON.stringify(lightScheme)
  );
  shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(TMP, 'desktop-light.png'), Buffer.from(shot.data, 'base64'));
  await evaluate(`document.getElementById('btnTheme').click()`);
  await sleep(350);

  await evaluate(`
    (() => {
      document.getElementById('npArt').click();
      return true;
    })()
  `);
  await sleep(900);
  shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(TMP, 'nowplaying.png'), Buffer.from(shot.data, 'base64'));
  await evaluate(`document.querySelector('#nowPlaying [data-close="nowPlaying"]').click()`);

  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await sleep(600);
  const mobileChrome = await evaluate(`({
    close: getComputedStyle(document.getElementById('btnCloseSidebar')).display,
    menu: getComputedStyle(document.getElementById('btnMenu')).display
  })`);
  check(
    'phone shows the sidebar close button',
    mobileChrome.close !== 'none' && mobileChrome.menu !== 'none',
    JSON.stringify(mobileChrome)
  );
  shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(TMP, 'mobile.png'), Buffer.from(shot.data, 'base64'));

  await evaluate(`document.getElementById('btnMenu').click()`);
  await sleep(450);
  const sidebarOpen = await evaluate(`({
    open: document.getElementById('sidebar').classList.contains('is-open'),
    visible: getComputedStyle(document.getElementById('sidebar')).visibility
  })`);
  check('mobile menu opens the sidebar', sidebarOpen.open && sidebarOpen.visible === 'visible', JSON.stringify(sidebarOpen));
  shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(TMP, 'mobile-menu.png'), Buffer.from(shot.data, 'base64'));
  await evaluate(`document.getElementById('scrimSidebar').click()`);
  await sleep(400);
  check('scrim closes the sidebar', !(await evaluate(`document.getElementById('sidebar').classList.contains('is-open')`)));

  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(300);

  /* ---------- 13. clear library ---------- */
  await evaluate(`document.getElementById('btnClear').click()`);
  await sleep(300);
  check('confirm dialog opens', await evaluate(`document.getElementById('confirmDialog').open`));
  await evaluate(`document.getElementById('confirmOk').click()`);
  await waitFor('Library.tracks.length === 0', 8000, 'clear library');
  const cleared = await evaluate(`(async () => ({
    tracks: Library.tracks.length,
    stored: (await DB.allTracks()).length,
    empty: !document.getElementById('empty').hidden,
    barTitle: document.getElementById('npTitle').textContent
  }))()`);
  check('library cleared from ui and database', cleared.tracks === 0 && cleared.stored === 0, cleared.barTitle);
  check('empty state returns', cleared.empty);

  /* ---------- summary ---------- */
  console.log('\nconsole errors:', consoleErrors.length);
  consoleErrors.slice(0, 12).forEach((e) => console.log('  ' + e));

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  if (consoleErrors.length) console.log('JS errors were reported above');

  ws.close();
  chrome.kill();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (error) => {
  console.error('TEST CRASH:', error.message);
  process.exit(2);
});
