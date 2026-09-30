# dsh-gomoku-client

五子棋（Gomoku）插件的 **浏览器半侧**：对话区里多出一个「五子棋」视图，里面是一块
**可点击的 15×15 棋盘**。人落子之后 **agent 会自动接着下**，不需要人去发"该你了"。

棋盘只是 Host 权威状态的一个视图与点击入口：数据全部来自
[`dsh-gomoku-host`](../dsh-gomoku-host) 的 `/gomoku` 路由。

## 界面

- 木纹棋盘：四段暖色底的斜向渐变 + 11 条柔边木纹 + 斜向高光 + 四周压暗 + 内框。
- **坐标数字**（上边一排、左边一列，0–14），方便你对着 agent 说"我下在 (7,7)"。
- 棋子按真实棋具的观感画：**黑子取青石冷调、白子取蛤贝暖调**，每子是五层叠出来的
  ——落影、本体（偏左上的径向渐变，光源在左上）、右下环境遮蔽、左上两枚柔光高光、
  极细描边（让白子在浅木色上也有边界）。
  ⚠️ 刻意**不用 `feGaussianBlur` 做落影**：一个盘面最多 225 子，每子挂一个模糊滤镜
  会让重绘明显变卡；径向渐变做落影既便宜又不糊。全盘只有"取胜连线"用一次滤镜。
- **最后一手**用圆环标出（黑子上亮环、白子上暗环）；**取胜五连**叠一条发光折线，
  其余棋子压暗。
- 悬停显示**幽灵子预览**；点击交叉点落子（乐观上屏，随后以 Host 权威快照覆盖）。
- **键盘**：棋盘可聚焦，方向键移动光标、`Enter`/空格落子。
- **对手模式选择器**（引擎 / 模型 / 手动）——"快不快、占不占对话"的总开关。
- 状态栏标出**最后一手是谁下的**（你 / 模型 / 引擎）及其坐标。引擎模式下一次点击会
  落两子，不标出来会看不懂。
- 「新开一局」与「换边重开」（都会沿用当前选择的模式）。

## 座位：只有右侧边栏

棋盘**只**出现在右侧边栏——屏幕中间留着对话，右边常驻棋盘，可以边聊边下。对话区的
视图页签里**没有**五子棋（这是按需求刻意去掉的）。

怎么让它出现：插件激活时会**自动打开**这个页签（`single: true`，所以对"已经开着"是
幂等的，不会开出第二个棋盘）。也可以在右侧栏自己的页签菜单里找到「五子棋」——注册时
带了标题、描述和一枚小棋盘图标。

### 为什么要留一个兜底

官方 `sidebar.right.pane.tab` 是按**已有页签种类**派发的（它的子节点是 guide / files /
document 这些既有种类），没有给"新增一种页签"留口子。所以右侧栏这条路依赖
`dsh-better-sidebar` 暴露的 `ctx.betterSidebar`（`registerTab` 注册页签、`openTab`
打开它，落地在 DSH 原生的右侧栏里）。

**万一那台机器上没有这个服务，本插件就会什么都看不见**——那是最难查的一类故障。
所以逻辑是：

| 情况 | 行为 |
|---|---|
| `apply` 时服务已在 | 只注册并打开右侧栏页签，**不碰对话区** |
| `apply` 时服务还没出现 | 先挂一个**对话视图兜底**座位（免得隐身），同时 `ctx.inject(["betterSidebar"], …)` 等它 |
| 服务随后出现 | 注册并打开侧栏页签，**把兜底座位撤掉**，回到"只有侧栏" |
| 服务始终没出现 | 兜底座位留着，插件仍然可用 |

关键在于 `ctx.inject` 的回调**只让那个回调等待，不会挡住本插件自己的激活**（宿主半侧
用的就是这个性质）：所以"服务还没出现"不会连累棋盘。注册是幂等的（`registered` 标记），
整套包在 try/catch 里——第三方服务的行为不该有机会弄坏棋盘。

> 侧栏的页签组件拿不到 slot 的 `hooks` / `locale` 座位，所以它**自己**订阅 store
> （`useStoreSnapshot`）、**自己**用 `localize` 取文案；`visible` 为假（后台页签）时
> 不订阅，也就不会继续每秒轮询 Host。

## 对手模式：默认是本地引擎

原先的做法是"人落一子 → 往会话投一条 prompt 把模型唤醒 → 模型落子"。实测下来它有三个
代价，全都会落到体验上：**慢**（一手 = 一次唤醒 + 一到两次工具往返）、**脏**（每手都在
对话里插一条用户消息）、**占用**（模型想棋期间那个会话干不了别的）。

所以默认改成 Host 的本地棋力内核：`POST /gomoku/move` 在**同一次 HTTP 往返**里就把
"你这一手 + 引擎的应对"一起返回——毫秒级、零会话副作用、对话完全不被占用。

