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

/* 内置书目：bundle 里的 books/ 用一个独立沙箱顶上（环境变量覆盖），
 * 这样单测不依赖真实仓库里的 7.3MB 小说。 */
const bundleBooks = path.join(sandbox, 'bundle-books');
await fs.mkdir(bundleBooks, { recursive: true });
const BUNDLED_NAMES = [
  '十日终焉 - 杀虫队队员.txt',
  '我在精神病院学斩神 - 三九音域.txt',
  '我不是戏神 - 三九音域.txt',
];
for (const name of BUNDLED_NAMES) {
  await fs.writeFile(path.join(bundleBooks, name), [
    '书名：' + name.replace(/\.txt$/, ''), '作者：测试', '【简介】', '内置书目测试副本。', '',
    '第一章 开头', '正文一。', '',
    '第二章 承接', '正文二。', '',
    '第三章 收束', '正文三。', '',
  ].join('\n'), 'utf8');
}
process.env.NOVEL_SHELF_BOOKS_DIR = bundleBooks;

const mod = await import('../lib/host.js');

/* 陪读桩：llm.stream 按增量吐字，agentDefaultModel 报一个默认选择。
 * 这两个服务在真实宿主里由 DSH 提供，桩按 apply 里 inject 声明提供同名属性。
 * resolveModelInfo 模仿真实宿主：公示 effort 列表，宿主代码必须自己压低到
 * 最低档，否则推理会吃光 220 的 maxTokens，正文一个字不吐。 */
const llmCalls = [];
const fakeLlm = {
  async *stream(spec) {
    llmCalls.push(spec);
    yield { type: 'text-delta', text: '这一段有点东西，' };
    yield { type: 'text-delta', text: '但不多。' };
  },
  async resolveModelInfo(provider, model) {
    /* 真实宿主形状：efforts 是 { id, name } 对象数组，不是裸字符串。
     * 见 dsh-llm normalizeModelInfo（lib/index.js:2075-2083）。宿主校验拿
     * effort.id 比对，传整个对象会得到 "[object Object]" 报错。 */
    return {
      provider, model,
      reasoning: {
        defaultEffort: 'high',
        efforts: [
          { id: 'low', name: 'Low' },
          { id: 'medium', name: 'Medium' },
          { id: 'high', name: 'High' },
        ],
      },
    };
  },
};
const fakeDefaultModel = { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) };

let handler = null;
const ctx = {
  connection: { requestRejection: () => undefined },
  llm: fakeLlm,
  agentDefaultModel: fakeDefaultModel,
  effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
  webServer: {
    register(route) { handler = route.handler; return () => { handler = null; }; },
  },
};
mod.apply(ctx);
assert.equal(typeof handler, 'function', 'host must register a route');

/* 陪读依赖的两个服务必须显式 inject：不声明的话 cordis 未注入属性访问会抛，
 * optionalService 只能吞掉 → 模型永远读不到 → 陪读一次都触发不了。 */
assert.ok(mod.inject.includes('llm'), 'host 必须 inject llm');
assert.ok(mod.inject.includes('agentDefaultModel'), 'host 必须 inject agentDefaultModel');

async function post(method, body, headers = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body ?? {}), 'utf8')]);
  req.method = 'POST';
  req.url = `/novel-shelf/api/${method}`;
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

