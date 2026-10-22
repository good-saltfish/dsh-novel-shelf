'use strict';

/**
 * 小说阅读器插件（Host 半）。
 *
 * 与 novel-reader Electron 应用共用同一份数据目录（%APPDATA%\novel-reader），
 * 因此书架 / 批注 / 阅读进度双向兼容。本半边只负责文件 IO、编码探测、
 * 章节切分、全文检索、JSON 落盘，不做任何渲染。
 *
 * 内置书目：bundle 里的 books/ 目录随插件一起分发，首次读取书架时复制到
 * 数据目录再注入书架，所以任何机器装上就有这三本可读。
 */

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-novel-shelf';
export const inject = ['webServer', 'connection'];

const API_PREFIX = '/novel-shelf/api';
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * 插件自带的书目（bundle 内的 books/ 目录）。
 *
 * 目标：任何人装上插件，书架里天然就有这三本，不需要填绝对路径。
 * 但**不能**把本机的 D:\... 绝对路径写进 books.json —— 换台机器路径不存在，
 * 书架会直接坏掉。所以做法是：首次读取书架时，把 bundle 内的书复制到
 * 插件数据目录的 books/ 下，再把那份副本的路径写进书架。
 */
const BUNDLED_BOOKS = [
  '十日终焉 - 杀虫队队员.txt',
  '我在精神病院学斩神 - 三九音域.txt',
  '我不是戏神 - 三九音域.txt',
];

/** bundle 自身根目录（host.js 位于 <root>/lib/host.js）。 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 测试可用环境变量把 bundle 目录指到别处，避免单测依赖真实仓库里的书。 */
function bundledBooksDir() {
  const override = process.env.NOVEL_SHELF_BOOKS_DIR;
  return override ? path.resolve(override) : path.join(PACKAGE_ROOT, 'books');
}

/** novel-reader 的五套配色，与 body[data-theme] 一一对应。 */
const THEMES = ['day', 'eye', 'sepia', 'dark', 'black'];

/* -------------------------------------------------------------------------- */
/* 错误                                                                        */
/* -------------------------------------------------------------------------- */

class ReaderError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'ReaderError';
    this.code = code;
    this.status = status == null ? 400 : status;
  }
}

/* -------------------------------------------------------------------------- */
/* 数据目录                                                                    */
/* -------------------------------------------------------------------------- */

function dataDir() {
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'novel-reader');
  }
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'novel-reader');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'novel-reader');
}

const booksFile = () => path.join(dataDir(), 'books.json');
const settingsFile = () => path.join(dataDir(), 'settings.json');
const annotationFile = (id) => path.join(dataDir(), 'annotations', id + '.json');
/** 用户主动移除的内置书目名，避免下次又被自动装回来。 */
const removedBundledFile = () => path.join(dataDir(), 'removed-bundled.json');

function bookIdOf(filePath) {
  return createHash('md5').update(path.resolve(filePath)).digest('hex').slice(0, 16);
}

/* -------------------------------------------------------------------------- */
/* 编码探测与章节切分（移植 novel-reader/src/js/parser.js）                     */
/* -------------------------------------------------------------------------- */

const CHAPTER_RE = /^[ \t　]*(第\s*[0-9零一二三四五六七八九十百千万两]{1,12}\s*[章节回卷篇][^\n]{0,40})$/gm;
const META_PREFIXES = ['章节更新时间', '更新时间', '本章字数', '字数：', '（本章完）', '(本章完)'];

function decodeBuffer(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), encoding: 'UTF-8 (BOM)' };
  }
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'UTF-16LE' };
  }
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'UTF-16BE' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'UTF-8' };
  } catch {
    return { text: new TextDecoder('gb18030').decode(buf), encoding: 'GB18030' };
  }
}

function parseMeta(head) {
  const pick = (label) => {
    const m = head.match(new RegExp(label + '\\s*[：:]\\s*(.+)'));
    return m ? m[1].trim() : undefined;
  };
  const meta = {};
  meta.title = pick('书名');
  meta.author = pick('作者');
  meta.status = pick('连载状态');
  meta.words = pick('字数');
  meta.chapters = pick('章节数');
  const intro = head.match(/【简介】([\s\S]{0,800})/);
  if (intro) {
    meta.intro = intro[1].split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 6).join('\n');
  }
  return meta;
}

