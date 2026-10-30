'use strict';

/**
 * Client 半真实验证。不造任何宿主私有 API 的替身：只按实况提供
 * window / document / fetch / React 和一个「只含真服务」的 ctx，
 * 然后断言 factory 被 Loader 调用、apply 跑通、右栏 tab 注册成功、
 * 主题状态在书架与阅读页之间不丢、切换主题会请求 settings.save。
 *
 *   node test/smoke.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

/* 真实 client ctx 有 ctx.inject(names, cb) —— agent-teams/deck 都用它等
 * sidebarRightTabs 这类「先声明座位、后提供服务」的可选服务。 */
const ctxHasInject = true;

/* ------------------------------------------------------------------ */
/* DOM / Host 桩：只实现 client.js 真实用到的那几个面                    */
/* ------------------------------------------------------------------ */

const head = [];
const sheets = new Map();

globalThis.document = {
  baseURI: 'http://127.0.0.1:56484/',
  head: { appendChild: (el) => head.push(el) },
  createElement: (tag) => {
    if (tag !== 'style') throw new Error(`unexpected element: ${tag}`);
    const el = { dataset: {}, textContent: '' };
    sheets.set('pending', el);
    return el;
  },
  querySelector(sel) {
    if (sel.includes('pluginCss')) {
      for (const el of head) if (el.dataset && el.dataset.pluginCss) return el;
    }
    return null;
  },
};
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.requestAnimationFrame = (fn) => fn();

/* fetch 记录调用，按方法名回放固定响应 */
const requests = [];
globalThis.fetch = async (url, init) => {
  const method = String(url).split('/').pop();
  const body = init && init.body ? JSON.parse(init.body) : {};
  requests.push({ method, url: String(url), body, init });
  /* 真实 host 里 companion.config 有记忆：写进去的 enabled/style
     之后 companion.get 会读出来。桩要照做，否则测的是假绿。 */
  if (method === 'companion.config') {
    if (typeof body.enabled === 'boolean') companionState.enabled = body.enabled;
    if (typeof body.intervalMs === 'number') companionState.intervalMs = body.intervalMs;
    if (typeof body.style === 'string') companionState.style = body.style;
  }
  if (method === 'companion.clear') companionState.lines = [];
  const entry = RESPONSES[method];
  /* byBody 给需要看请求体的桩用（library.scan 要看 dir，library.add 要看 path） */
  const value = entry && entry.byBody
    ? entry.byBody(body)
    : (entry && entry.byIndex ? entry.byIndex(body.index || 0) : (entry ? entry.value : undefined));
  const text = JSON.stringify(entry && entry.ok === false
    ? { ok: false, error: { code: 'e', message: entry.message } }
    : { ok: true, value: value || {} });
  return { status: 200, text: async () => text };
};

/* 陪读状态是「有记忆」的：真实 host 里 companion.config 会把 enabled/style
   记下来，之后 companion.get 再读出来。桩必须同样有状态，
   否则「开启陪读」这一段永远读回 enabled:false，
   自动说话那条链路根本走不到，测试就成了假绿。 */
const companionState = {
  enabled: false, intervalMs: 300000, style: 'roast', lines: [], pending: false, hasModel: true, error: '',
};

const RESPONSES = {
  'library.get': { value: { books: [{ id: 'b1', name: '测试书', path: 'C:/a.txt', size: 2048 }], settings: { theme: 'sepia', fontSize: 21 }, themes: ['day', 'eye', 'sepia', 'dark', 'black'] } },
  'book.open': { value: { id: 'b1', name: '测试书', path: 'C:/a.txt', encoding: 'UTF-8', chapters: [{ title: '第一章' }, { title: '第二章' }], progress: { chapterIndex: 0, scrollRatio: 0 }, settings: { fontSize: 21, lineHeight: 1.9, theme: 'sepia' } } },
  // 真实 host 按请求的 index 返回对应章节。桩必须同样按 index 回，
  // 否则「翻章」用例里 index 变了、章名不变，断言会测出假失败。
  'book.chapter': { byIndex: (i) => ({ index: i, title: `第${'一二三四五六七八九十'[i] || i}章`, paragraphs: [{ index: 0, text: '正文', meta: false }], highlights: [] }) },
  'book.save': { value: { saved: true } },
  'book.search': { value: { results: [], total: 0 } },
  'settings.save': { value: {} },
  /* 导入三条路要用的桩。library.scan 按 dir 分档返回：
     无参 = 主目录（一个子目录、没有 txt），带 novels 路径 = 两个 txt。
     让「进子目录 / 上一层 / 主目录 / 列出 txt / 导入」都真跑一遍。 */
  'library.scan': {
    byBody: (body) => {
      const dir = String(body.dir || '');
      if (dir.endsWith('novels')) {
        return {
          path: 'C:\\Users\\me\\novels',
          parent: 'C:\\Users\\me',
          home: 'C:\\Users\\me',
          dirs: [],
          entries: [
            { name: '甲.txt', path: 'C:\\Users\\me\\novels\\甲.txt', size: 2048 },
            { name: '乙.txt', path: 'C:\\Users\\me\\novels\\乙.txt', size: 3145728 },
          ],
        };
      }
      return {
        path: 'C:\\Users\\me',
        parent: 'C:\\',
        home: 'C:\\Users\\me',
        dirs: [{ name: 'novels', path: 'C:\\Users\\me\\novels' }],
        entries: [],
      };
    },
  },
  'library.upload': {
    byBody: (body) => ({
      added: !String(body.name || '').includes('dup'),
      path: 'C:\\Users\\me\\AppData\\Roaming\\novel-reader\\imported\\abc-' + String(body.name || 'x.txt'),
      books: [{ id: 'up1', name: String(body.name || 'x.txt'), path: 'C:/up.txt', size: 100 }],
    }),
  },
  'library.add': {
    byBody: (body) => ({
      added: !String(body.path || '').includes('dup'),
      path: body.path,
      books: [{ id: 'add1', name: '按路径加的书', path: body.path, size: 100 }],
    }),
  },
  'library.remove': { value: { books: [] } },
  'reader.session.get': { value: {} },
  'reader.session.set': { value: {} },
  'companion.get': { get value() { return { ...companionState }; } },
  'companion.config': { value: {} },
  'companion.nudge': { value: {} },
  'companion.clear': { value: {} },
  'companion.tick': { value: { fired: false, reason: 'not-due' } },
  'model.options': {
    value: {
      providers: [
        { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }] },
        { id: 'deepseek-account', name: 'DeepSeek Account', models: [], error: '还没登录 DeepSeek 账号' },
        { id: 'workbuddy-global', name: 'WorkBuddy', models: [{ id: 'hy3', name: 'HY3' }] },
      ],
      current: { provider: '', model: '' },
    },
  },
  'model.save': { value: { saved: true } },
  'model.reset': { value: { saved: true } },
  'model.test': { value: { ok: true, message: '通了' } },
};

