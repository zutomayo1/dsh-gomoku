# 宣传片

`dsh-gomoku` 的宣传片，26.2 秒 / 1920×1080 / 30fps / 786 帧。

```
promo/
  promo.html    ← 舞台：一页确定性动画（window.__seek(t) 定帧渲染）
  shoot.mjs     ← 逐帧截图：headless Chrome + CDP（Node 内置 WebSocket，无 Playwright）
  probe.mjs     ← 几何/样式自检：打印各时刻的相机矩阵与元素矩形，带页面异常捕获
  build.ps1     ← 一条命令：渲染 → ffmpeg 合成 → 抽定妆照
  out/          ← 成片与定妆照（build.ps1 生成）
  frames/       ← 中间帧（构建产物，不入版本库）
```

## 为什么是"逐帧渲染"而不是录屏

片子里每个镜头都要精确可控：第几帧落子、第几帧连线画完、镜头第几帧推到棋盘。
录屏会有掉帧和编码抖动，而且**不可重跑**——改一句字幕就得重新录一遍。

所以 `promo.html` 暴露一个纯函数 `window.__seek(t)`（t 单位秒），把**所有**动效按 t
算成内联样式或 canvas 绘制：没有 CSS `transition`、没有 `requestAnimationFrame`、
没有 `Math.random`、没有 `Date.now`。同一个 t 永远给出同一帧。

`shoot.mjs` 因此只做一件事：逐帧 `Runtime.evaluate(__seek(t))` + `Page.captureScreenshot`。

## 画面里有什么"炫"

| 手段 | 实现 |
|---|---|
| **粒子特效** | 两块 canvas：`#fxBack`（1920×1080，浮尘、开场那道白光与冲击波、五连全屏放射）和棋盘内的 `#boardFx`（636×636，落子冲击环 + 火花 + 五连沿连线喷发）。棋盘那块用棋盘坐标系，所以自动跟着镜头一起被变换，不用手算屏幕坐标 |
| **3D 镜头** | `#app` 上挂 `perspective`，`#cam` 每帧算 `translate3d + scale + rotateZ/X/Y`。窗口从下前方带角度飞入、回摆、再推近棋盘 |
| **屏幕震动** | 每次落子抖 4px（0.2s 衰减），关键节拍抖 11px。作用在 `#world` 上 |
| **冲击闪光** | 命中 / 切场 / 五连时全屏白闪，二次衰减 |
| **动能字幕** | 「边聊边下」「同一次往返」「对手可以换」按 96px 飞入，带运动模糊（`blur` 收敛）和**色差**（红/青两路 `mix-blend-mode:screen` 的伪元素，偏移量随时间收敛） |
| **速度渐变** | 前 26 手 0.135s/手（连珠炮），后 11 手 0.33s/手（放慢看五连） |
| **后期叠加** | 上下 56px 黑边（2.39:1 观感）、扫描线、暗角 |
| **棋盘霓虹** | 每次落子 `box-shadow` 脉一下，五连后持续呼吸 |

## 盘面是"真的"

`promo.html` 照抄 `dsh-gomoku-client` 的真实绘制参数——`STEP=40`、`PAD=38`、`STONE_R=17.3`、
木纹四段渐变、11 条木纹带、棋子六层叠加（落影 → 本体 → 环境遮蔽 → 柔光 → 亮点 → 描边）、
星位、坐标字号。片子里看到的盘面就是用户真正看到的盘面。

对局数据是**真实的一局**：37 手，人类执白、引擎执黑，最后一手 `(7,8)` 连成竖线五子
`(7,8)→(11,8)`。

延迟徽章上的数字是**实测**的引擎耗时中位数：

```powershell
cd ../dsh-gomoku-host
node -e "import('./src/ai.js').then(async m => { const b=new Array(225).fill(0);
  b[7*15+7]=1;b[7*15+6]=2;b[8*15+7]=1;b[9*15+7]=2;b[6*15+7]=1;b[5*15+7]=2;b[8*15+6]=1;
  const a=[]; for(let i=0;i<200;i++){const t0=process.hrtime.bigint();m.chooseMove(b,1);a.push(Number(process.hrtime.bigint()-t0)/1e6);}
  a.sort((x,y)=>x-y); console.log('median', a[100].toFixed(2), 'ms'); })"
# -> median 4.05 ms
```

改了这个数就要同步改 `promo.html` 里的 `ENGINE_MS`。

## 重建

```powershell
pwsh promo/build.ps1           # 全套：渲染 786 帧 + 合成 mp4/webm + 抽定妆照
pwsh promo/build.ps1 -Still    # 只出 6 张定妆照（几秒，用来调构图）
pwsh promo/build.ps1 -Fps 60   # 60fps
```

需要本机有 Chrome 或 Edge（`CHROME_PATH` 可覆盖）和 `ffmpeg`。

## 时间轴

| 时间 | 镜头 |
|---|---|
| 0.0 – 3.0 | 白光飞入命中 → 棋盘英雄镜头（3D 倾斜着转正）→ 「五子棋」带色差砸入 |
| 3.0 – 7.4 | 主界面带角度飞入；右侧栏滑出；对话逐条弹入；大字「边聊边下」 |
| 7.4 – 16.6 | 37 手逐子落下（前 26 手连珠炮）：冲击环、火花、震动、霓虹脉动、延迟徽章；大字「同一次往返」 |
| 16.6 – 20.1 | 五连：慢镜 + 命中停顿 → 连线画出 → 全屏放射、冲击环、棋盘内爆发 → 大字「五连」 |
| 20.1 – 23.3 | 三张模式卡片带 3D 翻转飞入，高亮依次走过 |
| 23.3 – 26.2 | 收尾：图标弹出、仓库地址、逐行安装命令、淡出 |

## 调试这套东西的两条经验

**一、`seek()` 半路抛错会让"半部片子"静止。** 片中所有元素都靠 `seek()` 每帧刷样式，
只要中间有任何一处 `.innerHTML = ...` 撞上 `null`，**它之后的每个场景整块不动**，
而画面看上去只是"少了几样东西"。踩过的那次是重写棋盘标记时漏掉了 `#latency` 那个
div —— 于是动能大字、五连标题、字幕、屏幕震动全部停在前一帧。

现在有两道闸：`promo.html` 加载时一次性校验 `REQUIRED` 里的元素是否都在（缺了就抛），
`shoot.mjs` 监听 `Runtime.exceptionThrown` 并在任何一帧抛错时**中止整次渲染**，
免得把坏帧编进成片。

**二、别在动画世界里用 `transform-style: preserve-3d`。** 一旦 `#world` 成为 3D 渲染
上下文，子元素的 `z-index` 就失效了，3D 旋转过的窗口会盖住上层大字（「五连」标题因此
整块消失）。透视要挂在各自需要的地方：`#app`、`#s5 .col`、以及棋盘自己的 `transform` 里。

定位这两个问题时，`probe.mjs`（打印相机矩阵 + 各元素屏幕矩形 + `display/opacity/font-size`）
比盯着图猜快得多。

## 已知取舍

- **不是真机录屏。** 主界面是按 DSH 的布局手搭的 mock（深色）。片子的价值在于把"边聊边下"
  和"引擎秒回"讲清楚，而不是像素级复刻 DSH 的外壳。
- **无音轨。** 合成音乐容易做廉价，宁可不做。要配乐的话把音轨丢进 `promo/` 再改
  `build.ps1` 里一条 ffmpeg 参数即可。
- 模式卡片用了 emoji（⚡🧠✋）：四十秒的片子里它比矢量图标更快读懂。
