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
import { readFileSync } from 'node:fs';

export const name = 'dsh-novel-shelf';
/**
 * Host 半需要的服务。
 *
 * llm 与 agentDefaultModel 是「AI 陪读」用的：前者调模型，后者读 DSH
 * 当前默认模型选择（provider / model / reasoningEffort）。这两个必须
 * 显式声明 —— cordis 的 fiber ctx 对未注入的属性访问会直接抛错，
 * 不声明的话 optionalService 只能吞掉异常返回 undefined，
 * 表现为「模型永远没配好」，陪读一次都触发不了。
 *
 * 反过来，这两个服务在旧宿主里可能不存在：所以访问一律走
 * optionalService（每个属性单独 try），拿不到就如实报 hasModel=false，
 * 绝不静默假装有模型。
 */
export const inject = ['webServer', 'connection', 'llm', 'agentDefaultModel'];

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
/** 上传导入的副本目录：浏览器拿不到真实路径，字节只能由宿主落一份。 */
const importedDir = () => path.join(dataDir(), 'imported');

/**
 * 上传体积上限。
 *
 * 与 JSON API 的 1 MiB 是两回事：那条是配置通道，这条是一本书。
 * 网络小说 txt 十几兆很常见，留 100 MiB 足够，也不至于让一次误拖
 * 整个文件夹把内存吃穿（整块读进 Buffer，所以必须有硬上限）。
 */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** 上传接口的请求体上限：base64 膨胀 4/3，再多留 1 MiB 给 JSON 外壳。 */
const uploadBodyLimit = () => Math.ceil(MAX_UPLOAD_BYTES * 4 / 3) + 1024 * 1024;

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

/**
 * 把一本书加进书架（幂等）。
 *
 * 抽出来是因为现在有三条入口都落到同一件事上：手动填路径、上传字节、
 * 目录里点。三条入口的差别只在「怎么拿到一个磁盘上的 .txt」，拿到之后
 * 的校验、去重、写盘必须完全一致，否则会出现「上传能进、填路径进不去」
 * 这种各走各的分叉。
 *
 * @param {string} resolved 已 resolve 的绝对路径
 * @param {string} [givenName] 用户指定的书名；不传就取文件名
 * @param {{ size?: number, copyOf?: string }} [extra] copyOf 表示这是宿主落的副本
 */
async function addBookAt(resolved, givenName, extra) {
  const stat = await fs.stat(resolved).catch(() => undefined);
  if (!stat || !stat.isFile()) throw new ReaderError('not-found', 'file not found: ' + resolved, 404);
  if (stat.size === 0) throw new ReaderError('empty-file', '文件是空的：' + path.basename(resolved));
  const books = await readBooks();
  if (books.some((b) => b.path === resolved)) return { books, added: false, book: books.find((b) => b.path === resolved) };
  const book = {
    id: bookIdOf(resolved),
    name: typeof givenName === 'string' && givenName.trim()
      ? givenName.trim()
      : path.basename(resolved, path.extname(resolved)),
    path: resolved,
    size: stat.size,
    addedAt: new Date().toISOString(),
  };
  /* 副本来源记一笔：移除时可以顺手清掉宿主落的这份，用户原文件绝不碰。 */
  if (extra && extra.copyOf) book.copyOf = extra.copyOf;
  const next = books.concat(book);
  await writeJson(booksFile(), next);
  return { books: next, added: true, book };
}

/**
 * 列一个目录里的子目录 + .txt。
 *
 * 为什么需要它：Web GUI 里 `<input type=file>` 选中的文件，浏览器**不给真实
 * 路径**（Chromium 早就把 `File.path` 藏了，安全考虑）。所以「选文件」只能
 * 走字节上传；而「从目录里挑」必须由宿主自己去 readdir —— 这样点中的每一项
 * 都是一个真路径，导入是零复制的，和手动填路径完全等价。
 *
 * 只列一层，不进递归：网文目录动辄几千个文件，递归扫盘会让面板卡死，
 * 用户想往深处走就一层层点。
 *
 * @param {string} dir 目标目录；空则回落 home
 * @returns {Promise<{path: string, parent: string, home: string, dirs: object[], entries: object[]}>}
 */
async function scanDirectory(dir) {
  const home = homedir();
  const raw = typeof dir === 'string' ? dir.trim() : '';
  const abs = raw ? path.resolve(raw) : home;
  const stat = await fs.stat(abs).catch(() => undefined);
  if (!stat) throw new ReaderError('not-found', '目录不存在：' + abs, 404);
  if (!stat.isDirectory()) throw new ReaderError('bad-request', '不是目录：' + abs);

  let dirents;
  try {
    dirents = await fs.readdir(abs, { withFileTypes: true });
  } catch (error) {
    const code = error && error.code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new ReaderError('forbidden-dir', '没有权限读这个目录：' + abs, 403);
    }
    throw new ReaderError('io-error', '读目录失败：' + ((error && error.message) || abs), 500);
  }

  const lower = (s) => s.toLowerCase();
  const dirs = dirents
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => ({ name: d.name, path: path.join(abs, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));

  const txts = dirents
    .filter((d) => d.isFile() && lower(path.extname(d.name)) === '.txt' && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, 'zh'));

  /* 大小与章数只对 txt 取：目录项不需要，白花 IO。并发上限 8，
     几百个文件的目录也不至于把句柄打爆。 */
  const entries = [];
  for (let i = 0; i < txts.length; i += 8) {
    const slice = txts.slice(i, i + 8);
    const stats = await Promise.all(slice.map(async (name) => {
      const file = path.join(abs, name);
      const st = await fs.stat(file).catch(() => undefined);
      return st && st.isFile() ? { name, path: file, size: st.size } : undefined;
    }));
    for (const item of stats) if (item) entries.push(item);
  }

  return { path: abs, parent: path.dirname(abs), home, dirs, entries };
}


