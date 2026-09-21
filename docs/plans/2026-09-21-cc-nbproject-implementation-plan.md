# cc-nbproject v0.1 实现计划

> 日期：2026-09-21
> 配套设计文档：[2026-09-21-cc-nbproject-design.md](./2026-09-21-cc-nbproject-design.md)

---

## 阶段划分原则

**按风险从高到低排序，而不是按用户可见顺序。**

最自然的做法是先搭 UI（能立刻看到东西，有成就感），把代理放在后面。但这是错的：代理的 SSE 流式转发是整个项目**唯一可能根本做不通**的部分 —— 如果它对 SSE 的处理有问题，UI 做得再漂亮也没用。而 UI 是最不可能失败的部分。

所以顺序是：**先把最难、最可能推翻设计的一环做掉并验证，再往上堆 UI。**

| 阶段 | 内容 | 风险 | 依赖 |
|---|---|---|---|
| P1 | 代理核心 + 配置存储 + 单元测试 | **最高** | 无 |
| P2 | Electron 外壳（窗口、IPC、preload） | 低 | P1 |
| P3 | 渲染进程 UI | 低 | P2 |
| P4 | 首次引导（改写 Claude Code 配置） | 中（涉及破坏性操作） | P1–P3 |
| P5 | 端到端实测与收尾 | 中 | P1–P4 |

---

## P1 — 代理核心（风险最高，先做）

**目标**：一个能独立运行、独立测试的 HTTP 代理，能把 `/v1/messages` 请求流式转发到上游，并旁路提取 token 用量。

**验收标准**：`npm test` 全绿，且可以用 `curl` 手工验证流式响应是逐块到达而非一次性到达。

### P1.1 `src/main/store.js` — 配置存储

| 项 | 内容 |
|---|---|
| 产出 | `loadProfiles()` / `saveProfiles()` / `getActiveProfile()` / `setActive()` |
| 要点 | **原子写入**：写临时文件 → `fs.rename` 替换 |
| 要点 | 文件权限 `600` |
| 要点 | 首次运行时自动创建默认结构 |
| 为什么原子写入 | 直接 `writeFile` 到目标路径，若在写入中途崩溃会留下半截 JSON，导致工具**完全无法启动**且用户难以自行修复。`rename` 在同一文件系统内是原子操作，要么是旧内容要么是新内容，不存在中间态 |

### P1.2 `src/main/proxy.js` — 代理核心 ★

| 项 | 内容 |
|---|---|
| 产出 | `createProxy({ getActiveProfile, onUsage, onRequest })` 返回 `{ start, stop, port }` |
| 要点 | **依赖注入**，不 require 任何 Electron API |
| 要点 | 双向流式转发（`upstreamRes.on('data')` → `clientRes.write()`） |
| 要点 | 旁路解析 SSE，提取 `message_start` / `message_delta` 里的 usage |
| 要点 | 丢弃客户端的 `Authorization`，改写为 profile 的真实 key |
| 要点 | 端口占用时自动向上寻找可用端口 |
| 要点 | 只 `listen('127.0.0.1')` |
| 要点 | 记录「是否已向客户端写过第一个字节」的标志位（为 v0.2 故障转移预留） |

**为什么依赖注入而不是直接 require Electron**：`proxy.js` 是本项目最容易出错、最需要反复调试的模块。如果它依赖 Electron，每次改一行都得开窗口才能跑。注入 `getActiveProfile` 和 `onUsage` 之后，它可以被一个普通的 Node 测试进程直接驱动。

**为什么监听 `data` 事件而不是直接 `.pipe()`**：`pipe` 是单向的，一旦接上去就无法同时读取数据做解析。我们需要"转发的同时解析用量"，所以手动处理 `data` 事件。代价是要自己处理背压（`write()` 返回 `false` 时暂停上游），这一点在测试中要覆盖。

### P1.3 `test/proxy.test.js` — 单元测试

| 用例 | 断言 | 为什么重要 |
|---|---|---|
| **流式转发保真** | 起一个假 SSE 上游，逐块推送；断言客户端收到的字节序列与上游完全一致 | 这是整个项目的正确性基石。缓冲 bug 会破坏流式体验，但不影响"能收到回答"，很容易漏测 |
| **分块到达** | 断言客户端是分多次收到数据，而非最后一次性收到 | 直接验证"不是缓冲模式"，比检查代码更可靠 |
| **用量提取** | 喂入构造好的 SSE 序列，断言提取出的 input/output token 数正确 | 数值算错会静默产生错误的统计 |
| **鉴权重写** | 断言发往上游的 `Authorization` 是 profile 的 key，而非客户端传来的 | 泄露/串号风险 |
| **非流式响应** | 普通 JSON 响应也能正确转发并提取 usage | 连接测试功能走的是这条路径 |
| **端口占用回退** | 先占住一个端口，断言代理能换到下一个 | 否则启动时静默失败 |

