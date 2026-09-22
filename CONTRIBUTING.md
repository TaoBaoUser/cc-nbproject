# 贡献指南

> 这份文件只讲**怎么提一个能合进去的改动**。想先搞清楚项目本身，
> 读 [docs/项目文档.md](docs/项目文档.md)；完整规范在 [docs/工程约束.md](docs/工程约束.md)。

**开始之前请知道一件事**：这个项目会**改写用户的 `~/.claude/settings.json`**，
写错的代价不是「功能不工作」，而是**用户的 Claude Code 突然不能用了，
而用户完全想不到是本工具造成的**。所以这里的许多规矩不是风格偏好，是用事故换来的。

---

## 1. 起步

```bash
git clone https://github.com/TaoBaoUser/cc-nbproject.git
cd cc-nbproject
nvm use            # 仓库有 .nvmrc，需要 Node ≥ 22.12
npm install
npm run build      # ⚠️ 必须先构建，dist/ 不在版本库里
npm start
```

日常开发用 `npm run dev`（Vite 热更新 + Electron）。

> ⚠️ 若你的终端设了 `ELECTRON_RUN_AS_NODE=1`，Electron 会退化成普通 Node 进程、
> 报 `app is undefined`。用 `env -u ELECTRON_RUN_AS_NODE npm run dev` 绕过。

---

## 2. 提交前必须跑的

```bash
npm run verify     # = typecheck + lint + test（第 1 级）
```

**动了下面这些，还必须跑第 2 级**：

```bash
npm run e2e        # 真 Electron 端到端
```

- `src/main/index.js` 的生命周期
- `src/renderer/**` 的任何改动

**为什么不能只看「构建成功」**：`tsc` / `lint` / 单测全绿，**证明不了渲染进程能渲染**，
也证明不了 `before-quit` 会触发。本仓库已经因此吃过两次亏 ——
遮罩层常驻导致界面点不动、函数少传参数一开编辑框就 `TypeError`，两次 ESLint 都看不出来。

三级验证的完整说明见 [docs/项目文档.md 第 6 章](docs/项目文档.md#6-开发测试与验证)。

---

## 3. 不能碰的线

改动前请确认没有越过下面任何一条。**每条都有理由**，理由在
[docs/工程约束.md](docs/工程约束.md) 与 [docs/项目文档.md](docs/项目文档.md)。

| #   | 规则                                                                                             |
| --- | ------------------------------------------------------------------------------------------------ |
| 1   | 代理跑在**主进程**；渲染进程不监听端口、不 `require`、不直接 `fs`                                |
| 2   | `contextBridge` 必须是**白名单**，绝不写 `exposeInMainWorld('ipcRenderer', ipcRenderer)`         |
| 3   | `setup.js` **只碰两个键**：`env.ANTHROPIC_BASE_URL`、`env.ANTHROPIC_AUTH_TOKEN`                  |
| 4   | 写进 Claude Code 的地址必须取自 `proxy.baseUrl`，**永远不许写死 `8787`**                         |
| 5   | `ANTHROPIC_AUTH_TOKEN` 写的是**随机准入凭证**，不是用户的真实 key，也不是固定常量                |
| 6   | `setup.js` / `store.js` / `proxy.js` / `usage.js` / `models.js` 必须保持**可注入路径的工厂形态** |
| 7   | 「接管」与「还原」必须**成对**出现 —— 新增任何写入路径，先想清楚它的还原路径在哪                 |
| 8   | 还原只走 `app.on('before-quit')` 一个口子；不许注册 `SIGINT`/`SIGTERM`                           |
| 9   | 写序不许反：`applyClaudeSettings` 成功落盘**之后**才能写 `takeover.enabled = true`               |
| 10  | 单实例锁必须在**模块顶层**判定，落败分支**不做任何还原**                                         |

**新增 IPC 能力必须四处同步**，缺一不可：
`src/main/index.js` 的 `ipcMain.handle` → `src/preload/index.js` 白名单 →
`src/renderer/ccnb.ts` 签名 → `src/renderer/types.ts` 数据结构。

---

## 4. 写测试

- 用 `node --test`，**不引入 jest / vitest / puppeteer / playwright**。
- 涉及文件系统的一律 `mkdtemp` 造隔离目录，**绝不碰用户的真实路径**。
- 临时目录**不做清理**（交给系统回收）—— 免得测试代码里出现任何 `rm` 类操作。
- 测试名写中文，说清「验的是什么行为」，不要写 `test1`、`should work`。
- **断言要断言行为，不要断言实现。** 不要写「读被测对象自己算出的值，再断言界面等于它」
  这种同源自证的检查 —— 算错了两边一起错，测试照样绿。
- 会破坏用户数据的回归**必须有测试钉死**。

---

## 5. 提交信息

用中文，形如 `fix(setup): 还原时把键删掉而不是写成空串`。

常用前缀：`feat` / `fix` / `docs` / `test` / `chore` / `refactor`。
范围用模块名（`setup`、`proxy`、`renderer`、`store`…）。

**说明「为什么」，不只说「改了什么」** —— 后者看 diff 就知道。

---

## 6. 提 PR

1. 从 `main` 切分支，别直接在 `main` 上改
2. 跑完第 2 节要求的验证（CI 也会跑，但本地先跑能省一个来回）
3. PR 描述里写清：**改了什么、为什么、怎么验证的**
4. CI 会有两个 job：
   - `check`（ubuntu）：类型 + 规范 + 单测 + 构建
   - `e2e`（macOS）：真 Electron 端到端 —— **只在 PR 上跑**（额度考虑，见 CI 文件里的注释）

涉及界面或生命周期的改动，**请贴上你实际跑过的命令与输出**。
「跑过了」不算证据。

---

## 7. 文档

改代码时如果发现文档与代码不符，**请顺手改掉文档** —— 一份说谎的文档比没有文档更糟。

- 常青文档放 `docs/`，中文文件名
- 带日期的过程产物放 `docs/plans/`，命名 `YYYY-MM-DD-主题.md`
- 站内链接一律用**相对路径**，指向真实文件
- **移动文档时，必须搜一遍全仓库有没有别的文件链到它**

文档分工见 [docs/项目文档.md 第 8.4 节](docs/项目文档.md#84-文档地图)。