function splitChapters(text) {
  const marks = [];
  CHAPTER_RE.lastIndex = 0;
  let m;
  while ((m = CHAPTER_RE.exec(text)) !== null) {
    marks.push({ title: m[1].trim().replace(/\s+/g, ' '), index: m.index });
  }
  if (marks.length >= 3) {
    const chapters = [];
    if (marks[0].index > 0 && text.slice(0, marks[0].index).trim().length > 0) {
      chapters.push({ title: '书籍信息 · 简介', start: 0, end: marks[0].index });
    }
    for (let i = 0; i < marks.length; i += 1) {
      const start = marks[i].index;
      const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
      chapters.push({ title: marks[i].title, start, end });
    }
    return chapters;
  }
  const chapters = [];
  const lines = text.split(/\r?\n/);
  let buffer = [];
  let cursor = 0;
  let blockStart = 0;
  let length = 0;
  const flush = () => {
    if (!buffer.length) return;
    chapters.push({
      title: '第 ' + (chapters.length + 1) + ' 段',
      start: blockStart,
      end: cursor,
    });
    buffer = [];
    length = 0;
  };
  for (const line of lines) {
    if (!buffer.length) blockStart = cursor;
    buffer.push(line);
    length += line.length + 1;
    cursor += line.length + 1;
    if (length >= 1500) flush();
  }
  flush();
  return chapters.length ? chapters : [{ title: '全文', start: 0, end: text.length }];
}

const toParagraphs = (raw) => raw
  .split(/\r?\n/)
  .map((s) => s.replace(/[\s　]+$/, '').replace(/^[\s　]+/, ''))
  .filter((s) => s.length > 0);