const loaded = [];
globalThis.window.__ModuleLoader__ = {
  load(spec) {
    loaded.push(spec);
    // 宿主 Loader 的契约：factory 必须返回模块对象
    spec.loaded = spec.factory((name) => {
      if (name === 'react') return ReactStub;
      throw new Error(`unexpected require: ${name}`);
    });
  },
};

/* --------------------------------------------------------------- */
/* 极简 React：够 client.js 跑起来、能驱动 hook、能触发交互          */
/* --------------------------------------------------------------- */

let cursor = 0;
let current = null;

/* hook 状态必须跨渲染存活（真实 React 就是这样）：按组件类型存一份 */
const states = new Map();

function beginComponent(type) {
  if (!states.has(type)) states.set(type, []);
  current = { slots: states.get(type), effects: [], type };
  cursor = 0;
  seenThisPass.add(type);
}

const ReactStub = {
  createElement(type, props, ...children) {
    const merged = { ...(props || {}) };
    if (children.length) merged.children = children.length === 1 ? children[0] : children;
    return { $$el: true, type, props: merged };
  },
  useState(initial) {
    const i = cursor++;
    if (!current.slots[i]) {
      current.slots[i] = { v: typeof initial === 'function' ? initial() : initial };
    }
    const cell = current.slots[i];
    return [cell.v, (next) => { cell.v = typeof next === 'function' ? next(cell.v) : next; }];
  },
  useRef(initial) {
    const i = cursor++;
    if (!current.slots[i]) current.slots[i] = { v: { current: initial } };
    return current.slots[i].v;
  },
  useMemo(fn, deps) {
    // 真 React 的 useMemo 在 deps 不变时返回同一个引用；桩若每次都新算，
    // 依赖它的 useEffect 就会误判成「变了」，于是每帧重挂载陪读面板。
    const i = cursor++;
    const cell = current.slots[i] || (current.slots[i] = { v: undefined, deps: undefined });
    if (cell.v === undefined || depsChanged(cell.deps, deps)) cell.v = fn();
    cell.deps = deps;
    return cell.v;
  },
  useCallback(fn, deps) {
    // 同理：useCallback 必须保持引用稳定。
    const i = cursor++;
    const cell = current.slots[i] || (current.slots[i] = { v: undefined, deps: undefined });
    if (cell.v === undefined || depsChanged(cell.deps, deps)) cell.v = fn;
    cell.deps = deps;
    return cell.v;
  },
  useEffect(fn, deps) { current.effects.push({ fn, deps, i: cursor++, cleanup: null }); },
};

function depsChanged(a, b) {
  if (!a || !b || a.length !== b.length) return true;
  return a.some((v, i) => v !== b[i]);
}

/** 渲染一棵树：递归跑组件、收集 effect，返回带 render 能力的 root。 */
async function render(element, depth = 0) {
  if (element == null || element === false) return { text: '', node: null, children: [] };
  if (typeof element === 'string' || typeof element === 'number') {
    return { text: String(element), node: null, children: [] };
  }
  if (Array.isArray(element)) {
    const parts = [];
    for (const child of element) parts.push(await render(child, depth));
    return { text: parts.map((p) => p.text).join(''), node: element, children: parts };
  }
  if (typeof element.type === 'function') {
    beginComponent(element.type);
    const mine = current;
    const out = element.type(element.props);
    // 立刻抓住本组件的 effect 列表：渲染子树会覆盖全局游标
    const effects = mine.effects.slice();
    const rendered = await render(out, depth + 1);
    current = null;
    for (const e of effects) {
      // React 按「组件 + hook 序号」比对 deps，不是按函数身份
      // （每次渲染都是新闭包，用 fn 当 key 会让 deps 永远算成「变了」）
      const key = `${mine.type.name || 'anon'}#${e.i}`;
      const prevCleanup = effectCleanups.get(key);
      if (e.deps === undefined || e.deps === null) {
        if (prevCleanup) { try { prevCleanup(); } catch { /* ignore */ } }
        e.cleanup = e.fn();
      } else if (depsChanged(effectDeps.get(key), e.deps)) {
        // 真 React：依赖变了先跑上一次的清理，再跑新的 effect
        if (prevCleanup) { try { prevCleanup(); } catch { /* ignore */ } }
        e.cleanup = e.fn();
      }
      effectDeps.set(key, e.deps);
      if (typeof e.cleanup === 'function') effectCleanups.set(key, e.cleanup);
    }
    return rendered;
  }
  const kids = element.props && element.props.children;
  const parts = [];
  if (kids !== undefined) {
    if (Array.isArray(kids)) for (const k of kids) parts.push(await render(k, depth));
    else parts.push(await render(kids, depth));
  }
  return { text: parts.map((p) => p.text).join(''), node: element, children: parts };
}