async function fileExists(file) {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

const bookPath = path.join(sandbox, '测试小说.txt');
await fs.writeFile(bookPath, [
  '书名：测试小说', '作者：某人', '【简介】', '简介一行。', '',
  '第一章 开始', '第一段正文。', '第二段正文。', '',
  '第二章 继续', '第三章 内容', '关键词在这里。', '更多正文。',
].join('\n'), 'utf8');

/* 内置书目：首次读取书架时自动装入 */
{
  await fs.rm(path.join(dataDir, 'books.json'), { force: true });
  const first = await ok('library.get');
  assert.equal(first.bundled, BUNDLED_NAMES.length, 'library.get 必须报告内置书目数');
  assert.equal(first.books.length, BUNDLED_NAMES.length, '内置书目必须自动装进书架');
  for (const name of BUNDLED_NAMES) {
    assert.ok(first.books.some((b) => b.name === name), '缺少内置书目：' + name);
  }
  /* 路径必须落在插件数据目录，绝不写死本机绝对路径 */
  for (const b of first.books) {
    assert.ok(b.path.startsWith(dataDir + path.sep), '内置书目必须在数据目录内：' + b.path);
    assert.ok(await fileExists(b.path), '副本必须已落盘：' + b.path);
  }
  /* 幂等：再读一次不得重复 */
  const second = await ok('library.get');
  assert.equal(second.books.length, BUNDLED_NAMES.length, '重复读取不得重复装入');
  /* 副本在磁盘上：打开第一本必须真的能读 */
  const bundled = first.books[0];
  const openedBundled = await ok('book.open', { path: bundled.path });
  assert.equal(openedBundled.chapters.length, 4, '内置书目副本必须可读（简介 + 3 章）');
  /* 移除后不会自己回来 */
  await ok('library.remove', { id: bundled.id });
  const afterRemove = await ok('library.get');
  assert.equal(afterRemove.books.length, BUNDLED_NAMES.length - 1, '移除一本内置书后不得自动补回');
  /* 把剩下的也移除，让「已移除名单」挡住全部内置书目，
   * 这样后面的断言面对的是一个干净的空书架（removed-bundled.json 必须留着）。 */
  for (const b of afterRemove.books) await ok('library.remove', { id: b.id });
  assert.equal((await ok('library.get')).books.length, 0, '全部移除后书架应为空');
  await fs.rm(path.join(dataDir, 'books.json'), { force: true });
  await fs.rm(path.join(dataDir, 'books'), { recursive: true, force: true });
}

/* 书架 */
assert.deepEqual((await ok('library.get')).books, [], '沙箱里没有任何预置书目');
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
bigReq.url = '/novel-shelf/api/library.get';
bigReq.headers = { 'sec-fetch-site': 'same-origin' };
const bigRes = { setHeader() {}, end() {} };
await handler(bigReq, bigRes);
assert.equal(bigRes.statusCode, 413, '超限 body 必须被拒');

const getReq = Readable.from([]);
getReq.method = 'GET';
getReq.url = '/novel-shelf/api/library.get';
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

/* --------------------------------------------------------------- AI 陪读 */

/* 陪读状态默认关闭，且默认 5 分钟一档 —— 没开就不该产生任何 llm 调用 */
llmCalls.length = 0;
const comp0 = await ok('companion.get', { sessionId: 's1' });
assert.equal(comp0.enabled, false, '陪读默认关闭');
assert.equal(comp0.intervalMs, 300000, '默认 5 分钟一档');
assert.equal(comp0.style, 'roast', '默认毒舌风格');
assert.deepEqual(comp0.lines, []);
assert.equal(comp0.hasModel, true, '有默认模型时必须如实报 true');
assert.equal(llmCalls.length, 0, '拉状态不得调用模型');

/* 关着的时候 tick 不该调模型，也不该产出吐槽 */
const tickOff = await ok('companion.tick', {
  sessionId: 's1', chapterIndex: 0, chapterTitle: '第一章', excerpt: '正文。', percent: 0,
});
assert.equal(tickOff.fired, false, '关闭时 tick 不得产出吐槽');
assert.equal(tickOff.reason, 'off');

/* 开陪读：先落配置（默认关闭，必须显式开） */
await ok('companion.config', { sessionId: 's1', enabled: true });
assert.equal((await ok('companion.get', { sessionId: 's1' })).enabled, true);

/* 开启后第一次 tick 就触发（lastLineAt 初值为 0） */
llmCalls.length = 0;
const tick1 = await ok('companion.tick', {
  sessionId: 's1', chapterIndex: 1, chapterTitle: '第二章', excerpt: '正文二。', percent: 50,
});
assert.equal(tick1.fired, true, '开启后第一次 tick 应触发');
assert.equal((await ok('companion.get', { sessionId: 's1' })).lines.length, 1);

/* 真实宿主踩过的坑：默认 effort 是 high，几百字吐槽会被推理吃光预算返回空。
 * 所以必须主动压到模型公示的最低档。 */
assert.equal(llmCalls.length, 1, '一次触发只调一次模型');
assert.equal(llmCalls[0].reasoningEffort, 'low', '必须把推理档压到模型公示的最低档');
assert.ok(Array.isArray(llmCalls[0].messages), 'messages 必须是数组');
const sent = llmCalls[0].messages[0] || {};
assert.equal(sent.role, 'user', '用户消息必须带 user 角色');
assert.ok(Array.isArray(sent.content) && sent.content[0] && sent.content[0].type === 'text',
  'content 必须是 block 数组，裸字符串宿主可能判成空消息');
assert.equal(typeof llmCalls[0].system, 'string', 'system prompt 必须下发');
assert.equal((await ok('companion.get', { sessionId: 's1' })).lines[0].chapterTitle, '第二章');

/* 配置写进共享 settings.json，重启后仍在 */
await ok('companion.config', { sessionId: 's1', intervalMs: 60000, style: 'detective' });
const compCfg = await ok('companion.get', { sessionId: 's1' });
assert.equal(compCfg.intervalMs, 60000);
assert.equal(compCfg.style, 'detective');
const settingsJson = JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'));
assert.equal(settingsJson.companion && settingsJson.companion.intervalMs, 60000, '陪读配置必须落盘');
assert.equal(settingsJson.companion.style, 'detective');

/* 非法配置必须被拒或夹紧，不得把状态改坏。
 * 非数字（NaN）报错；负数/天文数字夹到 [30s, 24h] 区间 —— 夹紧比报错友好。 */
assert.equal((await post('companion.config', { sessionId: 's1', intervalMs: 'abc' })).json.error.code, 'bad-request');
assert.equal((await post('companion.config', { sessionId: 's1', style: 'mean' })).json.error.code, 'bad-request');
assert.equal((await post('companion.config', { sessionId: 's1', enabled: 'yes' })).json.error.code, 'bad-request');
assert.equal((await ok('companion.config', { sessionId: 's1', intervalMs: -1 })).intervalMs, 30000, '负数夹到下限');
assert.equal((await ok('companion.config', { sessionId: 's1', intervalMs: 1e12 })).intervalMs, 86400000, '天文数字夹到上限');
assert.equal((await ok('companion.get', { sessionId: 's1' })).style, 'detective', '非法配置不得改坏风格');

/* 间隔门控：改回默认 5 分钟后，同样的位置再 tick 必须被挡下且不再调模型 */
llmCalls.length = 0;
const tick2 = await ok('companion.tick', {
  sessionId: 's1', chapterIndex: 2, chapterTitle: '第三章', excerpt: '正文三。', percent: 50,
});
assert.equal(tick2.fired, false, '间隔没到不得触发');
assert.ok(tick2.reason === 'waiting', '间隔没到应报 waiting');
assert.equal(llmCalls.length, 0, '被门控挡下不得调用模型');
assert.equal((await ok('companion.get', { sessionId: 's1' })).lines.length, 1, '被门控挡下不得新增吐槽');
await ok('companion.config', { sessionId: 's1', intervalMs: 300000 });

/* 手动触发（现在就说）：绕过间隔门控 */
const nudged = await ok('companion.nudge', {
  sessionId: 's1', chapterIndex: 2, chapterTitle: '第三章', excerpt: '正文三。',
});
assert.equal(typeof nudged.line.text, 'string', 'nudge 必须返回一句吐槽');
assert.ok(nudged.line.text.length > 0, '吐槽不能是空串');
assert.equal((await ok('companion.get', { sessionId: 's1' })).lines.length, 2, 'nudge 必须落一条');

/* 模型一句不吐时，nudge 必须如实报错，而不是塞一条空的进去 */
llmCalls.length = 0;
const emptyLlm = fakeLlm;
emptyLlm.stream = async function* () { yield { type: 'text-delta', text: '   ' }; };
const emptyRes = await post('companion.nudge', { sessionId: 's1', excerpt: '正文三。' });
assert.equal(emptyRes.json.error.code, 'empty-response', '模型空回复必须报错而非落一条空吐槽');
assert.equal((await ok('companion.get', { sessionId: 's1' })).lines.length, 2, '空回复不得新增条目');
emptyLlm.stream = async function* (spec) {
  llmCalls.push(spec);
  yield { type: 'text-delta', text: '这一段有点东西，' };
  yield { type: 'text-delta', text: '但不多。' };
};

/* 真实宿主踩过的坑：workbuddy/hy3 这类模型压根不公示 reasoning 元数据，
 * 此时宿主 must NOT 自作主张塞任何 effort —— 传了就会被 UNSUPPORTED_REASONING_EFFORT
 * 打回来，一个字正文都不吐（实测报错 `does not support reasoning effort "[object Object]"`）。 */
llmCalls.length = 0;
const noReasoningLlm = fakeLlm;
const savedResolve = noReasoningLlm.resolveModelInfo;
noReasoningLlm.resolveModelInfo = async () => ({ provider: 'deepseek', model: 'no-reasoning' });
const noEffort = await post('companion.nudge', { sessionId: 's1', excerpt: '正文三。' });
assert.equal(noEffort.json.ok, true, '不公示 reasoning 的模型也必须能出吐槽');
assert.ok(!('reasoningEffort' in llmCalls.at(-1)), '模型不公示 reasoning 时不得携带 reasoningEffort 字段');
noReasoningLlm.resolveModelInfo = savedResolve;

/* 清空 */
await ok('companion.clear', { sessionId: 's1' });
assert.equal((await ok('companion.get', { sessionId: 's1' })).lines.length, 0);

/* 关掉之后 tick 又变静默 */
await ok('companion.config', { sessionId: 's1', enabled: false });
const tickOff2 = await ok('companion.tick', {
  sessionId: 's1', chapterIndex: 2, chapterTitle: '第三章', excerpt: '正文三。', percent: 60,
});
assert.equal(tickOff2.fired, false);
assert.equal(tickOff2.reason, 'off');

/* 不同 session 的状态互相隔离 */
const other = await ok('companion.get', { sessionId: 's2' });
assert.equal(other.enabled, false, '另一个会话不得继承开启状态');
assert.equal(other.intervalMs, 300000, '另一个会话不得继承自定义间隔');

await fs.rm(sandbox, { recursive: true, force: true });
console.log('hosttest: all assertions passed');

/* ------------------------------------------------------------------ */
/* 模型选择                                                           */
/* ------------------------------------------------------------------ */

/* 桩上补 llm.listProviders / listModels：真实宿主有这两个方法，
 * 少了就只显示自定义端点那一支（面板不能让读者卡死）。 */
fakeLlm.listProviders = async () => ([
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'workbuddy', name: 'WorkBuddy' },
  { id: '', name: '无名 provider' },
]);
fakeLlm.listModels = async (id) => (id === 'deepseek'
  ? [{ id: 'deepseek-chat', name: 'Chat' }, { id: 'deepseek-reasoner', name: 'Reasoner' }, { id: null }]
  : id === 'deepseek-official'
    ? []
    : [{ id: 'hy3', name: 'HY3' }]);

