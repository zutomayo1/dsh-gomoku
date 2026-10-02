# 宣传片

`dsh-gomoku` 的宣传片，25.4 秒 / 1920×1080 / 30fps。

```
promo/
  promo.html    ← 舞台：一页确定性动画（window.__seek(t) 定帧渲染）
  shoot.mjs     ← 逐帧截图：headless Chrome + CDP（Node 内置 WebSocket，无 Playwright）
  build.ps1     ← 一条命令：渲染 → ffmpeg 合成 → 抽定妆照
  out/          ← 成片与定妆照（build.ps1 生成）
  frames/       ← 中间帧（约 760 张 JPEG，构建产物，不入版本库）
```

## 为什么是"逐帧渲染"而不是录屏

宣传片里每个镜头都要精确可控：棋子正好在第几帧落下、五连连线正好在第几帧画完、
镜头正好在第几帧推到棋盘。录屏会有掉帧和编码抖动，而且**不可重跑**——想改一句字幕
就得重新录一遍。

所以 `promo.html` 暴露了一个纯函数 `window.__seek(t)`（t 单位秒），它把**所有**动效
按 t 算成内联样式：没有 CSS `transition`、没有 `requestAnimationFrame`、没有
`Math.random`、没有 `Date.now`。同一个 t 永远给出同一帧。`shoot.mjs` 因此只做一件事：
逐帧 `Runtime.evaluate(__seek(t))` + `Page.captureScreenshot`。

好处是改文案只要改一个字符串，重跑一遍即可，而且每一帧都能单独拿出来当截图。

## 盘面是"真的"

`promo.html` 里的棋盘**照抄** `dsh-gomoku-client` 的真实绘制参数——`STEP=40`、`PAD=38`、
`STONE_R=17.3`、木纹四段渐变、11 条木纹带、棋子六层叠加（落影 → 本体 → 环境遮蔽 →
柔光 → 亮点 → 描边）、星位、坐标字号。所以片子里看到的盘面就是用户真正看到的盘面，
不是另画一个"像棋盘的图"。

对局数据也是**真实的一局**：37 手，人类执白、引擎执黑，最后一手 `(7,8)` 连成竖线五子
`(7,8)→(11,8)`。不是编的棋谱。

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
pwsh promo/build.ps1              # 全套：渲染 762 帧 + 合成 mp4/webm/gif + 抽定妆照
pwsh promo/build.ps1 -Still       # 只出 6 张定妆照（几秒钟，用来调构图）
pwsh promo/build.ps1 -Fps 60      # 60fps（1524 帧，渲染时间翻倍）
```

需要本机有 Chrome 或 Edge（`CHROME_PATH` 可覆盖）和 `ffmpeg`。

## 时间轴

| 时间 | 镜头 |
|---|---|
| 0.0 – 3.0 | 开场：图标 + 「五子棋」标题 |
| 3.0 – 7.2 | 边聊边下：模拟 DSH 窗口，棋盘在右侧栏，对话一条条出现 |
| 7.2 – 16.4 | 对局：37 手逐子落下；每次引擎应手弹出实测延迟徽章；镜头推到棋盘 |
| 16.4 – 19.4 | 五连：连线画出、非连线棋子压暗、「五连」大字与冲击环 |
| 19.4 – 22.4 | 模式：引擎 / 模型 / 手动 三张卡片，高亮依次走过 |
| 22.4 – 25.4 | 收尾：仓库地址与安装命令 |

## 已知取舍

- **不是真机录屏。** 主界面是按 DSH 的布局手搭的 mock（深色）。片子的价值在于把
  "边聊边下"和"引擎秒回"讲清楚，而不是像素级复刻 DSH 的外壳。要真机录屏就得开
  CDP 录 DSH 自己的窗口，那是另一件事。
- **模式卡片用了 emoji**（⚡🧠✋）。四十秒的片子里它比矢量图标更快读懂。
- 逐帧渲染出的 JPEG 帧约 200 MB，只在本地产出；`out/` 里的成片才进版本库。
