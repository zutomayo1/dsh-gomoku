<#
.SYNOPSIS
  把五子棋插件从 DSH profile 里彻底撤掉，并恢复用户原有配置。

.DESCRIPTION
  用途：如果重启后 DSH **起不来**（弹窗、白屏、Web 服务不监听），在**普通 PowerShell
  窗口**里跑这个脚本即可让应用恢复到装插件之前的状态——不需要 GUI，也不需要 agent。

  它会：
    1. 先把当前 profile 的 package.json / cordis.patch.yml 另存到 _safety-backup-revert-<时间戳>；
    2. 用已知良好的备份覆盖 cordis.patch.yml（保住 llm-pi-ai / opencode-go /
       danger-full-access / reasoningEffort）；
    3. 从 package.json 的 dependencies 与 dsh.profile.bundles 里摘掉两个 gomoku 包；
    4. 删掉 node_modules 下的两个符号链接（用 rmdir，PowerShell 的 Remove-Item 在
       非交互模式下会拒绝删符号链接）；
    5. 核对并打印结果（`- id:` 行数、关键配置是否还在）。

  为什么必须同时做 2/3/4：dependencies 里的包会被自动加载，**与 bundles 列表无关**，
  所以只摘 bundles 是不够的。

.PARAMETER ProfileDir
  目标 profile 目录。默认取 $env:DSH_PROFILE_DIR，再退回 ~\.dsh\profiles\desktop。

.PARAMETER DryRun
  只打印将要做什么，不写任何文件。

.PARAMETER BackupFile
  cordis.patch.yml 的还原来源。默认用本包安装前留存的
  _safety-backup-gomoku\cordis.patch.yml；找不到就退回"条目数最多的
  cordis.patch.yml.bak-*"。

.EXAMPLE
  pwsh -File .\revert-profile.ps1 -DryRun
  pwsh -File .\revert-profile.ps1
#>
[CmdletBinding()]
param(
  [string]$ProfileDir,
  [switch]$DryRun,
  [string]$BackupFile
)

$ErrorActionPreference = 'Stop'

# ---- 定位 profile ----------------------------------------------------------
if (-not $ProfileDir -or $ProfileDir.Trim() -eq '') {
  if ($env:DSH_PROFILE_DIR) { $ProfileDir = $env:DSH_PROFILE_DIR }
  elseif ($env:DSH_PROFILE) { $ProfileDir = Join-Path (Join-Path $env:USERPROFILE '.dsh\profiles') $env:DSH_PROFILE }
  else { $ProfileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }
}
$ProfileDir = (Resolve-Path -LiteralPath $ProfileDir).Path
$pkgPath = Join-Path $ProfileDir 'package.json'
$patchPath = Join-Path $ProfileDir 'cordis.patch.yml'
$nodeModules = Join-Path $ProfileDir 'node_modules'

if (-not (Test-Path -LiteralPath $pkgPath)) { throw "找不到 profile 的 package.json：$pkgPath" }

$targets = @('dsh-gomoku-host', 'dsh-gomoku-client')
Write-Host "profile   : $ProfileDir" -ForegroundColor Cyan
Write-Host "移除目标  : $($targets -join ', ')" -ForegroundColor Cyan
if ($DryRun) { Write-Host "模式      : DryRun（不写任何文件）" -ForegroundColor Yellow }

# ---- 还原来源 --------------------------------------------------------------
# 本包安装前留存的已知良好副本（9 个 `- id:`，含 llm-pi-ai 与 danger-full-access）
$safety = Join-Path $ProfileDir '_safety-backup-gomoku\cordis.patch.yml'

if (-not $BackupFile -or $BackupFile.Trim() -eq '') {
  if (Test-Path -LiteralPath $safety) { $BackupFile = $safety }
  else {
    # 退回条目数最多的 .bak
    $cands = Get-ChildItem -LiteralPath $ProfileDir -Filter 'cordis.patch.yml.bak-*' -ErrorAction SilentlyContinue |
      Sort-Object { (Get-Content -LiteralPath $_.FullName -Encoding utf8 | Select-String -Pattern '^- id:').Count } -Descending
    if ($cands) { $BackupFile = $cands[0].FullName }
  }
}
if ($BackupFile -and (Test-Path -LiteralPath $BackupFile)) {
  Write-Host "patch 还原来源: $BackupFile" -ForegroundColor Cyan
} else {
  Write-Host "⚠ 没找到 cordis.patch.yml 的还原来源，将保留当前文件（只有依赖/符号链接会被清掉）" -ForegroundColor Yellow
}

