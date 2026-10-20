# dsh-novel-shelf

Read local txt novels inside the DSH (DeepSeek Harness) right sidebar.

![plugin](https://img.shields.io/badge/dsh--plugin-4d6bfe)

![The "小说书架 / Novel Shelf" panel in the DSH right sidebar](docs/screenshot-right-panel.png)

## Features

- **Right-sidebar reading**: opens as a native DSH right-sidebar tab — no new window, no app switch.
- **Local txt shelf**: add books by absolute path; the plugin only reads files, never uploads them.
- **Chapter splitting**: recognises `第 N 章 / 节 / 回 / 卷 / 篇` headings, with a length-based fallback.
- **Encoding detection**: UTF-8 / UTF-8 BOM / UTF-16LE / UTF-16BE / GB18030.
- **Full-text search**: matches within chapters and reports the chapter name plus a context snippet.
- **Reading progress**: chapter index and scroll ratio are written back and restored on reopen.
- **Five colour schemes**: white / eye-care green / sepia / dark grey / pure black, matching novel-reader's `body[data-theme]` names and colours.
- **Shares data with novel-reader**: reads and writes `books.json`, `settings.json` and `annotations/*.json` under `%APPDATA%/novel-reader`, so theme and progress stay in sync with the desktop app.
- **Zero runtime dependencies**: only Node built-ins and services the DSH host already provides. No third-party dependency, no network request.

## Install

### Option 1: plugin market (recommended)

Search `dsh-novel-shelf` in the DSH plugin market and click install.

### Option 2: command line

```sh
dsh plugin --profile desktop add good-saltfish/dsh-novel-shelf
```

### Option 3: from a checkout

```sh
git clone https://github.com/good-saltfish/dsh-novel-shelf
dsh plugin --profile desktop add link:<repo path>
```

### Option 4: manual tarball

Download `dsh-novel-shelf-<version>.tgz` from [Releases](https://github.com/good-saltfish/dsh-novel-shelf/releases), then:

```sh
dsh plugin --profile desktop add file:<tgz path>
```

> **Refresh the DSH page after installing.** The plugin's client half loads with the page; neither an install nor an upgrade hot-swaps an already loaded module. After the refresh a "小说书架 / Novel Shelf" tab appears in the right sidebar.

## Usage steps

1. **Open the right sidebar**: click the right-column button in the top-right of the DSH window.
2. **Pick the "小说书架" tab**: choose it in the tab bar at the top of the right sidebar to reach the shelf.
3. **Add a book**: type the **absolute path** of a local txt file (e.g. `D:\books\foo.txt`) in the input box and press Enter. The title shows up in the list.
4. **Start reading**: click a title — the chapter text appears directly in the right sidebar.
5. **Navigate**: "上一章 / 下一章" switch chapters, the catalogue button next to the title opens the chapter list, and the search box runs a full-text search over the book (press Enter; a hit reports the chapter name plus a context snippet).
6. **Tune the page**: the bottom slider changes the font size, the five swatches switch the background (white / eye-care / sepia / dark grey / pure black).
7. **Progress is saved for you**: the chapter index and scroll ratio are written to `%APPDATA%/novel-reader/annotations/<id>.json`, so reopening lands you where you left off.

> The right sidebar is narrow — widen the window for a more comfortable reading column.

## How it works

Useful background if you want to modify the plugin yourself:

1. **Host half (`lib/host.js`)** registers a prefix route inside `ctx.effect()` with `ctx.webServer.register({kind:'prefix', path:'/novel-shelf/api'})`, exposing 8 methods: `library.get` / `library.add` / `library.remove` / `book.open` / `book.chapter` / `book.save` / `settings.save` / `book.search`.
2. **Every request passes a trust fence first**: `ctx.connection.requestRejection(req)` decides whether the call comes from a trusted browser session (a bare command-line call is always 403), backed by a `Sec-Fetch-Site` cross-site rejection. Method names are allow-listed with `Object.hasOwn(api, method)` so prototype members such as `POST /novel-shelf/api/constructor` cannot be reached. Request bodies are capped at 1 MiB.
3. **The host half does the real IO**: disk reads, encoding detection, chapter splitting, full-text search and JSON persistence (write to a temp file then rename; a corrupt JSON is first backed up as `*.corrupt-<timestamp>` and then falls back instead of being silently overwritten). Paths are always normalised with `path.resolve`.
4. **Client half (`lib/client.js`)** mounts through `window.__ModuleLoader__.load({id:'dsh-novel-shelf', factory})`. It first calls `ctx.inject(['sidebarRight','sidebarRightTabs'], ...)` to obtain the right-sidebar tab registry, registers a tab type (`id = dsh-novel-shelf/reader`, `kind = dsh-novel-shelf:reader`), then occupies two keyed slots through `ctx.slots.inject('sidebar.right.pane.tab', ...)` (body and title).
5. **A slot injection callback must return a cleanup function** — otherwise the host never occupies the slot and the panel degrades to the host placeholder "这类内容还没有可用的查看方式" ("this kind of content has no viewer yet"). This is the most common pitfall when writing a DSH right-sidebar plugin.
6. **The panel calls the API**: the client builds `novel-shelf/api/<method>` (leading slash removed, resolved against `document.baseURI`), POSTs JSON, and receives `{ok:true,value}` or `{ok:false,error}`.
7. **Settings are shared**: theme, font size and line height are written to `%APPDATA%/novel-reader/settings.json`, which the novel-reader desktop app also reads, so the two stay in sync.

## Data layout

| File | Content |
| --- | --- |
| `%APPDATA%/novel-reader/books.json` | Shelf (path, name, size, added time) |
| `%APPDATA%/novel-reader/settings.json` | Theme, font size, line height, last read book |
| `%APPDATA%/novel-reader/annotations/<id>.json` | Highlights and reading progress per book |
| `%APPDATA%/novel-reader/plugin-client.log` | Runtime diagnostics of the client half (tags and counters only, no text) |

Windows uses `%APPDATA%`, macOS `~/Library/Application Support/novel-reader`, Linux `~/.config/novel-reader`.

When a JSON file is corrupt the plugin first backs it up as `*.corrupt-<timestamp>` and then falls back to an empty value — it never silently overwrites the original data.

## Privacy

- All data stays in the local plugin data directory; the plugin makes no network request.
- The host route uses the official trust fence (`ctx.connection.requestRejection`) and rejects cross-site requests, so a bare command-line call is denied.
- Only `.txt` is accepted, request bodies are capped at 1 MiB, and the API method allow-list uses `Object.hasOwn` so prototype members cannot be reached.

## Development

### Layout

```
lib/host.js            host half: file IO, encoding detection, chapter splitting, full-text search, JSON persistence, HTTP route
lib/client.js          client half: right-sidebar tab registration, shelf and reader components, five theme palettes
locale/zh.json         Chinese strings
locale/en.json         English strings
test/hosttest.mjs      host-half unit tests
test/smoke.mjs         client-half interaction smoke test (self-contained minimal React stub)
screenshots.json       plugin-market screenshot declaration
```

### Run the tests

```sh
npm test        # host-half unit tests + client-half interaction smoke test (self-contained minimal React stub, no DSH runtime needed)
```

### Pack and install locally

```sh
npm pack --pack-destination .
dsh plugin --profile desktop add file:.\dsh-novel-shelf-0.1.0.tgz
```

After changing the client half, **refresh the page** before verifying. After changing the host half, reinstall the bundle.

### Cut a release

```sh
npm version patch
npm pack --pack-destination .
gh release upload v0.1.1 dsh-novel-shelf-0.1.1.tgz --repo good-saltfish/dsh-novel-shelf
```

Name the release asset with its version (`dsh-novel-shelf-<version>.tgz`) and reference it from the catalog entry with a pinned path `releases/download/v<version>/<asset>`, so `latest/download/` does not 404 on the next release.

## License

MIT
