# cc-nbproject 设计文档

> 日期：2026-09-21
> 状态：已批准
> 定位：学习为主、功能可用

---

## 1. 背景与问题

Claude Code 通过 `~/.claude/settings.json` 的 `env` 块读取供应商配置：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "sk-...",
    "ANTHROPIC_MODEL": "deepseek-v4-pro"
  }
}
```

切换供应商意味着改写这几个键。手工改有两个痛点：一是要记住各家的端点和模型名，二是**改完必须重启 Claude Code**。

### 为什么"必须重启"是根本痛点

我们对 Claude Code 的配置机制做了核实，结论如下：

| 机制 | 事实 | 影响 |
|---|---|---|
| `env` 值插值 | **不支持**（[issue #46889](https://github.com/anthropics/claude-code/issues/46889) 至今未实现） | 无法写 `"${MY_KEY}"`，工具必须自己完成取值 |
| base URL 的运行时钩子 | **不存在** | 只有 `apiKeyHelper` 能动态供 API key，**没有**对应的 base URL helper |
| `env` 删除语义 | 运行中的会话**不会** unset 被删掉的变量 | 切换时只能覆盖，不能靠删 |
| 配置优先级 | user → project → local → `--settings` → managed | 企业 managed settings 会压过一切用户级配置 |
| `~/.claude.json` | **不是** settings 源 | 写在这里的 `env` 会被完全忽略 |

**关键推论**：由于 base URL 没有任何运行时钩子，**只要 base URL 会变，就一定要重启**。这是纯配置写入方案的硬性天花板。

### 破解思路

反过来想 —— 如果 base URL **永远不变**呢？

让 Claude Code 始终指向一个本地地址，由这个本地服务负责把请求转发到真正的上游。切换供应商就从"改 Claude Code 的配置"变成了"改本地服务的路由表"，而 Claude Code 全程无感知。

这个思路一次性绕开了上表中的全部限制。

---

## 2. 目标与非目标

### 目标（v0.1）

1. **供应商增删改查 + 一键切换**，切换零重启
2. **连接测试**：发一个极小请求，验证 key 有效并测出延迟
3. **首次启动引导**：把 Claude Code 指向本地代理（一次性、需用户确认）
4. **请求日志**：实时看到每个请求走了哪个供应商、状态码、耗时
5. **用量统计**：累计 token 消耗与请求数

### 非目标（v0.1 明确不做）

| 不做的事 | 原因 |
|---|---|
| 模型映射 | 锦上添花；v0.1 先用 Claude Code 原生的 `ANTHROPIC_DEFAULT_*_MODEL` 解决 |
| 故障转移 | 需要先有稳定的代理核心和可靠的错误分类，放在 v0.2 更稳 |
| 系统托盘 / 菜单栏 | 纯体验优化，且各平台差异大 |
| 支持 Codex / Gemini CLI | 先把 Claude Code 一个客户端做扎实 |
| 应用打包分发 | v0.1 用 `npm start` 开发模式运行，打包放 v0.2 |

---

## 3. 核心架构决策

### 3.1 采用本地反向代理，而非直接改配置

```
        Claude Code
             │  ANTHROPIC_BASE_URL 固定 = http://127.0.0.1:8787
             │  （只写一次，之后永不修改）
             ▼
   ┌─────────────────────┐
   │   cc-nbproject      │
   │   HTTP 代理          │  读当前激活的 profile
   └─────────────────────┘
        │         │         │
        ▼         ▼         ▼
    DeepSeek     智谱      Kimi
