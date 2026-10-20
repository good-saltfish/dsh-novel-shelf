# dsh-novel-shelf

Read local txt novels inside the DSH (DeepSeek Harness) right sidebar.

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

```sh
dsh plugin --profile desktop add good-saltfish/dsh-novel-shelf
```

Or from a checkout:

```sh
git clone https://github.com/good-saltfish/dsh-novel-shelf
dsh plugin --profile desktop add link:<repo path>
```

**Refresh the DSH page** after installing (the client half loads with the page); a "小说书架 / Novel Shelf" tab then appears in the right sidebar.

## Usage

1. Open the "小说书架" tab in the right sidebar — the shelf.
2. Type the **absolute path** of a local txt file (e.g. `D:\books\foo.txt`) and press Enter to add it.
3. Click a title to read. The top bar switches chapters, toggles the table of contents and searches the book; the bottom bar adjusts font size and background.

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

```sh
npm test        # host-half unit tests + client-half interaction smoke test (self-contained minimal React stub)
```

- `lib/host.js` — host half: file IO, encoding detection, chapter splitting, full-text search, JSON persistence, HTTP route.
- `lib/client.js` — client half: right-sidebar tab registration, shelf and reader components, five theme palettes.
- `test/hosttest.mjs`, `test/smoke.mjs` — run without a DSH runtime.

## License

MIT