/* 声明式 provider 目录也要合进来。
   真实宿主里 DeepSeek 的两个路由（账号 / API Key）先 registerConfigurableProviders
   声明自己，等用户登录或填了 key 才有 adapter、才有模型列表。
   只读 listProviders 的话，读者在面板里根本看不到「DeepSeek」这个选项。 */
fakeLlm.listConfigurableProviders = async () => ([
  { provider: 'deepseek-account', displayName: 'DeepSeek Account', settingsNs: 'llm-deepseek-account', settingsPath: [] },
  { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek-api-key', settingsPath: [], error: 'api key missing' },
  { provider: 'deepseek', displayName: '重复项' },
]);
const merged = await ok('model.options');
assert.ok(merged.providers.some((p) => p.id === 'deepseek-account'),
  '声明式 provider 必须在列表里（否则读者看不到 DeepSeek 账号登录这条路）');
assert.ok(merged.providers.some((p) => p.id === 'deepseek-official'),
  'API Key 版 DeepSeek 也必须在列表里');
assert.equal(merged.providers.filter((p) => p.id === 'deepseek').length, 1, '同一个 provider 不得出现两次');
const official = merged.providers.find((p) => p.id === 'deepseek-official');
assert.equal(official.error, 'api key missing', 'provider 自带的错误信息要带给界面');
assert.equal(official.models.length, 0, '没有 key 时列不出模型是正常的');
delete fakeLlm.listConfigurableProviders;

const mopts = await ok('model.options');
assert.deepEqual(mopts.providers.map((p) => p.id), ['deepseek', 'workbuddy'], 'provider 列表必须过滤掉没有 id 的');
assert.deepEqual(mopts.providers[0].models.map((m) => m.id), ['deepseek-chat', 'deepseek-reasoner'], '模型列表必须过滤掉没有 id 的');
assert.equal(mopts.providers[1].models[0].id, 'hy3', '第二个 provider 的模型必须列出来');
assert.equal(mopts.defaultModel.provider, 'deepseek', '默认模型来自 agentDefaultModel');
assert.deepEqual(mopts.saved, { provider: '', model: '', baseURL: '', apiKey: '' }, '没存过时必须是空选择');

/* 存一个 DSH 站内模型 */
assert.deepEqual((await ok('model.save', { provider: 'workbuddy', model: 'hy3' })).saved,
  { provider: 'workbuddy', model: 'hy3', baseURL: '', apiKey: '' });
assert.equal((await ok('model.options')).saved.model, 'hy3', 'model.save 必须落盘');

/* 存过的选择必须真的用上：吐槽请求的 provider/model 跟着变 */
llmCalls.length = 0;
await ok('companion.config', { sessionId: 's3', enabled: true });
await ok('companion.nudge', { sessionId: 's3', excerpt: '正文一。' });
assert.equal(llmCalls.at(-1).provider, 'workbuddy', '存了 provider 就必须传给 llm.stream');
assert.equal(llmCalls.at(-1).model, 'hy3', '存了 model 就必须传给 llm.stream');

/* 空字段 = 回到跟随 DSH 默认 */
await ok('model.save', { provider: '', model: '' });
assert.equal((await ok('model.options')).saved.model, '', '空字段表示跟随默认');
llmCalls.length = 0;
await ok('companion.nudge', { sessionId: 's3', excerpt: '正文一。' });
assert.equal(llmCalls.at(-1).provider, 'deepseek', '没存选择时必须用 DSH 默认模型');
assert.equal(llmCalls.at(-1).model, 'deepseek-chat');

/* 自定义端点：三项齐全才收，缺一个都要说清缺谁 */
assert.equal((await post('model.save', { baseURL: 'https://api.example.com/v1' })).json.error.code, 'bad-request');
assert.equal((await post('model.save', { apiKey: 'sk-x' })).json.error.code, 'bad-request');
assert.equal((await post('model.save', {
  baseURL: 'https://api.example.com/v1', apiKey: 'sk-x',
})).json.error.code, 'bad-request', '只填 baseURL + key 不收：会发到没有模型名的地址上');
assert.match((await post('model.save', { baseURL: 'https://a.com', apiKey: 'k' })).json.error.message, /模型名/,
  '报错要说清缺的是模型名');
assert.match((await post('model.save', { baseURL: 'notaurl', apiKey: 'k', model: 'm' })).json.error.message,
  /http/, 'baseURL 必须校验协议');
assert.equal((await post('model.save', { apiKey: 'sk-x', model: 'm', baseURL: 'ftp://a.com' })).json.error.code,
  'bad-request', 'ftp 这类协议必须拒');
assert.equal((await post('model.save', { baseURL: 'https://api.example.com', apiKey: 'k', model: 'm' })).json.ok, true,
  'http(s) 根地址（不带 /v1）必须收');

/* 自定义端点存盘后，吐槽改走 fetch，不再动宿主 llm */
const realFetch = globalThis.fetch;
const seenBodies = [];
const seenInits = [];
globalThis.fetch = async (url, init) => {
  seenBodies.push({ url: String(url), body: JSON.parse(String(init.body)) });
  seenInits.push(init);
  /* 真实端点是 SSE：data: 行 + 空行分段，末行 [DONE]。
   * 桩必须按这个形状返回，否则等于没测到 SSE 解析路径。 */
  const sse = [
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '自定义端点' } }] }), '',
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '说话了。' } }] }), '',
    'data: [DONE]', '',
    '',
  ].join('\n');
  const encoder = new TextEncoder();
  return {
    ok: true,
    body: {
      getReader() {
        let i = 0;
        const chunks = [sse];
        return {
          async read() { return i < chunks.length ? { done: false, value: encoder.encode(chunks[i++]) } : { done: true, value: undefined }; },
          cancel() {},
        };
      },
    },
  };
};
try {
  await ok('model.save', { baseURL: 'https://api.example.com/v1', apiKey: 'sk-secret', model: 'my-model' });
  llmCalls.length = 0;
  const custom = await ok('companion.nudge', { sessionId: 's3', excerpt: '正文一。' });
  assert.equal(custom.line.text, '自定义端点说话了。', '自定义端点必须真的被调用');
  assert.equal(llmCalls.length, 0, '自定义端点不得再走宿主 llm');
  assert.equal(seenBodies.at(-1).url, 'https://api.example.com/v1/chat/completions');
  assert.equal(seenBodies.at(-1).body.model, 'my-model');
  assert.equal(seenBodies.at(-1).body.authorization, undefined, 'key 走 Authorization 头，不塞 body');
  assert.ok(seenBodies.at(-1).body.messages.length >= 2, '请求必须带 system + user 两条');
  assert.equal(seenBodies.at(-1).body.stream, true, '自定义端点必须走 SSE 流式');
  const authHeader = seenInits.at(-1).headers;
  assert.ok(authHeader && String(authHeader.authorization).startsWith('Bearer '), 'key 必须走 Authorization: Bearer');

  const tested = await ok('model.test');
  assert.equal(tested.source, 'custom', 'model.test 必须报告走的是自定义端点');
  assert.equal(tested.sample, '自定义端点说话了。');
} finally {
  globalThis.fetch = realFetch;
}