```

**收益**

- **零重启切换**：切换只是改代理内存里的一个指针。正在跑的请求不受影响，新请求走新上游。
- **模型映射、故障转移、用量统计有了落点**：这些能力都需要"站在请求链路上"才做得到，而代理天然就在链路上。
- **Claude Code 配置只需写一次**：后续所有变更都不再触碰用户的配置文件，风险面大幅收窄。

**代价（必须诚实记录）**

- 需要一个常驻进程；代理挂了，Claude Code 就用不了
- 首次要改动用户的 `~/.claude/settings.json`（破坏性操作，需显式授权 + 备份）
- SSE 流式转发必须实现正确，否则会出现严重的响应延迟

### 3.2 代理运行在 Electron 主进程

**决策**：代理服务器跑在主进程（main process），不跑渲染进程。

**为什么**：Electron 的渲染进程是一个沙箱化的浏览器环境，其设计目的是渲染 UI，不适合监听 TCP 端口、管理长连接。主进程则是完整的 Node.js 运行时，可以直接 `require('http')`。

这条边界是理解 Electron 架构的核心：**主进程 = 有特权的 Node 环境，渲染进程 = 受限的浏览器环境，两者通过 IPC 通信**。把代理放在主进程，UI 放在渲染进程，正好是这套架构的标准用法。

### 3.3 前端不使用框架

**决策**：渲染进程用原生 HTML + CSS + JavaScript，不引入 React/Vue。

**为什么**：

- v0.1 只有三个视图（供应商列表、日志、用量），框架带来的抽象收益低于其理解成本
- 项目定位是学习。引入框架会掩盖 Electron 本身的机制（IPC、preload、contextBridge），学习者容易分不清哪些是 Electron 的能力、哪些是框架的
- 最小依赖原则：少一个依赖就少一份需要跟进的升级和安全面

### 3.4 `proxy.js` 与 Electron 解耦

**决策**：代理核心是一个纯 Node 模块，不 `require` 任何 Electron API。

**为什么**：这样才能**离开 Electron 单独运行和测试**。

具体做法是让 `proxy.js` 导出一个工厂函数，把"当前用哪个 profile"和"用量记录回调"作为依赖注入进来，而不是自己去读 Electron 的全局状态：

```js
// 概念示意：依赖注入，而非直接依赖 Electron
const proxy = createProxy({
  getActiveProfile: () => store.getActive(),   // 注入
  onUsage: (record) => usage.append(record),   // 注入
});
```

调试代理逻辑时（这是整个项目最容易出错的部分），可以直接 `node` 起一个进程跑它，不用每次都开窗口。

---

## 4. 技术选型

| 选择 | 版本 | 理由 |
|---|---|---|
| **Runtime** | Node.js ≥ 20 | Electron 44 内置的 Node 版本远高于此；`engines` 字段只用于约束开发环境 |
| **桌面框架** | Electron 44 | 用户指定 Node 技术栈。相比 Tauri 无需引入 Rust 工具链，学习成本集中在 JS 一侧 |
| **模块系统** | CommonJS | Electron 主进程对 ESM 的支持较新且在 preload 等场景有额外约束。CommonJS 在本生态中资料最多、坑最少，适合以学习为目的的项目 |
| **HTTP 代理** | Node 内置 `http` / `https` | 不引入 express/koa。代理的核心是 `pipe` 流式转发，用内置模块反而更直接、更少黑盒 |
| **测试** | Node 内置 `node --test` | Node 20+ 自带测试运行器，无需 jest/vitest。零额外依赖，且足够覆盖 `proxy.js` 这类纯逻辑模块 |
| **Lint / 格式化** | ESLint 10 + Prettier 3 | 工程化基线，保证代码风格一致 |
| **配置存储** | JSON 文件 | 数据量极小（几个 profile、按天的用量），无需数据库。存放在 `~/.cc-nbproject/` |

---

## 5. 目录结构

```
cc-nbproject/
├── package.json
├── .gitignore
├── eslint.config.js
├── .prettierrc
├── README.md
├── LICENSE                        # MIT
├── docs/
│   └── plans/                     # 设计文档与实现计划
├── src/
│   ├── main/                      # 主进程（有特权的 Node 环境）
│   │   ├── index.js               # Electron 入口：创建窗口、装配各模块
│   │   ├── proxy.js               # ★ 代理核心（纯 Node，不依赖 Electron）
│   │   ├── store.js               # profiles.json 读写（原子写入）
│   │   ├── usage.js               # 用量记录与聚合
│   │   └── setup.js               # 首次引导：改写 Claude Code 配置
│   ├── preload/
│   │   └── index.js               # contextBridge：向渲染进程暴露白名单 API
│   └── renderer/                  # 渲染进程（沙箱化的浏览器环境）
│       ├── index.html
│       ├── app.js
│       └── style.css
└── test/
    └── proxy.test.js              # 代理核心的单元测试（不经 Electron）
```

---

## 6. 关键实现

### 6.1 SSE 流式转发（最高风险项）

Anthropic 的 `/v1/messages` 在 `stream: true` 时返回 SSE（Server-Sent Events）流。Claude Code 依赖这个流式能力实现"逐字输出"。

**要求**：代理必须**边收边转**，绝不能缓冲整个响应。

```js
// 正确：双向 pipe，数据边到边走
upstreamRes.pipe(clientRes);

