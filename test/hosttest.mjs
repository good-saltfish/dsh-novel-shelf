'use strict';

/**
 * Host 半端到端：APPDATA 指向临时沙箱，桩 webServer/connection 走真实路由，
 * 覆盖 书架读写 / 章节切分 / 编码探测 / 进度与批注回写 / 检索 / 路由防护。
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'nr-'));
process.env.APPDATA = sandbox;
const dataDir = path.join(sandbox, 'novel-reader');
await fs.mkdir(path.join(dataDir, 'annotations'), { recursive: true });

const mod = await import('../lib/host.js');

let handler = null;
const ctx = {
  connection: { requestRejection: () => undefined },
  effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
  webServer: {
    register(route) { handler = route.handler; return () => { handler = null; }; },
  },
};
mod.apply(ctx);
assert.equal(typeof handler, 'function', 'host must register a route');

async function post(method, body, headers = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body ?? {}), 'utf8')]);
  req.method = 'POST';
  req.url = `/novel-reader/api/${method}`;
  req.headers = { 'sec-fetch-site': 'same-origin', ...headers };
  const res = { setHeader() {}, end(t) { this.text = String(t); } };
  await handler(req, res);
  return { status: res.statusCode, json: res.text ? JSON.parse(res.text) : null };
}

const ok = async (m, b) => {
  const r = await post(m, b);
  assert.equal(r.json && r.json.ok, true, `${m} 应成功: ${JSON.stringify(r.json && r.json.error)}`);
  return r.json.value;
};

const bookPath = path.join(sandbox, '测试小说.txt');
await fs.writeFile(bookPath, [
  '书名：测试小说', '作者：某人', '【简介】', '简介一行。', '',
  '第一章 开始', '第一段正文。', '第二段正文。', '',
  '第二章 继续', '第三章 内容', '关键词在这里。', '更多正文。',
].join('\n'), 'utf8');

/* 书架 */
assert.deepEqual((await ok('library.get')).books, []);
const added = await ok('library.add', { path: bookPath });
assert.equal(added.added, true);
assert.equal(added.books.length, 1);
assert.equal(added.books[0].name, '测试小说');
assert.equal((await ok('library.add', { path: bookPath })).added, false, '重复加入不得重复写');
assert.equal((await post('library.add', { path: bookPath.replace('.txt', '.pdf') })).json.ok, false);
assert.equal((await post('library.add', { path: path.join(sandbox, 'nope.txt') })).status, 404);

/* 打开 + 目录 */
const opened = await ok('book.open', { path: bookPath });
assert.equal(opened.chapters.length, 4, '简介 + 3 章');
assert.equal(opened.chapters[0].title, '书籍信息 · 简介');
assert.equal(opened.encoding, 'UTF-8');
assert.equal(opened.meta.title, '测试小说');
assert.deepEqual(opened.progress, { chapterIndex: 0, scrollRatio: 0 });

const ch1 = await ok('book.chapter', { path: bookPath, index: 1 });
assert.equal(ch1.title, '第一章 开始');
assert.equal(ch1.paragraphs.length, 2, '标题行不得在正文重复出现');
assert.equal(ch1.paragraphs[0].text, '第一段正文。');
assert.deepEqual(ch1.highlights, []);
assert.equal((await post('book.chapter', { path: bookPath, index: 99 })).status, 404);
assert.equal((await post('book.chapter', { path: bookPath, index: -1 })).json.error.code, 'bad-request');

/* 进度 + 批注写回 */
await ok('book.save', {
  path: bookPath,
  progress: { chapterIndex: 3, scrollRatio: 0.42 },
  highlights: [{ id: 'h1', groupId: 'h1', chapterIndex: 3, paragraph: 0, start: 0, end: 3, text: '关键词', color: 'yellow', style: 'highlight', note: '测试', createdAt: new Date().toISOString() }],
});
const reopened = await ok('book.open', { path: bookPath });
assert.equal(reopened.progress.chapterIndex, 3);
assert.equal(reopened.progress.scrollRatio, 0.42);
assert.equal((await ok('book.chapter', { path: bookPath, index: 3 })).highlights[0].note, '测试');
const settings = JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'));
assert.equal(settings.lastBookId, reopened.id);