const effectDeps = new Map();
const effectCleanups = new Map();
/* 本轮渲染出现过的组件类型；和上一轮比，差集就是被卸载的组件。 */
let seenThisPass = new Set();
let seenLastPass = new Set();

/**
 * 一轮完整渲染结束：结算哪些组件被卸载了。
 * 真 React 里卸载 = 组件实例销毁、state 丢失、effect 清理函数被调用。
 * 桩按组件类型复用 state，就分不清「重渲染」和「重新挂载」——
 * 结果是关掉再打开陪读面板时 effect 不再执行，看起来像 host 收到了请求，
 * 其实一次都没发。这里补上卸载语义，让桩跟真 React 对齐。
 */
function finishPass() {
  for (const type of seenLastPass) {
    if (seenThisPass.has(type)) continue;
    const prefix = `${type.name || 'anon'}#`;
    for (const [key, fn] of Array.from(effectCleanups.entries())) {
      if (!key.startsWith(prefix)) continue;
      try { fn(); } catch { /* 清理失败不该让测试炸 */ }
      effectCleanups.delete(key);
    }
    states.delete(type);
    for (const key of Array.from(effectDeps.keys())) {
      if (key.startsWith(prefix)) effectDeps.delete(key);
    }
  }
  seenLastPass = new Set(seenThisPass);
  seenThisPass = new Set();
}

/** 顶层渲染一轮，并在结束时结算卸载。 */
async function renderPass(element) {
  const tree = await render(element, 0);
  finishPass();
  return tree;
}

/** 在渲染树里按 className 找元素节点。 */
function findAll(tree, className, out = []) {
  const n = tree && tree.node;
  if (n && n.props && typeof n.props.className === 'string'
    && n.props.className.split(/\s+/).includes(className)) out.push(n);
  for (const c of (tree && tree.children) || []) findAll(c, className, out);
  return out;
}

const flush = async () => { for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0)); };

/* --------------------------------------------------------------- 加载 */

const clientPath = path.resolve(process.cwd(), 'lib/client.js');
const tmp = path.resolve(process.cwd(), 'test', '.smoke-client.cjs');
await fs.mkdir(path.dirname(tmp), { recursive: true });
await fs.writeFile(tmp, await fs.readFile(clientPath, 'utf8'), 'utf8');
const { createRequire } = await import('node:module');
createRequire(import.meta.url)(tmp);

assert.equal(loaded.length, 1, 'client.js must call __ModuleLoader__.load once');
assert.equal(loaded[0].id, 'dsh-novel-shelf');
const mod = loaded[0].loaded;
assert.ok(mod, 'factory must return module.exports (Loader contract)');
assert.equal(typeof mod.apply, 'function', 'must export apply');
assert.ok(Array.isArray(mod.inject), 'must declare exports.inject');
console.log('✔ factory 返回了模块对象，exports.inject =', JSON.stringify(mod.inject));

const REAL_SERVICES = ['slots', 'locale', 'layout', 'sessions', 'theme', 'timer', 'workspaces', 'uiWorkspace', 'connection'];
for (const name of mod.inject) {
  assert.ok(REAL_SERVICES.includes(name), `exports.inject 只能填真服务名，收到 "${name}"（座位名不是服务名）`);
}

/* --------------------------------------------------------------- apply */

const registered = [];
const tabTypes = [];
const injected = [];

const ctx = {
  slots: {
    // session 作用域的座位只在属主 dispatch 时才交给组件。桩必须忠实于这一点，
    // 否则直接 register 的写法在测试里会绿、在真实浏览器里挂不上。
    _seats: {},
    /** 记录已 dispatch 的座位效果，供解除注入时回收。 */
    _effects: {},
    inject(seat, cb) {
      const list = (this._seats[seat] = this._seats[seat] || []);
      list.push(cb);
      return () => {
        // 真实宿主在解除注入时，会把每个已 dispatch 回调返回的
        // SlotInjectionEffect 跑一遍（于是座位里的组件被注销）。
        const at = list.indexOf(cb);
        if (at >= 0) list.splice(at, 1);
        for (const effect of this._effects[seat] || []) {
          try { effect(); } catch (error) { /* 已注销 */ }
        }
        this._effects[seat] = [];
      };
    },
    /** 属主 dispatch 座位：回调交出组件与清理函数。 */
    _dispatch(seat) {
      for (const cb of (this._seats[seat] || []).slice()) {
        const effect = cb();
        assert.equal(
          typeof effect,
          'function',
          '座位注入回调必须返回清理函数（SlotInjectionEffect）：' + seat,
        );
        (this._effects[seat] = this._effects[seat] || []).push(effect);
      }
    },
    register(definition, component) {
      registered.push({ name: definition.name, key: definition.key, component });
      return () => {
        const at = registered.findIndex((r) => r.component === component);
        if (at >= 0) registered.splice(at, 1);
      };
    },
  },
  get(key) {
    if (key === 'locale') return { getSnapshot: () => ({ active: 'zh' }), subscribe: () => () => {} };
    if (key === 'sidebarRightTabs') {
      return {
        register(def) {
          tabTypes.push(def);
          return () => { tabTypes.splice(tabTypes.indexOf(def), 1); };
        },
      };
    }
    return undefined;
  },
  effect(fn) {
    const dispose = fn();
    return typeof dispose === 'function' ? dispose : () => {};
  },
};
if (ctxHasInject) {
  // 真实契约：ctx.inject(names, cb) —— 服务到达时调用 cb(injectedCtx)，
  // injectedCtx 上带该服务本身（agent-teams: native.sidebarRightTabs）。
  ctx.inject = (names, cb) => {
    injected.push({ names, cb });
    if (Array.isArray(names) && names.indexOf('sidebarRightTabs') >= 0) {
      cb({ sidebarRightTabs: ctx.get('sidebarRightTabs'), slots: ctx.slots });
    }
    return () => {};
  };
}