| 选择 | 谁应对 | 合适什么时候用 |
|---|---|---|
| **引擎**（默认） | 本地棋力内核 | 想安静、快速地下一局 |
| 模型 | 模型，经 `session.prompt` 唤醒 | 想看它"想"棋、听它讲思路 |
| 手动 | 谁都不自动 | 摆棋/复盘 |

> ⚠️ 客户端对**快照里没有 `agentMode` 的旧 Host** 一律按"模型"兜底，而不是按新默认值
> "引擎"。否则"只刷新了页面、还没重启应用"的那段窗口里，客户端会以为引擎会应对，结果
> 既不去唤醒模型、也没人落子——棋局直接卡死。

## 模型模式：怎么唤醒模型

选了"模型"之后，人落子会往当前会话投一条 prompt 把会话唤醒：

```js
ctx.get("remote").session.prompt({
  requestId, sessionId, mode: "queue",
  content: [{ type: "text", text: "（五子棋）我下在 (7, 7) 了。轮到你执黑，请用 gomoku_move 落子。" }],
  clientTimeZone,
});
```

这正是输入框 Send 按钮走的那条路（`@deepseek-ai/dsh-api-session-controller` 的
`@Remote('prompt')`，Remote 命名空间 `ctx.remote.session`）。链路是：

```
点击棋盘 → POST /gomoku/move → Host 落子、轮到对手
        → session.prompt("该你…") → 模型被唤醒 → gomoku_show 看盘 → gomoku_move 落子
        → Host 落下一手 → 客户端轮询到新 rev → 棋盘更新
```

⚠️ **prompt 文案刻意不含任何局面断言**——不写"人下在哪"，也不写"你执什么颜色"。

这是踩过的坑：早期版本写的是"我下在 ({row}, {col}) 了。轮到你执{who}…"，实测中真的
发出了 **"我下在 (?, ?) 了。轮到你执黑"**——那条 prompt 是从一份**与真实盘面不一致的
快照**拼出来的（`lastMove` 为 null、`humanColor` 还是默认值），也就是 prompt 在替 Host
说话，而且说错了。

修法是从根上取消这类断言：文案只说"该你落子，先看盘再落子"，权威局面由模型自己去
`gomoku_show` 拿。而 `gomoku_move` 的 `color` 可以省略、自动按轮次落子，所以模型
**根本不需要**从 prompt 里知道执子方。于是文案与局面彻底解耦，任何时序/陈旧问题都
不可能再让 prompt 说假话。自检里有一条断言：换一个完全不同的局面（连 `lastMove`
为 null 的开局也算），prompt 文案必须**逐字不变**。

几个刻意的设计选择：

| 决定 | 原因 |
|---|---|
| 用 `rev` 做护栏，同一局面只自动投一次 | 否则视图重挂载 / 每秒轮询会把同一手反复投出去，变成 prompt 风暴 |
| 会话身份由组件在挂载时交给 store（`attachSession`） | Remote 需要 `sessionId`，而它只存在于 slot 的 standard props 里 |
| Remote **惰性、可选**获取，不写进 `inject` | 一旦某个组合里没有 `remote.session`，硬注入会让 fiber 停在 pending，**连棋盘都注册不出来**；现在最坏只是退回手动提示 |
| 失败时显示原因 + 「催 agent 落子」按钮 | 唤醒通道坏掉时游戏仍然能推进，不会卡死 |
| prompt 走 `mode: "queue"` | 它是一条普通的用户消息，不是对当前轮次的插话 |
| prompt 只说"该你落子"，局面由工具去读 | 上述"prompt 说假话"的根因消除 |

副作用要说清楚：**每一手都会在对话里留下一条用户消息**（就是上面那句 prompt）。
这是让模型获得轮次的唯一通道（`SessionPromptRequest` 没有"隐藏消息"这种选项），
好处是过程完全可见、可审计。

还有一条边界：`conversation.view` 是"一次只渲染一个"的视图，**只有你正停在五子棋
标签页上时**组件才是挂载的。人落子必然是点棋盘，所以那条链路总能触发；但如果你切到
chat 标签页，棋盘就不再轮询（回来时会立刻补上）。

## 看不到浏览器里发生了什么怎么办

这是这个插件最难受的一点：客户端 bundle 的失败**在源头就被丢弃**（web boot 内核的审计
循环只打印 fiber 状态名，不带异常），崩溃日志里也只有一句 `<包名>: failed`。所以这一版
内置了三样东西：

1. **构建徽章**：棋盘标题旁的 `v0.3.1`。改了 `lib/client.js` 就**必须同时改 `BUILD`**，
   否则"新代码到底加载了没有"又变成猜谜。（实测教训：改完文件只靠 HMR，页面里跑的可能
   还是旧那一份——见下。）