function pick(payload, key) {
  return payload && typeof payload === 'object' ? payload[key] : undefined;
}

const numberOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/* -------------------------------------------------------------------------- */
/* AI 陪读                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * AI 陪读（轮询式）。
 *
 * 用户诉求：读到某一段时，AI 跟着吐槽；可设轮询间隔（如 5 分钟一次）。
 *
 * 三条硬约束：
 *   1) **不自己存 API key**。模型走 DSH 的 `llm` 服务 + `agentDefaultModel`
 *      当前选择，也就是说直接用用户在 DSH 里配好的模型。没配就是没配，
 *      报错告诉用户去配，不静默降级成假输出。
 *   2) **纯轮询，不挂钩子**。客户端每 N 秒把「读到哪了」报上来，host 判断
 *      是否够间隔、是否够新内容，够了一次才调一次模型。客户端不调，就一次
 *      都不调 —— 绝不后台偷跑。
 *   3) **不落盘书籍内容**。只写"AI 说过什么"到日志，正文只进 prompt 不进盘。
 */

/** 陪读风格：同一段内容用不同提示词产出不同口吻。 */
const COMPANION_STYLES = ['roast', 'warm', 'detective', 'slacker'];
const DEFAULT_COMPANION_STYLE = 'roast';

/** 各风格的系统提示词。口吻是产品差异点，所以逐条写死而不是拼模板。 */
const COMPANION_SYSTEM = {
  // 毒舌吐槽：好笑但不能刻薄到读不下去
  roast: [
    '你是读者的毒舌书搭子，正在陪他看网文。',
    '用一句吐槽回应刚读到的内容：一针见血、带梗、口语化。',
    '可以说情节套路、角色降智、设定穿帮，但不要重复原文句子，不要人身攻击。',
    '只输出吐槽本身，不加引号、不加"吐槽："这类前缀。',
  ].join('\n'),
  // 温暖陪伴：慢热型读者的需求
  warm: [
    '你是读者的温柔书搭子，正在陪他看网文。',
    '用一句话接住这段内容：可以是被戳到、可以是共鸣、也可以是温柔的调侃。',
    '不要过度解读，不要总结剧情，只表达"读到这里的真实感受"。',
    '只输出这句话，不加引号、不加前缀。',
  ].join('\n'),
  // 推理侦探：把伏笔当线索
  detective: [
    '你是读者的推理书搭子，正在陪他看网文。',
    '从这段内容里挖出一个可疑点：前后矛盾、被忽略的细节、可能是伏笔的句子。',
    '只提一个点，用提问或判断句说出来，不要罗列多个。',
    '只输出这一句，不加引号、不加前缀。',
  ].join('\n'),
  // 摆烂躺平：社畜下班后的状态
  slacker: [
    '你是读者的摆烂书搭子，正在陪他看网文。',
    '用社畜躺平的口吻回应：敷衍、摆烂、想下班，但别真的吐槽剧情。',
    '可以借题发挥说点无关的懒话，但必须和刚读到的内容沾边。',
    '只输出这一句，不加引号、不加前缀。',
  ].join('\n'),
};

/** 每个会话（浏览器标签）一份陪读状态。 */
const companionSessions = new Map();

/** 陪读单条记录。 */
function companionLine(entry, style) {
  return {
    at: new Date().toISOString(),
    chapterIndex: entry.chapterIndex,
    chapterTitle: String(entry.chapterTitle || '').slice(0, 120),
    text: entry.text,
    style,
  };
}

/**
 * 取出/新建一个会话的陪读状态。
 *
 * 新建时**同步**套用 settings.json 里存过的间隔与风格（companionState 是
 * 同步函数，整条 tick 路径都靠它，不能改成 async）。读文件失败就当没存过，
 * 用默认值兜底 —— 配置文件坏掉不该让陪读整个不可用。
 */
function companionState(sessionId) {
  const key = String(sessionId || 'default');
  let state = companionSessions.get(key);
  if (!state) {
    state = {
      enabled: false,
      intervalMs: 5 * 60 * 1000,
      style: DEFAULT_COMPANION_STYLE,
      lastAt: 0,
      lastText: '',
      pending: false,
      lines: [],
      lastError: '',
    };
    const stored = readCompanionPrefsSync();
    if (stored) {
      if (Number.isFinite(stored.intervalMs)) {
        state.intervalMs = Math.min(24 * 3600 * 1000, Math.max(30000, Math.trunc(stored.intervalMs)));
      }
      if (COMPANION_STYLES.includes(stored.style)) state.style = stored.style;
    }
    companionSessions.set(key, state);
  }
  return state;
}

