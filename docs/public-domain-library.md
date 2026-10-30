# 公版书库：目录是怎么生成的

这份文档记的是 `catalog/zh.json` 的**生成方法**，不是运行时逻辑。运行时只看目录，不联网查任何东西。

## 一、为什么走 GITenberg

Project Gutenberg 官方站（`www.gutenberg.org`）与常见镜像在部分网络下不通：实测 `gutenberg.pglaf.org` / `aleph.gutenberg.org` / `readingroo.ms` 全部连接失败，`mirror.csclub.uwaterloo.ca` / `gutenberg.net.au` 返回 404。

**GITenberg** 是 Project Gutenberg 在 GitHub 上的镜像组织，每本书一个仓库，仓库里放 `-0.txt` 纯文本。借 jsDelivr 的 CDN 就能取到：

```
https://<cdn-host>/gh/GITenberg/<repo>@master/<gutenberg-id>-0.txt
```

实测四个边缘节点都通（2026-10 测，取《西遊記》2.26 MB）：

| 节点 | 耗时 |
| --- | --- |
| `cdn.jsdelivr.net` | 7.3 s（边缘缓存命中后约 1 s） |
| `gcore.jsdelivr.net` | 7.0 s |
| `testingcf.jsdelivr.net` | 7.5 s |
| `fastly.jsdelivr.net` | 34.2 s |

`ghproxy.net` 要 75.8 s；`raw.githubusercontent.com` 直接 `ECONNRESET`；`raw.gitmirror.com` `ENOTFOUND`。所以运行时按 **cdn → gcore → testingcf → fastly** 顺序回退。

## 二、书目从哪来

`https://gutendex.com/books?languages=zh` —— 一个 Gutenberg 的第三方 JSON API，按语言过滤。返回 **count = 444** 本中文书，每本带 `id` / `title` / `authors` / `download_count`。

抓下来存成 `zh-books.json`，只保留要用的字段。

## 三、仓库名怎么算

GITenberg 的仓库名规则：**标题里每个非 `[A-Za-z0-9]` 字符替换成一个 `-`，不做合并**，后面接 `_<id>`。

几个真实例子：

| 标题 | 仓库名 |
| --- | --- |
| `西遊記` | `---_23962`（三个汉字 → 三个 `-`） |
| `紅樓夢` | `---_24264` |
| `灵历集光` | `----_25716` |
| `三國志演義` | `-----_23950` |
| `兵法 (Bīng Fǎ)` | `----B-ng-F--_12407` |
| `管子 — Volume 01 : Chapters 1-5` | `-----Volume-01---Chapters-1-5_7483` |

注意 `兵法 (Bīng Fǎ)` 这个例子：`兵法` → `--`，空格 → `-`，`(` → `-`，`B` 保留，`ī` → `-`，`ng` 保留，空格 → `-`，`F` 保留，`ǎ` → `-`，`)` → `-`，合起来正好 `----B-ng-F--`。

**规则会失配的情况**：标题带副标题、卷号、副题说明的，GITenberg 那边的仓库名可能按另一套标题串生成。实测 `夢溪筆談, Volume 01-26`（`------Volume-01-26_7317`）、`Three Hundred Tang Poems, Volume 1`、`Dao De Jing: A Minimalist Translation` 都按规则算不出来。

## 四、兜底：GitHub 搜索

规则算出来的名字用 jsDelivr `HEAD` 探活，404 就依次试「去掉副标题」「去掉卷号」的变体；还不行就走 GitHub 搜索：

```
GET https://api.github.com/search/repositories?q=org:GITenberg+<id>+in:name
```

取第一个名字以 `_<id>` 结尾的结果。

## 五、结果

444 本里 **434 本命中**：345 本靠命名规则，89 本靠 GitHub 搜索。

未命中的 10 本（`20968` / `51828` / `3100` / `38585` / `25517` / `24060` / `25377` / `24041` / `7314` / `7328`）直接放弃——它们在 GITenberg 上找不到对应仓库，或者标题对不上任何候选。

产物按 `downloads` 降序：

```json
{
  "source": "Project Gutenberg (public domain) via GITenberg",
  "generatedAt": "...",
  "count": 434,
  "books": [{ "id": 23962, "title": "西遊記", "author": "吴承恩", "downloads": 11629, "repo": "---_23962" }]
}
```

头部几本：《西遊記》11629、《紅樓夢》9312、《三國志演義》5097、《水滸傳》3553、《宋史》3351、《封神演義》3008。

## 六、正文的页眉页脚怎么剥

Gutenberg 的纯文本有一层固定包装，必须剥掉才能当小说读。实测《西遊記》的 `23962-0.txt` 同时混了三种形态：

1. **开头**先是一段授权说明（`This eBook is for the use of anyone anywhere at no cost...`），然后是 `The Project Gutenberg EBook of Journey to the West, by Cheng'en Wu` 这样的标题行；
2. **中间**才是 `*** START OF THE PROJECT GUTENBERG EBOOK JOURNEY TO THE WEST ***`；
3. 紧跟着还有一行 `Produced by Leong Joana Kit Ieng`；
4. **结尾**最坑：无星号的 `End of the Project Gutenberg EBook of Journey to the West, by Cheng'en Wu` 在 offset **785115**，而星号的 `*** END OF THIS PROJECT GUTENBERG EBOOK ***` 在 **785939** —— 无星号那个在**前面**。

所以剥的顺序必须是：

1. 有 `*** START ***` 就切掉它之前的一切；
2. **无条件**跑一遍「丢弃开头样板行」（`Produced by` / `Transcribed from` / `Character set encoding` / `Release date` / `Language:` 等，最多 400 行）；
3. 页脚两种形态**都找，取最靠前的下标**切。

只按星号形态切页脚，会把 `End of the Project Gutenberg EBook of ...` 那行英文尾巴留在正文最后——这正是第一版实现踩的坑。

剥完《西遊記》：805,004 字符 → 784,513 字符，正文从「第一回」开始、收在「《西遊記》至此終。」，`CHAPTER_RE` 切出 **90 回**。

## 七、为什么只发目录不发正文

434 本正文加起来约 900 MB。塞进包里既装不下，也没必要——绝大多数人只读其中几本。所以包里只有 44 KB 的 `catalog/zh.json`，正文在用户点「下载」时才取。

## 八、授权

插件自身 MIT，不对这些正文主张任何权利。GITenberg 是 Gutenberg 的镜像。
