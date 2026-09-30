# dsh-gomoku-host

五子棋（Gomoku）插件的 **Host 半侧**。棋局的权威状态在这个包里，不在浏览器。

- **规则**：freestyle（无禁手），15×15，黑先，连成五子及以上即胜（长连也算胜）。
- **默认执子**：**对手执黑、人类执白**（可换边）。
- **两条通道**：人类点击走 HTTP 路由（**只允许落人类自己那一方**），模型走工具
  （任意一方，缺省按轮次）。
- **默认对手是本地棋力内核**（`src/ai.js`），毫秒级应对，**完全不占用会话**。

## 对手由谁应对：`agentMode`

这是这个插件最重要的一处设计，也是踩过坑之后改出来的。

一开始的做法是"人落一子 → 往会话投一条 prompt 把模型唤醒 → 模型调 `gomoku_move`"。
实测下来这个做法有三个代价，而且全都直接落到体验上：

1. **慢**——一手棋 = 一次唤醒 + 一到两次工具往返，秒级；
2. **脏**——每一手都要往会话里插一条用户消息，对话被棋局刷屏；
3. **占用**——模型"想棋"期间，那个会话干不了别的。

所以现在 Host 自带棋力内核，并区分三种模式：

| 模式 | 谁来应对 | 特点 |
|---|---|---|
| `engine`（默认） | 本地棋力内核 | **毫秒级、零会话副作用**。`POST /gomoku/move` 在**同一次往返**里就把"人这一手 + 引擎的应对"一起返回，界面一帧到位 |
| `model` | 模型（经 `session.prompt` 唤醒） | 棋风像人、能解释思路，但慢，且每手都会在对话里留一条消息 |
| `manual` | 谁都不自动 | 只给调试/复盘用 |

模型仍然可以随时 `gomoku_show` 看盘、点评，或在 `model` 模式下亲自落子。
切换方式：浏览器半侧的模式选择器，或 `POST /gomoku/mode { "agentMode": "engine" }`，
或 `gomoku_new { "mode": "model" }`。

### 棋力内核（`src/ai.js`）

经典的"五窗口计分"：对每个候选点，假设某一方在此落子，枚举**经过该点的
4 个方向 × 6 个长度为 5 的窗口**；窗口里只要没有对方棋子，就按窗口中己方子数计一个
权重。于是"活四 / 冲四 / 活三"这些形状不需要专门写规则——它们天然会让更多窗口、
更高的子数命中，权重自然堆上去。

一手棋的总分 = `我下在这里的价值 + 对手下在这里的价值 × 0.85`；但**先判"能不能立刻赢"**，
再判"对手是不是立刻要赢"（必须堵），否则才按总分取最优。

候选点只取已有棋子周围 2 格以内的空点（`NEIGHBORHOOD` 常量）。随机性用 xorshift32
（`makeRng`，以 `rev` 为种子）而不是 `Math.random`：单测可复现，出问题时可以把种子
抄下来重放。

## 工具

| 工具 | 作用 |
|---|---|
| `gomoku_show` | 看盘：盘面文字、该谁走、双方子数、按"离天元由近及远"排出的候选点 |
| `gomoku_move` | 落子。`row`/`col` 为 0–14，`(0,0)` 在左上角，天元是 `(7,7)`；`color` 可省略 |
| `gomoku_new` | 开新局；可指定 `black`/`white` 由 `agent` 还是 `human` 执子，或 `both: true` |
| `gomoku_archive` | 把棋谱（手顺 + 盘面）写成文件，默认落在 `$DSH_HOME/gomoku/` |

## 路由

前缀 `/gomoku`（见下文"为什么路由前缀是 `/gomoku`"）：

| 方法与路径 | 作用 |
|---|---|
| `GET /gomoku/state` | 棋局快照（浏览器半侧轮询这个） |
| `POST /gomoku/move` | 人类落子；`color` 必须是人类执子方，否则 403 |
| `POST /gomoku/new` | 开新局；可带 `{ "humanColor": "black" \| "white" }` |
| `GET /gomoku/archives` | 列出已存档的棋谱 |

## 安装

```powershell
# 用 plugin_manager 工具
install_bundle  C:/Users/nuton/Documents/deepseek-harness/dsh-gomoku/dsh-gomoku-host
```

或者手工把它 `link:` 进 profile 的 `dependencies`，并把 `dsh-gomoku-host` 加进
`dsh.profile.bundles`（`cordis.patch.yml` 里的 `insert` 行会由安装器自动叠加）。

## ⚠️ 本包为什么**不含** `dsh.client`（已实测确认的根因）