/* SSE 拆包要按空行分段：把两段塞进同一个 chunk，也必须是两条完整文本 */
globalThis.fetch = async (url, init) => {
  seenBodies.push({ url: String(url), body: JSON.parse(String(init.body)) });
  const sse = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '甲' } }] }) + '\n\n'
    + 'data: ' + JSON.stringify({ choices: [{ delta: { content: '乙' } }] }) + '\n\n'
    + 'data: [DONE]\n\n';
  const encoder = new TextEncoder();
  return {
    ok: true,
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: encoder.encode(sse) };
          },
          cancel() {},
        };
      },
    },
  };
};
try {
  const oneShot = await ok('companion.nudge', { sessionId: 's3', excerpt: '正文二。' });
  assert.equal(oneShot.line.text, '甲乙', '一个 chunk 里的多段 SSE 必须全部拆出来');
} finally {
  globalThis.fetch = realFetch;
}

/* 自定义端点 HTTP 报错时，nudge 必须把状态码说出来 */
const linesBeforeDenied = (await ok('companion.get', { sessionId: 's3' })).lines.length;
globalThis.fetch = async () => ({ ok: false, status: 401, statusText: 'Unauthorized', async text() { return 'bad key'; } });
try {
  const denied = await post('companion.nudge', { sessionId: 's3', excerpt: '正文三。' });
  assert.equal(denied.json.ok, false, '自定义端点 401 必须报错');
  assert.match(denied.json.error.message, /401/, '报错要带 HTTP 状态码');
  assert.equal((await ok('companion.get', { sessionId: 's3' })).lines.length, linesBeforeDenied,
    '失败不得落一条空吐槽');
} finally {
  globalThis.fetch = realFetch;
}

