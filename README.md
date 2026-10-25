# Aurora — Local Music Player

A small music player that runs from one file. There is no server, no install, and no
build step. You open `index.html` and the app works. Nothing is uploaded, and no
internet is needed.

Your songs are copied into your own browser storage. The library, the last song, the
playback position, the volume, and your settings all come back after a reload.

## ⚠️ Important note

> **This project was built entirely with AI.** I only gathered the pieces and put them
> together, so that I and anyone else can use it. I make no claim about writing or
> designing the code. Use it, change it, and share it as you like.

## Who is this for?

For anyone who wants to play their own music files without installing an app, without
making an account, and without sending a single byte to a server.

This is not a music streaming service. It is a small player for the files you already
own. Add a folder, and the app keeps a copy of the songs inside your browser. Your
original files on disk are never changed, moved, or deleted.

## Features

- 📚 **Library views** — All songs and Favorites, each with a count.
- 🔎 **Search** — type words in any order. The app matches them against the song name.
- 🔤 **6 sort modes** — newest, oldest, name A–Z, name Z–A, shortest, longest.
- 🖱️ **Right-click menu** — right-click any song to play it next, favorite it, or
  remove it. The same menu works inside the queue drawer.
- ❤️ **Favorites** — one click on the heart, in the list or in the player bar.
- 🎧 **Queue** — the queue button shows the play order. The queue holds every song
  that is visible right now, so search and sort change the order.
- 🎚️ **Now playing** — click the cover in the player bar for a full view with a live
  audio visualizer.
- 🔊 **Volume read-out** — the exact percentage appears above the slider knob while the
  pointer is over it, and follows the knob while dragging.
- 🅰️ **Vazirmatn font** — Persian and Arabic text render correctly. The font ships
  with the app, so it works offline.
- 🗂️ **Playing queue view** — a third sidebar tab shows the play order, with drag
  handles to reorder it.
- 🔀 **Drag to reorder** — grab the grip on a queue row (or press Arrow Up / Down on
  it) to change the play order. Works in the queue drawer too.
- ⌨️ **Media keys** — the play, pause, next, and previous keys on your keyboard work.
  The song name also shows in the system media panel.
- 🌗 **Themes** — dark and light. The app follows your system theme on the first run.
- 🧹 **Remove and clear** — remove one song from its row, or clear the whole library
  from the sidebar. Both ask for confirmation first.
- 📱 **Responsive** — the sidebar becomes a drawer on a phone, and the list shows only
  the name and the time.

## How to use

1. Download this repository (the green **Code** button → **Download ZIP**), and unzip
   it somewhere you keep your files.
2. Keep the folder together. `index.html` reads `css/`, `js/`, and `assets/`. Copying
   only `index.html` breaks the app.
3. Double-click `index.html`.
4. Add your songs from the sidebar, and press play.

If the file opens in the wrong program, right-click it, choose **Open with**, and pick
Chrome or Edge.

On Windows you can also make a desktop shortcut to `index.html`, so it opens with one
click.

There is no server and no internet. Browsers block ES modules on `file://`, so the code
uses plain scripts instead. The Inter font also ships in `assets/fonts/`, so the page
looks the same offline.

## How to add songs

You have three ways:

- **Add music** — opens a file picker. You can select many files at once.
- **Add folder** — pick a folder. Every audio file inside it is added, including the
  files in its subfolders.
- **Drag and drop** — drag files or a whole folder onto the window.

Adding a song copies its bytes into browser storage. Your original files on disk stay
where they are, so you can delete the app folder at any time and your music is still
safe.

A file is skipped when its **name and size** match a song that is already in the
library. Adding the same folder twice is therefore safe.

## Where your songs live

This is the part to read carefully.

Songs are stored in **your browser profile**, not in a folder you can open. They are in
**IndexedDB**, and the settings are in **localStorage**. Both belong to the browser and
the Windows user account, not to the app folder.

Three results follow from that:

1. **Clearing site data deletes your songs.** If you clear cookies and site data, or
   use a "clean up" tool, the library is gone from the app. If the app folder is still
   there, you add the songs again from your disk.
