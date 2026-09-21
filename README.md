# cc-nbproject

> 本地反向代理 + 桌面控制台，为 **Claude Code** 提供**零重启**的供应商切换。

## 它解决什么问题

在 Claude Code 里换一个 API 供应商，通常要手工改 `~/.claude/settings.json` 的 `env` 块，**然后重启 Claude Code**。

而"必须重启"是绕不过去的：Claude Code 只提供了动态获取 **API key** 的钩子（`apiKeyHelper`），**没有**任何能动态改变 **base URL** 的机制。只要 base URL 会变，就一定要重启。

本项目换个思路：**让 base URL 永远不变**。

```
   Claude Code
        │  ANTHROPIC_BASE_URL = http://127.0.0.1:8787-8807
        │  （只写一次，之后永不修改；8787 被占则自动顺延）
        ▼
   ┌──────────────┐
   │ cc-nbproject │  按当前选中的 profile 转发
   └──────────────┘
      │      │      │
      ▼      ▼      ▼
  DeepSeek  智谱   Kimi
```

切换供应商 = 改变本地代理的路由目标。Claude Code 全程无感知，**正在运行的会话不受影响**。

## 功能（v0.1）

- 供应商的增删改查，一键切换（零重启）
- 连接测试：发一个极小请求，验证 key 有效性并测出延迟
- **接管 Claude Code 配置，且双向可逆**：点一次「确认接管」即长期记住，
  此后每次启动自动生效、**每次退出自动还原**你的原配置；随时可以「断开接入」
  （接入前会先备份 `settings.json`，且**只备份一次**）
- 实时请求日志：每个请求走了哪个供应商、状态码、耗时
- 用量统计：token 消耗与请求数
- 模型映射：不同供应商对同一个模型的叫法不同（如 OpenRouter 要求 `vendor/model`），
  在供应商配置里按「源=目标」逐行填写即可，未命中的模型名原样转发
- 模型列表拉取：从供应商拉取可选模型 ID 自动预填映射（**这是辅助，不是依赖** ——
  Claude Code 的兼容接口规范里并没有 `/v1/models`，不少供应商没有这个端点，手动填写始终可用）

暂不支持（计划中）：故障转移、系统托盘、应用打包、配置加密。

## 安装

```bash
git clone <repo-url>
cd cc-nbproject
npm install
```

> **⚠️ 关于 Electron 二进制**
> `electron@44` 的 npm 包**不再自带 `postinstall` 脚本**，二进制需要单独下载。
> 本项目的 `package.json` 已经补上了这一步，正常情况下 `npm install` 就会自动完成。
> 如果你在安装后遇到 `Cannot find module ... path.txt`，说明二进制没下载成功，手动执行：
>
> ```bash
> node node_modules/electron/install.js
> ```
>
> 国内网络建议走镜像加速：
>
> ```bash
> ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
> ```

## 使用

```bash
npm run build    # ⚠️ 必须先构建：npm start 加载的是 dist/renderer/index.html
npm start        # 启动应用
```

> **干净克隆直接 `npm start` 会白屏** —— `dist/` 在 `.gitignore` 里，不存在。

首次启动会引导你：

1. 添加至少一个供应商（填 base URL 和 API key）
2. 授权本工具接管 Claude Code 配置（**会先自动备份 `settings.json`**）
3. 完成 —— 之后切换供应商都不再需要重启 Claude Code

### 接管是双向的

| 时机 | 行为 |
|---|---|
| 点「确认接管」 | 备份（仅首次）→ 写入配置，记住你原本的值 |
| 之后每次启动 | 自动接管，不再询问 |
| **每次退出** | **自动还原成你原来的配置** |
| 点「断开接入」 | 还原 + 清除授权记忆（此后启动不再接管） |

还原只针对 `ANTHROPIC_BASE_URL` 与 `ANTHROPIC_AUTH_TOKEN` 两个键，
模型名、权限、hooks 等一概不碰；**你自己手改过的键不会被覆盖**，应用会告诉你哪一项被跳过了。

> **如果你以后不再打算打开本应用，请先点「断开接入」。**
> 应用关着的时候代理是不运行的，此时 Claude Code 会指向一个没人监听的端口。

## 开发

```bash
npm run dev        # Vite dev server + Electron（改渲染进程时用这个，有热更新）
npm run build      # 构建渲染进程到 dist/

npm test           # 单元测试（Node 内置测试运行器，不需要 jest/vitest）
npm run lint       # ESLint 检查
npm run format     # Prettier 格式化
npx tsc --noEmit   # 渲染进程类型检查
```

### 真 Electron 端到端

`npm run e2e` 在隔离的 `HOME` 上启动**生产入口**，用 CDP 驱动界面走完
「接管 → 校验文件 → 用真实退出路径关掉 → 校验文件已还原」，共 5 个场景。

**它验的是静态检查永远验不了的两件事**：渲染进程真的渲染出来了（不是白屏）、
以及 `before-quit` 真的会触发且 `app.exit(0)` 不会形成退出死循环。
**改了 `index.js` 的生命周期或渲染进程就必须跑它。**