await ok('book.save', { path: bookPath, progress: { chapterIndex: -5, scrollRatio: 9 } });
const clamped = await ok('book.open', { path: bookPath });
assert.equal(clamped.progress.chapterIndex, 0);
assert.equal(clamped.progress.scrollRatio, 1);
assert.equal((await ok('book.chapter', { path: bookPath, index: 3 })).highlights.length, 1, '只传进度不得清空批注');

/* 检索 */
const found = await ok('book.search', { path: bookPath, keyword: '关键词' });
assert.equal(found.total, 1);
assert.equal(found.results[0].chapterIndex, 3);
assert.ok((await ok('book.search', { path: bookPath, keyword: '正文' })).total >= 2);
assert.equal((await post('book.search', { path: bookPath, keyword: '  ' })).json.error.code, 'bad-request');

/* GB18030 回退 */
const gbkPath = path.join(sandbox, 'gbk.txt');
await fs.writeFile(gbkPath, Buffer.from([0xd5, 0xa2, 0xb5, 0xda, 0x0d, 0x0a, 0xce, 0xc4, 0xcb, 0xce]));
assert.equal((await ok('book.open', { path: gbkPath })).encoding, 'GB18030');

/* 移除书架：文件仍在磁盘 */
await ok('library.remove', { id: opened.id });
assert.equal((await ok('library.get')).books.length, 0);
assert.ok((await fs.stat(bookPath)).size > 0, '移除书架不得删除文件');

/* 路由防护 */
for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
  assert.equal((await post(bad, {})).json.error.code, 'unknown-method', bad);
}
assert.equal((await post('library.get', {}, { 'sec-fetch-site': 'cross-site' })).status, 403);
ctx.connection.requestRejection = () => 401;
assert.equal((await post('library.get', {})).status, 403, '宿主信任栅栏必须先于方法白名单');
ctx.connection.requestRejection = () => undefined;

const bigReq = Readable.from([Buffer.alloc(1024 * 1024 + 16, 0x20)]);
bigReq.method = 'POST';
bigReq.url = '/novel-reader/api/library.get';
bigReq.headers = { 'sec-fetch-site': 'same-origin' };
const bigRes = { setHeader() {}, end() {} };
await handler(bigReq, bigRes);
assert.equal(bigRes.statusCode, 413, '超限 body 必须被拒');

const getReq = Readable.from([]);
getReq.method = 'GET';
getReq.url = '/novel-reader/api/library.get';
getReq.headers = { 'sec-fetch-site': 'same-origin' };
const getRes = { setHeader() {}, end() {} };
await handler(getReq, getRes);
assert.equal(getRes.statusCode, 405, '只接受 POST');

/* 主题：五套配色 + 白名单 + 与 novel-reader 共享同一份 settings.json */
const lib = await ok('library.get');
assert.deepEqual(lib.themes, ['day', 'eye', 'sepia', 'dark', 'black']);
assert.equal((await ok('book.open', { path: bookPath })).settings.theme, 'eye', '未设主题时默认 eye');
assert.equal((await ok('settings.save', { theme: 'black' })).theme, 'black');
assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8')).theme, 'black');
assert.equal((await ok('book.open', { path: bookPath })).settings.theme, 'black');
assert.equal((await post('settings.save', { theme: 'neon' })).json.error.code, 'bad-request');
assert.equal((await post('settings.save', {})).json.error.code, 'bad-request');
assert.equal((await ok('settings.save', { theme: 'sepia', fontSize: 99 })).fontSize, 40, '字号必须夹紧');
assert.equal((await ok('book.open', { path: bookPath })).settings.theme, 'sepia');
const kept = JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'));
assert.equal(kept.lastBookId, reopened.id, 'settings.save 不得抹掉其它字段');
assert.equal((await ok('settings.save', { fontSize: 21, lineHeight: 1.7 })).lineHeight, 1.7);

/* 损坏 json：备份后回退，不静默覆盖 */
const booksFile = path.join(dataDir, 'books.json');
await ok('library.add', { path: bookPath });
await fs.writeFile(booksFile, '{ broken', 'utf8');
assert.deepEqual((await ok('library.get')).books, []);
assert.equal((await fs.readdir(dataDir)).filter((n) => n.startsWith('books.json.corrupt-')).length, 1, '损坏文件必须备份而非覆盖');

await fs.rm(sandbox, { recursive: true, force: true });
console.log('hosttest: all assertions passed');