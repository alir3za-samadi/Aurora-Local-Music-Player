# AGENTS.md — notes for changing this project

This file is for anyone (person or tool) who edits the code in this folder.
`README.md` is for the user. This file is for the developer.

---

## 1. What this project is

A music player that runs from `index.html` opened with `file://`, by double-clicking.
It has no server, no package manager, no build step, no test runner, and no network
access at runtime.

---

## 2. Hard rules

Break one of these and the app stops working. They are not style choices.

1. **No build step.** The files in the folder are the files the browser runs. Never
   add a step that has to run before `index.html` works.
2. **No ES modules.** Browsers block `<script type="module">` on `file://`. Every
   file is a plain classic script that assigns one global.
3. **No network at runtime.** No CDN for the font, no library from a CDN, no
   `fetch` to a remote host. Everything ships in `assets/` or is written by hand.
4. **No npm dependencies.** Nothing to install. If you need a small helper, write it
   in `util.js`.
5. **`js/` script order matters.** See section 3. A file may only use a global that
   an earlier file created.
6. **Never send a file name, tag, or any user text into `innerHTML`.** Build rows
   with `U.el` and `textContent`. A song file named `<img onerror=...>.mp3` must not
   be able to run code.
7. **Comments and all `.md` files are in simple English.** Short sentences, common
   words, no idioms. The user reads English at a beginner level.
8. **Do not upgrade the storage schema in place without care.** People have real
   songs in IndexedDB. If you must change it, raise the version and write an
   `onupgradeneeded` path that keeps old records.

---

## 3. Script order and globals

`index.html` loads the scripts in this exact order. Each one is an IIFE and exposes
one global at the end.

| # | File | Global | Owns |
| --- | --- | --- | --- |
| 1 | `js/util.js` | `U` | DOM helpers, `U.store` (localStorage), time format, thumbnail, duration probe |
| 2 | `js/db.js` | `DB` | IndexedDB: `tracks`, `files`, `art` |
| 3 | `js/tags.js` | `Tags` | ID3v1/v2, FLAC Vorbis, MP4 `ilst` readers. The app only uses the cover picture. |
| 4 | `js/player.js` | `Player` | one `<audio>` element, queue, shuffle, repeat, speed, Media Session, art cache, Web Audio visualizer |
| 5 | `js/library.js` | `Library`, `isAudioFile` | import pipeline, search, sort, duplicate keys |
| 6 | `js/ui.js` | `UI` | all rendering, all events, the song menu, keyboard shortcuts, toasts, visualizer drawing |
| 7 | `js/app.js` | — | startup order, saved state, throttled saving |

Dependency direction, top to bottom only:

```text
util  ->  db  ->  tags  ->  player  ->  library  ->  ui  ->  app
```

`ui.js` is the only file that touches the DOM. The other files work on data and tell
`ui.js` what happened through events. `app.js` runs last and starts everything.

---

## 4. Storage

### IndexedDB

- Database name: `aurora-player`, version `1`.
- Store `tracks`, `keyPath: 'id'`. One record per song, no audio bytes. Fields:
  `id, title, duration, size, mime, fileName, addedAt, favorite, hasArt, thumb`.
  `title` is the file name without its extension. Tag text is never stored.
  `thumb` is a small data URL (about 96 px) so the list can show art without
  reading the big blob.
- Store `files`, `keyPath: 'id'`. `{ id, blob }`, the audio file itself.
- Store `art`, `keyPath: 'id'`. `{ id, blob }`, the full-size cover.
- The three stores are separate on purpose. The list only reads `tracks`, so opening
  a big library stays fast and never loads megabytes of audio.

Why IndexedDB and not only localStorage: localStorage holds about 5 MB of text, so one
song would fill it. IndexedDB stores real `Blob`s and keeps them across reloads.

`DB.askToPersist()` calls `navigator.storage.persist()` once, so the browser is less
likely to delete the library when the disk is tight. A `false` answer is normal and
harmless.

### localStorage

Key prefix `aurora.v3.` (defined once in `util.js` as `U.store`). Access it through
`U.store.get/set/remove`, never with raw `localStorage`.

| Key | Value |
| --- | --- |
| `aurora.v3.state` | playback state, see below |
| `aurora.v3.view` | `'all'` or `'favorites'` |
| `aurora.v3.sort` | one of the 6 sort keys in `library.js` |
| `aurora.v3.theme` | `'dark'` or `'light'` |