function isMetaLine(line) {
  if (META_PREFIXES.some((p) => line.startsWith(p))) return true;
  if (line.startsWith('［') && line.endsWith('］')) return true;
  if (/^https?:\/\//.test(line)) return true;
  return false;
}

/* -------------------------------------------------------------------------- */
/* JSON 读写：损坏文件先备份再回退，绝不静默覆盖用户数据                         */
/* -------------------------------------------------------------------------- */

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback;
    try { await fs.rename(file, file + '.corrupt-' + Date.now()); } catch { /* 备份失败则原样保留 */ }
    return fallback;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

async function readBooks() {
  const value = await readJson(booksFile(), []);
  if (!Array.isArray(value)) return [];
  const books = value
    .filter((b) => b && typeof b.path === 'string' && typeof b.name === 'string')
    .map((b) => ({
      id: typeof b.id === 'string' && b.id ? b.id : bookIdOf(b.path),
      name: b.name,
      path: b.path,
      size: Number.isFinite(b.size) ? b.size : 0,
      addedAt: typeof b.addedAt === 'string' ? b.addedAt : new Date().toISOString(),
    }));
  const merged = await ensureBundledBooks(books);
  return merged === books ? books : merged;
}

/**
 * 把 bundle 内置书目装进书架。
 *
 * 三条硬约束：
 *  1. 只用数据目录里的副本路径，绝不写死本机绝对路径（跨机器不存在）；
 *  2. 幂等 —— 已在书架里的（按书名判断）不重复加；
 *  3. 任何一步失败都只返回原书架，不让内置书目把书架搞坏。
 */
async function ensureBundledBooks(books) {
  let sourceDir;
  try {
    sourceDir = bundledBooksDir();
    const stat = await fs.stat(sourceDir);
    if (!stat.isDirectory()) return books;
  } catch {
    return books; // bundle 里没有 books/（例如精简安装）→ 什么都不做
  }

  const known = new Set(books.map((b) => b.name));
  const missing = BUNDLED_BOOKS.filter((name) => !known.has(name));
  if (missing.length === 0) return books;

  /* 用户主动删掉的内置书目不再自动补回：记一份「已移除」名单。 */
  const dropped = new Set(await readRemovedBundled());
  const installable = missing.filter((name) => !dropped.has(name));
  if (installable.length === 0) return books;

  const targetDir = path.join(dataDir(), 'books');
  const added = [];
  for (const name of installable) {
    try {
      const source = path.join(sourceDir, name);
      const stat = await fs.stat(source);
      if (!stat.isFile()) continue;
      const target = path.join(targetDir, name);
      if (!(await fileExists(target))) {
        await fs.mkdir(targetDir, { recursive: true });
        await fs.copyFile(source, target);
      }
      added.push({
        id: bookIdOf(target),
        name,
        path: target,
        size: stat.size,
        addedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.warn('[dsh-novel-shelf] bundled book "' + name + '" skipped:', error.message);
    }
  }
  if (added.length === 0) return books;

  const next = books.concat(added);
  try {
    await writeJson(booksFile(), next);
  } catch (error) {
    console.warn('[dsh-novel-shelf] could not persist bundled books:', error.message);
    return books;
  }
  return next;
}

async function fileExists(file) {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

const readRemovedBundled = async () => {
  const value = await readJson(removedBundledFile(), []);
  return Array.isArray(value) ? value.filter((n) => typeof n === 'string') : [];
};

const readSettings = async () => {
  const value = await readJson(settingsFile(), {});
  return value && typeof value === 'object' ? value : {};
};

/* -------------------------------------------------------------------------- */
/* 书籍缓存                                                                    */
/* -------------------------------------------------------------------------- */

const bookCache = new Map();
const MAX_CACHE = 4;

async function loadBook(filePath) {
  const key = path.resolve(filePath);
  const hit = bookCache.get(key);
  if (hit) {
    bookCache.delete(key);
    bookCache.set(key, hit);
    return hit;
  }
  let stat;
  try {
    stat = await fs.stat(key);
  } catch {
    throw new ReaderError('not-found', 'file not found: ' + key, 404);
  }
  if (!stat.isFile()) throw new ReaderError('bad-request', 'not a file: ' + key);

  const bytes = await fs.readFile(key);
  const decoded = decodeBuffer(new Uint8Array(bytes));
  const entry = {
    path: key,
    name: path.basename(key, path.extname(key)),
    size: stat.size,
    encoding: decoded.encoding,
    text: decoded.text,
    meta: parseMeta(decoded.text.slice(0, 4000)),
    chapters: splitChapters(decoded.text),
  };
  bookCache.set(key, entry);
  while (bookCache.size > MAX_CACHE) {
    bookCache.delete(bookCache.keys().next().value);
  }
  return entry;
}

function assertTxt(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new ReaderError('bad-request', 'path is required');
  }
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.txt') {
    throw new ReaderError('bad-request', 'only .txt is supported, got "' + (ext || 'no extension') + '"');
  }
}

function pick(payload, key) {
  return payload && typeof payload === 'object' ? payload[key] : undefined;
}

const numberOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/* -------------------------------------------------------------------------- */
/* API                                                                         */
/* -------------------------------------------------------------------------- */

const api = {
  async 'library.get'() {
    const books = await readBooks();
    const settings = await readSettings();
    return { books, settings, themes: THEMES, bundled: BUNDLED_BOOKS.length };
  },

  async 'library.add'(payload) {
    assertTxt(pick(payload, 'path'));
    const resolved = path.resolve(pick(payload, 'path'));
    const stat = await fs.stat(resolved).catch(() => undefined);
    if (!stat || !stat.isFile()) throw new ReaderError('not-found', 'file not found: ' + resolved, 404);
    const books = await readBooks();
    if (books.some((b) => b.path === resolved)) return { books, added: false };
    const givenName = pick(payload, 'name');
    const next = books.concat({
      id: bookIdOf(resolved),
      name: typeof givenName === 'string' && givenName
        ? givenName
        : path.basename(resolved, path.extname(resolved)),
      path: resolved,
      size: stat.size,
      addedAt: new Date().toISOString(),
    });
    await writeJson(booksFile(), next);
    return { books: next, added: true };
  },

  async 'library.remove'(payload) {
    const id = String(pick(payload, 'id') || '');
    const books = await readBooks();
    const gone = books.find((b) => b.id === id);
    const next = books.filter((b) => b.id !== id);
    if (next.length !== books.length) {
      await writeJson(booksFile(), next);
      // 内置书目被用户主动移除：记下来，否则下次读书架又自动装回来。
      if (gone && BUNDLED_BOOKS.includes(gone.name)) {
        const dropped = await readRemovedBundled();
        if (!dropped.includes(gone.name)) {
          await writeJson(removedBundledFile(), dropped.concat(gone.name));
        }
      }
    }
    return { books: next };
  },

  async 'book.open'(payload) {
    assertTxt(pick(payload, 'path'));
    const book = await loadBook(pick(payload, 'path'));
    const settings = await readSettings();
    const id = bookIdOf(book.path);
    const annot = await readJson(annotationFile(id), null);
    const p = annot && typeof annot.progress === 'object' && annot.progress ? annot.progress : {};
    return {
      id,
      name: book.name,
      path: book.path,
      size: book.size,
      encoding: book.encoding,
      meta: book.meta,
      chapters: book.chapters.map((c) => ({ title: c.title })),
      progress: {
        chapterIndex: Math.max(0, Math.trunc(Number(p.chapterIndex) || 0)),
        scrollRatio: clamp01(Number(p.scrollRatio) || 0),
      },
      settings: {
        fontSize: numberOr(settings.fontSize, 19),
        lineHeight: numberOr(settings.lineHeight, 1.9),
        theme: THEMES.includes(settings.theme) ? settings.theme : 'eye',
      },
    };
  },

  async 'book.chapter'(payload) {
    assertTxt(pick(payload, 'path'));
    const index = Number(pick(payload, 'index'));
    if (!Number.isInteger(index) || index < 0) {
      throw new ReaderError('bad-request', 'index must be a non-negative integer');
    }
    const book = await loadBook(pick(payload, 'path'));
    const chapter = book.chapters[index];
    if (!chapter) {
      throw new ReaderError('not-found', 'chapter ' + index + ' not found (total ' + book.chapters.length + ')', 404);
    }
    const lines = toParagraphs(book.text.slice(chapter.start, chapter.end));
    // 标题行本身就在正文首行；面板单独渲染标题，正文里去掉重复
    if (lines.length && lines[0].replace(/\s+/g, ' ').trim() === chapter.title) lines.shift();
    const annot = await readJson(annotationFile(bookIdOf(book.path)), { highlights: [] });
    return {
      index,
      title: chapter.title,
      paragraphs: lines.map((text, i) => ({ index: i, text, meta: isMetaLine(text) })),
      highlights: Array.isArray(annot.highlights) ? annot.highlights : [],
    };
  },

  async 'book.save'(payload) {
    assertTxt(pick(payload, 'path'));
    const id = bookIdOf(pick(payload, 'path'));
    const current = await readJson(annotationFile(id), { highlights: [], progress: {} });
    const givenHighlights = pick(payload, 'highlights');
    const highlights = Array.isArray(givenHighlights)
      ? givenHighlights
      : Array.isArray(current.highlights) ? current.highlights : [];
    const givenProgress = pick(payload, 'progress');
    const progress = givenProgress && typeof givenProgress === 'object'
      ? {
        chapterIndex: Math.max(0, Math.trunc(Number(givenProgress.chapterIndex) || 0)),
        scrollRatio: clamp01(Number(givenProgress.scrollRatio) || 0),
      }
      : current.progress || { chapterIndex: 0, scrollRatio: 0 };
    await writeJson(annotationFile(id), {
      ...current, version: 1, bookId: id, highlights, progress,
    });
    const settings = await readSettings();
    await writeJson(settingsFile(), { ...settings, lastBookId: id });
    return { saved: true, highlightCount: highlights.length };
  },

  /**
   * 写回 settings.json。字段名与 novel-reader 完全一致，两边共用同一个文件，
   * 所以切主题会与 Electron 版双向同步。
   */
  async 'settings.save'(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new ReaderError('bad-request', 'payload must be an object');
    }
    const current = await readSettings();
    const patch = {};
    if (typeof payload.theme === 'string') {
      if (!THEMES.includes(payload.theme)) {
        throw new ReaderError('bad-request', 'unknown theme "' + payload.theme + '"');
      }
      patch.theme = payload.theme;
    }
    if (payload.fontSize !== undefined) {
      patch.fontSize = Math.min(40, Math.max(10, numberOr(payload.fontSize, 19)));
    }
    if (payload.lineHeight !== undefined) {
      patch.lineHeight = Math.min(3, Math.max(1.2, numberOr(payload.lineHeight, 1.9)));
    }
    if (Object.keys(patch).length === 0) {
      throw new ReaderError('bad-request', 'nothing to save');
    }
    await writeJson(settingsFile(), { ...current, ...patch });
    return { ...current, ...patch };
  },

  /**
   * 客户端半边的诊断通道：浏览器控制台读不到，只能把运行时信息落到磁盘。
   * 只写自己数据目录下的日志文件，不含任何书籍内容。
   */
  async 'client.log'(payload) {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      tag: String(pick(payload, 'tag') || 'client'),
      data: pick(payload, 'data') ?? null,
    });
    await fs.appendFile(path.join(dataDir(), 'plugin-client.log'), line + '\n', 'utf8');
    return { logged: true };
  },

  async 'book.search'(payload) {
    assertTxt(pick(payload, 'path'));
    const keyword = String(pick(payload, 'keyword') || '').trim();
    if (!keyword) throw new ReaderError('bad-request', 'keyword is required');
    const limit = Math.min(200, Math.max(1, Math.trunc(Number(pick(payload, 'limit')) || 50)));
    const book = await loadBook(pick(payload, 'path'));
    const needle = keyword.toLowerCase();
    const results = [];
    for (let i = 0; i < book.chapters.length && results.length < limit; i += 1) {
      const c = book.chapters[i];
      const span = c.end - c.start;
      const slice = book.text.slice(c.start, c.end).toLowerCase();
      let from = 0;
      let hit = slice.indexOf(needle, from);
      while (hit !== -1 && results.length < limit) {
        results.push({
          chapterIndex: i,
          chapterTitle: c.title,
          snippet: book.text
            .slice(c.start + Math.max(0, hit - 28), c.start + Math.min(span, hit + needle.length + 28))
            .replace(/\s*\n\s*/g, ' '),
        });
        from = hit + needle.length;
        hit = slice.indexOf(needle, from);
      }
    }
    return { results, total: results.length };
  },
};

