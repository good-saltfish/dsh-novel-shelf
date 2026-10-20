# dsh-novel-shelf

在 DSH（DeepSeek Harness）右侧栏里直接读本地 txt 小说。English version: [README.en.md](README.en.md)

![plugin](https://img.shields.io/badge/dsh--plugin-4d6bfe)

![DSH 右侧栏中的「小说书架」面板](docs/screenshot-right-panel.png)

![DSH 整体界面，右侧栏打开「小说书架」](docs/screenshot-full.png)

## 功能 / Features

- **右侧栏阅读**：作为 DSH 原生右栏标签打开，不开新窗口、不切应用。
- **本地 txt 书架**：按绝对路径加入书架，插件只读取文件，不上传、不外发。
- **章节切分**：识别「第 N 章 / 节 / 回 / 卷 / 篇」标题；识别不到时按长度分段兜底。
- **编码探测**：UTF-8 / UTF-8 BOM / UTF-16LE / UTF-16BE / GB18030 自动判定。
- **全书搜索**：章节内全文匹配，命中给出章节名与上下文片段。
- **阅读进度**：章节号与滚动比例自动回写，重开自动回到原处。
- **五套配色**：白 / 护眼绿 / 米黄 / 深灰 / 纯黑，与 [novel-reader](https://github.com/) 的 `body[data-theme]` 同名同色。
- **与 novel-reader 共用数据**：读写 `%APPDATA%/novel-reader` 下的 `books.json`、`settings.json`、`annotations/*.json`，两边切换主题/进度即时同步。
- **零依赖**：只用 Node 内置模块与 DSH 宿主自带的服务，不引入第三方运行时依赖，不做网络请求。

## 安装 / Install

### 方式一：插件市场（推荐）

在 DSH 的插件市场里搜索 `dsh-novel-shelf`，点安装。

### 方式二：命令行

```sh
dsh plugin --profile desktop add good-saltfish/dsh-novel-shelf
```

### 方式三：从源码安装

```sh
git clone https://github.com/good-saltfish/dsh-novel-shelf
dsh plugin --profile desktop add link:<仓库路径>
```

### 方式四：手动装 tarball

从 [Releases](https://github.com/good-saltfish/dsh-novel-shelf/releases) 下载 `dsh-novel-shelf-<版本>.tgz`，然后：

```sh
dsh plugin --profile desktop add file:<tgz 路径>
```

> **装完必须刷新 DSH 页面**。插件的 client 半边是随页面加载的，安装或升级都不会热替换已加载的模块。刷新后右栏会出现「小说书架」标签。

## 使用步骤 / Usage steps

1. **打开右栏**：点 DSH 界面右上角的右栏按钮，展开右侧列。
2. **切到「小说书架」标签**：右栏顶部标签栏里选「小说书架」，进入书架页。
3. **加入一本书**：在输入框里填本地 txt 的**绝对路径**（例如 `D:\books\foo.txt`），按回车。书名会出现在列表里。
4. **开始读**：点书名进入阅读页，当前章节正文直接显示在右栏里。
5. **翻章与导航**：顶部「上一章 / 下一章」翻章，标题栏右侧的目录按钮展开章节列表，搜索框做全书全文检索（回车搜索，命中会给出章节名与上下文片段）。
6. **调阅读体验**：底部滑块调字号，底部五个色板切换背景（白 / 护眼 / 米黄 / 深灰 / 纯黑）。
7. **进度自动保存**：章节号与滚动比例写回 `%APPDATA%/novel-reader/annotations/<id>.json`，关掉再开自动回到原处。

> 右侧栏宽度有限，直接把窗口拉宽或切到更宽的布局阅读更舒服。

## 它是怎么工作的 / How it works

理解这几步有助于自己改这个插件：

1. **Host 半边（`lib/host.js`）** 在 `ctx.effect()` 里用 `ctx.webServer.register({kind:'prefix', path:'/novel-shelf/api'})` 挂一条前缀路由，对外提供 8 个方法：`library.get` / `library.add` / `library.remove` / `book.open` / `book.chapter` / `book.save` / `settings.save` / `book.search`。
2. **每条请求先过信任栅栏**：`ctx.connection.requestRejection(req)` 判定是否来自可信的浏览器会话（命令行直连一律 403），再叠加 `Sec-Fetch-Site` 跨站拒绝；方法名用 `Object.hasOwn(api, method)` 做白名单，`Object.hasOwn` 防的是 `POST /novel-shelf/api/constructor` 这类原型成员命中；请求体上限 1 MiB。
3. **Host 半边做真正的 IO**：读盘、编码探测、章节切分、全文检索、JSON 落盘（写临时文件再 rename；读到损坏 JSON 先备份成 `*.corrupt-<时间戳>` 再回退，不静默覆盖）。路径一律 `path.resolve` 归一。
4. **Client 半边（`lib/client.js`）** 通过 `window.__ModuleLoader__.load({id:'dsh-novel-shelf', factory})` 挂载。它先 `ctx.inject(['sidebarRight','sidebarRightTabs'], ...)` 拿到右栏标签注册表，注册一个 tab 类型（`id = dsh-novel-shelf/reader`，`kind = dsh-novel-shelf:reader`），再通过 `ctx.slots.inject('sidebar.right.pane.tab', ...)` 占用两个 keyed 座位（正文与标题）。
5. **座位注入回调必须返回清理函数**，否则宿主不会真正占位，面板会退化成宿主占位文案「这类内容还没有可用的查看方式」。这是 DSH 右栏插件最容易踩的坑。
6. **面板调 API**：client 侧把路径拼成 `novel-shelf/api/<method>`（去掉前导斜杠，挂在 `document.baseURI` 下），POST JSON，收到 `{ok:true,value}` 或 `{ok:false,error}`。
7. **主题与设置共享**：主题、字号、行距都写进 `%APPDATA%/novel-reader/settings.json`，桌面版 novel-reader 读同一份文件，所以两边即时同步。

## 数据位置 / Data layout

| 文件 | 内容 |
| --- | --- |
| `%APPDATA%/novel-reader/books.json` | 书架（路径、名称、大小、加入时间） |
| `%APPDATA%/novel-reader/settings.json` | 主题、字号、行距、最后阅读的书 |
| `%APPDATA%/novel-reader/annotations/<id>.json` | 每本书的批注与阅读进度 |
| `%APPDATA%/novel-reader/plugin-client.log` | 插件 client 半边的运行诊断日志（只含标签与计数，不含正文） |

Windows 用 `%APPDATA%`，macOS 用 `~/Library/Application Support/novel-reader`，Linux 用 `~/.config/novel-reader`。

JSON 文件损坏时插件会先备份为 `*.corrupt-<时间戳>` 再回退到空值，**不会静默覆盖原数据**。

## 隐私 / Privacy

- 全部数据留在本机插件数据目录，插件不做任何网络请求。
- 宿主路由带官方信任栅栏（`ctx.connection.requestRejection`）与跨站请求拒绝，命令行直连会被拒。
- 只接受 `.txt`；请求体上限 1 MiB；API 方法白名单用 `Object.hasOwn` 防原型成员。

## 开发 / Development

### 目录结构

```
lib/host.js            宿主半边：文件 IO、编码探测、章节切分、全文检索、JSON 落盘、HTTP 路由
lib/client.js          客户端半边：右栏标签注册、书架/阅读页组件、五套主题样式
locale/zh.json         中文文案
locale/en.json         英文文案
test/hosttest.mjs      宿主半边单测
test/smoke.mjs         客户端半边交互冒烟（自带极简 React 桩）
screenshots.json       插件市场截图声明
```

### 跑测试

```sh
npm test        # host 半边单测 + client 半边交互冒烟（自带极简 React 桩，无需 DSH 运行时）
```

### 打包与本地安装

```sh
npm pack --pack-destination .
dsh plugin --profile desktop add file:.\dsh-novel-shelf-0.1.0.tgz
```

改完 client 半边记得**刷新页面**再验证；改完 host 半边需要重装 bundle。

### 发一个版本

```sh
npm version patch
npm pack --pack-destination .
gh release upload v0.1.1 dsh-novel-shelf-0.1.1.tgz --repo good-saltfish/dsh-novel-shelf
```

Release 资产名建议带版本号（`dsh-novel-shelf-<版本>.tgz`），目录条目里用固定版本路径 `releases/download/v<版本>/<资产名>`，避免 `latest/download/` 在下个版本时 404。

## License

MIT
