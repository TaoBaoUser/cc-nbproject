# cc-nbproject — AI 执行规则

> 本文件是**规则**，写给在本仓库里动手的 AI。只写「必须怎么做」，不解释为什么。
> 「为什么」在 [docs/项目速览.md](docs/项目速览.md) 与 [docs/架构说明.md](docs/架构说明.md)；
> 给人读的完整工程规范在 [docs/工程约束.md](docs/工程约束.md)。
>
> **冲突时以本文件为准。**

---

## 0. 语言

始终用简体中文回复、写注释、写文档、提交信息。代码标识符、命令、路径保持原文。

---

## 1. 文件保护（最高优先级，不可违反）

未经用户明确、逐次的许可，禁止对任何文件或目录执行破坏性操作：

- **删除**：`rm`、`rm -rf`、`git clean`、移入废纸篓
- **覆盖**：覆盖写入已存在的文件、`cp` 覆盖、`>` / `>>` 重定向覆盖
- **移动 / 重命名**：`mv`、`git mv`
- **权限 / 属主变更**：`chmod`、`chown`
- **破坏性 git**：`git reset --hard`、`git checkout -- .`、`git push --force`

执行前必须：① 列出将影响的文件 ② 说明影响与不可逆性 ③ 取得明确同意。
**优先用 `Edit` 做定点替换，不要用 `Write` 覆盖已有文件。**
确需删除时先备份。

### 本仓库里尤其危险的目标

| 目标 | 为什么 |
|---|---|
| `~/.claude/settings.json` | **用户的真实 Claude Code 配置**，里面有他的真实 API key。本工具唯一承诺只改一次的（且必须还原） |
| `~/.cc-nbproject/profiles.json` | 用户所有供应商的 API key 都在这里 |
| `~/.claude/settings.json.bak.*` | 用户回滚的唯一凭据，删掉就没了 |

**任何自动化检查都不得读写用户真实的这两个文件。** 需要验证就用
`mkdtemp` 造隔离目录（`createStore({ dir })` / `createSetup({ claudeDir })` 就是为此存在的）。

---

## 2. 改动之后必须给的证据

**「跑过了」不算证据。要说清跑的是什么、输出是什么。**

| 改了什么 | 最少要跑到 |
|---|---|
| 任何 `.js` / `.ts` / `.tsx` | `npx tsc --noEmit`、`npm run lint`、`npm test` |
| `src/main/proxy.js`、`store.js`、`setup.js`、`models.js` | 上面三条 + **针对该行为的新单元测试** |
| `src/main/index.js`（生命周期）、`src/renderer/**` | 上面三条 + **`npm run e2e`（真 Electron）** |
| `src/renderer/**` 的界面改动 | 上面三条 + **`npm run e2e` 或 `npm run smoke`** |

### 一条不可绕过的规矩

**`tsc` / `lint` / 单测全绿，证明不了渲染进程能渲染，也证明不了生命周期钩子会触发。**

这个仓库已经因此吃过两次亏：`.modal-root` 的 `display:flex` 压掉 `hidden`
导致遮罩层常驻（界面全灰、点不动）；函数少传参数导致一打开编辑框就 `TypeError`。
两次都是「代码根本没跑到过」，而 ESLint 看不出来。

改渲染进程或 `index.js` 后**必须真起一个 Electron**。别用「构建成功」交差。

---

## 3. 硬边界（改代码时不能碰的线）

1. **代理跑在主进程，不在渲染进程。** 渲染进程是沙箱化的浏览器环境，不许监听端口、
   不许 `require`、不许直接 `fs`。需要主进程能力 → 加 IPC + 在
   [src/preload/index.js](src/preload/index.js) 登记 + 在
   [src/renderer/types.ts](src/renderer/types.ts) 补类型，**三处缺一不可**。

2. **`contextBridge` 必须是白名单，不许透传。** 绝不写
   `exposeInMainWorld('ipcRenderer', ipcRenderer)`。

3. **`setup.js` 只碰两个键**：`env.ANTHROPIC_BASE_URL`、`env.ANTHROPIC_AUTH_TOKEN`。
   `ANTHROPIC_MODEL` 等模型键、`permissions`、`hooks` 一律不动。

4. **写进 Claude Code 的地址必须取自 `proxy.baseUrl`，永远不许写死 `127.0.0.1:8787`。**
   被占时端口会顺延到 8807；写死会把一个连不上的地址写进用户配置。

5. **`ANTHROPIC_AUTH_TOKEN` 写的是本地准入凭证（`store.getLocalToken()`），
   不是用户的真实 key，也不是任何固定常量。** 固定常量等于把代理敞开给同机所有进程。

6. **`setup.js` 必须保持可注入路径的工厂形态**（`createSetup({ claudeDir })`），
   `store.js` / `proxy.js` / `usage.js` / `models.js` 同理。
   路径写死在模块顶层 = 这段逻辑永远测不了。

7. **「接管」与「还原」必须成对。** 只接不管，用户关掉应用后 Claude Code
   就指向一个没人监听的端口。任何新增的写入路径都要想清楚它的还原路径在哪。

8. **还原只走 `app.on('before-quit')` 一个口子。** 不许注册 `SIGINT`/`SIGTERM`
   处理器（macOS 上 Finder 启动的 .app 收不到，覆盖为零却会和 Electron 自己的
   退出流程打架），也不许挂到 `window-all-closed`（应用退出时它根本不触发）。

9. **写序不许反**：`applyClaudeSettings` 成功落盘**之后**才能写 `takeover.enabled = true`。
   反过来会留下「界面说已接管、文件其实还是原样」的半接管状态。

10. **单实例锁必须在模块顶层判定**，且落败分支**不做任何还原**
    （它读到的状态是另一个实例写的，它无权撤销）。

---

## 4. 写测试的约定

- 用 `node --test`，**不引入 jest / vitest / puppeteer / playwright**。
- 涉及文件系统的一律 `mkdtemp` 造隔离目录，**不碰用户真实路径**。
- 临时目录**不做清理**（交给系统回收）—— 免得测试代码里出现任何 rm 类操作。
- 测试名写中文，说清「验的是什么行为」，不要写「test1」「should work」。
- **断言要断言行为，不要断言实现。** 尤其不要写「读被测对象自己算出的值，
  再断言界面等于它」这种同源自证的检查。
- 会破坏用户数据的回归**必须有测试钉死**。已钉死的清单见
  [docs/审计发现与处置.md](docs/审计发现与处置.md)。

---

## 5. 提交前

```bash
npx tsc --noEmit && npm run lint && npm test
```

涉及主进程生命周期或渲染进程时，再加 `npm run e2e`。

提交信息用中文，形如 `fix(setup): 还原时把键删掉而不是写成空串`。
**不要在没有明确要求的情况下提交或推送。**

---

## 6. 环境坑

- **`ELECTRON_RUN_AS_NODE=1`** 会让 Electron 退化成普通 Node 进程，`app` 是
  `undefined`。跑任何 Electron 脚本用 `env -u ELECTRON_RUN_AS_NODE`。
- **`npm start` 之前必须 `npm run build`**：`dist/` 在 `.gitignore` 里。
- 用户可能**正开着一个本应用的实例**，它会占住 8787 并持有单实例锁。
  不要 `pkill` 它。