2. **Another browser is a different library.** Chrome, Edge, and Firefox each keep
   their own copy. Opening `index.html` in Edge does not show the songs you added in
   Chrome.
3. **All local pages share one storage area.** Chrome treats every `file://` page as
   one origin, so another local HTML file could in theory reach this data. The app
   marks all of its keys with the `aurora.v3.` prefix to avoid name clashes.

There is a **Browser storage** bar in the sidebar. It shows how much space the songs
use. The limit is a share of your free disk space, and the bar warns you before it
fills. The app asks the browser to keep this data when the disk gets tight, but the
browser may say no. That answer is normal and harmless.

The app stores a small thumbnail and the cover image with each song, so the number in
that bar is a little bigger than the size of your audio files.

> Back up your music files. The app is a player, not a backup tool.

## Supported formats

MP3, M4A, M4B, MP4, AAC, FLAC, WAV, WAVE, OGG, OGA, OPUS, WEBA, WEBM, AIF, AIFF.

The app reads the tags by itself, so there is no library to download:

- **MP3** — ID3v2.2, ID3v2.3, ID3v2.4, and ID3v1.
- **FLAC** — Vorbis comments and the `PICTURE` block.
- **M4A / MP4** — `ilst` atoms.

Only the **cover picture** is used from the tags. The song name is always the **file
name** without its extension, exactly as it is on your disk. Artist, album, year, and
track number are ignored on purpose, so a wrong tag can never rename your file.

A song without a cover gets a plain gradient. The color comes from the file name, so
the same song always looks the same.

Which format actually plays depends on your browser. Chrome and Edge play all of the
list above. Firefox does not play some AAC or M4A files.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` or `K` | Play or pause |
| `N` / `P` | Next / previous song |
| `→` / `←` | Seek 5 seconds (hold `Shift` for 20) |
| `↑` / `↓` | Volume up / down |
| `M` | Mute |
| `F` | Favorite the current song |
| `S` / `R` | Shuffle / repeat mode |
| `Q` | Open the queue |
| Right-click | Open the song menu (play next, favorite, remove) |
| `/` | Focus the search box |
| `T` | Switch theme |
| `?` | Show this list inside the app |
| `Esc` | Close the panel or the dialog |

## First play needs one click

Browsers block sound until you interact with the page. This is why the app restores
your last song **paused** at the saved position. Press `Space` or the play button once,
and playback starts.

## What the app remembers

- The song list, with the duration and the added date.
- Favorites.
- The last song and the playback position.
- The volume and the mute state.
- The shuffle and repeat mode.
- The play order (the queue) at the moment you closed the page.
- The current view, the sort mode, and the theme.

The search box starts empty again after a reload.

## File structure

```text
V3/
  index.html          the page, the icon sprite, and the dialogs
  README.md           this file
  AGENTS.md           notes for people (and tools) who change the code
  css/
    styles.css        theme tokens, layout, responsive rules
  js/
    util.js           small helpers: DOM, icons, time, thumbnails
    db.js             IndexedDB wrapper (tracks, files, art)
    tags.js           ID3, FLAC, and MP4 readers (only the cover is used)
    player.js         the audio engine, queue, shuffle, repeat, Media Session
    library.js        import pipeline, search, sort, duplicates
    ui.js             rendering, events, menu, visualizer, shortcuts
    app.js            startup and state saving
  assets/
    fonts/            Inter, self-hosted, so it works offline
  tools/
    browser-test.js   headless browser test, for development only
```

`tools/.tmp/` is created by the test. You can delete it any time.

The files in `js/` are plain scripts, not modules. They share globals (`U`, `DB`,
`Tags`, `Player`, `Library`, `UI`), so **the order of the `<script>` tags matters**.
`AGENTS.md` explains why and lists the order.

## Known limits

- Songs belong to one browser profile. Use **Add folder** again to rebuild the library
  on another computer or in another browser.
- The library can be slow to build with thousands of songs, because each file is read
  and copied in turn.
- A file the browser cannot decode still shows in the list, but it will not play.
- The first play always needs one click or key press. The app never autoplays.

## License

Free to use, change, and share. It was made for learning and for personal use, and it
comes with no warranty.