/* -------------------------------------------------------------------------- */
/* 路由                                                                        */
/* -------------------------------------------------------------------------- */

/** 自写栅栏：跨站请求直接拒。 */
function fence(req) {
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site') return 'cross-site requests are rejected';
  return undefined;
}

/** DSH 官方信任栅栏：回环 / trusted-host / 浏览器会话认证。必须先于方法白名单。 */
function trustFence(req, ctx) {
  const connection = ctx.connection;
  if (!connection || typeof connection.requestRejection !== 'function') return undefined;
  const rejection = connection.requestRejection(req);
  return rejection ? 'host trust fence rejected (' + rejection + ')' : undefined;
}

async function readJsonBody(req) {
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new ReaderError('too-large', 'request body exceeds 1 MiB', 413);
    }
    parts.push(chunk);
  }
  if (!parts.length) return {};
  try {
    const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    throw new ReaderError('bad-request', 'request body must be a JSON object');
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const send = (status, body) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      };
      const denied = fence(req) || trustFence(req, ctx);
      if (denied) {
        send(403, { ok: false, error: { code: 'forbidden', message: denied } });
        return;
      }
      if (req.method !== 'POST') {
        send(405, { ok: false, error: { code: 'method-not-allowed', message: 'use POST' } });
        return;
      }
      try {
        const tail = decodeURIComponent(
          req.url.slice(req.url.indexOf(API_PREFIX) + API_PREFIX.length).replace(/^\/+/, ''),
        );
        // Object.hasOwn：原型成员不能当方法
        if (!Object.hasOwn(api, tail)) {
          send(404, { ok: false, error: { code: 'unknown-method', message: 'unknown API method "' + tail + '"' } });
          return;
        }
        send(200, { ok: true, value: await api[tail](await readJsonBody(req)) });
      } catch (error) {
        const known = error instanceof ReaderError;
        const status = known ? error.status : 500;
        if (!known) console.error('[dsh-novel-shelf]', error);
        send(status, {
          ok: false,
          error: { code: known ? error.code : 'internal', message: (error && error.message) || 'internal error' },
        });
      }
    },
  }), 'dsh-novel-shelf:api');
}