/** 同步读 settings.json 里的 companion 段；读不到就返回 null。 */
function readCompanionPrefsSync() {
  try {
    const raw = readFileSync(settingsFile(), 'utf8');
    const value = JSON.parse(raw);
    return value && typeof value.companion === 'object' && value.companion ? value.companion : null;
  } catch (error) {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* 模型选择（AI 陪读用哪个模型）                                                */
/* -------------------------------------------------------------------------- */

/**
 * 陪读专用模型选择，存进 settings.json 的 `model` 段。
 *
 * 字段：
 *   - `provider` / `model`：`''` 表示「跟随 DSH 默认模型」（当前行为，向后兼容）
 *   - `baseURL` / `apiKey`：自定义 OpenAI 兼容端点；填了就以插件自己的
 *     provider 路由名发请求，不依赖 DSH 里配过任何 provider
 *
 * 为什么存 settings.json 而不是 DSH 设置：这份文件与桌面版 novel-reader
 * 共用，未知键会被它忽略；而 DSH 的 agentDefaultModel 是全会话共享的全局
 * 默认模型，陪读想单独换个便宜模型时不该动它（用户亲口说「自主添加」）。
 */
const MODEL_DEFAULTS = { provider: '', model: '', baseURL: '', apiKey: '' };

function readModelPrefsSync() {
  try {
    const raw = readFileSync(settingsFile(), 'utf8');
    const value = JSON.parse(raw);
    const stored = value && typeof value.model === 'object' && value.model ? value.model : {};
    return {
      provider: typeof stored.provider === 'string' ? stored.provider : MODEL_DEFAULTS.provider,
      model: typeof stored.model === 'string' ? stored.model : MODEL_DEFAULTS.model,
      baseURL: typeof stored.baseURL === 'string' ? stored.baseURL : MODEL_DEFAULTS.baseURL,
      apiKey: typeof stored.apiKey === 'string' ? stored.apiKey : MODEL_DEFAULTS.apiKey,
    };
  } catch (error) {
    return { ...MODEL_DEFAULTS };
  }
}

/** 自定义 provider 的路由名。固定字符串，注册与发请求必须用同一个。 */
const CUSTOM_PROVIDER_ROUTE = 'dsh-novel-shelf:custom';
/** 自定义端点的模型清单：endpoint 不需要提前知道，请求时按用户填的 model 直接发。 */
const CUSTOM_MODEL_ID = '__custom__';

/**
 * 解析「这次吐槽到底用哪个模型」。
 *
 * 三种情况：
 *   1. 用户填了自定义 endpoint + key → 插件自己的路由（provider/model 都用固定值）
 *   2. 只填了 provider/model → 用 DSH 里已注册的那个 provider
 *   3. 什么都没填 → 跟随 DSH 默认模型（向后兼容）
 */
function resolveCompanionRoute(ctx) {
  const prefs = readModelPrefsSync();
  if (prefs.baseURL && prefs.apiKey && prefs.model) {
    return { provider: CUSTOM_PROVIDER_ROUTE, model: prefs.model, custom: prefs, source: 'custom' };
  }
  const picked = prefs.provider && prefs.model ? prefs : null;
  if (picked) return { provider: picked.provider, model: picked.model, custom: null, source: 'picked' };
  const fallback = currentModelSelection(ctx);
  if (!fallback) return undefined;
  return { provider: fallback.provider, model: fallback.model, custom: null, source: 'default' };
}

/**
 * 把间隔 / 风格写进共享 settings.json。
 *
 * 故意**不持久化开关**：enabled 是「这次要不要开」的当场决定，
 * 写进去会让下次一进面板就被 AI 追着吐槽，属于打扰。
 */
async function persistCompanionPrefs(state) {
  const current = await readSettings();
  await writeJson(settingsFile(), {
    ...current,
    companion: {
      intervalMs: state.intervalMs,
      style: state.style,
    },
  });
}

/** 从 ctx 上取可选服务；cordis 未注入的属性访问会抛，必须逐个包 try。 */
function optionalService(ctx, key) {
  if (!ctx) return undefined;
  try {
    const direct = ctx[key];
    if (direct) return direct;
  } catch (error) { /* 未注入 */ }
  if (typeof ctx.get !== 'function') return undefined;
  try {
    const value = ctx.get(key, false);
    if (value) return value;
  } catch (error) {
    try {
      const value = ctx.get(key);
      if (value) return value;
    } catch (error2) { /* 不存在 */ }
  }
  return undefined;
}

/**
 * 宿主侧的诊断行，写进同一个 plugin-client.log（client.log API 只服务浏览器
 * 半边）。只记运行参数，不记书籍内容。
 */
function appendClientLog(tag, data) {
  const line = JSON.stringify({ at: new Date().toISOString(), tag: 'host:' + tag, data });
  void fs.appendFile(path.join(dataDir(), 'plugin-client.log'), line + '\n', 'utf8').catch(() => {});
}

/** 读取 DSH 当前默认模型选择；没配返回 undefined。 */
function currentModelSelection(ctx) {
  const service = optionalService(ctx, 'agentDefaultModel');
  if (!service || typeof service.currentSelection !== 'function') return undefined;
  try {
    const selection = service.currentSelection();
    if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string') {
      return selection;
    }
  } catch (error) { /* 读不到就当没配 */ }
  return undefined;
}

/**
 * 吐槽要用的最低推理档。DeepSeek 适配器默认 `high`：一次几百字的吐槽如果
 * 也用 high，推理过程会吃掉整个输出预算，模型一个字正文都不吐（实测拿到
 * 空回复）。dsh-better-sidebar 的 `commitReasoningEffort` 就是为此存在的
 * （lib/index.js:8216-8224：查模型公示的 effort 列表，取最低）。
 *
 * 注意 `ModelInfo.reasoning.efforts` 的每一项是 `{ id, name }` 对象而不是裸
 * 字符串（dsh-llm normalizeModelInfo，lib/index.js:2075-2083）。宿主在校验时
 * 拿 `effort.id` 去比对，若我们把整个对象当档位传进去，错误信息就变成
 * `does not support reasoning effort "[object Object]"`——实测正是这个报错。
 */
async function lowestReasoningEffort(llm, route) {
  if (!llm || typeof llm.resolveModelInfo !== 'function') return undefined;
  try {
    const info = await llm.resolveModelInfo(route.provider, route.model);
    const efforts = info && info.reasoning && Array.isArray(info.reasoning.efforts)
      ? info.reasoning.efforts
      : [];
    /* 容错：将来若改回裸字符串也不炸 */
    const ids = efforts
      .map((effort) => (typeof effort === 'string' ? effort : effort && typeof effort.id === 'string' ? effort.id : undefined))
      .filter((id) => typeof id === 'string');
    if (ids.length === 0) return undefined;
    /* 未排序的列表按常见档位顺序挑最靠前的 */
    const RANK = ['minimal', 'low', 'medium', 'high', 'none'];
    return ids.slice().sort((a, b) => RANK.indexOf(a) - RANK.indexOf(b))[0];
  } catch (error) {
    return undefined; /* 读不到就不带这个字段，让模型自己定 */
  }
}

/** 用户消息的规范构造：宿主按 content block 数组读，裸字符串可能被当成空消息。 */
function companionUserMessage(contextText) {
  return [{
    role: 'user',
    content: [{ type: 'text', text: contextText }],
    source: { kind: 'plugin:dsh-novel-shelf' },
  }];
}

/* -------------------------------------------------------------------------- */
/* 自定义 OpenAI 兼容端点                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 直接打 OpenAI 兼容的 `/chat/completions`，把 SSE 增量拼成文本。
 *
 * 不走宿主 llm.stream，原因有两条：
 *   1) 自定义 provider 路由要在 apply 时注册成 LlmAdapter，那是上百行的类，
 *      为一个「填个 key 就能用」的功能不值当；
 *   2) 宿主可能没加载到能注册 adapter 的 llm 服务（旧版本），那时这条路仍可用。
 * 代价：拿不到宿主的重试/计费/审计，对这个一次性调用的场景可以接受。
 */
async function callCustomEndpoint(prefs, messages) {
  const base = String(prefs.baseURL || '').replace(/\/+$/, '');
  const url = base + '/chat/completions';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + String(prefs.apiKey || ''),
      },
      body: JSON.stringify({
        model: String(prefs.model || ''),
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: 0.9,
        max_tokens: 220,
        stream: true,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    const why = error && error.name === 'AbortError' ? '请求超时（60 秒）' : String(error && error.message || error);
    throw new ReaderError('upstream', '连不上 ' + base + '：' + why, 502);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ReaderError('upstream', '端点返回 ' + response.status + ' ' + (body || '').slice(0, 200), 502);
  }
  if (!response.body) throw new ReaderError('upstream', '端点没有返回内容流', 502);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE：以空行分段，每段里的 data: 行才是负载
    let cut = buffer.indexOf('\n\n');
    while (cut !== -1) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      for (const line of block.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
          if (delta && typeof delta.content === 'string') text += delta.content;
        } catch (error) { /* 半行 JSON，等下一块 */
        }
      }
      cut = buffer.indexOf('\n\n');
    }
  }
  return text;
}