const disposers = [];
const realEffect = ctx.effect.bind(ctx);
ctx.effect = (fn) => {
  const d = realEffect(fn);
  if (typeof d === 'function') disposers.push(d);
  return d;
};

mod.apply(ctx);

assert.equal(tabTypes.length, 1, 'right-sidebar tab type must be registered on first apply');
const tab = tabTypes[0];
assert.equal(tab.id, 'dsh-novel-shelf/reader');
assert.ok(tab.kind && tab.kind !== tab.id, 'kind 与 id 必须是两个不同字符串');
assert.ok(Array.isArray(tab.guide) && tab.guide.length === 1, 'guide entry required');
assert.equal(tab.guide[0].id, tab.id, 'guide 条目必须带 id，否则宿主静默降级');
assert.equal(tab.title(), '小说书架', '标题必须是中文');

/* 座位必须经 slots.inject 挂载，且在属主 dispatch 后才占位。 */
assert.equal(
  registered.length,
  0,
  'tab 类型注册后座位不应立刻占位：必须走 slots.inject',
);
for (const seat of ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']) {
  const pending = ctx.slots._seats[seat];
  assert.ok(Array.isArray(pending) && pending.length === 1, '座位必须 inject 到：' + seat);
}
/* 属主 dispatch 座位，组件才交出去。
 * 真实契约：slots.inject 的回调必须 return 一个清理函数（SlotInjectionEffect），
 * 返回 undefined 的注入是无效的 → 宿主显示「这类内容还没有可用的查看方式」。 */
for (const seat of ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']) {
  ctx.slots._dispatch(seat);
}

const seats = registered.map((r) => r.name);
assert.ok(seats.includes('sidebar.right.pane.tab'), 'tab body seat required');
assert.ok(seats.includes('sidebar.right.pane.tab.title'), 'tab title seat required');
for (const row of registered) assert.equal(row.key, tab.id, 'seats must be keyed by the tab id');
console.log('✔ 右栏 tab 类型 + 两个 keyed 座位注册成功:', seats.join(', '));

const BodyComponent = registered.find((r) => r.name === 'sidebar.right.pane.tab').component;

/* --------------------------------------------------------------- 渲染 + 主题 */

let tree = await renderPass(ReactStub.createElement(BodyComponent, {}));
await flush();
tree = await renderPass(ReactStub.createElement(BodyComponent, {}));
await flush();

assert.ok(requests.some((r) => r.method === 'library.get'), '挂载必须拉书架');
assert.ok(tree.text.includes('测试书'), '书架必须列出书名');

/* 书架页必须有五个主题按钮 */
let swatches = findAll(tree, 'nr-swatch');
assert.equal(swatches.length, 5, '书架页应有五个主题按钮，实际 ' + swatches.length);

/* 根容器带上 data-theme，且取自 settings.json */
let pane = findAll(tree, 'nr-pane')[0];
assert.equal(pane.props['data-theme'], 'sepia', '主题必须从 settings.json 读出');

/* 点第五个色板（纯黑）→ 本地立刻切换 + 发 settings.save
   顺序是 day/eye/sepia/dark/black；初始主题就是 sepia，所以要点 black 才看得出变化 */
requests.length = 0;
swatches = findAll(tree, 'nr-swatch');
assert.equal(swatches.length, 5);
swatches[4].props.onClick();
tree = await renderPass(ReactStub.createElement(BodyComponent, {}));
pane = findAll(tree, 'nr-pane')[0];
assert.equal(pane.props['data-theme'], 'black', '点第五个色板应切到 black');
await flush();
const saved = requests.filter((r) => r.method === 'settings.save');
assert.equal(saved.length, 1, '切主题必须写回一次 settings.save');
assert.equal(saved[0].body.theme, 'black');

/* 设置成功后刷新一次：主题应从 Host 读回（此处 Host 回 sepia 是桩的固定值，
   所以只验证请求发出与本地状态即时生效，不断言回读） */

/* --------------------------------------------------------------- 导入书籍 */

/* v0.3.0 的主功能：三条路加书。这段之前 smoke 一次都没点过导入面板。 */

requests.length = 0;
const plusBtn = findAll(tree, 'nr-btn').find((b) => b.props.title === '导入书籍');
assert.ok(plusBtn, '书架工具栏必须有「导入书籍」按钮');
plusBtn.props.onClick();
for (let i = 0; i < 4; i += 1) { await flush(); tree = await renderPass(ReactStub.createElement(BodyComponent, {})); }

/* --- 路 1：主视图（拖拽 + 选文件 + 浏览目录按钮） --- */
const card = findAll(tree, 'nr-import-card')[0];
assert.ok(card, '点「导入书籍」必须渲染导入卡片');
assert.ok(findAll(tree, 'nr-drop')[0], '主视图必须有拖拽区');
/* 拖拽事件挂在卡片上（nr-drop 是卡片内的视觉区块，事件从它冒泡上来） */
assert.equal(typeof card.props.onDragOver, 'function', '卡片必须接 onDragOver');
assert.equal(typeof card.props.onDrop, 'function', '卡片必须接 onDrop');
assert.equal(typeof card.props.onDragLeave, 'function', '卡片必须接 onDragLeave');
const fileInput = findAll(tree, 'nr-file-input')[0];
assert.ok(fileInput, '主视图必须有 file input');
assert.equal(fileInput.props.type, 'file');
assert.equal(fileInput.props.multiple, true, '必须允许多选');
assert.ok(String(fileInput.props.accept).includes('.txt'), 'file input 必须限定 .txt');