---

## P2 — Electron 外壳

**目标**：一个能打开窗口、渲染进程能安全调用主进程能力的应用骨架。

### P2.1 `src/main/index.js`

- 创建 `BrowserWindow`，开启 `contextIsolation: true`、`nodeIntegration: false`
- 装配 `store` / `proxy` / `usage`，把 `getActiveProfile` 注入给代理
- 启动时自动启动代理，把实际端口通过 IPC 告知 UI
- 应用退出时优雅停止代理

**为什么 `nodeIntegration: false` 是必须的**：渲染进程会加载并显示来自 API 响应的日志内容。若开启 `nodeIntegration`，渲染进程中的任何脚本都能 `require('child_process')` 执行任意命令。这条配置是 Electron 安全模型的地基，不是可选项。

### P2.2 `src/preload/index.js`

用 `contextBridge.exposeInMainWorld` 暴露**白名单方法**，例如：

```
ccnb.listProfiles() / addProfile(p) / updateProfile(p) / removeProfile(id)
ccnb.activate(id) / testProfile(id)
ccnb.getUsage(range) / getProxyStatus()
ccnb.onRequestLog(cb)        // 主进程 → 渲染进程的推送
```

**为什么需要 preload**：它是主进程与渲染进程之间唯一的合法通道。渲染进程不能直接 `ipcRenderer`，只能调用 preload 显式暴露的方法，从而把"渲染进程能做什么"限定在一个明确的清单里。

### P2.3 验收

`npm start` 打开窗口，页面显示代理运行状态与端口。

---

## P3 — 渲染进程 UI

**目标**：三个视图。原生 HTML/CSS/JS，不引入框架。

| 视图 | 内容 |
|---|---|
| 供应商 | 列表（含连接状态）、当前激活项高亮、增删改、一键切换、连接测试按钮 |
| 日志 | 实时滚动的请求记录：时间、供应商、状态码、耗时、token |
| 用量 | 按供应商/按天的请求数与 token 汇总 |

**要点**：日志通过主进程主动推送（`webContents.send`）而非轮询。

---

## P4 — 首次引导（涉及破坏性操作）

**目标**：把 Claude Code 指向本地代理，且**用户始终清楚发生了什么**。

### P4.1 `src/main/setup.js`

流程必须是：

1. 读取现有 `~/.claude/settings.json`，展示当前 `env` 内容
2. **先备份**为 `settings.json.bak.<时间戳>`
3. 生成改动预览（旧值 → 新值），在 UI 上逐项展示
4. **用户显式点击确认后才写入**
5. 写入采用与 `store.js` 相同的原子替换方式
6. 检测是否存在 managed settings 下发的 `ANTHROPIC_BASE_URL`，若有则提示本工具会失效

**为什么坚持"先展示 diff 再写入"**：这是我们在设计阶段就承诺的约束 —— 工具会修改一个用户在意的、且 Claude Code 依赖的配置文件。任何"静默修改"都会让用户在出问题时无从排查。备份 + diff + 显式确认，是这个功能能被信任的前提。

### P4.2 验收

- 拒绝确认时，原文件**逐字节不变**
- 确认后，备份文件存在且内容与原文件一致
- 写入后 Claude Code 能正常通过代理工作

---

## P5 — 端到端实测与收尾

1. **真实端到端**：用真实的 DeepSeek key 跑一次 Claude Code，确认流式输出正常、日志有记录、用量有统计
2. **异常路径**：key 错误、上游 500、网络断开，确认错误能被正确显示而非静默挂起
3. **权限检查**：确认 `~/.cc-nbproject/profiles.json` 权限是 `600`
4. **仓库自查**：全库搜索确认无任何真实 API key 被提交
5. **推送**：创建私有 GitHub 仓库并推送

---

## 全局约束（每个阶段都适用）

1. **不引入非必要依赖** —— 测试用 `node --test`，HTTP 用内置 `http`，UI 用原生 DOM
2. **代码注释解释「为什么」，而不是「是什么」** —— 例如注释应当说明"这里手动处理 data 事件是因为 pipe 无法旁路解析"，而不是"这里写入数据"
3. **每个阶段结束时 `npm run lint && npm test` 必须通过**
4. **每完成一个可独立成立的阶段做一次提交**，提交信息说明改了什么、为什么

---

## 完成定义（v0.1 Done）

- [ ] 能用 GUI 添加/编辑/删除供应商
- [ ] 切换供应商后，**正在运行的 Claude Code 会话无需重启**即可用新供应商
- [ ] 连接测试能正确报告可用性与延迟
- [ ] 日志视图能看到实时请求记录
- [ ] 用量视图能看到 token 消耗汇总
- [ ] 首次引导能安全改写 Claude Code 配置，且备份可恢复
- [ ] `npm test` 全绿，`npm run lint` 无错
- [ ] 仓库中不含任何真实 API key