/**
 * 从 finish 块里抠出失败原因。
 *
 * 宿主把「模型为什么没吐字」放在 finish 块的 reason.failure.message 里
 * （401 无效 key、额度用尽、上下文超长……）。不抠出来的话，界面上只会显示
 * 一句「the model returned nothing」，用户根本不知道自己填的 key 有问题。
 */
function extractFailure(meta) {
  for (const raw of meta) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { continue; }
    const reason = parsed && parsed.reason;
    const failure = reason && reason.failure;
    if (failure && typeof failure.message === 'string' && failure.message.trim()) {
      const code = failure.code || reason.kind || '';
      return code ? code + ': ' + failure.message : failure.message;
    }
    if (reason && typeof reason.kind === 'string' && reason.kind !== 'stop') {
      return reason.kind;
    }
  }
  return '';
}

/**
 * 调一次宿主 llm.stream，返回正文与失败原因。
 *
 * failure 非空 = 模型没吐字的真实原因（401 无效 key、额度用尽、effort 不支持…）。
 * 宿主把这些原因放在 finish 块的 reason.failure.message 里；不抠出来的话，
 * 界面上只会显示一句「模型没有返回内容」，用户根本不知道是自己的 key 有问题。
 *
 * effort 一律走最低档（lowestReasoningEffort）：默认 high 会把几百字的输出
 * 预算全吃在推理上，正文一个字都不吐。
 */
async function streamHostLlm(llm, route, options) {
  const effort = await lowestReasoningEffort(llm, route);
  let text = '';
  let sawDelta = false;
  const kinds = [];
  const meta = [];
  for await (const chunk of llm.stream({
    provider: route.provider,
    model: route.model,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
    system: options.system,
    messages: options.messages,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
  })) {
    if (chunk && typeof chunk.type === 'string') {
      kinds.push(chunk.type);
      /* text-delta 之外的原样留下：finish 常带原因（length / filter / error），
       * 这是"模型没吐字"唯一的线索。delta 本身是正文，不记。 */
      if (chunk.type !== 'text-delta') meta.push(JSON.stringify(chunk).slice(0, 400));
    }
    if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text;
      sawDelta = true;
    }
  }
  return { text, failure: sawDelta ? '' : extractFailure(meta), kinds, meta, effort };
}