/* reset：清掉插件存的模型偏好（连同 key） */
await ok('companion.config', { sessionId: 's3', intervalMs: 60000 });
await ok('model.reset');
assert.equal((await ok('model.options')).saved.apiKey, '', 'reset 必须把 key 一起清掉');
const settingsAfterReset = JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'));
assert.equal(settingsAfterReset.model.apiKey, '', 'key 必须真的从磁盘上消失');
assert.equal(settingsAfterReset.companion.intervalMs, 60000, 'model.reset 不得抹掉其它设置');

/* lastBookId 与模型偏好互不干扰：一次 book.save 之后再 reset，
 * 上次读的书必须还在（否则重开面板时书签位置就丢了）。 */
const { createHash } = await import('node:crypto');
const bookIdOfFor = (p) => createHash('md5').update(path.resolve(p)).digest('hex').slice(0, 16);
await ok('model.save', { provider: 'workbuddy', model: 'hy3' });
await ok('book.save', { path: bookPath, progress: { chapterIndex: 2, scrollRatio: 0.5 } });
const withLast = JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'));
assert.equal(withLast.lastBookId, bookIdOfFor(bookPath), 'book.save 必须记下 lastBookId');
await ok('model.reset');
const stillThere = JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'));
assert.equal(stillThere.lastBookId, bookIdOfFor(bookPath), 'reset 后 lastBookId 必须还在');

