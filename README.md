# dsh-keenable-search

**给 DeepSeek Harness 的免费联网搜索插件。** 一次注册，**所有 Agent、所有会话、所有工作区**都能用。

> 搜索能力挂在 Host 层，装一次就全局可用 —— 不需要每个项目复制一份，不需要写 client 端，不注册任何 HTTP 路由。

---

## 它能做什么

| 工具 | 作用 |
|---|---|
| `keenable_search` | 联网搜索，返回标题、URL、摘要 |
| `keenable_fetch` | 抓取单个网页正文 |

### `keenable_search` 参数

| 参数 | 类型 | 说明 |
|---|---|---|
| `queries` | string[] | **必填**，1–4 个查询，结果合并并按 URL 去重 |
| `site` | string | 限定域名，如 `github.com`、`docs.python.org` |
| `publishedAfter` / `publishedBefore` | string | 按发布时间过滤（`YYYY-MM-DD`、ISO 8601 或 `7d`） |
| `acquiredAfter` | string | 按收录时间过滤 |
| `maxResults` | integer | 每个查询返回条数，默认 8，上限 50 |

多个查询**串行执行**而非并发：API 按 key 限流，四个请求同时打过去是最容易触发限流的方式。

### `keenable_fetch` 参数

| 参数 | 类型 | 说明 |
|---|---|---|
| `url` | string | **必填**，完整 http(s) 地址 |
| `maxChars` | integer | 默认 8000 |
| `live` | boolean | 抓实时内容而非缓存副本 |

---

## 🔑 如何获取 API Key（免费）

**Keenable 提供免费搜索额度，注册即可用。**

1. 打开 **https://keenable.ai** 注册账号
2. 进入控制台 / API Keys 页面
3. 创建一个 API Key（形如 `keen_aot...`，80 字符左右）
4. 把 key 填进 DSH 的环境变量（见下）

> 如果官方地址有变化，也可以直接访问 API 域名 **https://api.keenable.ai** 查看其 `openapi.json` 与文档。

**免费额度说明**：具体额度以 Keenable 官网为准。本插件只调用其公开 API，不代收任何费用。

---

## 配置密钥

插件按以下顺序读取，**前面的优先**：

1. 本插件行配置里的 `apiKey` / `baseUrl`
2. DSH 进程环境变量 `KEENABLE_API_KEY` / `KEENABLE_API_URL`

`KEENABLE_API_URL` 未设置时默认 `https://api.keenable.ai`。

### 方式一：写进 DSH 的 .env（推荐）

在 DSH 的 `.env` 文件里加两行：

```dotenv
KEENABLE_API_KEY=keen_aot_你的密钥
KEENABLE_API_URL=https://api.keenable.ai
```

然后**完全重启 DSH**（不是关窗口）。

### 方式二：写进 profile 配置

编辑 profile 的 `cordis.patch.yml`，找到 `keenable-search` 那行，在 `config` 下加：

```yaml
- id: keenable-search
  name: dsh-keenable-search
  config:
    timeoutMs: 15000
    maxResults: 8
    apiKey: keen_aot_你的密钥      # ← 加这两行
    baseUrl: https://api.keenable.ai
```

> **为什么不把 key 存在插件目录里？** 因为 DSH 的 `.env` 已经有了，再存一份就是第二个要防泄漏的地方、第二个要同步的地方。插件本身**不含任何密钥**。

**没配 key 会怎样**：工具会返回明确错误，指名 `KEENABLE_API_KEY` 未设置，而不是静默失败。

---

## 安装

### 前置：完全退出 DSH

**必须**先完全退出（不是关窗口），否则 pnpm 重写 `node_modules` 时会被文件锁挡住。

```powershell
# 1. 退出 DSH 后，进入 profile 目录
cd "D:\AI agent cache\dsh\profiles\desktop"

# 2. 安装（注意用 pnpm.cmd，PowerShell 执行策略可能拦截 pnpm.ps1）
& "$env:APPDATA\npm\pnpm.cmd" add "file:D:/AI sandbox/dsh-sandbox/keenable_search"
```

### 关键：加进 bundles

**`pnpm add` 只做包管理，不会自动注册。** 必须手动把包名加进 profile 的 `package.json`：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "...",
        "dsh-keenable-search"
      ]
    }
  }
}
```

**不加这一行，DSH 不会加载插件**，工具也不会出现。

### 然后重启 DSH

---

## 配置项

```yaml
- id: keenable-search
  name: dsh-keenable-search
  config:
    timeoutMs: 15000    # 单次请求超时；卡住的搜索不能拖死一轮对话
    maxResults: 8       # 调用方未指定时的默认条数
    # apiKey: ...       # 可选覆盖，通常从环境变量读
    # baseUrl: ...      # 可选覆盖
```

---

## 失败时的行为

所有失败都是**结构化返回值**，绝不向 Agent 循环抛异常：

| 错误码 | 含义 |
|---|---|
| `BAD_INPUT` | 查询或 URL 为空 |
| `AUTH` | 401/403，key 错误或过期 |
| `HTTP` | 其他非 2xx |
| `TIMEOUT` | 超过 `timeoutMs` 被中止 |
| `NETWORK` | DNS / TLS / 连接失败 |
| `BAD_JSON` | 服务端返回非 JSON |
| `NO_FETCH` | 运行环境没有 `fetch` |

**如果一次调用里所有查询都失败**，工具会报错而不是返回空结果集 —— 「没结果」会被理解成「网上没有这个」，那是完全不同的结论。

---

## 为什么做成独立插件

`dsh-session-suite` 是每个会话都加载的，负责快照、记忆、分享。会超时的网络 I/O 不该和它们共享故障域，改搜索也不该需要重新发布一个 3000 行的套件。独立之后，也可以随时禁用而不影响其他任何东西。

---

## 测试

```powershell
node tools/test-contract.mjs    # manifest、exports、工具定义、渲染、错误路径
node tools/test-live.mjs        # 客户端对真实 API
node tools/test-e2e.mjs         # 已注册工具的端到端测试
node tools/test-installed.mjs   # 验证安装到 profile 后能被正确加载
```

`test-live` / `test-e2e` 需要 `KEENABLE_API_KEY` 和网络。它们会直接读取 DSH 的 `.env`，无需额外配置。

---

## 已知限制

- 返回结果是 Keenable 的排序，本插件**不做二次重排**
- 摘要是节选不是全文。引用某页之前，先用 `keenable_fetch` 读一遍
- **无缓存**：每次调用都是一次真实请求
- 仅 Host 端，**没有客户端界面**

---

## 声明

- 本插件为**非官方**第三方工具，与 Keenable 无隶属关系
- 只调用其公开 HTTP API，**未包含任何 Keenable 源码**
- 使用产生的额度与费用遵循 Keenable 的服务条款
- 本项目以 MIT 协议开源

---

## License

MIT © heixiua
