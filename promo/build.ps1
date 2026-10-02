<#
.SYNOPSIS
  重建 dsh-gomoku 的宣传片：渲染帧 → ffmpeg 合成 → 抽定妆照。

.DESCRIPTION
  渲染用 promo/shoot.mjs（headless Chrome + CDP 逐帧截图），合成用 ffmpeg。
  这两个都是"可重跑"的：改了 promo.html 里的文案或时间轴，重跑一遍即可。

.PARAMETER Fps
  帧率，默认 30。60 会多一倍渲染时间。

.PARAMETER Still
  只出定妆照（几秒钟），用来快速调构图。

.PARAMETER KeepFrames
  保留中间帧（默认编码完就删，它们约 200 MB）。

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

function Require-Command([string]$name) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if (-not $cmd) { throw "找不到 $name —— 编码需要它（winget install Gyan.FFmpeg）" }
  return $cmd.Source
}

# ---------- 1. 渲染 ----------
if ($Still) {
  # fps=1 时 shoot.mjs 只跑一遍时间轴 + 出定妆照，几秒钟
  Write-Host '渲染定妆照…' -ForegroundColor Cyan
  & node (Join-Path $here 'shoot.mjs') 1 $frames | Select-Object -Last 1
  Copy-Item (Join-Path $frames 'still-*.png') $out -Force
  Remove-Item $frames -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "定妆照 → $out" -ForegroundColor Green
  exit 0
}

Write-Host "渲染 $Fps fps 逐帧…" -ForegroundColor Cyan
& node (Join-Path $here 'shoot.mjs') $Fps $frames | Select-Object -Last 1

# ---------- 2. 合成 ----------
$ffmpeg = Require-Command 'ffmpeg'
$seq = Join-Path $frames 'f%05d.jpg'
$mp4 = Join-Path $out 'dsh-gomoku-promo.mp4'
$webm = Join-Path $out 'dsh-gomoku-promo.webm'
$poster = Join-Path $out 'poster.png'

Write-Host '合成 mp4（H.264 / yuv420p / +faststart）…' -ForegroundColor Cyan
& $ffmpeg -y -loglevel error -framerate $Fps -i $seq `
  -c:v libx264 -preset slow -crf 19 -pix_fmt yuv420p -movflags +faststart `
  -vf "scale=1920:1080:flags=lanczos" $mp4
if ($LASTEXITCODE -ne 0) { throw "ffmpeg 合成 mp4 失败（退出码 $LASTEXITCODE）" }

Write-Host '合成 webm（VP9）…' -ForegroundColor Cyan
& $ffmpeg -y -loglevel error -framerate $Fps -i $seq `
  -c:v libvpx-vp9 -crf 34 -b:v 0 -row-mt 1 -pix_fmt yuv420p `
  -vf "scale=1920:1080:flags=lanczos" $webm
if ($LASTEXITCODE -ne 0) { Write-Warning 'webm 合成失败（mp4 已经好了，可以忽略）' }

# 海报：用第 1.5 秒那一帧当封面
Copy-Item (Join-Path $frames 'still-01-intro.png') $poster -Force
Copy-Item (Join-Path $frames 'still-*.png') $out -Force

# ---------- 3. 报告 ----------
$mp4Item = Get-Item $mp4
Write-Host ''
Write-Host ("成片：{0}  {1:N1} MB" -f $mp4Item.Name, ($mp4Item.Length / 1MB)) -ForegroundColor Green
if (Test-Path $webm) { Write-Host ("      {0}  {1:N1} MB" -f (Split-Path -Leaf $webm), ((Get-Item $webm).Length / 1MB)) -ForegroundColor Green }
Write-Host "定妆照：$out" -ForegroundColor Green

if (-not $KeepFrames) {
  Remove-Item $frames -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host '已删除中间帧（-KeepFrames 可保留）' -ForegroundColor DarkGray
}