/** 调一次 llm.stream，把增量文本拼起来。 */
async function callCompanionModel(ctx, style, contextText) {
  const route = resolveCompanionRoute(ctx);
  if (!route) {
    throw new ReaderError('no-model', '还没有选模型 —— 在面板里挑一个，或在 DSH 设置里配默认模型', 503);
  }
  const system = COMPANION_SYSTEM[style] || COMPANION_SYSTEM[DEFAULT_COMPANION_STYLE];

  // 自定义端点：自己打 HTTP，不经宿主 llm 服务
  if (route.source === 'custom') {
    const text = await callCustomEndpoint(route.custom, [
      { role: 'system', content: system },
      { role: 'user', content: contextText },
    ]);
    return text.trim();
  }

  const llm = optionalService(ctx, 'llm');
  if (!llm || typeof llm.stream !== 'function') {
    throw new ReaderError('no-model', 'no LLM service is available in this host', 503);
  }
  const result = await streamHostLlm(llm, route, {
    system,
    messages: companionUserMessage(contextText),
    temperature: 0.9,
    maxTokens: 220,
  });
  if (!result.text.trim()) {
    appendClientLog('companion-no-text', {
      style, source: route.source, provider: route.provider, model: route.model,
      effort: result.effort === undefined ? null : result.effort,
      kinds: result.kinds.slice(0, 12), meta: result.meta.slice(0, 4),
      textLength: result.text.length, failure: result.failure,
    });
    if (result.failure) {
      /* 把真实原因带出去：401 无效 key / 额度用尽 / 模型名不存在…… */
      throw new ReaderError('model-failed', '模型没返回内容（' + result.failure + '）', 502);
    }
  }
  return result.text.trim();
}

/** 陪读的宿主上下文：apply 时存下来，供 API 用。 */
let companionCtx = null;

/* -------------------------------------------------------------------------- */
/* 阅读位置记忆（跨会话切换）                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 记住「这个会话正在读哪本书」。
 *
 * 右栏 tab 的座位是 **session 作用域**的：切到别的会话再切回来，组件会重新
 * 挂载，React state 一律清零 —— 用户看到的就是「书还在，但退回了书架」。
 * 记忆放在 host 侧（进程内 Map，按 sessionId 分开），组件重建后重读即可。
 *
 * 不用 localStorage/sessionStorage：那是浏览器侧的，宿主页面刷新或多开
 * 窗口时行为不可控；host 进程内更符合「同一台机器、同一个 DSH」。
 */
const readerSessions = new Map();