### 渲染进程冒烟检查

渲染进程没有任何单元测试保护，而它出过两次「代码正确、lint 全绿，但一跑就崩」的问题
（遮罩层压掉 `hidden`、函数少传参数导致 `TypeError`）。这类问题无法靠单测发现，
所以有一个连真实窗口去点的冒烟检查：

```bash
# 终端 A：带调试端口启动（先退出正在运行的实例 —— 本应用是单实例的）
npx electron . --remote-debugging-port=9222

# 终端 B：驱动它
npm run smoke            # 默认挑名字含 openrouter 的 profile
npm run smoke -- <名字片段>
```

**它不会动你已有的供应商。** 第二个参数只用来抄 `baseUrl`/`apiKey` —— 检查全程
操作的是一个当场新建的一次性供应商 `__smoke__`，结束时无条件删掉，并逐字段核对
你原有的配置一字未变。（早先的版本直接在真实 profile 上改、收尾再还原，
结果把用户运行期间自己改的值覆盖掉了；检查工具不该有这种窗口期。）

零依赖 —— 用 Chrome DevTools Protocol 直接驱动，Node 自带的 `fetch` / `WebSocket` 就够，
不引入 puppeteer。详见[设计文档 9.1](docs/plans/2026-09-21-cc-nbproject-design.md)。

### 项目结构

```
src/
├── main/            # 主进程：完整的 Node 环境（代理、配置、用量）
│   ├── index.js     #   Electron 入口，装配各模块 + 生命周期
│   ├── proxy.js     #   ★ 代理核心，纯 Node，不依赖 Electron，可独立测试
│   ├── proxy-agent.js # 让上游请求走系统代理（macOS scutil / 环境变量）
│   ├── models.js    #   从供应商拉取模型列表（带缓存）
│   ├── store.js     #   配置读写（原子写入，权限 0600）
│   ├── usage.js     #   用量记录
│   └── setup.js     #   ★ 唯一会改 ~/.claude/settings.json 的模块：接管与还原
├── preload/         # 安全桥：用 contextBridge 向渲染进程暴露白名单 API
└── renderer/        # 渲染进程：React + TypeScript（Vite 构建）

scripts/
├── dev.mjs          # dev 模式：Vite dev server + Electron
├── ui-smoke.js      # 用 CDP 驱动真实窗口的渲染进程冒烟检查
├── takeover-e2e.js  # 接管/还原的真 Electron 端到端检查
└── e2e-app/         # 上面那个用的 Electron 入口（不是生产代码）

test/                # node --test 的单元测试
```

**架构要点**：代理运行在**主进程**而非渲染进程 —— 渲染进程是沙箱化的浏览器环境，不适合监听端口；主进程才是完整的 Node 运行时。这条边界是理解 Electron 的关键。

**为什么 `proxy.js` 不依赖 Electron**：这样才能离开窗口单独运行和测试。调试代理逻辑（本项目最易出错的部分）时不必每次开 GUI。

## 安全说明

- **API key 以明文存储在 `~/.cc-nbproject/profiles.json`**，依靠文件权限 `600` 保护。
  v0.1 不做自研加密 —— 加密所需的主密钥同样得存在本地，只是把问题挪了一层。后续计划接入系统钥匙串（macOS Keychain 等）。
- 代理**只监听 `127.0.0.1`**，局域网内其他机器无法访问。
- **但「本机」不等于「本用户」**：同机的其他进程连得上这个端口，而代理会拿你的真实 key
  去发请求。所以本工具**每次安装随机生成一个准入凭证**（32 字节），写进 Claude Code 的
  `ANTHROPIC_AUTH_TOKEN`；代理不认这个凭证就回 `401`，**一次上游都不会打到**。
  凭证与 API key 同存于 `profiles.json`，不增加新的暴露面。
- 渲染进程启用 `contextIsolation`、`sandbox` 并禁用 `nodeIntegration`，只能通过 preload
  白名单访问主进程能力（白名单而非透传 —— 页面会显示来自 API 响应的内容）。
- 本工具**替代** Claude Code 保存真实的 API key：Claude Code 的配置里填的是上面那个
  准入凭证，真实 api key 由本工具管理、从不写进 Claude Code 的配置。

## 文档

- [项目速览](docs/项目速览.md) —— 一页硬事实，第一次接触这个仓库先读它
- [架构说明](docs/架构说明.md) —— 代码地图与「我想做 X → 改哪里」
- [工程约束](docs/工程约束.md) —— 分层、约定、验证要求、评审清单
- [审计发现与处置](docs/审计发现与处置.md) —— 已修缺陷与守护它们的测试
- [设计文档](docs/plans/2026-09-21-cc-nbproject-design.md) —— 架构决策与取舍的完整记录
  （**注意第 3.3 节「前端不使用框架」已过时**，渲染进程已迁到 React）
- [实现计划](docs/plans/) —— 分步实现路线
- [CLAUDE.md](CLAUDE.md) —— 给 AI 的硬规则

## License

MIT
