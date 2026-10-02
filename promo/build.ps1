<#
.SYNOPSIS
  重建 dsh-gomoku 的宣传片：合成音轨 → 渲染帧 → ffmpeg 合成 → 混音 → 抽定妆照。

.DESCRIPTION
  三步都是"可重跑"的：
    1. promo/audio.mjs   纯 JS 合成 120 BPM 音轨（写成 WAV，固定种子，可复现）
    2. promo/shoot.mjs   headless Chrome + CDP 逐帧截图
    3. ffmpeg            编码 + 混音
  改了 promo.html 里的文案或时间轴，重跑一遍即可；改 BPM 要同时改 audio.mjs 和
  promo.html 里的 BPM 常量（画面的事件是卡在拍上的）。

.PARAMETER Fps
  帧率，默认 30。60 会多一倍渲染时间。

.PARAMETER Still
  只出定妆照（几秒），用来快速调构图。

.PARAMETER KeepFrames
  保留中间帧（默认编码完就删，它们约 250 MB）。

.EXAMPLE
  pwsh promo/build.ps1
  pwsh promo/build.ps1 -Still
  pwsh promo/build.ps1 -Fps 60 -KeepFrames
#>
[CmdletBinding()]
param(
  [int]$Fps = 30,
  [switch]$Still,
  [switch]$KeepFrames
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$frames = Join-Path $here 'frames'
$out = Join-Path $here 'out'
New-Item -ItemType Directory -Force -Path $out | Out-Null

$wav = Join-Path $out 'dsh-gomoku-promo.wav'
$mp4 = Join-Path $out 'dsh-gomoku-promo.mp4'
$silent = Join-Path $out 'video-silent.mp4'

function Require-Command([string]$name) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if (-not $cmd) { throw "找不到 $name（winget install Gyan.FFmpeg）" }
  return $cmd.Source
}

# ---------- 1. 音轨 ----------
Write-Host '合成音轨…' -ForegroundColor Cyan
& node (Join-Path $here 'audio.mjs') $wav | Select-Object -Last 2

# ---------- 2. 渲染 ----------
if ($Still) {
  Write-Host '渲染定妆照…' -ForegroundColor Cyan
  & node (Join-Path $here 'shoot.mjs') 1 $frames | Select-Object -Last 1
  Copy-Item (Join-Path $frames 'still-*.png') $out -Force
  Remove-Item $frames -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "定妆照 → $out" -ForegroundColor Green
  exit 0
}

Write-Host "渲染 $Fps fps 逐帧…" -ForegroundColor Cyan
& node (Join-Path $here 'shoot.mjs') $Fps $frames | Select-Object -Last 1

# ---------- 3. 编码 ----------
$ffmpeg = Require-Command 'ffmpeg'
$seq = Join-Path $frames 'f%05d.jpg'

Write-Host '编码画面（H.264 / yuv420p）…' -ForegroundColor Cyan
& $ffmpeg -y -loglevel error -framerate $Fps -i $seq `
  -c:v libx264 -preset slow -crf 19 -pix_fmt yuv420p `
  -vf "scale=1920:1080:flags=lanczos" $silent
if ($LASTEXITCODE -ne 0) { throw "画面编码失败（退出码 $LASTEXITCODE）" }

Write-Host '混音（AAC 192k / +faststart）…' -ForegroundColor Cyan
& $ffmpeg -y -loglevel error -i $silent -i $wav `
  -c:v copy -c:a aac -b:a 192k -ac 2 -shortest -movflags +faststart $mp4
if ($LASTEXITCODE -ne 0) { throw "混音失败（退出码 $LASTEXITCODE）" }
Remove-Item $silent -Force -ErrorAction SilentlyContinue

Copy-Item (Join-Path $frames 'still-*.png') $out -Force

# ---------- 4. 报告 ----------
Write-Host ''
Write-Host ("成片：{0}  {1:N1} MB" -f (Split-Path -Leaf $mp4), ((Get-Item $mp4).Length / 1MB)) -ForegroundColor Green
& ffprobe -v error -show_entries format=duration -show_entries stream=codec_type,codec_name,width,height `
  -of default=noprint_wrappers=1 $mp4 | ForEach-Object { "      $_" }
Write-Host "定妆照：$out" -ForegroundColor Green

if (-not $KeepFrames) {
  Remove-Item $frames -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host '已删除中间帧（-KeepFrames 可保留）' -ForegroundColor DarkGray
}