/* --- 选文件（点「选文件」→ 隐藏 input 的 onChange）也是走 library.upload --- */
requests.length = 0;
const pickTarget = { value: 'C:\\fakepath\\选进来的.txt' };
await fileInput.props.onChange({
  target: { files: [{ name: '选进来的.txt', size: 4096, arrayBuffer: async () => new ArrayBuffer(4096) }], ...pickTarget },
});
for (let i = 0; i < 4; i += 1) { await flush(); tree = await renderPass(ReactStub.createElement(BodyComponent, {})); }
const pickReq = requests.find((r) => r.method === 'library.upload');
assert.ok(pickReq, '选文件必须调 library.upload');
assert.equal(pickReq.body.name, '选进来的.txt');
assert.equal(findAll(tree, 'nr-import-card').length, 0, '选文件导入成功后应回到书架');

/* 多选：两个 txt 必须串行各发一次 */
requests.length = 0;
findAll(tree, 'nr-btn').find((b) => b.props.title === '导入书籍').props.onClick();
for (let i = 0; i < 4; i += 1) { await flush(); tree = await renderPass(ReactStub.createElement(BodyComponent, {})); }
await findAll(tree, 'nr-file-input')[0].props.onChange({
  target: { files: [
    { name: '一.txt', size: 10, arrayBuffer: async () => new ArrayBuffer(10) },
    { name: '二.txt', size: 20, arrayBuffer: async () => new ArrayBuffer(20) },
  ], value: '' },
});
for (let i = 0; i < 4; i += 1) { await flush(); tree = await renderPass(ReactStub.createElement(BodyComponent, {})); }
const multi = requests.filter((r) => r.method === 'library.upload');
assert.equal(multi.length, 2, '多选两个 txt 必须各发一次上传');
assert.deepEqual(multi.map((r) => r.body.name), ['一.txt', '二.txt'], '必须按选择顺序串行上传');

/* 重新打开面板，后面的拖拽用例从这里接着走 */
requests.length = 0;
findAll(tree, 'nr-btn').find((b) => b.props.title === '导入书籍').props.onClick();
for (let i = 0; i < 4; i += 1) { await flush(); tree = await renderPass(ReactStub.createElement(BodyComponent, {})); }

/* 拖进一个 txt：走 library.upload，成功后回书架 */
requests.length = 0;
await card.props.onDrop({
  preventDefault() {},
  dataTransfer: { files: [{ name: '拖进来的.txt', size: 1024, arrayBuffer: async () => new ArrayBuffer(1024) }] },
});
for (let i = 0; i < 4; i += 1) { await flush(); tree = await renderPass(ReactStub.createElement(BodyComponent, {})); }
const upReq = requests.find((r) => r.method === 'library.upload');
assert.ok(upReq, '拖入 txt 必须调 library.upload');
assert.equal(upReq.body.name, '拖进来的.txt');
assert.ok(typeof upReq.body.data === 'string' && upReq.body.data.length > 0, 'upload 必须带 base64 数据');
assert.equal(findAll(tree, 'nr-import-card').length, 0, '导入成功后应回到书架');

/* 非 txt 与空文件在客户端就拦掉，不许发请求 */
requests.length = 0;
findAll(tree, 'nr-btn').find((b) => b.props.title === '导入书籍').props.onClick();
for (let i = 0; i < 4; i += 1) { await flush(); tree = await renderPass(ReactStub.createElement(BodyComponent, {})); }
await findAll(tree, 'nr-import-card')[0].props.onDrop({
  preventDefault() {},
  dataTransfer: { files: [
    { name: '不是文本.md', size: 10, arrayBuffer: async () => new ArrayBuffer(10) },
    { name: '空的.txt', size: 0, arrayBuffer: async () => new ArrayBuffer(0) },
  ] },
});
await flush();
for (let i = 0; i < 4; i += 1) { await flush(); tree = await renderPass(ReactStub.createElement(BodyComponent, {})); }
assert.equal(requests.filter((r) => r.method === 'library.upload').length, 0, '非 txt / 空文件不得发上传请求');
assert.ok(findAll(tree, 'nr-error').length >= 1, '客户端拦截要给提示');

/* --- 路 2：浏览目录 --- */
requests.length = 0;
findAll(tree, 'nr-btn').find((b) => b.props.children === '浏览目录').props.onClick();
for (let i = 0; i < 4; i += 1) { await flush(); tree = await renderPass(ReactStub.createElement(BodyComponent, {})); }
const scanReq = requests.find((r) => r.method === 'library.scan');
assert.ok(scanReq, '点「浏览目录」必须调 library.scan');
assert.equal(scanReq.body.dir, '', '首次浏览应不传 dir（宿主回落主目录）');
assert.equal(findAll(tree, 'nr-brow-dir').length, 1, '主目录下应有一个子目录按钮');
assert.equal(findAll(tree, 'nr-brow-files').length, 0, '主目录没有 txt 时不该有文件列表');

/* 进子目录 → 列出两个 txt */
requests.length = 0;
findAll(tree, 'nr-brow-dir')[0].props.onClick();
for (let i = 0; i < 4; i += 1) { await flush(); tree = await renderPass(ReactStub.createElement(BodyComponent, {})); }
assert.equal(requests.find((r) => r.method === 'library.scan').body.dir, 'C:\\Users\\me\\novels', '点子目录要把该目录传上去');
const rows = findAll(tree, 'nr-brow-file');
assert.equal(rows.length, 2, '子目录里应有两条 txt');
assert.ok(rows[0].props.children[0].props.children.includes('甲'), '要显示文件名');
assert.ok(rows[0].props.children[1].props.children.includes('KB'), '要显示大小');