/* 站内模型走 model.test：桩 llm 有回应才算通 */
const siteTest = await ok('model.test');
assert.equal(siteTest.source, 'default', '跟随默认时应报告走 DSH 默认模型');
assert.ok(siteTest.sample.length > 0, 'model.test 要带回一句样本');

/* 只有 provider/model 没有自定义端点时，source 报 picked */
await ok('model.save', { provider: 'deepseek', model: 'deepseek-chat' });
const pickedTest = await ok('model.test');
assert.equal(pickedTest.source, 'picked', '显式挑了站内模型时应报 picked');

/* 什么都没配（宿主也没有默认模型）时，必须明确报错而不是崩 */
const savedSelection = fakeDefaultModel.currentSelection;
fakeDefaultModel.currentSelection = () => undefined;
await ok('model.reset');
const noRoute = await post('model.test');
assert.equal(noRoute.json.error && noRoute.json.error.code, 'no-model', '没有可用模型时必须报 no-model');
fakeDefaultModel.currentSelection = savedSelection;

/* 模型报错（401/额度用尽这类）时，model.test 必须把「哪个路由不通」和
 * 「为什么不通」一起报出来。只说「模型没有返回内容」的话，
 * 用户只会以为插件坏了，实际往往是他自己填的 key 无效。 */
const failingLlm = fakeLlm;
const savedStream = failingLlm.stream;
failingLlm.stream = async function* () {
  yield {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: { message: 'Authentication Fails, Your api key: ****8cc4 is invalid', code: 'AUTH', status: 401 },
    },
  };
};
await ok('model.save', { provider: 'deepseek-official', model: 'deepseek-flash' });
const failedTest = await post('model.test');
assert.equal(failedTest.json.error && failedTest.json.error.code, 'model-failed', '模型报错必须归类为 model-failed');
assert.ok(
  String(failedTest.json.error.message).includes('deepseek-official/deepseek-flash'),
  '报错必须带出是哪个路由不通，实际：' + String(failedTest.json.error && failedTest.json.error.message),
);
assert.ok(
  String(failedTest.json.error.message).includes('invalid'),
  '报错必须带出模型的真实原因，实际：' + String(failedTest.json.error && failedTest.json.error.message),
);
failingLlm.stream = savedStream;