2. **`[gomoku <build>]` 控制台面包屑**：F12 → Console。会打出 `bundle evaluated`、
   `view mounted {sessionId, propKeys}`、`attachSession`、`skip wake: …`（以及为什么跳）、
   `waking agent`、`remote resolved via <哪条路>`、`prompt accepted / REJECTED`。
3. **状态栏里的详细失败原因**：三条取 Remote 的路径各自怎么了会直接印在棋盘下面。

**改了客户端代码之后请强刷页面（Ctrl+Shift+R）。** 普通的 Ctrl+R 可能复用缓存的
index.html，那 graph 还是旧的、拿到的还是旧 bundle。DSH 的 HMR 会更新 graph 的 rev
（可以实测到 rev 变化），但替换一个**已经加载**的插件的代码不在普通 enable/disable
同步范围内，页面会保留它原来那份。这一步我踩过：改完代码让用户 Ctrl+R，结果页面里跑的
还是改动之前那一版，白等一轮。

## 安装

```powershell
install_bundle  C:/Users/nuton/Documents/deepseek-harness/dsh-gomoku/dsh-gomoku-client
```

改动 `lib/client.js` 之后，Host 侧的 `client-hmr` 会按文件 mtime 变化推送 `rebuilt`，
浏览器通常会自动换上新版本；**刷新一次页面**（Ctrl+R）是更保险的做法。改客户端
**不需要重启应用**。

## ⚠️ 本包是**纯客户端**插件

`lib/index.js` 的 `apply` 是空函数，宿主侧什么都不做。这不是偷懒，而是实测约束：
**只要 `package.json` 里出现 `dsh.client` 字段，宿主半侧就不会激活**（对照实验见
[`dsh-gomoku-host/README.md`](../dsh-gomoku-host/README.md)）。所以真正干活的宿主逻辑
放在不含该字段的 `dsh-gomoku-host` 里。

参考形态是本机长期稳定的 `dsh-plugin-account-balance`——同样是一个纯客户端插件，
`lib/index.js` 18 行、零 import、空 `apply`。

## ⚠️ `bundle` 的 id 必须等于包名

`@deepseek-ai/dsh-client-modules` 用**包的 manifest 名**当浏览器模块标识，并据此组装
boot graph（`/plugins/<包名>/client.js?rev=<rev>`）。`lib/client.js` 里

```js
window.__ModuleLoader__.load({ id: "dsh-gomoku-client", factory: (require) => { ... } })
```

的 `id` 与 `package.json` 的 `name` 不一致，factory 永远不会被认领——脚本会加载，
但插件不生效。`test/client-check.mjs` 专门断言这一点。

## 只依赖平台种子表

客户端 factory 的 `require` 只能解析**静态平台种子表**里的名字（`react`、`react-dom`、
`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-slots` 等）以及 boot graph 里的包行。
本 bundle 刻意**只 `require("react")`**，所以 `dsh.client` 里既不需要 `external`
也不需要 `inject`，升级时最不容易被跳过。

## slot 契约

```js
ctx.effect(() => ctx.locale.register(NS, { zh, en }), "gomoku: dictionaries");

ctx.slots.inject("conversation.view", () =>           // 等 owner 声明后再注册
  ctx.slots.register({
    name: "conversation.view",   // 与 chat / trajectory 并列的对话视图
    id: "gomoku",                // 自有 id，不复用 chat(0) / trajectory(10)
    order: 20,
    label: () => "五子棋",
    locale: NS,                  // → 组件拿到 t()
    inject: () => ({
      hooks: { gomoku: store },  // → 组件的 useGomoku
      play, reset, flip, nudge, attachSession,
    }),
  }, GomokuView));
```

`hooks: { gomoku: store }` 会在组件 props 上变成 `useGomoku`（框架用
`useSyncExternalStore` 绑定）；`store` 只需满足 `getSnapshot()` / `subscribe()`。
store **只在有订阅者时轮询** `/gomoku/state`——视图切走就不再打扰 Host。

## 目录

```
lib/client.js          浏览器 bundle（既是源码也是产物，免构建）
lib/index.js           宿主半侧占位：空 apply
cordis.patch.yml       bundle patch 层：插入自己的 Loader 行
test/client-check.mjs  自检：桩 __ModuleLoader__ + 迷你 React + stub fetch + stub Remote
```

```powershell
node test/client-check.mjs
```

自检会：校验只 require 白名单模块、校验注册 id 等于包名、把组件真的渲染成元素树
（225 个热区 / 棋子分层 / 坐标数字 / 取胜折线 / 终局压暗 / 畸形快照不抛异常），
跑一遍 store 的 `state` / `move` / `new`，并覆盖自动唤醒的全部路径：
挂载即唤醒、同一 `rev` 不重复投递、`nudge()` 无视护栏、Remote 失败/缺失时降级、
终局与人回合不得唤醒。