/* 导入其中一本：零复制，走 library.add(path) */
requests.length = 0;
const importBtns = findAll(tree, 'nr-btn').filter((b) => b.props.children === '导入');
assert.equal(importBtns.length, 2, '每个 txt 都要有「导入」按钮');
importBtns[0].props.onClick();
for (let i = 0; i < 4; i += 1) { await flush(); tree = await renderPass(ReactStub.createElement(BodyComponent, {})); }
const addReq = requests.find((r) => r.method === 'library.add');
assert.ok(addReq, '浏览目录导入必须调 library.add（零复制）');
assert.equal(addReq.body.path, 'C:\\Users\\me\\novels\\甲.txt', '必须传宿主给的绝对路径');
assert.ok(!requests.some((r) => r.method === 'library.upload'), '浏览导入不得上传字节');

/* 「上一层」「主目录」都要真发请求 */
requests.length = 0;
findAll(tree, 'nr-btn').find((b) => b.props.children === '上一层').props.onClick();
for (let i = 0; i < 4; i += 1) { await flush(); tree = await renderPass(ReactStub.createElement(BodyComponent, {})); }
assert.ok(requests.some((r) => r.method === 'library.scan' && r.body.dir === 'C:\\Users\\me'), '「上一层」要扫父目录');
requests.length = 0;
findAll(tree, 'nr-btn').find((b) => b.props.children === '主目录').props.onClick();
for (let i = 0; i < 4; i += 1) { await flush(); tree = await renderPass(ReactStub.createElement(BodyComponent, {})); }
assert.ok(requests.some((r) => r.method === 'library.scan' && r.body.dir === ''), '「主目录」要重扫主目录');

/* scan 失败要在面板里显示，不许把书架带崩 */
requests.length = 0;
const scanOriginal = RESPONSES['library.scan'];
RESPONSES['library.scan'] = { ok: false, message: '目录不存在：X' };
findAll(tree, 'nr-brow-dir')[0].props.onClick();
for (let i = 0; i < 4; i += 1) { await flush(); tree = await renderPass(ReactStub.createElement(BodyComponent, {})); }
assert.ok(findAll(tree, 'nr-error').length >= 1, 'scan 失败必须在面板内显示错误');
assert.equal(findAll(tree, 'nr-import-card').length, 1, 'scan 失败后导入面板仍在');
RESPONSES['library.scan'] = scanOriginal;

/* 关掉导入面板 → 回到书架 */
findAll(tree, 'nr-btn').find((b) => b.props.title === '关闭').props.onClick();
for (let i = 0; i < 4; i += 1) { await flush(); tree = await renderPass(ReactStub.createElement(BodyComponent, {})); }
assert.equal(findAll(tree, 'nr-import-card').length, 0, '关闭后导入面板应消失');
console.log('✔ 导入书籍三条路全部走通: 拖拽上传 / 浏览目录零复制 / 客户端拦截 / scan 失败提示');

/* 打开一本书：主题在阅读页不得丢 */
requests.length = 0;
findAll(tree, 'nr-item-main')[0].props.onClick();
for (let i = 0; i < 4; i += 1) { await flush(); tree = await renderPass(ReactStub.createElement(BodyComponent, {})); }
assert.ok(requests.some((r) => r.method === 'book.open'), '点书必须调 book.open');
pane = findAll(tree, 'nr-pane')[0];
assert.equal(pane.props['data-theme'], 'black', '进入阅读页主题不得回退');
swatches = findAll(tree, 'nr-swatch');
assert.equal(swatches.length, 5, '阅读页也要有五个主题按钮');
assert.ok(swatches[4].props.className.includes('is-on'), '当前主题要标记 is-on');
assert.equal(swatches[4].props['aria-pressed'], 'true');
assert.ok(swatches[0].props['aria-pressed'] === 'false');

/* 翻章 + 搜索：不许抛 */
requests.length = 0;
const nextBtn = findAll(tree, 'nr-btn').find((b) => b.props.children === '下一章');
nextBtn.props.onClick();
for (let i = 0; i < 4; i += 1) { await flush(); tree = await renderPass(ReactStub.createElement(BodyComponent, {})); }
assert.ok(requests.some((r) => r.method === 'book.chapter'), '翻章必须请求正文');

/* 字号改动必须写回 */
requests.length = 0;
const range = findAll(tree, 'nr-range')[0];
range.props.onChange({ target: { value: '26' } });
await flush();
assert.ok(requests.some((r) => r.method === 'settings.save' && r.body.fontSize === 26), '字号必须写回');

/* --------------------------------------------------------------- AI 陪读 */

/* 陪读面板默认收起：Reader 挂载时不许打任何「会花钱」的请求。
   注意陪读组件是常驻挂载的（面板开合只控制画不画 UI），
   所以 companion.get 这种读状态是允许的；真正不许出现的是
   companion.tick / companion.nudge —— 它们会真的调模型。 */
requests.length = 0;
for (let i = 0; i < 4; i += 1) { await flush(); tree = await renderPass(ReactStub.createElement(BodyComponent, {})); }
assert.ok(
  !requests.some((r) => r.method === 'companion.tick' || r.method === 'companion.nudge'),
  '陪读默认关闭：不得发起任何会调用模型的 companion.tick / companion.nudge',
);

/* 展开陪读面板 */
const compToggle = findAll(tree, 'nr-btn').find((b) => b.props.children === 'AI 陪读');
assert.ok(compToggle, '阅读页必须有「AI 陪读」开关按钮');
requests.length = 0;
compToggle.props.onClick();
for (let i = 0; i < 4; i += 1) { await flush(); tree = await renderPass(ReactStub.createElement(BodyComponent, {})); }
assert.ok(requests.some((r) => r.method === 'companion.get'), '展开陪读面板必须拉取状态');
const compBox = findAll(tree, 'nr-companion')[0];
assert.ok(compBox, '陪读面板必须渲染');

/* 间隔与风格下拉：选项数量与档位要对 */
const selects = findAll(tree, 'nr-select');
assert.equal(selects.length, 2, '陪读应有「间隔 + 风格」两个下拉');
assert.equal(selects[0].props.children.length, 4, '间隔应有 4 档');
assert.equal(selects[1].props.children.length, 4, '风格应有 4 种');