`aurora.v3.state` holds:

```js
{ trackId, position, volume, muted, speed, repeat, shuffle, queue }
```

`queue` is capped at 1000 ids to keep the value small.

A saved sort value that no longer exists (from an older version) is not an error.
`ui.js` only accepts a value that is present as an `<option>`, so anything else falls
back to the default.

The prefix exists because **Chrome treats every `file://` page as one origin**. Any
local HTML file shares this localStorage and this IndexedDB. The prefix keeps the keys
from clashing with another local page.

### When state is written

`app.js` listens to `Player`'s `time`, `track`, `state`, and `queue` events and writes
through a 1500 ms throttle (`U.throttle`). It also writes on `pagehide` and when the
tab becomes hidden, so a close does not lose the position. Do not add a save on every
`timeupdate` event; that is a write every 250 ms.

### First paint and the theme

`app.js` sets `document.documentElement.dataset.theme` **before** anything renders, so
the first paint has the right colors and does not flash. If you add a setting that
changes colors, restore it in the same early step.

---

## 5. How the pieces talk

`player.js` has a tiny event bus: `Player.on(event, fn)` and an internal `emit`.
Events: `time`, `track`, `state`, `queue`, `art`, `loading`, `error`. `ui.js`
subscribes to the ones it draws.

The flow for a click on a song row:

```text
click -> ui.js delegated handler -> playRow(id)
      -> Player.playIds(visibleIds, id)   // queue = the visible list
      -> Player emits 'track' / 'state' / 'queue'
      -> ui.js renders the player bar, the row highlight, and the queue
```

`Player.state.queue` is the play order. It is built from the **visible** list, so
search and sort change the order. New imports go to the end through
`Player.appendToQueue(ids)`.

`Player.playNext(id)` moves one song to the place right after the current song. It
moves the id, it never duplicates it. The right-click menu uses it.

The queue is also written to localStorage, so a reload continues in the same order.

---

## 6. UI conventions

- **The song name is the file name.** `U.baseName(file.name)` — the extension is
  dropped, nothing else. Tag text is ignored on purpose, so a wrong tag can never
  rename a file. `Tags.read` is called only to find the cover picture.
- **Rows have exactly four cells:** index, name, time, actions. Do not add artist,
  album, or a second line to a row. The CSS grid in `.list-wrap` sets the column count
  with `--cols`; the three breakpoints must keep the same number of cells.
- **Rows are DOM, never HTML strings.** See rule 6 above.
- **Events are delegated.** One listener on the list, one on the document. A control
  is marked with `data-act="name"` (global) or `data-row-action="name"` (inside a
  row). Add a case in the switch in `ui.js`; do not add a new listener per element.
- **The song menu is built on every open.** `openContextMenu(event, id, source)` fills
  `#ctxMenu` with the items and focuses the first one. `source` is `'queue'` when the
  click came from a queue row; then the last item removes from the queue, not the
  library. Use `contextItem(label, run)` so a new item also works with the keyboard.
- **Buttons carry three things:** `aria-label`, `aria-pressed` when they are toggles,
  and a `title` that names the shortcut, for example `title="Shuffle (S)"`.
  `ui.js` keeps `aria-pressed` and the `title` in sync when the state changes.
- **The list renders in pages.** `state.rendered` grows by `limit` (200) when you
  scroll near the end. `state.visible` holds the full filtered list; only
  `state.rendered` of them are in the DOM. Do not render everything.
- **Styling uses CSS variables** from `:root` in `styles.css`, and the theme flips
  them through `[data-theme="light"]`. Never hard-code a color in the JS.
- **The cover placeholder is a plain gradient.** `thumbNode` and `placeholder` only set
  `--hue`; the two colors come from the `--grad-*` tokens. Never put text, initials, or
  an icon inside a cover.
- **Icons are one SVG sprite** at the top of `index.html`. Use
  `U.icon('i-play')` or `<svg class="icon"><use href="#i-play"/></svg>`. Do not add an
  icon file.

---

## 7. Things that cost real debugging time

Keep these in mind before you "fix" something.

- **One `MediaElementSource` per element, ever.** `player.js` creates the Web Audio
  graph once and connects the single `<audio>` element to an `AnalyserNode` and then
  to the destination. Calling `createMediaElementSource` twice on the same element
  throws.
