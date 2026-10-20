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
  const value = RESPONSES[method];
  const text = JSON.stringify(value && value.ok === false
    ? { ok: false, error: { code: 'e', message: value.message } }
    : { ok: true, value: value ? value.value : {} });
  return { status: 200, text: async () => text };
};

const RESPONSES = {
  'library.get': { value: { books: [{ id: 'b1', name: '测试书', path: 'C:/a.txt', size: 2048 }], settings: { theme: 'sepia', fontSize: 21 }, themes: ['day', 'eye', 'sepia', 'dark', 'black'] } },
  'book.open': { value: { id: 'b1', name: '测试书', path: 'C:/a.txt', encoding: 'UTF-8', chapters: [{ title: '第一章' }, { title: '第二章' }], progress: { chapterIndex: 0, scrollRatio: 0 }, settings: { fontSize: 21, lineHeight: 1.9, theme: 'sepia' } } },
  'book.chapter': { value: { index: 0, title: '第一章', paragraphs: [{ index: 0, text: '正文', meta: false }], highlights: [] } },
  'book.save': { value: { saved: true } },
  'book.search': { value: { results: [], total: 0 } },
  'settings.save': { value: {} },
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
  useMemo(fn) { return fn(); },
  useCallback(fn) { return fn; },
  useEffect(fn, deps) { current.effects.push({ fn, deps, i: cursor++ }); },
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
      if (e.deps === undefined || e.deps === null) e.fn();
      else if (depsChanged(effectDeps.get(key), e.deps)) e.fn();
      effectDeps.set(key, e.deps);
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

let tree = await render(ReactStub.createElement(BodyComponent, {}));
await flush();
tree = await render(ReactStub.createElement(BodyComponent, {}));
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
tree = await render(ReactStub.createElement(BodyComponent, {}));
pane = findAll(tree, 'nr-pane')[0];
assert.equal(pane.props['data-theme'], 'black', '点第五个色板应切到 black');
await flush();
const saved = requests.filter((r) => r.method === 'settings.save');
assert.equal(saved.length, 1, '切主题必须写回一次 settings.save');
assert.equal(saved[0].body.theme, 'black');

/* 设置成功后刷新一次：主题应从 Host 读回（此处 Host 回 sepia 是桩的固定值，
   所以只验证请求发出与本地状态即时生效，不断言回读） */

/* 打开一本书：主题在阅读页不得丢 */
requests.length = 0;
findAll(tree, 'nr-item-main')[0].props.onClick();
for (let i = 0; i < 4; i += 1) { await flush(); tree = await render(ReactStub.createElement(BodyComponent, {})); }
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
for (let i = 0; i < 4; i += 1) { await flush(); tree = await render(ReactStub.createElement(BodyComponent, {})); }
assert.ok(requests.some((r) => r.method === 'book.chapter'), '翻章必须请求正文');

/* 字号改动必须写回 */
requests.length = 0;
const range = findAll(tree, 'nr-range')[0];
range.props.onChange({ target: { value: '26' } });
await flush();
assert.ok(requests.some((r) => r.method === 'settings.save' && r.body.fontSize === 26), '字号必须写回');

/* --------------------------------------------------------------- 注销 */

for (const d of disposers.reverse()) d();
assert.equal(tabTypes.length, 0, 'dispose must unregister the tab type');
assert.equal(registered.length, 0, 'dispose must release every seat');

await fs.rm(tmp, { force: true });
console.log('✔ 主题切换 / 打开 / 翻章 / 字号 全部走通');
console.log('smoke: all assertions passed');