// 错误：这会让 Claude Code 卡住直到整个回答生成完毕
// const body = await res.text();
// clientRes.end(body);
```

一旦写成缓冲模式，用户会看到几十秒的空白然后整段文字突然出现 —— 流式体验完全失效。

**旁路解析**：`pipe` 是单向的，无法同时解析数据。因此不能直接 `pipe`，而要监听 `data` 事件：一边 `write` 给客户端，一边喂给增量解析器提取用量（见 6.2）。这是为什么用 `http` 内置模块更合适 —— 事件流是透明的。

**错误分类**（为 v0.2 的故障转移预留）：
- **未响应头阶段出错** → 可安全重试下一个 profile（此时还没给客户端写任何字节）
- **已开始流式响应后出错** → 不可重试，只能中断并向客户端报错

这个判断依据是"是否已向客户端写过第一个字节"，实现时需用一个标志位记录。

### 6.2 用量数据提取

**决策**：不自己估算 token，直接读上游响应里的官方数据。

| 响应类型 | 数据位置 |
|---|---|
| 流式（SSE） | 末尾的 `message_start` 带 `usage.input_tokens`，`message_delta` 带累计 `usage.output_tokens` |
| 非流式 | 响应体顶层的 `usage` 字段 |

代理只需在旁路解析时提取这两个字段，**转发内容本身零改动**。

### 6.3 鉴权重写

Claude Code 会把 `ANTHROPIC_AUTH_TOKEN` 的值放在 `Authorization: Bearer <token>` 请求头里发出。

**处理方式**：代理**丢弃**客户端传来的鉴权头，改用当前 profile 中存储的真实 key 重写。

**推论**：Claude Code 那边填一个无意义的占位符（如 `proxy-managed`）即可 —— 真实凭证完全由本工具管理，不会再散落在 Claude Code 的配置文件里。这本身就是一个安全收益。

### 6.4 配置存储的原子写入

写入 `profiles.json` 时采用「写临时文件 → `fs.rename` 原子替换」的方式，避免写入过程中崩溃导致配置文件损坏（半截 JSON 会让工具完全无法启动）。

写入完成后设置文件权限为 `600`（仅当前用户可读写），防止同机其他账户读取 API key。

---

## 7. 数据模型

### `~/.cc-nbproject/profiles.json`

```jsonc
{
  "version": 1,
  "activeId": "uuid-of-active-profile",
  "profiles": [
    {
      "id": "uuid",
      "name": "DeepSeek",                        // 展示名
      "baseUrl": "https://api.deepseek.com/anthropic",
      "apiKey": "sk-...",                        // 明文，靠文件权限 600 保护
      "createdAt": "2026-09-21T10:00:00.000Z"
    }
  ],
  "settings": {
    "port": 8787                                 // 实际端口在运行时探测，可能与此不同
  }
}
```

> **关于 `apiKey` 明文存储**：v0.1 不做加密。加密需要一个"主密钥"，而主密钥本身又得存在本地某处，在单机场景下只是把问题挪了一层，安全增益有限。真正的保护来自文件权限 `600` + 不进入任何版本库。若后续要提升，正确的方向是接入系统钥匙串（macOS Keychain / Windows Credential Manager），而不是自研加密 —— 这一点记为 v0.2 的候选。

### `~/.cc-nbproject/usage.jsonl`

按行追加的 JSONL，每行一条请求记录，便于流式追加和按天聚合：

```jsonc
{"ts":"2026-09-21T10:00:00.000Z","profileId":"uuid","model":"deepseek-v4-pro","inputTokens":1024,"outputTokens":512,"status":200,"durationMs":3200}
```

选择 JSONL 而非单个 JSON 数组的原因：追加写是 O(1)，不需要读出整个文件再写回，避免了用量增长后每次记录都要重写全文件。

---

## 8. 安全与风险

| 风险 | 处理 |
|---|---|
| **API key 落地** | 存 `~/.cc-nbproject/`，权限 `600`；`.gitignore` 兜底；提交前人工复扫确认无 key 混入 |
| **改写用户 Claude Code 配置** ⚠️ | `setup.js` 会**覆盖** `~/.claude/settings.json` 的 `env` 块。**不自动执行**：先备份为 `settings.json.bak.<时间戳>`，再把 diff 展示给用户确认 |
| **代理被外部访问** | 只 `listen` 在 `127.0.0.1`，不监听 `0.0.0.0` |
| **渲染进程越权** | `contextIsolation: true` + `nodeIntegration: false`；渲染进程只能通过 preload 暴露的白名单方法访问主进程能力 |
| **企业 managed settings 冲突** | 若用户环境存在 managed settings 下发的 `ANTHROPIC_BASE_URL`，会压过用户级配置，导致本工具失效。启动时检测并在 UI 中提示 |

---

## 9. 测试策略

**只测纯逻辑，不测 UI。**

`proxy.js` 因为做了依赖注入（见 3.4），可以用 `node --test` 直接测试，无需启动 Electron：

- 流式转发：起一个假的 SSE 上游，断言客户端收到的字节序列与上游一致（**这是最重要的一个测试**）
- 用量提取：喂入构造好的 SSE 事件序列，断言提取出的 token 数正确
- 鉴权重写：断言发往上游的请求头里是 profile 的 key，而非客户端传来的
- 错误分类：断言"未响应头"与"已响应头"两种情况被正确区分

UI 层不做自动化测试 —— 对学习型项目，手工验证的性价比更高。

---

## 10. 版本路线

| 版本 | 内容 |
|---|---|
| **v0.1**（本设计） | 代理核心 + 供应商管理 + 连接测试 + 首次引导 + 日志 + 用量统计 |
| v0.2 | 模型映射、故障转移、系统托盘 |
| v0.3 | 应用打包（electron-builder）、系统钥匙串存储 key |
| 待定 | 支持 Codex 等其他 CLI 客户端 |