/* 切风格必须写回，且不得触发任何模型调用 */
requests.length = 0;
selects[1].props.onChange({ target: { value: 'detective' } });
await flush();
assert.ok(
  requests.some((r) => r.method === 'companion.config' && r.body.style === 'detective'),
  '切风格必须写回 companion.config',
);
assert.ok(
  !requests.some((r) => r.method === 'companion.nudge' || r.method === 'companion.tick'),
  '改配置不得顺手调用模型',
);

/* 开陪读：只发一次 config，host 才会在下一个轮询周期调模型 */
requests.length = 0;
const onBtn = findAll(tree, 'nr-btn').find((b) => b.props.children === '已关闭');
assert.ok(onBtn, '关闭态要显示「已关闭」按钮');
onBtn.props.onClick();
for (let i = 0; i < 4; i += 1) { await flush(); tree = await renderPass(ReactStub.createElement(BodyComponent, {})); }
assert.ok(
  requests.some((r) => r.method === 'companion.config' && r.body.enabled === true),
  '点开启必须写回 enabled=true',
);
/* 开关一开就该立刻说一句，不该让读者干等一个周期。 */
assert.ok(
  requests.some((r) => r.method === 'companion.tick'),
  '开启陪读必须立刻 tick 一次（自动说话）',
);
assert.ok(
  !requests.some((r) => r.method === 'companion.nudge'),
  '自动说话走 tick，不得冒充「现在就说」',
);

/* 「现在就说」必须把章号/章名/正文摘要一起报上去 */
requests.length = 0;
const nudgeBtn = findAll(tree, 'nr-btn').find((b) => b.props.children === '现在就说');
assert.ok(nudgeBtn, '必须有「现在就说」按钮');
nudgeBtn.props.onClick();
for (let i = 0; i < 4; i += 1) { await flush(); tree = await renderPass(ReactStub.createElement(BodyComponent, {})); }
const nudge = requests.find((r) => r.method === 'companion.nudge');
assert.ok(nudge, '点「现在就说」必须调 companion.nudge');
// 前面「翻章」用例已经把 index 推到 1，所以这里应报 1 / 第二章
assert.equal(nudge.body.chapterIndex, 1, 'nudge 必须报章号');
assert.equal(nudge.body.chapterTitle, '第二章', 'nudge 必须报章名');
assert.ok(typeof nudge.body.excerpt === 'string' && nudge.body.excerpt.length > 0, 'nudge 必须带正文摘要');

/* 陪读失败只显示错误，不许把阅读页带崩。
   注意：useCallback/useMemo 的引用现在稳定了（和真 React 一样），
   挂载 effect 不会每帧重跑 —— 所以要让「下一次拉状态」失败，
   必须把面板卸载再挂载（关掉 → 重新打开）。 */
requests.length = 0;
const companionGetOriginal = RESPONSES['companion.get'];
RESPONSES['companion.get'] = { ok: false, message: 'boom' };
findAll(tree, 'nr-btn').find((b) => b.props.children === 'AI 陪读').props.onClick();
for (let i = 0; i < 4; i += 1) { await flush(); tree = await renderPass(ReactStub.createElement(BodyComponent, {})); }
assert.equal(findAll(tree, 'nr-companion').length, 0, '关掉后陪读面板应卸载');
findAll(tree, 'nr-btn').find((b) => b.props.children === 'AI 陪读').props.onClick();
for (let i = 0; i < 4; i += 1) { await flush(); tree = await renderPass(ReactStub.createElement(BodyComponent, {})); }
assert.ok(requests.some((r) => r.method === 'companion.get'), '重新打开必须再拉一次状态');
assert.ok(findAll(tree, 'nr-error').length >= 1, '陪读出错要在面板内显示错误');
assert.ok(findAll(tree, 'nr-reader').length === 1, '陪读出错不得影响正文渲染');
RESPONSES['companion.get'] = companionGetOriginal;
Object.assign(companionState, { enabled: false, intervalMs: 300000, style: 'roast', lines: [], pending: false, hasModel: true, error: '' });

/* --------------------------------------------------------------- 悬浮人物 + 气泡 */

/* 陪读关着：右下角什么都不该出现（不能凭空多个图占地方） */
requests.length = 0;
for (let i = 0; i < 4; i += 1) { await flush(); tree = await renderPass(ReactStub.createElement(BodyComponent, {})); }
assert.equal(findAll(tree, 'nr-avatar').length, 0, '陪读未开启时不得出现悬浮人物');

/* 陪读开着且有吐槽：右下角出现人物 + 气泡 */
Object.assign(companionState, {
  enabled: true, intervalMs: 300000, style: 'roast', pending: false, hasModel: true, error: '',
  lines: [{ at: '2026-10-25T10:00:00Z', chapterIndex: 1, chapterTitle: '第二章', text: '这段有点水' }],
});
/* 面板当前是开着的（上一段重新打开过），先关掉再打开，
   让 Companion 重新挂载、去 host 拉一次新状态。 */
findAll(tree, 'nr-btn').find((b) => b.props.children === 'AI 陪读').props.onClick();
for (let i = 0; i < 4; i += 1) { await flush(); tree = await renderPass(ReactStub.createElement(BodyComponent, {})); }
findAll(tree, 'nr-btn').find((b) => b.props.children === 'AI 陪读').props.onClick();
for (let i = 0; i < 4; i += 1) { await flush(); tree = await renderPass(ReactStub.createElement(BodyComponent, {})); }
assert.ok(requests.some((r) => r.method === 'companion.get'), '重新打开必须再拉一次陪读状态');

