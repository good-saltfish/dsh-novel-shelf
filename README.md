# dsh-novel-reader

在 DSH（DeepSeek Harness）右侧栏里直接读本地 txt 小说。English version: [README.en.md](README.en.md)

![plugin](https://img.shields.io/badge/dsh--plugin-4d6bfe)

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

```sh
dsh plugin --profile desktop add good-saltfish/dsh-novel-reader
```

或从源码目录安装：

```sh
git clone https://github.com/good-saltfish/dsh-novel-reader
dsh plugin --profile desktop add link:<仓库路径>
```

装完**刷新 DSH 页面**（client 半边随页面加载），右栏即可看到「小说阅读器」标签。

## 使用 / Usage

1. 右栏点开「小说阅读器」→ 书架页。
2. 输入本地 txt 文件的**绝对路径**（如 `D:\books\foo.txt`），回车加入书架。
3. 点书名打开；顶部可翻章、开关目录、搜索全书；底部可调字号与背景配色。

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

```sh
npm test        # host 半边单测 + client 半边交互冒烟（自带极简 React 桩）
```

- `lib/host.js` —— 宿主半边：文件 IO、编码探测、章节切分、全文检索、JSON 落盘、HTTP 路由。
- `lib/client.js` —— 客户端半边：右栏标签注册、书架/阅读页组件、五套主题样式。
- `test/hosttest.mjs`、`test/smoke.mjs` —— 无需 DSH 运行时即可跑。

## License

MIT
