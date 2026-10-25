# dsh-novel-shelf

**Office-sloof reading**: keep a local txt novel in the DSH (DeepSeek Harness) right sidebar while you keep working on your project.

![plugin](https://img.shields.io/badge/dsh--plugin-4d6bfe)

![The "小说书架 / Novel Shelf" panel in the DSH right sidebar](docs/screenshot-right-panel.png)

![The whole DSH window with the "小说书架 / Novel Shelf" tab open in the right sidebar](docs/screenshot-full.png)

## What's new in v0.2.0

This release turns the AI reading companion into something you actually use, and fixes a few things that got in the way:

- **The companion is no longer hidden behind the panel**: the polling used to live inside the "AI 陪读" panel, so closing it stopped the polling and the avatar vanished. Now switching it on makes it **say something right away**, then keeps going on your chosen interval; the little character and its speech bubble stay in the corner while the panel is closed.
- **A floating character with a speech bubble** in the bottom-right corner of the reader.
- **Pick your own model**: the "模型" panel lists the providers registered inside DSH together with their models; pick one, or fill in your own **OpenAI-compatible endpoint + API key** (baseURL / apiKey / model id) and bill it to your own account.
- **Errors that say what is wrong**: instead of a bare "模型没有返回内容", you now get the **route** that failed and the **reason** (invalid key / not signed in / unknown model / quota), and a provider that is not configured yet shows its own error right in the panel.
- **Switching conversations no longer loses your page**: leaving for another session used to drop you back on the shelf; the open book is now remembered per session.
- **The reading position is restored across sessions**, and the progress file is written back reliably.

## Features

- **Right-sidebar reading**: opens as a native DSH right-sidebar tab — no new window, no app switch. Your project stays on screen while the novel rides along.
- **Local txt shelf**: add books by absolute path; the plugin only reads files, never uploads them.
- **Three books built in**: 《十日终焉》, 《我在精神病院学斩神》 and 《我不是戏神》 land on the shelf automatically the first time you open the sidebar — no file hunting, no path config. Remove them if you want; they stay removed.
- **Chapter splitting**: recognises `第 N 章 / 节 / 回 / 卷 / 篇` headings, with a length-based fallback.
- **Encoding detection**: UTF-8 / UTF-8 BOM / UTF-16LE / UTF-16BE / GB18030.
- **Full-text search**: matches within chapters and reports the chapter name plus a context snippet.
- **Reading progress**: chapter index and scroll ratio are written back and restored on reopen.
- **Five colour schemes**: white / eye-care green / sepia / dark grey / pure black, matching novel-reader's `body[data-theme]` names and colours.
- **Shares data with novel-reader**: reads and writes `books.json`, `settings.json` and `annotations/*.json` under `%APPDATA%/novel-reader`, so theme and progress stay in sync with the desktop app.
- **Zero runtime dependencies**: only Node built-ins and services the DSH host already provides. No third-party dependency. The plugin makes no network request of its own, except the AI companion you switch on yourself.
- **AI reading companion (off by default)**: once switched on, the AI roasts whatever you just read every few minutes, in four styles (roast / warm / detective / slacker), or on demand with "say it now". Switching it on makes it speak immediately — you do **not** have to open the panel first — and the companion character plus its speech bubble stay in the corner. Pick a model from the providers registered in DSH, or supply your own OpenAI-compatible endpoint and API key. Off means the model is never called. See [docs/ai-companion.md](docs/ai-companion.md).

### How the bundled books work

The bundle ships a `books/` directory (about 7.3 MB, three txt files). The plugin **never writes a machine-local `D:\...` absolute path into the shelf** — on another machine that path does not exist and the shelf breaks. So instead:

1. On the first shelf read (`library.get`), the host side checks which bundled books are missing from `books.json`.
2. The missing ones are **copied** out of the bundle's `books/` into `%APPDATA%/novel-reader/books/<title>.txt`.
3. That **in-data-dir copy path** is what goes into `books.json`, so the shelf shows them.

Three hard rules: idempotent (dedup by title, never added twice), never breaks the shelf (a failed copy only logs a `console.warn`), and **once you delete a bundled book it stays deleted** (its title is recorded in `removed-bundled.json`). Tests point the bundle directory at a sandbox via the `NOVEL_SHELF_BOOKS_DIR` environment variable, so the unit tests do not depend on the real novels in the repo.

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
3. **Three books are already there**: on the first open the bundled 《十日终焉》, 《我在精神病院学斩神》 and 《我不是戏神》 are copied out of the plugin and added to the shelf automatically. Click one to start reading right away.
4. **Add more books**: type the **absolute path** of a local txt file (e.g. `D:\books\foo.txt`) in the input box and press Enter. The title shows up in the list.
5. **Start reading**: click a title — the chapter text appears directly in the right sidebar.
6. **Navigate**: "上一章 / 下一章" switch chapters, the catalogue button next to the title opens the chapter list, and the search box runs a full-text search over the book (press Enter; a hit reports the chapter name plus a context snippet).
7. **Tune the page**: the bottom slider changes the font size, the five swatches switch the background (white / eye-care / sepia / dark grey / pure black).
8. **Progress is saved for you**: the chapter index and scroll ratio are written to `%APPDATA%/novel-reader/annotations/<id>.json`, so reopening lands you where you left off.
9. **Want the companion**: click **"AI 陪读"** at the bottom, flip the switch, and the first remark arrives right away; the companion character shows up in the corner and clicking it opens the bubble. The interval and the style live in the same panel.
10. **Change the model**: click **"模型"** at the bottom, pick one of the providers registered in DSH, or fill in your own OpenAI-compatible endpoint and API key. "测试" sends one real minimal request — a sample on success, and on failure it names the route and the reason. With nothing configured you get the DSH default model.

> The right sidebar is narrow — widen the window for a more comfortable reading column.

## How it works

Useful background if you want to modify the plugin yourself:

1. **Host half (`lib/host.js`)** registers a prefix route inside `ctx.effect()` with `ctx.webServer.register({kind:'prefix', path:'/novel-shelf/api'})`, exposing 19 methods: shelf `library.get` / `library.add` / `library.remove`, text `book.open` / `book.chapter` / `book.save` / `book.search`, settings `settings.save`, model `model.options` / `model.save` / `model.reset` / `model.test`, companion `companion.get` / `companion.config` / `companion.tick` / `companion.nudge` / `companion.clear`, plus `reader.session.get` / `reader.session.set` which remember the open page per session.
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
| `%APPDATA%/novel-reader/books/` | Local copies of the three bundled books (copied out of the bundle on first shelf read) |
| `%APPDATA%/novel-reader/removed-bundled.json` | Titles of bundled books you removed — they are never auto-installed again |
| `%APPDATA%/novel-reader/settings.json` | Theme, font size, line height, last read book |
| `%APPDATA%/novel-reader/annotations/<id>.json` | Highlights and reading progress per book |
| `%APPDATA%/novel-reader/plugin-client.log` | Runtime diagnostics of the client half (tags and counters only, no text) |

Windows uses `%APPDATA%`, macOS `~/Library/Application Support/novel-reader`, Linux `~/.config/novel-reader`.

When a JSON file is corrupt the plugin first backs it up as `*.corrupt-<timestamp>` and then falls back to an empty value — it never silently overwrites the original data.

## Privacy

- All data stays in the local plugin data directory. **With the AI companion off, the plugin makes no network request at all**; with it on, only the short passage you just read (about six paragraphs, 1200 characters at most) is sent to the one model provider you configured inside DSH — no third-party relay. If the text must not leave your machine, leave the switch off.
- The host route uses the official trust fence (`ctx.connection.requestRejection`) and rejects cross-site requests, so a bare command-line call is denied.
- Only `.txt` is accepted, request bodies are capped at 1 MiB, and the API method allow-list uses `Object.hasOwn` so prototype members cannot be reached.
- The companion log `%APPDATA%/novel-reader/plugin-client.log` records tags and counters only, never the text.

## Development

### Layout

```
lib/host.js            host half: file IO, encoding detection, chapter splitting, full-text search, JSON persistence, HTTP route, model catalog, companion
lib/client.js          client half: right-sidebar tab registration, shelf / reader / companion panel / model panel, five theme palettes
assets/reader-avatar.png  the companion character (floating in the corner, ~114 KB PNG)
books/                 the three bundled txt files (~7.3 MB, shipped with the bundle, copied to the data dir on first run)
locale/zh.json         Chinese strings
locale/en.json         English strings
docs/ai-companion.md    how the AI companion is configured and what it sends out
docs/screenshot-*.png  screenshots
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
dsh plugin --profile desktop add file:.\dsh-novel-shelf-0.2.0.tgz
```

After changing the client half, **refresh the page** before verifying. After changing the host half, reinstall the bundle.

### Cut a release

```sh
npm version patch
npm pack --pack-destination .
gh release upload v0.2.0 dsh-novel-shelf-0.2.0.tgz --repo good-saltfish/dsh-novel-shelf
```

Name the release asset with its version (`dsh-novel-shelf-<version>.tgz`) and reference it from the catalog entry with a pinned path `releases/download/v<version>/<asset>`, so `latest/download/` does not 404 on the next release.

### After submitting to the market: that red check will not clear on its own

`Submission gate` blocks repositories younger than one day. That is a hard rule and it passes once the day is up. But **the verdict is a snapshot, and it is only recomputed on push**.

There is a `regate.yml` that re-runs red gates every six hours, but it caps each pass at `MAX_RERUNS=20` and works through pull requests in ascending number order. Pull request numbers in this list are already past eight thousand and the queue is long, so yours is very likely beyond the cap — the "clears in about 24h" promise does not hold for a pull request at the tail, and the red just sits there with nothing pushing it.

So once the repository is a day old, **push an empty commit to your fork branch** to trigger a re-run:

```sh
git commit --allow-empty -m "chore: re-trigger the submission gate (repository is now a day old)"
git -c http.version=HTTP/1.1 push origin <branch>
```

The empty commit changes no file; it only asks CI to judge again. If the age bar is met the gate turns green at once and the PR moves from `UNSTABLE` to `CLEAN`.

If a push fails with `Recv failure: Connection was reset`, add `-c http.version=HTTP/1.1` — that fixes it in practice.

One more thing: merging is a maintainer's manual act. With everything green and no review, the PR is simply waiting in the queue, and a polite comment on the PR is the only legitimate way to move it along. Until the entry lands on upstream `main`, the market cannot find it — the market reads `data/plugins/*.yml`, and anything not on `main` is a 404.

## License

MIT
