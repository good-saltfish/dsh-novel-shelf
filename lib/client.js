/**
 * 小说阅读器插件（Client 半）。
 *
 * 骨架严格照抄 dsh-mattpocock-skills-deck 的 lib/client.js：
 *   window.__ModuleLoader__.load({ id, factory(require) })
 *   factory 内建 module/exports，末尾 `return module.exports`
 *   exports.inject 全部填 **真服务名**（slots / locale），座位名不是服务名
 *   exports.apply(ctx) 由框架调用
 *
 * 关键教训（前几版白踩）：
 *   - client ctx 上没有 ctx.inject（那是 Host 侧 API），调它会在 apply 里抛
 *     TypeError，整个 client 半边静默失败；等依赖要靠 exports.inject 声明。
 *   - factory 必须 return module.exports，否则 Loader 拿不到模块。
 */

window.__ModuleLoader__.load({
  id: 'dsh-novel-reader',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');

    const API_PREFIX = 'novel-reader/api';
    const NS = 'dshNovelReader';

    /** novel-reader 的五套配色：白 / 护眼绿 / 米黄 / 深灰 / 纯黑 */
    const THEMES = ['day', 'eye', 'sepia', 'dark', 'black'];

    /* ------------------------------------------------------------------ */
    /* 文案：自带字典（宿主只有一张 locale 表，翻不出自有命名空间的键）      */
    /* ------------------------------------------------------------------ */

    const MESSAGES = {
      zh: {
        title: '小说阅读器',
        shelf: '书架',
        empty: '书架是空的',
        emptyHint: '添加一个本地 txt 文件开始阅读。',
        add: '添加本地 txt',
        added: '已加入书架',
        addFailed: '加入书架失败',
        removing: '移除',
        removed: '已从书架移除（文件仍在磁盘上）',
        open: '打开',
        reading: '正在打开…',
        openFailed: '打开失败',
        notFound: '文件已被移动或删除',
        back: '返回书架',
        prev: '上一章',
        next: '下一章',
        chapters: '目录',
        chapterOf: '第 {i}/{n} 章',
        progress: '进度',
        search: '搜索',
        searchHint: '回车搜索全书',
        searching: '搜索中…',
        searchResults: '找到 {n} 处',
        searchEmpty: '没有找到',
        font: '字号',
        theme: '背景',
        themeDay: '白',
        themeEye: '护眼',
        themeSepia: '米黄',
        themeDark: '深灰',
        themeBlack: '纯黑',
        loading: '加载中…',
        emptyChapter: '这一章是空的',
        addPathPrompt: '输入 txt 文件的完整路径',
        error: '出错了',
      },
      en: {
        title: 'Novel Reader',
        shelf: 'Shelf',
        empty: 'The shelf is empty',
        emptyHint: 'Add a local txt file to start reading.',
        add: 'Add local txt',
        added: 'Added to the shelf',
        addFailed: 'Could not add to the shelf',
        removing: 'Remove',
        removed: 'Removed from the shelf (the file stays on disk)',
        open: 'Open',
        reading: 'Opening…',
        openFailed: 'Could not open',
        notFound: 'The file has been moved or deleted',
        back: 'Back to shelf',
        prev: 'Previous',
        next: 'Next',
        chapters: 'Contents',
        chapterOf: 'Chapter {i}/{n}',
        progress: 'Progress',
        search: 'Search',
        searchHint: 'Enter to search the whole book',
        searching: 'Searching…',
        searchResults: '{n} hits',
        searchEmpty: 'No hits',
        font: 'Font size',
        theme: 'Background',
        themeDay: 'White',
        themeEye: 'Eye care',
        themeSepia: 'Sepia',
        themeDark: 'Dark',
        themeBlack: 'Black',
        loading: 'Loading…',
        emptyChapter: 'This chapter is empty',
        addPathPrompt: 'Full path of a txt file',
        error: 'Something went wrong',
      },
    };

    let tr = MESSAGES.en;
    const setLanguage = (id) => { tr = MESSAGES[id] || MESSAGES.en; };
    function t(key, vars) {
      let out = tr[key] ?? key;
      if (vars) for (const name of Object.keys(vars)) out = out.split('{' + name + '}').join(String(vars[name]));
      return out;
    }

    const h = React.createElement;

    /* ------------------------------------------------------------------ */
    /* 宿主 API 客户端                                                     */
    /* ------------------------------------------------------------------ */

    /** 反代前缀下必须用去前导斜杠的相对路径，否则整条 404。 */
    function routeUrl(path) {
      return new URL(String(path).replace(/^\/+/, ''), new URL(document.baseURI, 'http://localhost'));
    }

    /**
     * 诊断通道：浏览器控制台读不到，把运行时信息落到插件数据目录的
     * plugin-client.log。host 半边的 client.log 接口负责落盘。
     * 任何一步失败都静默忽略 —— 诊断不能反过来搞崩插件。
     */
    function diag(tag, data) {
      try {
        const body = JSON.stringify({ tag, data });
        fetch(routeUrl(`${API_PREFIX}/client.log`), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          keepalive: true,
        }).catch(() => {});
      } catch (error) { /* 诊断失败不影响功能 */ }
    }

    async function call(method, payload) {
      const res = await fetch(routeUrl(`${API_PREFIX}/${method}`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {}),
      });
      const text = await res.text();
      let body;
      try { body = text === '' ? {} : JSON.parse(text); } catch { throw new Error(`HTTP ${res.status}`); }
      if (!body || body.ok !== true) {
        throw new Error((body && body.error && body.error.message) || `HTTP ${res.status}`);
      }
      return body.value;
    }

    /* ------------------------------------------------------------------ */
    /* 小组件                                                              */
    /* ------------------------------------------------------------------ */

    const PATHS = {
      book: 'M3 2.5h4.5A1.5 1.5 0 0 1 9 4v9.5H4.5A1.5 1.5 0 0 1 3 12zM9 4a1.5 1.5 0 0 1 1.5-1.5H13v9.5h-2.5A1.5 1.5 0 0 0 9 13.5z',
      back: 'M9.5 3.5 5 8l4.5 4.5M5 8h7',
      list: 'M3 4.5h10M3 8h10M3 11.5h10',
      trash: 'M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.6 8.5h4.8l.6-8.5',
      search: 'M7.2 11.9a4.7 4.7 0 1 0 0-9.4 4.7 4.7 0 0 0 0 9.4zM10.7 10.7 14 14',
    };

    function Icon({ name, size }) {
      const s = size || 14;
      return h('svg', {
        width: s, height: s, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
        children: h('path', { d: PATHS[name] || PATHS.book }),
      });
    }

    function Btn({ children, onClick, disabled, title, kind }) {
      return h('button', {
        type: 'button', className: `nr-btn${kind ? ' nr-btn-' + kind : ''}`,
        onClick, disabled: !!disabled, title, children,
      });
    }

    const fmtSize = (size) => {
      const n = Number(size) || 0;
      if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
      if (n >= 1024) return `${Math.round(n / 1024)} KB`;
      return `${n} B`;
    };

    /** 五个主题色板按钮，书架与阅读页共用。 */
    function ThemeSwatch({ theme, onPick }) {
      return h('div', { className: 'nr-themes', role: 'group', 'aria-label': t('theme') },
        THEMES.map((name) => h('button', {
          type: 'button',
          key: name,
          className: `nr-swatch nr-swatch-${name}${name === theme ? ' is-on' : ''}`,
          title: t('theme' + name[0].toUpperCase() + name.slice(1)),
          'aria-pressed': name === theme ? 'true' : 'false',
          onClick: () => onPick(name),
          children: h('span', { className: 'nr-swatch-dot', 'aria-hidden': true }),
        })));
    }

    /* ------------------------------------------------------------------ */
    /* 书架                                                                */
    /* ------------------------------------------------------------------ */

    function Shelf({ books, busy, onOpen, onAdd, onRemove, note, theme, onTheme }) {
      const [path, setPath] = React.useState('');
      const submit = async () => {
        const value = path.trim();
        if (!value) return;
        await onAdd(value);
        setPath('');
      };
      return h('div', { className: 'nr-pane' },
        h('div', { className: 'nr-toolbar' },
          h('span', { className: 'nr-title', children: t('shelf') }),
          h('span', { className: 'nr-count', children: String(books.length) }),
          ThemeSwatch({ theme, onPick: onTheme })),
        books.length === 0
          ? h('div', { className: 'nr-empty' },
            h('p', { children: t('empty') }),
            h('p', { className: 'nr-hint', children: t('emptyHint') }))
          : h('ul', { className: 'nr-list' }, books.map((book) => h('li', { key: book.id, className: 'nr-item' },
            h('button', {
              type: 'button', className: 'nr-item-main', disabled: busy,
              onClick: () => onOpen(book),
              children: h('span', { className: 'nr-item-name', children: book.name }),
            }),
            h('span', { className: 'nr-size', children: fmtSize(book.size) }),
            Btn({ title: t('removing'), kind: 'ghost', onClick: () => onRemove(book), children: h(Icon, { name: 'trash', size: 13 }) })))),
        h('div', { className: 'nr-add' },
          h('input', {
            className: 'nr-input', value: path, placeholder: t('addPathPrompt'),
            onChange: (e) => setPath(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') submit(); },
          }),
          Btn({ disabled: !path.trim(), onClick: submit, children: t('add') })),
        note ? h('p', { className: 'nr-hint', children: note }) : null);
    }

    /* ------------------------------------------------------------------ */
    /* 阅读视图                                                            */
    /* ------------------------------------------------------------------ */

    function Reader({ book, theme, onTheme, onBack }) {
      const progress = book.progress || {};
      const settings = book.settings || {};
      const [index, setIndex] = React.useState(progress.chapterIndex || 0);
      const [chapter, setChapter] = React.useState(null);
      const [toc, setToc] = React.useState(false);
      const [error, setError] = React.useState('');
      const [fontSize, setFontSize] = React.useState(settings.fontSize || 19);
      const [lineHeight, setLineHeight] = React.useState(settings.lineHeight || 1.9);
      const [query, setQuery] = React.useState('');
      const [results, setResults] = React.useState(null);
      const [searching, setSearching] = React.useState(false);
      const scrollRef = React.useRef(null);

      /* 主题由根组件持有，这里只转发；字号/行距仍即时写回 */
      const commitFont = async (nextSize, nextHeight) => {
        try {
          await call('settings.save', { fontSize: nextSize, lineHeight: nextHeight });
        } catch { /* 偏好保存失败不打断阅读 */ }
      };

      React.useEffect(() => {
        let cancelled = false;
        setChapter(null);
        setError('');
        call('book.chapter', { path: book.path, index })
          .then((value) => { if (!cancelled) setChapter(value); })
          .catch((err) => { if (!cancelled) setError(err.message); });
        return () => { cancelled = true; };
      }, [book.path, index]);

      // 恢复阅读位置 + 卸载时回写进度
      React.useEffect(() => {
        if (!chapter || !scrollRef.current) return;
        const el = scrollRef.current;
        const restore = progress.chapterIndex === index ? (progress.scrollRatio || 0) : 0;
        requestAnimationFrame(() => { el.scrollTop = el.scrollHeight * restore; });
        const save = () => {
          const ratio = el.scrollHeight > el.clientHeight
            ? Math.min(1, Math.max(0, el.scrollTop / (el.scrollHeight - el.clientHeight)))
            : 0;
          call('book.save', { path: book.path, progress: { chapterIndex: index, scrollRatio: ratio } })
            .catch(() => { /* 进度保存失败不打断阅读 */ });
        };
        window.addEventListener('beforeunload', save);
        return () => { window.removeEventListener('beforeunload', save); save(); };
      }, [book.path, index, chapter, progress.chapterIndex, progress.scrollRatio]);

      const runSearch = async () => {
        const keyword = query.trim();
        if (!keyword) return;
        setSearching(true);
        try {
          setResults((await call('book.search', { path: book.path, keyword, limit: 50 })).results);
        } catch (err) {
          setError(err.message);
        } finally {
          setSearching(false);
        }
      };

      const total = (book.chapters && book.chapters.length) || 1;
      return h('div', { className: 'nr-pane', 'data-theme': theme },
        h('div', { className: 'nr-toolbar' },
          Btn({ title: t('back'), kind: 'ghost', onClick: onBack, children: h(Icon, { name: 'back', size: 13 }) }),
          h('span', { className: 'nr-title', children: book.name }),
          Btn({
            title: t('chapters'), kind: toc ? 'on' : 'ghost',
            onClick: () => setToc((v) => !v),
            children: h(Icon, { name: 'list', size: 13 }),
          })),
        h('div', { className: 'nr-subbar' },
          Btn({ disabled: index <= 0, onClick: () => setIndex((i) => Math.max(0, i - 1)), children: t('prev') }),
          h('span', { className: 'nr-mid', children: t('chapterOf', { i: index + 1, n: total }) }),
          Btn({ disabled: index >= total - 1, onClick: () => setIndex((i) => Math.min(total - 1, i + 1)), children: t('next') }),
          h('span', { className: 'nr-hint', children: `${Math.round(((index + 1) / total) * 100)}%` })),
        toc
          ? h('div', { className: 'nr-toc' }, (book.chapters || []).map((c, i) => h('button', {
            type: 'button', key: `${i}-${c.title}`,
            className: `nr-toc-item${i === index ? ' is-current' : ''}`,
            onClick: () => { setIndex(i); setToc(false); },
            children: c.title,
          })))
          : null,
        h('div', { className: 'nr-searchbar' },
          h('input', {
            className: 'nr-input', value: query, placeholder: t('searchHint'),
            onChange: (e) => setQuery(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') runSearch(); },
          }),
          Btn({ disabled: searching || !query.trim(), onClick: runSearch, children: h(Icon, { name: 'search', size: 13 }) })),
        results
          ? h('div', { className: 'nr-results' },
            h('div', { className: 'nr-hint', children: results.length ? t('searchResults', { n: results.length }) : t('searchEmpty') }),
            results.map((r, i) => h('button', {
              type: 'button', key: `${r.chapterIndex}-${i}`, className: 'nr-result',
              onClick: () => { setIndex(r.chapterIndex); setResults(null); },
              children: r.chapterTitle,
            })))
          : null,
        error
          ? h('p', { className: 'nr-error', children: error })
          : chapter
            ? h('div', {
              className: 'nr-reader', ref: scrollRef,
              style: { fontSize: `${fontSize}px`, lineHeight: String(lineHeight) },
            },
            h('div', { className: 'nr-chapter', children: chapter.title }),
            chapter.paragraphs.length === 0
              ? h('p', { className: 'nr-hint', children: t('emptyChapter') })
              : chapter.paragraphs.map((p) => h('p', {
                key: p.index, className: `nr-p${p.meta ? ' nr-p-meta' : ''}`, children: p.text,
              })))
            : h('p', { className: 'nr-hint', children: t('loading') }),
        h('div', { className: 'nr-fontbar' },
          h('span', { className: 'nr-hint', children: t('font') }),
          h('input', {
            type: 'range', min: 14, max: 30, step: 1, value: fontSize, className: 'nr-range',
            onChange: (e) => {
              const next = Number(e.target.value);
              setFontSize(next);
              commitFont(next, lineHeight);
            },
          }),
          h('span', { className: 'nr-hint', children: t('theme') }),
          ThemeSwatch({ theme, onPick: onTheme }),
          h('span', { className: 'nr-hint', children: String(book.encoding || '') })));
    }

    /* ------------------------------------------------------------------ */
    /* 面板根                                                              */
    /* ------------------------------------------------------------------ */

    function ReaderTab() {
      const [library, setLibrary] = React.useState(null);
      const [open, setOpen] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [note, setNote] = React.useState('');
      /* 主题放在根上：书架与阅读页切换时不丢 */
      const [theme, setTheme] = React.useState('eye');

      React.useEffect(() => {
        let cancelled = false;
        call('library.get')
          .then((v) => {
            if (cancelled) return;
            setLibrary(v);
            if (v && v.settings && typeof v.settings.theme === 'string' && THEMES.includes(v.settings.theme)) {
              setTheme(v.settings.theme);
            }
          })
          .catch((e) => { if (!cancelled) setLibrary({ books: [] }); });
        return () => { cancelled = true; };
      }, []);

      /* 切换主题：本地先生效，失败回滚；同时写回与 novel-reader 共享的 settings.json */
      const onTheme = async (next) => {
        const previous = theme;
        setTheme(next);
        try {
          await call('settings.save', { theme: next });
        } catch (error) {
          setTheme(previous);
          setNote(error.message);
        }
      };

      const onOpen = async (entry) => {
        setBusy(true);
        setNote('');
        try {
          setOpen(await call('book.open', { path: entry.path }));
        } catch (e) {
          setNote(`${t('openFailed')}: ${e.message}`);
        } finally {
          setBusy(false);
        }
      };

      const onAdd = async (value) => {
        setBusy(true);
        try {
          const v = await call('library.add', { path: value });
          setLibrary((prev) => (prev ? { ...prev, books: v.books } : prev));
          setNote(t('added'));
        } catch (e) {
          setNote(`${t('addFailed')}: ${e.message}`);
        } finally {
          setBusy(false);
        }
      };

      const onRemove = async (entry) => {
        try {
          const v = await call('library.remove', { id: entry.id });
          setLibrary((prev) => (prev ? { ...prev, books: v.books } : prev));
          setNote(t('removed'));
        } catch (e) {
          setNote(`${t('error')}: ${e.message}`);
        }
      };

      if (!library) return h('div', { className: 'nr-pane', 'data-theme': theme }, h('p', { className: 'nr-hint', children: t('loading') }));
      // data-theme 必须在 Reader 自己那一层：Reader 返回的根节点就是 nr-pane
      if (open) return h(Reader, { book: open, theme, onTheme, onBack: () => setOpen(null) });
      return h('div', { className: 'nr-pane', 'data-theme': theme },
        h(Shelf, {
          books: library.books || [], busy, onOpen, onAdd, onRemove, note, theme, onTheme,
        }));
    }

    /* ------------------------------------------------------------------ */
    /* 样式（只用 --dsw-alias-* token + 本地类名）                          */
    /* ------------------------------------------------------------------ */

    const STYLE = `
/* ------------------------------------------------------------------ */
/* 主题变量：直接搬 novel-reader 的 body[data-theme] 五套配色，          */
/* 这样面板与 Electron 版看起来完全一致。                                */
/* ------------------------------------------------------------------ */
.nr-pane[data-theme="day"]{--n-bg:#ffffff;--n-panel:#f7f8fa;--n-elev:#fff;--n-hover:#eef1f5;--n-border:#e2e6ec;--n-text:#1f2328;--n-soft:#5b6570;--n-accent:#2f6f4e;--n-accent-soft:rgba(47,111,78,.12);}
.nr-pane[data-theme="eye"]{--n-bg:#dfeade;--n-panel:#d3e2d2;--n-elev:#e9f2e8;--n-hover:#c9dcc8;--n-border:#bcd4bb;--n-text:#243026;--n-soft:#4c5a4e;--n-accent:#2f6f4e;--n-accent-soft:rgba(47,111,78,.14);}
.nr-pane[data-theme="sepia"]{--n-bg:#f5ecd9;--n-panel:#ece0c8;--n-elev:#fbf5e6;--n-hover:#e4d6bb;--n-border:#dbc9a8;--n-text:#3b3222;--n-soft:#6b5c42;--n-accent:#8a6a2f;--n-accent-soft:rgba(138,106,47,.16);}
.nr-pane[data-theme="dark"]{--n-bg:#1b1e23;--n-panel:#21252b;--n-elev:#2a2f36;--n-hover:#2e343c;--n-border:#363d47;--n-text:#c8ced6;--n-soft:#8b949e;--n-accent:#7fb2ff;--n-accent-soft:rgba(127,178,255,.14);}
.nr-pane[data-theme="black"]{--n-bg:#000000;--n-panel:#0c0d0f;--n-elev:#15171a;--n-hover:#1c1f23;--n-border:#23262b;--n-text:#a9a9a9;--n-soft:#7a7a7a;--n-accent:#7fb2ff;--n-accent-soft:rgba(127,178,255,.14);}

.nr-pane{display:flex;flex-direction:column;height:100%;min-height:0;gap:8px;padding:10px 12px;
  box-sizing:border-box;font-family:var(--dsw-alias-font-family,system-ui,sans-serif);
  background:var(--n-bg,var(--dsw-alias-surface,#fff));
  color:var(--n-text,var(--dsw-alias-text-primary,#222));}
.nr-toolbar,.nr-subbar,.nr-searchbar,.nr-fontbar,.nr-add{display:flex;align-items:center;gap:6px;flex:none;flex-wrap:wrap;}
.nr-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600;}
.nr-count,.nr-size,.nr-hint,.nr-mid{font-size:11px;color:var(--n-soft);white-space:nowrap;}
.nr-mid{min-width:88px;text-align:center;}
.nr-btn{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:6px;cursor:pointer;
  font-size:12px;line-height:1.5;font-family:inherit;
  border:1px solid var(--n-border,#d4d4d4);background:var(--n-elev,var(--dsw-alias-surface,#fff));color:inherit;}
.nr-btn:hover:not(:disabled){background:var(--n-hover,#f2f2f2);}
.nr-btn:disabled{opacity:.45;cursor:default;}
.nr-btn-ghost{border-color:transparent;background:transparent;padding:3px 5px;}
.nr-btn-on{background:var(--n-accent,#2f6f4e);border-color:transparent;color:#fff;}
.nr-input{flex:1;min-width:0;padding:4px 8px;border-radius:6px;font-size:12px;font-family:inherit;
  border:1px solid var(--n-border,#d4d4d4);background:var(--n-elev,var(--dsw-alias-surface,#fff));color:inherit;}
.nr-list{list-style:none;margin:0;padding:0;flex:1;min-height:0;overflow:auto;}
.nr-item{display:flex;align-items:center;gap:6px;padding:2px 0;}
.nr-item-main{flex:1;min-width:0;text-align:left;border:0;cursor:pointer;
  padding:5px 4px;border-radius:6px;color:inherit;font-size:12.5px;font-family:inherit;
  background:var(--n-elev,transparent);}
.nr-item-main:hover:not(:disabled){background:var(--n-hover,#f2f2f2);}
.nr-item-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.nr-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;text-align:center;color:var(--n-soft);}
.nr-empty p{margin:0;font-size:13px;}
.nr-error{font-size:11.5px;color:#c0392b;margin:0;flex:none;}
.nr-toc{max-height:34%;overflow:auto;border:1px solid var(--n-border);border-radius:6px;padding:4px;flex:none;
  background:var(--n-panel);}
.nr-toc-item{display:block;width:100%;text-align:left;border:0;cursor:pointer;
  padding:3px 6px;border-radius:4px;font-size:11.5px;color:inherit;overflow:hidden;font-family:inherit;
  background:transparent;}
.nr-toc-item:hover{background:var(--n-hover);}
.nr-toc-item.is-current{background:var(--n-accent-soft);}
.nr-results{max-height:30%;overflow:auto;flex:none;border:1px solid var(--n-border);border-radius:6px;padding:4px;
  background:var(--n-panel);}
.nr-result{display:block;width:100%;text-align:left;border:0;cursor:pointer;
  padding:3px 6px;border-radius:4px;font-size:11.5px;color:inherit;font-family:inherit;background:transparent;}
.nr-result:hover{background:var(--n-hover);}
.nr-reader{flex:1;min-height:0;overflow:auto;padding:4px 2px 12px;
  font-family:var(--dsw-alias-font-family,system-ui,sans-serif);}
.nr-chapter{font-size:1em;font-weight:600;margin:0 0 .8em;}
.nr-p{margin:0 0 .55em;text-align:justify;}
.nr-p-meta{color:var(--n-soft);font-size:.85em;}
.nr-range{width:88px;accent-color:var(--n-accent);}
/* 主题色板：五个小圆点，点谁切谁 */
.nr-themes{display:inline-flex;gap:4px;align-items:center;}
.nr-swatch{width:16px;height:16px;padding:0;border-radius:50%;cursor:pointer;
  border:1px solid var(--n-border);background:var(--n-elev);line-height:0;}
.nr-swatch-dot{display:block;width:10px;height:10px;border-radius:50%;margin:2px auto;}
.nr-swatch-day .nr-swatch-dot{background:#ffffff;}
.nr-swatch-eye .nr-swatch-dot{background:#cfe2cd;}
.nr-swatch-sepia .nr-swatch-dot{background:#eadfc4;}
.nr-swatch-dark .nr-swatch-dot{background:#2a2f36;}
.nr-swatch-black .nr-swatch-dot{background:#000000;}
.nr-swatch:hover{background:var(--n-hover);}
.nr-swatch.is-on{border-color:var(--n-accent);box-shadow:0 0 0 2px var(--n-accent-soft);}
`;

    function installStyle() {
      if (typeof document === 'undefined') return;
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(NS)}]`)) return;
      const el = document.createElement('style');
      el.dataset.plugin = 'dsh-novel-reader';
      el.dataset.pluginCss = NS;
      el.textContent = STYLE;
      document.head.appendChild(el);
    }

    /* ------------------------------------------------------------------ */
    /* 右栏 tab 注册（与 deck 同构：先注册类型，再填两个 keyed 座位）          */
    /* ------------------------------------------------------------------ */

    /**
     * 右栏 tab 注册。
     *
     * 与 deck / agent-teams / guardian / better-sidebar 同构，三点必须齐：
     *   1) 等服务用 ctx.inject(['sidebarRightTabs'], cb)（运行时服务注入）。
     *      不能靠轮询 ctx.get —— 原生右栏先声明座位、后提供服务，
     *      按座位声明触发时会读到空服务，永久注册不上。
     *      也不能把 sidebarRightTabs 写进 exports.inject：它不在客户端
     *      Service 目录里，声明为硬依赖可能让整个 client 半边加载不了。
     *   2) slots.inject(seat, cb) 的 cb **必须 return 一个清理函数**，
     *      契约是 () => SlotInjectionEffect；只把 disposer 塞进数组、
     *      cb 返回 undefined → 座位拿不到 occupant，宿主显示
     *      「这类内容还没有可用的查看方式」占位。
     *   3) tab 类型 id 与 kind 是两个字符串，座位的 key 用 **id**。
     */
    // id 与 kind 的书写规范照抄 deck：
    //   deck  DECK_NATIVE_TYPE_ID = 'dsh-mattpocock-skills-deck/deck:map'  （座位 key 用它）
    //        DECK_NATIVE_TAB_KIND = 'dsh-mattpocock-skills-deck:deck-map'  （宿主按 kind 找类型）
    //   之前写反了（id 用 ':'、kind 用 '/'），宿主按 kind 反查类型时找不到，
    //   于是座位永远拿不到 occupant，右栏只显示占位。
    const TAB_TYPE_ID = 'dsh-novel-reader/reader';
    const TAB_KIND = 'dsh-novel-reader:reader';
    const TAB_ORDER = 35;

    function TabTitleCell() {
      return h('span', { className: 'nr-tab-title', children: t('title') });
    }

    /** 已注册的 tab 类型（用于幂等与清理）。 */
    let tabTypeDisposer = null;
    /** 每个座位只注一次。 */
    const injectedSeats = {};
    /** 座位注入的清理函数。 */
    const seatDisposers = [];

    function injectSeat(slots, seat, factory) {
      if (injectedSeats[seat]) return;
      injectedSeats[seat] = true;
      const dispose = slots.inject(seat, () => {
        // 座位回调必须返回清理函数，否则注入无效。
        const disposer = factory();
        return () => {
          if (typeof disposer === 'function') {
            try { disposer(); } catch (error) { /* 已注销 */ }
          }
        };
      });
      if (typeof dispose === 'function') seatDisposers.push(dispose);
    }

    function registerNativeTab(slots, tabs) {
      if (!(slots && typeof slots.register === 'function' && typeof slots.inject === 'function')) return false;
      if (!(tabs && typeof tabs.register === 'function')) return false;

      if (!tabTypeDisposer) {
        try {
          tabTypeDisposer = tabs.register({
            id: TAB_TYPE_ID,
            kind: TAB_KIND,
            title: () => t('title'),
            icon: () => h(Icon, { name: 'book', size: 14 }),
            priority: 'builtin',
            // guide 条目 id 必填：缺了它注册不报错，但宿主会把
            // entryId: undefined 传给 sidebar.right.tab.guide.entry（静默降级）。
            guide: [{
              id: TAB_TYPE_ID,
              order: TAB_ORDER,
              title: () => t('title'),
              icon: () => h(Icon, { name: 'book', size: 14 }),
            }],
          });
        } catch (error) {
          console.warn('[dsh-novel-reader] tab type registration refused:', error);
          tabTypeDisposer = null;
          return false;
        }
      }
      if (!tabTypeDisposer) return false;

      injectSeat(slots, 'sidebar.right.pane.tab', () => slots.register(
        { name: 'sidebar.right.pane.tab', key: TAB_TYPE_ID, inject: (sessionId) => ({ sessionId }) },
        ReaderTab,
      ));
      injectSeat(slots, 'sidebar.right.pane.tab.title', () => slots.register(
        { name: 'sidebar.right.pane.tab.title', key: TAB_TYPE_ID },
        TabTitleCell,
      ));
      return true;
    }

    /**
     * 安全地从一个 ctx 上取属性。
     *
     * 关键：cordis 的 fiber ctx 是代理，未 inject 的属性访问会直接抛
     * `cannot get property "x" without inject`。所以每一次属性读取都必须
     * 单独包 try —— 之前 `source.register` 这类探测裸奔在回调里抛错，
     * 被宿主静默吞掉，表现为「注册从未发生」且没有任何日志。
     */
    function safeGet(source, key) {
      if (!source) return undefined;
      try {
        const value = source[key];
        if (value !== undefined && value !== null) return value;
      } catch (error) { /* 该服务未 inject 到当前 fiber */ }
      return undefined;
    }

    /** 取可选服务：宿主 get 实现差异大（有的支持第二个 optional 参数，有的没有）。 */
    function optionalService(source, key) {
      if (!source) return undefined;
      const direct = safeGet(source, key);
      if (direct) return direct;
      if (typeof source.get !== 'function') return undefined;
      try {
        const value = source.get(key, false);
        if (value !== undefined && value !== null) return value;
      } catch (error) {
        try {
          const value = source.get(key);
          if (value !== undefined && value !== null) return value;
        } catch (error2) { /* 服务不存在 */ }
      }
      return undefined;
    }

    /**
     * 从注入回调的 fiber ctx 取 tabs，从外层 ctx 取 slots。
     *
     * 注入回调拿到的 fiber 只 inject 了 ['sidebarRight','sidebarRightTabs']，
     * 所以 slots 必须在**外层 ctx**（exports.inject 里有 'slots'）取；
     * 反过来 tabs 只能从注入 fiber 取（外层没 inject 它）。
     */
    function findTabs(injected, outerCtx) {
      const fromInjected = safeGet(injected, 'sidebarRightTabs');
      if (fromInjected && typeof fromInjected.register === 'function') return fromInjected;
      const fromOuter = optionalService(outerCtx, 'sidebarRightTabs');
      if (fromOuter && typeof fromOuter.register === 'function') return fromOuter;
      return null;
    }

    /** 从任意 ctx 取 slots / tabs 并注册；成功返回 true。 */
    function registerFrom(source, fallbackCtx) {
      const slots = safeGet(fallbackCtx, 'slots') || optionalService(fallbackCtx, 'slots');
      const tabs = findTabs(source, fallbackCtx);
      if (!tabs) {
        diag('tabs-not-found', {
          injectedHasTabs: !!safeGet(source, 'sidebarRightTabs'),
          outerHasSlots: !!slots,
        });
        return false;
      }
      const ok = registerNativeTab(slots, tabs);
      diag('register-attempt', { ok, hasSlots: !!slots, hasTabs: !!tabs });
      if (ok) console.info('[dsh-novel-reader] right-sidebar tab registered');
      return ok;
    }

    exports.name = 'dsh-novel-reader';
    // 只写真服务名。slots / locale 是真服务；座位名不是服务名。
    exports.inject = ['slots', 'locale'];

    exports.apply = function apply(ctx) {
      installStyle();
      diag('apply', {
        ctxKeys: Object.keys(ctx).join(','),
        hasInject: typeof ctx.inject === 'function',
        hasGet: typeof ctx.get === 'function',
        hasEffect: typeof ctx.effect === 'function',
        hasSlots: !!optionalService(ctx, 'slots'),
        hasLocale: !!optionalService(ctx, 'locale'),
      });

      const locale = optionalService(ctx, 'locale');
      if (locale && typeof locale.getSnapshot === 'function') {
        setLanguage(locale.getSnapshot().active || 'en');
        if (typeof locale.subscribe === 'function') {
          locale.subscribe(() => setLanguage(locale.getSnapshot().active || 'en'));
        }
      }

      let done = false;

      // 首选：运行时服务注入。原生右栏提供 sidebarRightTabs 时才注册。
      // agent-teams 一次 inject 两个服务名（sidebarRight / sidebarRightTabs），
      // 这里照抄，避免只等一个服务名导致回调不触发。
      // 注意：ctx.inject 必须在 apply 顶层调用（与 agent-teams 一致），
      // 放进 ctx.effect 里会让新 fiber 跟着 effect 一起被回收。
      if (typeof ctx.inject === 'function') {
        try {
          ctx.inject(['sidebarRight', 'sidebarRightTabs'], (injected) => {
            // 整段包 try：cordis 对未 inject 的属性访问会抛错，
            // 之前裸奔在这里抛错被宿主吞掉 → 注册从未发生、也无日志。
            try {
              const hasTabs = !!safeGet(injected, 'sidebarRightTabs');
              const hasRight = !!safeGet(injected, 'sidebarRight');
              diag('inject-fired', { hasTabs, hasRight });
              if (registerFrom(injected, ctx)) {
                done = true;
              }
            } catch (error) {
              diag('inject-callback-threw', { message: String(error && error.message) });
              console.warn('[dsh-novel-reader] register inside inject callback failed:', error);
            }
          });
        } catch (error) {
          diag('inject-threw', { message: String(error && error.message) });
          console.warn('[dsh-novel-reader] ctx.inject for sidebarRightTabs failed:', error);
        }
      } else {
        diag('no-ctx-inject', {});
      }

      // tab 类型与两个 keyed 座位的注册，统一在 ctx.effect 里，宿主保证
      // 卸载时按注册序反解绑。
      ctx.effect(() => {
        // 兜底：老宿主没有 ctx.inject，或服务尚未到达 —— 每秒试一次，最多 30 次。
        let tries = 0;
        const timer = setInterval(() => {
          if (done) { clearInterval(timer); return; }
          tries += 1;
          if (registerFrom(ctx, ctx)) {
            done = true;
            clearInterval(timer);
          } else if (tries >= 30) {
            clearInterval(timer);
            diag('gave-up', { tries });
            console.warn('[dsh-novel-reader] sidebarRightTabs never became available');
          }
        }, 1000);

        return () => {
          clearInterval(timer);
          for (const dispose of seatDisposers.splice(0)) {
            try { dispose(); } catch (error) { /* 已注销 */ }
          }
          if (tabTypeDisposer) {
            try { tabTypeDisposer(); } catch (error) { /* 已注销 */ }
            tabTypeDisposer = null;
          }
          for (const seat of Object.keys(injectedSeats)) delete injectedSeats[seat];
        };
      }, 'dsh-novel-reader: right tab');
    };

    return module.exports;
  },
});