实测（A/B/C 对照）结论：**对于以 `link:` 方式安装的插件，只要 `package.json` 里出现
`dsh.client` 字段，宿主半侧就不会激活。**

| 变体 | `dsh.client` | `/plugins/xxx/state` |
|---|---|---|
| v3 | `{platform:"web", inject:[...]}` | **404（宿主未激活）** |
| v4 | 无该字段 | **200（正常）** |
| v5 | `{platform:"web", inject:[]}` | **404（宿主未激活）** |

与 `inject` 内容无关：只要有这个字段宿主就不激活。所以浏览器半侧拆到独立的
[`dsh-gomoku-client`](../dsh-gomoku-client) 包里（那个包宿主 `apply` 为空）。

**一个曾经的错误归因已被推翻。** 早期把 404 解释成"API 挂在 `/plugins/gomoku`，被
dsh-client-modules 的 `/plugins` bundle prefix 遮蔽了"。用单变量探针实测：把一条
宿主 prefix 路由注册在 `/plugins/probeA`（同属 `/plugins` 子树），请求返回 **200**。
路由器能正确分派嵌套 prefix，**根本没有遮蔽问题**。所以 404 的根因就是上表的
`dsh.client` 字段。

## 为什么路由前缀是 `/gomoku`

这是**语义与结构**上的选择，不是修 bug：

- `/plugins` 是 dsh-client-modules 的 bundle 路由（`PLUGIN_ROUTE = "/plugins"`），
  职责是下发插件资源；本插件的 API 是业务路由，不属于那一族。
- 两个 prefix 家族结构上互不为前缀，行为不依赖路由器的 tie-break 语义
  （实测嵌套 prefix 也能工作，但没必要依赖它）。

改这个前缀时，**必须同时改浏览器半侧 `lib/client.js` 的 `API_BASE`**。

## 形态上的两条硬约束

1. **单文件、零静态导入。** 本插件以符号链接装进 profile；相对导入经 symlink 解析后
   会落在 profile 包表之外，被 DSH 的模块解析拦截层拒绝。表现为"`install_bundle` 后
   可用（直接 import 文件 URL，绕过拦截层），但**启动时激活失败并挡住整个 Web 启动**"。
   `lib/index.js` 由 `tools/build.mjs` 从 `src/engine.js` + `src/host.js` 内联生成，
   需要 node 内建时用惰性 `import()`。

   ```powershell
   node tools/build.mjs   # 重新生成 lib/index.js
   ```

2. **注册必须走 `ctx.inject` + `scope.effect`。** `tools` 与 `webServer` 在插件加载之后
   才注册。写成"取不到服务就 return"会让 fiber 立即 active 却什么都没注册，被宿主判为
   `did not activate`。所以用 `ctx.inject(['tools','webServer'], scope => ...)`，并把每个
   注册挂在 `scope.effect` 上——这样 disable/enable 时注册会被干净释放，否则下一次
   `tools.register` 会因**同一层内工具重名**抛错。

## 出事了怎么撤（不需要 GUI）

如果重启后 DSH **起不来**（弹窗 / 白屏 / Web 服务不监听），在**普通 PowerShell 窗口**里：

```powershell
pwsh -File C:\Users\nuton\Documents\deepseek-harness\dsh-gomoku\dsh-gomoku-host\tools\revert-profile.ps1
```

它会：备份当前状态 → 用已知良好的副本还原 `cordis.patch.yml`（保住 `llm-pi-ai` /
`opencode-go` / `danger-full-access` / `reasoningEffort`）→ 从 `dependencies` 与
`dsh.profile.bundles` 里摘掉两个 gomoku 包 → `rmdir` 掉两个符号链接 → 打印核对结果。

先看它要做什么可以加 `-DryRun`。**这三步必须一起做**：`dependencies` 里的包会被自动
加载、**与 `bundles` 列表无关**，只摘 `bundles` 是不够的。

> 这也是为什么启动失败要格外小心：DSH 的自动恢复会把 `dsh.profile.bundles` 截断成
> 只剩 `dsh-base` + `dsh-web-app`，并把 `cordis.patch.yml` 重置成默认偏好——**会连带
> 抹掉用户的模型提供商配置**。每次改写前会留 `cordis.patch.yml.bak-<时间戳>`。

## 目录

```
src/engine.js     规则内核：纯函数、零依赖、15 项单测全绿
src/host.js       宿主半侧：工具 + 路由
tools/build.mjs   内联成 lib/index.js
tools/revert-profile.ps1  紧急撤销（见上）
lib/index.js      产物（勿手工编辑）
test/engine.test.mjs   规则单测（node test/engine.test.mjs）
test/activate.mjs      宿主自检：桩 ctx 走一遍注册/工具/路由/卸载
```