/* 人物必须是 bundle 内的图（别人装上也有），不是本机绝对路径 */
const avatarNodes = findAll(tree, 'nr-avatar-img');
assert.equal(avatarNodes.length, 1, '悬浮人物必须渲染一个 img');
const img = avatarNodes[0];
assert.ok(
  String(img.props.src).includes('novel-shelf/assets/reader-avatar.png'),
  '人物图必须走插件自带静态路由，收到 ' + img.props.src,
);
assert.equal(img.props.alt, '陪读形象', '图片要有中文 alt');

/* 气泡默认展开，显示最新一条 + 章节定位 */
const bubble = findAll(tree, 'nr-avatar-bubble')[0];
assert.ok(bubble, '开启陪读后应显示吐槽气泡');
const bubbleTree = bubble ? (await render(bubble)) : null;
assert.ok(
  bubbleTree && bubbleTree.text.includes('这段有点水'),
  '气泡要显示最新一条吐槽，实际文本：' + JSON.stringify(bubbleTree && bubbleTree.text),
);
assert.ok(bubbleTree && bubbleTree.text.includes('第二章'), '气泡要带章节定位');

/* 点气泡收起：人物留着，气泡消失，且不该打任何请求 */
requests.length = 0;
bubble.props.onClick();
for (let i = 0; i < 4; i += 1) { await flush(); tree = await renderPass(ReactStub.createElement(BodyComponent, {})); }
assert.equal(findAll(tree, 'nr-avatar-bubble').length, 0, '点气泡应收起');
assert.equal(findAll(tree, 'nr-avatar').length, 1, '收起气泡后人物应仍在');
assert.ok(
  !requests.some((r) => String(r.method).startsWith('companion.')),
  '收起气泡只动本地状态，不该打请求',
);

/* 一条吐槽都没有时：不画气泡，连人物也不该出现（避免空占位）
   状态是随陪读面板挂载时从 host 拉来的，所以要先关再开，让它重新拉一次。 */
Object.assign(companionState, { enabled: true, intervalMs: 300000, style: 'roast', lines: [], pending: false, hasModel: true, error: '' });
findAll(tree, 'nr-btn').find((b) => b.props.children === 'AI 陪读').props.onClick();
for (let i = 0; i < 4; i += 1) { await flush(); tree = await renderPass(ReactStub.createElement(BodyComponent, {})); }
findAll(tree, 'nr-btn').find((b) => b.props.children === 'AI 陪读').props.onClick();
for (let i = 0; i < 4; i += 1) { await flush(); tree = await renderPass(ReactStub.createElement(BodyComponent, {})); }
assert.equal(findAll(tree, 'nr-avatar-bubble').length, 0, '没有吐槽时不得显示气泡');
assert.equal(findAll(tree, 'nr-avatar').length, 0, '没有吐槽时连人物也不占地方');

/* 恢复默认桩，避免影响后面的用例 */
Object.assign(companionState, { enabled: false, intervalMs: 300000, style: 'roast', lines: [], pending: false, hasModel: true, error: '' });

/* --------------------------------------------------------------- 模型选择 */

/* 模型按钮在阅读页 */
const modelBtn = findAll(tree, 'nr-btn').find((b) => b.props.children === '模型');
assert.ok(modelBtn, '阅读页必须有「模型」按钮');

/* 打开模型面板：列出 provider */
requests.length = 0;
modelBtn.props.onClick();
for (let i = 0; i < 4; i += 1) { await flush(); tree = await renderPass(ReactStub.createElement(BodyComponent, {})); }
assert.ok(requests.some((r) => r.method === 'model.options'), '打开模型面板必须拉 provider 列表');
const providerSelect = findAll(tree, 'nr-select').find((s) => s.props.className === 'nr-select');
assert.ok(providerSelect, '模型面板必须有 provider 下拉');
const providerIds = providerSelect.props.children.map((o) => o.props.value);
assert.ok(providerIds.includes('deepseek-official'), 'provider 下拉必须列出 DSH 已注册的 provider，实际 ' + JSON.stringify(providerIds));

/* 选了还没配好的 provider：界面必须把 provider 自带的错误摆出来，
   否则读者只看到「模型没保存成功」，不知道是那个 provider 还没登录。 */
requests.length = 0;
providerSelect.props.onChange({ target: { value: 'deepseek-account' } });
for (let i = 0; i < 4; i += 1) { await flush(); tree = await renderPass(ReactStub.createElement(BodyComponent, {})); }
const providerErrors = findAll(tree, 'nr-error');
assert.ok(
  providerErrors.some((n) => String(n.props.children).includes('还没登录')),
  'provider 自带的错误必须显示在面板里，实际：' + JSON.stringify(providerErrors.map((n) => n.props.children)),
);

/* 选一个 provider 后保存：必须发 model.save */
requests.length = 0;
const modelSaves = findAll(tree, 'nr-btn').filter((b) => String(b.props.children).includes('保存'));
assert.ok(modelSaves.length >= 1, '模型面板必须有保存按钮');
modelSaves[0].props.onClick();
await flush();
const savedModel = requests.find((r) => r.method === 'model.save');
assert.ok(savedModel, '保存模型必须调 model.save');
assert.ok(typeof savedModel.body.provider === 'string', 'model.save 必须带 provider');

/* --------------------------------------------------------------- 注销 */

/* 先跑掉所有 effect 的清理函数：陪读的轮询是 setInterval，
   不清掉它 node 进程会一直挂着不退。 */
for (const [key, fn] of Array.from(effectCleanups.entries())) {
  try { fn(); } catch { /* 清理失败不该让测试炸 */ }
  effectCleanups.delete(key);
}

for (const d of disposers.reverse()) d();
assert.equal(tabTypes.length, 0, 'dispose must unregister the tab type');
assert.equal(registered.length, 0, 'dispose must release every seat');

await fs.rm(tmp, { force: true });
console.log('✔ 主题切换 / 打开 / 翻章 / 字号 全部走通');
console.log('smoke: all assertions passed');