- **An `AudioContext` must start inside a user gesture.** That is why the app restores
  the last song paused, and why the first play needs a click or `Space`. Do not try to
  autoplay.
- **Do not let `Space` on a focused button also toggle playback.** `ui.js` ignores the
  shortcut when the event target is a button or an input.
- **`input[type=range]` needs `input.vol`, not `.vol`,** for the width rule. The
  element selector wins over the class in specificity.
- **`.app` creates a stacking context.** The mobile scrim for the sidebar lives
  inside `.app` as `#scrimSidebar` so the drawer stays above it. A scrim outside
  `.app` blurs the drawer it should sit behind.
- **Setting `style.backgroundImage = 'none'` removes a gradient for good.** To clear
  the placeholder art, `ui.js` uses `style.removeProperty('background-image')`.
- **Mixed-language titles need `unicode-bidi: plaintext`.** A Persian title with a
  Latin number otherwise reorders the punctuation.
- **MP4 `trkn` is binary.** `tags.js` must try the binary branch before any text
  decode, or the track number comes out as garbage.
- **A browser that blocks storage is not a crash.** `app.js` catches it and shows a
  toast that tells the user to open the file in Chrome or Edge.
- **Quota errors are their own case.** A full disk shows a specific message, not the
  generic "import failed" one.
- **Native dropdowns need `color-scheme`.** The sort and speed `<select>` popups are
  drawn by the operating system, not by CSS. Without `color-scheme: dark` on
  `[data-theme='dark']`, the popup is white with light text. The token lives in the
  theme blocks, so a new theme must set it too.
- **The cover gradient needs both lightness tokens.** `[data-theme='dark']` overrides
  `--grad-l1` / `--grad-l2` to darker values, and `[data-theme='light']` to lighter
  ones. The base `:root` values are the fallback only.
- **`.close-sidebar` fights `.icon-btn` in specificity.** Both are one class, so the
  later rule wins. The base rule keeps `display: none`, and a
  `@media (min-width: 901px)` block near the responsive rules repeats it for the
  desktop case. Do not remove that block, or the button comes back on desktop.
- **The menu closes on the next document click.** The item's own handler runs first, so
  the action happens before the close. A new item that needs the menu to stay open must
  stop the event.

---

## 8. Testing

The test drives real Chrome through the DevTools protocol. It needs no packages.

```powershell
cd "C:\Users\Alir3za\Downloads\Music Player\V3"
node tools/browser-test.js
```

- Expected result: `67/67 checks passed` and `console errors: 0`.
- The test starts its own headless Chrome with its own profile under `tools/.tmp/`,
  so it never touches the songs in the real browser profile.
- It builds its own audio files in memory: a 2 s WAV, a 3 s WAV, and an MP3 with a
  real ID3v2.3 tag and a 1x1 PNG cover. That means the tag parsers are tested without
  shipping test files.
- It also checks that the library survives a reload, that the position is restored,
  that the visualizer paints pixels, that the mobile drawer opens, that `color-scheme`
  follows the theme, that the song menu moves a song with "Play next", that the speed
  drop-down sets the playback rate, and that a cover placeholder is a gradient with
  nothing drawn on top.
- It checks the row shape too: the title is the file name, the row has four cells, and
  there is no artist, album, or "showing N of M" line.
- It writes five screenshots into `tools/.tmp/`.
- If Chrome is elsewhere, set `CHROME` to the path.

When you add a feature, add a check to `tools/browser-test.js` in the same section as
the other checks. Keep the console-error counter at zero.

### Manual check before you call it done

1. Double-click `index.html`. Add a folder of real songs.
2. Play one, seek, then reload the page. The song and the position must come back,
   paused.
3. Switch to light theme, pick a different sort, favorite a song, reload. All three
   must survive.
4. Press `?` and walk the shortcut list.
5. Right-click a song in the list and in the queue drawer. Both menus must open, and
   "Play next" must move the song.
6. Resize to phone width and open the menu.

---

## 9. Style

- Two-space indent, semicolons, single quotes, trailing commas in multiline literals.
- One IIFE per file with `'use strict';` at the top.
- Comments explain **why**, not what. Section banners use the
  `/* ---------- name ---------- */` shape.
- Prefer a small named function over a long inline arrow.
- Keep the console clean: no leftover `console.log` in shipped code.
- Match the file you are editing. `ui.js` and `player.js` are the big ones; read the
  section header before you add to them.