/** 会话键：没有 sessionId 时退化成固定串，至少单机单窗口能用。 */
const readerSessionKey = (payload) => String(pick(payload, 'sessionId') || 'reader');

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
    const result = await addBookAt(resolved, pick(payload, 'name'));
    return { books: result.books, added: result.added };
  },

  /**
   * 浏览目录：把「选目录 → 挑文件」这条路铺出来。
   *
   * 不传 dir 就回落到用户主目录，让面板第一次打开有个落脚点。
   */
  async 'library.scan'(payload) {
    return scanDirectory(pick(payload, 'dir'));
  },

  /**
   * 上传导入：把浏览器选中的字节落成宿主侧的一份副本。
   *
   * 为什么必须落副本：Web GUI 拿不到 File 的真实路径，只有字节。要想之后
   * 还能按路径读书，就得先把字节写到磁盘上，再把那个路径记进书架。
   *
   * 幂等靠内容哈希：同一本书重复导入（用户手滑点两次、或从两个入口各导
   * 一次）落成同一个文件，不会在书架里出现两个同名条目。
   */
  async 'library.upload'(payload) {
    const name = String(pick(payload, 'name') || '').trim();
    if (!name) throw new ReaderError('bad-request', 'name is required');
    assertTxt(name);
    const base64 = String(pick(payload, 'data') || '');
    if (!base64) throw new ReaderError('bad-request', 'data is required');
    /* 先按 base64 长度粗筛，避免把超大串整个解出来才发现超限。
       base64 膨胀 4/3，多留一点点余量给 padding。 */
    if (base64.length > Math.ceil(MAX_UPLOAD_BYTES * 4 / 3) + 16) {
      throw new ReaderError('too-large', '文件过大（上限 ' + Math.round(MAX_UPLOAD_BYTES / 1048576) + ' MB）', 413);
    }
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length === 0) throw new ReaderError('empty-file', '文件是空的');
    if (bytes.length > MAX_UPLOAD_BYTES) {
      throw new ReaderError('too-large', '文件过大（上限 ' + Math.round(MAX_UPLOAD_BYTES / 1048576) + ' MB）', 413);
    }

    const digest = createHash('md5').update(bytes).digest('hex').slice(0, 16);
    const safeName = path.basename(name).replace(/[\\/:*?"<>|]/g, '_');
    const dir = importedDir();
    const dest = path.join(dir, digest + '-' + safeName);
    const existing = await fs.stat(dest).catch(() => undefined);
    if (!existing || existing.size !== bytes.length) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(dest, bytes);
    }
    const result = await addBookAt(dest, path.basename(safeName, path.extname(safeName)));
    return { books: result.books, added: result.added, path: dest };
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
      /* 上传导入的副本随移除一起删：那份是宿主替用户存的，用户原文件在别处，
         删副本不会丢东西。用前缀判断而不是信任 copyOf 字段 —— 老版本书架里
         没有这个字段，但副本确实躺在 imported/ 下面。 */
      if (gone && typeof gone.path === 'string') {
        const owned = importedDir() + path.sep;
        if (gone.path.startsWith(owned)) {
          await fs.unlink(gone.path).catch(() => { /* 已经不在了就算了 */ });
        }
      }
    }
    return { books: next };
  },

  /**
   * 记下「这个会话在读哪本书」。
   *
   * 只记路径 —— 章节与滚动位置本来就在 annotations/<id>.json 里（与桌面版
   * novel-reader 共用），重新打开时 book.open 会带回 progress。
   */
  async 'reader.session.set'(payload) {
    const key = readerSessionKey(payload);
    const bookPath = String(pick(payload, 'path') || '');
    if (!bookPath) {
      readerSessions.delete(key);
      return { path: '' };
    }
    readerSessions.set(key, { path: bookPath, at: Date.now() });
    return { path: bookPath };
  },

  /** 读回这个会话上次在读的书。切会话再切回来时用来自动续上。 */
  async 'reader.session.get'(payload) {
    const key = readerSessionKey(payload);
    const entry = readerSessions.get(key);
    return { path: entry ? entry.path : '' };
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

  /**
   * 模型选择面板要的一切：DSH 里已注册的 provider / 各自的模型、
   * 当前默认模型、本插件存过的选择。
   *
   * provider 列不出来（宿主没这个服务或旧版本）时返回空数组，面板就只显示
   * 「自定义端点」那一支 —— 绝不因为列不出来就假装没模型可选。
   */
  async 'model.options'() {
    const llm = optionalService(companionCtx, 'llm');
    const providers = [];
    const seen = new Set();
    const addProvider = (id, name) => {
      if (typeof id !== 'string' || !id.trim() || seen.has(id)) return;
      seen.add(id);
      providers.push({ id, name: name && String(name).trim() ? String(name) : id, models: [] });
    };
    if (llm && typeof llm.listProviders === 'function') {
      let list = [];
      try {
        list = await llm.listProviders() || [];
      } catch (error) {
        appendClientLog('model-list-providers-failed', { message: String(error && error.message) });
      }
      for (const info of list) {
        if (!info || typeof info.id !== 'string' || !info.id.trim()) continue;
        addProvider(info.id, info.name);
      }
    }
    /* 已声明但还没拿到模型的 provider 也要列出来。
       DeepSeek 的两个路由（账号 / API Key）都属于这一类：它们先声明自己，
       能不能列出模型取决于有没有登录、有没有有效 key。不列出来的话，
       用户在面板里根本看不到「DeepSeek」这个选项。 */
    if (llm && typeof llm.listConfigurableProviders === 'function') {
      try {
        const declared = await llm.listConfigurableProviders() || [];
        for (const entry of declared) {
          if (!entry || typeof entry.provider !== 'string') continue;
          addProvider(entry.provider, entry.displayName);
          const target = providers.find((p) => p.id === entry.provider);
          if (target && entry.error) target.error = String(entry.error);
        }
      } catch (error) { /* 列不出来就只显示已注册的 */ }
    }
    for (const provider of providers) {
      if (!llm || typeof llm.listModels !== 'function') continue;
      try {
        const models = await llm.listModels(provider.id) || [];
        provider.models = models
          .filter((m) => m && typeof m.id === 'string' && m.id.trim())
          .map((m) => ({ id: m.id, name: typeof m.name === 'string' && m.name.trim() ? m.name : m.id }));
      } catch (error) { /* 单个 provider 列不出来不影响别人 */ }
    }
    const saved = readModelPrefsSync();
    return {
      providers,
      defaultModel: currentModelSelection(companionCtx) || null,
      saved,
      customRoute: CUSTOM_PROVIDER_ROUTE,
    };
  },

  /**
   * 存模型选择。
   *
   * 传 `{}` 或全空字段 = 回到「跟随 DSH 默认模型」。baseURL + apiKey + model
   * 三者齐全才算自定义端点；只填一半就报错，说清缺哪个 —— 半截配置会让
   * 请求发到一个没有 key 的地址上，报错信息还很难懂。
   */
  async 'model.save'(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new ReaderError('bad-request', 'payload must be an object');
    }
    const current = await readSettings();
    const next = {
      provider: typeof payload.provider === 'string' ? payload.provider.trim() : '',
      model: typeof payload.model === 'string' ? payload.model.trim() : '',
      baseURL: typeof payload.baseURL === 'string' ? payload.baseURL.trim() : '',
      apiKey: typeof payload.apiKey === 'string' ? payload.apiKey.trim() : '',
    };
    const hasCustom = next.baseURL || next.apiKey;
    if (hasCustom && !(next.baseURL && next.apiKey && next.model)) {
      const missing = [];
      if (!next.baseURL) missing.push('接口地址 baseURL');
      if (!next.apiKey) missing.push('API Key');
      if (!next.model) missing.push('模型名 model');
      throw new ReaderError('bad-request', '自定义端点还缺：' + missing.join('、'));
    }
    if (hasCustom) {
      if (!/^https?:\/\//i.test(next.baseURL)) {
        throw new ReaderError('bad-request', 'baseURL 必须以 http:// 或 https:// 开头');
      }
    }
    await writeJson(settingsFile(), {
      ...current,
      model: {
        provider: next.provider,
        model: next.model,
        baseURL: next.baseURL,
        apiKey: next.apiKey,
      },
    });
    return { saved: next };
  },

  /**
   * 清掉插件自己存的模型选择，回到跟随 DSH 默认模型。
   * key 一并清掉 —— 用户说「不用了」时留着密钥没有意义。
   */
  async 'model.reset'() {
    const current = await readSettings();
    await writeJson(settingsFile(), { ...current, model: { ...MODEL_DEFAULTS } });
    return { saved: { ...MODEL_DEFAULTS } };
  },

  /**
   * 按当前选择真调一次模型，返回能不能用 + 拿到什么。
   *
   * 「验证」按钮用：存完 key 立刻知道是通的还是 401，不用先去点吐槽。
   * 自定义端点在这里**不依赖宿主 llm 服务**（宿主可能根本没注册我们的
   * 自定义路由），直接走 fetch，与 callCompanionModel 的自定义分支一致。
   */
  async 'model.test'() {
    const route = resolveCompanionRoute(companionCtx);
    if (!route) throw new ReaderError('no-model', '还没有选模型', 503);
    if (route.source === 'custom') {
      const text = await callCustomEndpoint(route.custom, [
        { role: 'system', content: '只回复两个字：可用' },
        { role: 'user', content: '测试' },
      ]);
      return {
        ok: true, source: route.source, provider: route.provider, model: route.model,
        sample: text.slice(0, 80),
      };
    }
    const llm = optionalService(companionCtx, 'llm');
    if (!llm || typeof llm.stream !== 'function') {
      throw new ReaderError('no-model', 'no LLM service is available in this host', 503);
    }
    const result = await streamHostLlm(llm, route, {
      system: '只回复两个字：可用',
      messages: companionUserMessage('测试'),
      temperature: 0,
      maxTokens: 32,
    });
    if (!result.text.trim()) {
      /* 报清楚「哪个路由不通」和「为什么不通」——
       * 只说「模型没有返回内容」的话，用户会以为是插件坏了，
       * 实际往往是他自己填的 key 无效（401）或额度用尽。 */
      const which = route.provider + '/' + route.model;
      appendClientLog('model-test-no-text', {
        source: route.source, provider: route.provider, model: route.model,
        kinds: result.kinds.slice(0, 12), meta: result.meta.slice(0, 4), failure: result.failure,
      });
      if (result.failure) {
        throw new ReaderError('model-failed', '模型没有返回内容（' + which + '）：' + result.failure, 502);
      }
      throw new ReaderError('empty-response', '模型没有返回内容（' + which + '）', 502);
    }
    return { ok: true, source: route.source, provider: route.provider, model: route.model, sample: result.text.trim().slice(0, 80) };
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

  /* ---------------------------------------------------------------------- */
  /* AI 陪读                                                                */
  /* ---------------------------------------------------------------------- */

  /** 取一个会话的陪读快照（开关 / 间隔 / 风格 / 最近几条吐槽）。 */
  async 'companion.get'(payload) {
    const state = companionState(pick(payload, 'sessionId'));
    return {
      enabled: state.enabled,
      intervalMs: state.intervalMs,
      style: state.style,
      styles: COMPANION_STYLES,
      lines: state.lines.slice(-12),
      pending: state.pending,
      error: state.lastError,
      hasModel: !!currentModelSelection(companionCtx),
    };
  },

  /**
   * 改开关 / 间隔 / 风格。
   *
   * 开关只影响当前会话（一个人在这台机器上开着陪读，不该污染别的会话/窗口），
   * 但间隔和风格写进共享 settings.json —— 不然每次重开 DSH 都要重新调一遍，
   * 用户要的是「设一次就一直是这样」。settings.json 与桌面版 novel-reader
   * 共用，多一个 companion 键对它是未知键，直接忽略。
   */
  async 'companion.config'(payload) {
    const state = companionState(pick(payload, 'sessionId'));
    if (payload.enabled !== undefined) {
      if (typeof payload.enabled !== 'boolean') {
        throw new ReaderError('bad-request', 'enabled must be a boolean');
      }
      state.enabled = payload.enabled;
      // 关掉的瞬间把等待态也清掉，否则会留下一条永远 pending 的假状态
      if (!state.enabled) state.pending = false;
    }
    if (payload.intervalMs !== undefined) {
      // 30 秒起，1 天止；低于 30 秒会被当成误触
      const ms = Math.trunc(Number(payload.intervalMs));
      if (!Number.isFinite(ms)) throw new ReaderError('bad-request', 'intervalMs must be a number');
      state.intervalMs = Math.min(24 * 3600 * 1000, Math.max(30000, ms));
    }
    if (payload.style !== undefined) {
      if (!COMPANION_STYLES.includes(payload.style)) {
        throw new ReaderError('bad-request', 'unknown style "' + payload.style + '"');
      }
      state.style = payload.style;
    }
    state.lastError = '';
    await persistCompanionPrefs(state);
    return {
      enabled: state.enabled, intervalMs: state.intervalMs, style: state.style,
    };
  },

  /**
   * 客户端每 N 秒报一次「读到哪了」。
   *
   * 四条门控，全过才调一次模型：
   *   1) 开关开着；
   *   2) 距上次吐槽够间隔；
   *   3) 内容真的变了（同一段反复报不重复吐槽）；
   *   4) 当前没有在生成的请求（并发只留一个）。
   */
  async 'companion.tick'(payload) {
    const state = companionState(pick(payload, 'sessionId'));
    if (!state.enabled) return { fired: false, reason: 'off' };
    if (state.pending) return { fired: false, reason: 'busy' };

    const chapterIndex = Math.max(0, Math.trunc(Number(pick(payload, 'chapterIndex')) || 0));
    const chapterTitle = String(pick(payload, 'chapterTitle') || '');
    const excerpt = String(pick(payload, 'excerpt') || '').slice(0, 1200).trim();
    const percent = clamp01(Number(pick(payload, 'percent')) || 0);

    const now = Date.now();
    if (now - state.lastAt < state.intervalMs) {
      return { fired: false, reason: 'waiting', waitMs: state.intervalMs - (now - state.lastAt) };
    }
    if (!excerpt) return { fired: false, reason: 'empty' };
    if (excerpt === state.lastText) return { fired: false, reason: 'unchanged' };

    state.pending = true;
    state.lastError = '';
    try {
      const context = [
        `章节：${chapterTitle}（第 ${chapterIndex + 1} 章）`,
        `本章已读：${Math.round(percent * 100)}%`,
        '',
        '刚读到的内容：',
        excerpt,
      ].join('\n');
      const text = await callCompanionModel(companionCtx, state.style, context);
      state.lastAt = Date.now();
      state.lastText = excerpt;
      if (text) {
        state.lines.push(companionLine({ chapterIndex, chapterTitle, text }, state.style));
        // 只留最近 50 条，别让内存无上限涨
        if (state.lines.length > 50) state.lines.splice(0, state.lines.length - 50);
      }
      return { fired: !!text, line: text ? state.lines[state.lines.length - 1] : null };
    } catch (error) {
      const known = error instanceof ReaderError;
      state.lastError = (error && error.message) || 'companion failed';
      if (!known) console.error('[dsh-novel-shelf] companion failed:', error);
      // 失败也记 lastAt：否则模型没配好时会每 30 秒重试一次，刷一屏错
      state.lastAt = Date.now();
      return { fired: false, reason: 'error', error: state.lastError };
    } finally {
      state.pending = false;
    }
  },

  /** 手动要一条（不受间隔限制），满足"我现在就想听一句"的场景。 */
  async 'companion.nudge'(payload) {
    const state = companionState(pick(payload, 'sessionId'));
    const excerpt = String(pick(payload, 'excerpt') || '').slice(0, 1200).trim();
    if (!excerpt) throw new ReaderError('bad-request', 'excerpt is required');
    const chapterIndex = Math.max(0, Math.trunc(Number(pick(payload, 'chapterIndex')) || 0));
    const chapterTitle = String(pick(payload, 'chapterTitle') || '');
    state.pending = true;
    state.lastError = '';
    try {
      const context = [
        `章节：${chapterTitle}（第 ${chapterIndex + 1} 章）`,
        '',
        '刚读到的内容：',
        excerpt,
      ].join('\n');
      const text = await callCompanionModel(companionCtx, state.style, context);
      state.lastAt = Date.now();
      state.lastText = excerpt;
      if (text) {
        state.lines.push(companionLine({ chapterIndex, chapterTitle, text }, state.style));
        if (state.lines.length > 50) state.lines.splice(0, state.lines.length - 50);
      }
      if (!text) {
        const route = resolveCompanionRoute(companionCtx);
        const which = route ? `${route.provider}/${route.model}` : 'no model';
        throw new ReaderError('empty-response', `模型没有返回内容（${which}）`);
      }
      return { line: state.lines[state.lines.length - 1] };
    } catch (error) {
      state.lastError = (error && error.message) || 'companion failed';
      throw error;
    } finally {
      state.pending = false;
    }
  },

  /** 清掉这一个会话的吐槽历史。 */
  async 'companion.clear'(payload) {
    const state = companionState(pick(payload, 'sessionId'));
    state.lines = [];
    state.lastText = '';
    state.lastError = '';
    return { cleared: true };
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

/**
 * 读 JSON 请求体。
 *
 * `limit` 必须可调：配置类接口 1 MiB 足够，但上传一本书要几十兆（base64
 * 还要再膨胀 4/3）。共用一个硬上限的结果就是「上传大文件永远 413」。
 */
async function readJsonBody(req, limit) {
  const cap = Number.isFinite(limit) && limit > 0 ? limit : MAX_BODY_BYTES;
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > cap) {
      throw new ReaderError('too-large', 'request body exceeds ' + Math.round(cap / 1048576) + ' MiB', 413);
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
  companionCtx = ctx;
  /* 静态资源：人物立绘。与 API 同前缀，但走 GET 且不带 /api 段。
     bundle 内的 assets/reader-avatar.png 跟插件一起分发，别人装上也有。 */
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/novel-shelf/assets',
    handler: async (req, res) => {
      const send = (status, body, type) => {
        res.statusCode = status;
        if (type) res.setHeader('content-type', type);
        res.end(body);
      };
      const denied = fence(req) || trustFence(req, ctx);
      if (denied) {
        send(403, JSON.stringify({ ok: false, error: { code: 'forbidden', message: denied } }), 'application/json');
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(405, JSON.stringify({ ok: false, error: { code: 'method-not-allowed', message: 'use GET' } }), 'application/json');
        return;
      }
      // 只允许白名单文件名，杜绝路径穿越
      const tail = decodeURIComponent(req.url.slice(req.url.indexOf('/novel-shelf/assets') + '/novel-shelf/assets'.length).replace(/^\/+/, ''));
      if (tail !== 'reader-avatar.png') {
        send(404, JSON.stringify({ ok: false, error: { code: 'unknown-asset', message: 'unknown asset "' + tail + '"' } }), 'application/json');
        return;
      }
      try {
        const file = path.join(PACKAGE_ROOT, 'assets', 'reader-avatar.png');
        const data = await fs.readFile(file);
        res.setHeader('content-type', 'image/png');
        res.setHeader('cache-control', 'public, max-age=3600');
        if (req.method === 'HEAD') { res.end(); return; }
        send(200, data);
      } catch (error) {
        send(404, JSON.stringify({ ok: false, error: { code: 'asset-missing', message: (error && error.message) || 'missing' } }), 'application/json');
      }
    },
  }), 'dsh-novel-shelf:assets');
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
        send(200, { ok: true, value: await api[tail](await readJsonBody(req, tail === 'library.upload' ? uploadBodyLimit() : undefined)) });
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