# ---- 先备份当前状态 --------------------------------------------------------
$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$backupDir = Join-Path $ProfileDir "_safety-backup-revert-$stamp"
if (-not $DryRun) {
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
  Copy-Item -LiteralPath $pkgPath -Destination (Join-Path $backupDir 'package.json') -Force
  if (Test-Path -LiteralPath $patchPath) { Copy-Item -LiteralPath $patchPath -Destination (Join-Path $backupDir 'cordis.patch.yml') -Force }
  Write-Host "已备份当前状态到: $backupDir" -ForegroundColor DarkGray
}

# ---- 1) 还原 cordis.patch.yml（用 Copy-Item，不用 Set-Content）-------------
if ($BackupFile -and (Test-Path -LiteralPath $BackupFile)) {
  if ($DryRun) { Write-Host "[dry] Copy-Item '$BackupFile' -> '$patchPath'" }
  else { Copy-Item -LiteralPath $BackupFile -Destination $patchPath -Force }
}

# ---- 2) 从 package.json 摘掉两个包 ----------------------------------------
$raw = [System.IO.File]::ReadAllText($pkgPath, [System.Text.Encoding]::UTF8)
$doc = $raw | ConvertFrom-Json

$removedDeps = @()
if ($doc.dependencies) {
  foreach ($name in $targets) {
    if ($doc.dependencies.PSObject.Properties.Name -contains $name) {
      $doc.dependencies.PSObject.Properties.Remove($name)
      $removedDeps += $name
    }
  }
}
$removedBundles = @()
if ($doc.dsh -and $doc.dsh.profile -and $doc.dsh.profile.bundles) {
  $kept = @()
  foreach ($entry in $doc.dsh.profile.bundles) {
    if ($targets -contains $entry) { $removedBundles += $entry } else { $kept += $entry }
  }
  $doc.dsh.profile.bundles = $kept
}

Write-Host "dependencies 摘掉 : $(if ($removedDeps) { $removedDeps -join ', ' } else { '(无)' })" -ForegroundColor Green
Write-Host "bundles   摘掉    : $(if ($removedBundles) { $removedBundles -join ', ' } else { '(无)' })" -ForegroundColor Green

$json = $doc | ConvertTo-Json -Depth 40
if ($DryRun) {
  Write-Host "[dry] 将把 package.json 写成："
  Write-Host $json -ForegroundColor DarkGray
} else {
  # 用 WriteAllText 保证是完整的一次写入，且不带 BOM
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($pkgPath, $json, $utf8)
}

# ---- 3) 删符号链接 ---------------------------------------------------------
foreach ($name in $targets) {
  $link = Join-Path $nodeModules $name
  if (Test-Path -LiteralPath $link) {
    if ($DryRun) { Write-Host "[dry] cmd /c rmdir `"$link`"" }
    else {
      cmd.exe /c rmdir "$link" | Out-Null
      Write-Host "已删符号链接: $link" -ForegroundColor Green
    }
  } else {
    Write-Host "符号链接不存在（跳过）: $link" -ForegroundColor DarkGray
  }
}

# ---- 4) 核对 ---------------------------------------------------------------
Write-Host ''
Write-Host '---- 核对 ----' -ForegroundColor Cyan
if (Test-Path -LiteralPath $patchPath) {
  $ids = (Get-Content -LiteralPath $patchPath -Encoding utf8 | Select-String -Pattern '^- id:').Count
  $text = Get-Content -LiteralPath $patchPath -Encoding utf8 -Raw
  Write-Host "cordis.patch.yml '^- id:' 行数 : $ids"
  Write-Host "llm-pi-ai 还在                : $($text.Contains('llm-pi-ai'))"
  Write-Host "opencode-go 还在              : $($text.Contains('opencode-go'))"
  Write-Host "deepseek-v4.1-flash 还在      : $($text.Contains('deepseek-v4.1-flash'))"
  Write-Host "danger-full-access 还在       : $($text.Contains('defaultPreset: danger-full-access'))"
  Write-Host "reasoningEffort 还在          : $($text.Contains('reasoningEffort'))"
}
if (-not $DryRun) {
  $check = [System.IO.File]::ReadAllText($pkgPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  $stillDeps = @($targets | Where-Object { $check.dependencies.PSObject.Properties.Name -contains $_ })
  $stillBundles = @($check.dsh.profile.bundles | Where-Object { $targets -contains $_ })
  Write-Host "package.json 仍含目标依赖     : $(if ($stillDeps) { $stillDeps -join ', ' } else { '无 ✓' })"
  Write-Host "package.json 仍含目标 bundles : $(if ($stillBundles) { $stillBundles -join ', ' } else { '无 ✓' })"
  Write-Host "package.json 可解析           : ✓"
  Write-Host ''
  Write-Host '现在可以重新启动 DSH。' -ForegroundColor Green
}
