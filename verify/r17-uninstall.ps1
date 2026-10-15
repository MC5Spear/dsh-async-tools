# R17 卸载无残留四段：profile 侧的文件手术（不含重启——重启单独执行，便于逐段留证）
#
# 判据（需求 §7.2 停用与卸载、§8.2「安装卸载」验收行）：安装 → 使用 → 卸载 → 重启 → 四段核对：
#   (a) 预设花名册无 dsh-async   (b) 默认预设可解析   (c) 对照预设工具面貌不变
#   (d) %DSH_HOME%\.agent-presets\dsh-async 目录不存在
#
# 本脚本只做"装/卸"两件事，且**必须显式给参数**（危险默认值等于没有安全值）：
#   -Action Uninstall  ：备份 profile 的 package.json → 摘掉包名（dependencies + bundles）→ 把 junction 改名让开
#   -Action Restore    ：从备份还原 package.json → 把 junction 改回来
#   -Action Status     ：只读打印现状（不写任何文件）
#
# 用法（需在验证实例的服务进程树之外执行；跑在开发实例进程树里的会话不满足此前提）：
#   pwsh -File verify\r17-uninstall.ps1 -Action Status -ProfileDir <服务家目录>\profiles\web -PackageName dsh-async-tools
param(
  [Parameter(Mandatory = $true)][ValidateSet('Status', 'Uninstall', 'Restore')][string]$Action,
  [Parameter(Mandatory = $true)][string]$ProfileDir,
  [Parameter(Mandatory = $true)][string]$PackageName
)

$ErrorActionPreference = 'Stop'
$pkgJson = Join-Path $ProfileDir 'package.json'
$backup = Join-Path $ProfileDir 'package.json.r17-backup'
$junction = Join-Path $ProfileDir "node_modules\$PackageName"
$junctionOff = Join-Path $ProfileDir "node_modules\$PackageName.r17-off"
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Show-State([string]$label) {
  $text = [System.IO.File]::ReadAllText($pkgJson, [System.Text.Encoding]::UTF8)
  $deps = ($text -split "`n" | Where-Object { $_ -match "^\s*`"$([regex]::Escape($PackageName))`"\s*:" }).Count
  $bundle = ($text -split "`n" | Where-Object { $_ -match "^\s*`"$([regex]::Escape($PackageName))`"\s*,?\s*$" }).Count
  "== $label =="
  "  package.json 里 dependencies 行: $deps"
  "  package.json 里 bundles 行:      $bundle"
  "  junction 在:                     $(Test-Path $junction)"
  "  junction 已让开:                 $(Test-Path $junctionOff)"
  "  备份在:                          $(Test-Path $backup)"
  "  .agent-presets\${PackageName}:      $(Test-Path (Join-Path (Split-Path (Split-Path $ProfileDir -Parent) -Parent) ".agent-presets\$PackageName"))"
}

function Assert-Json([string]$text, [string]$when) {
  try { $null = $text | ConvertFrom-Json } catch { throw "package.json 在$when 之后不是合法 JSON：$($_.Exception.Message)" }
}

function Assert-JsonFile([string]$path, [string]$when) {
  $verdict = & node -e "const fs=require('fs');try{JSON.parse(fs.readFileSync(process.argv[1],'utf8'));console.log('ok')}catch(e){console.log('bad')}" $path
  if ($verdict -ne 'ok') { throw "package.json 在$when 之后不是合法 JSON（node 校验）" }
}

switch ($Action) {
  'Status' { Show-State '现状（只读）' }
  'Uninstall' {
    if (-not (Test-Path $pkgJson)) { throw "找不到 $pkgJson" }
    $text = [System.IO.File]::ReadAllText($pkgJson, [System.Text.Encoding]::UTF8)
    if (Test-Path $backup) {
      # 陈旧备份只在"与当前文件逐字节相同"时可覆盖——否则它是唯一副本，不许动。
      $old = [System.IO.File]::ReadAllText($backup, [System.Text.Encoding]::UTF8)
      if ($old -ne $text) { throw "备份与当前 profile 不同（$backup）——先人工确认哪份是对的，不要覆盖唯一副本" }
    }
    [System.IO.File]::WriteAllText($backup, $text, $utf8)
    $lines = $text -split "`n"
    $kept = $lines | Where-Object {
      -not ($_ -match "^\s*`"$([regex]::Escape($PackageName))`"\s*:") -and
      -not ($_ -match "^\s*`"$([regex]::Escape($PackageName))`"\s*,?\s*$")
    }
    # 摘掉最后一项会留下悬空逗号（逗号后紧跟 } 或 ]），这里一并收干净。
    $new = [regex]::Replace(($kept -join "`n"), ",(\s*\r?\n\s*[\]}])", '$1')
    [System.IO.File]::WriteAllText($pkgJson, $new, $utf8)
    try { Assert-JsonFile $pkgJson '摘掉包名' } catch {
      [System.IO.File]::WriteAllText($pkgJson, $text, $utf8)
      throw "$($_.Exception.Message)；已从备份回滚，profile 未改"
    }
    if (Test-Path $junction) { Move-Item -LiteralPath $junction -Destination $junctionOff }
    Show-State '卸载后（未重启）'
  }
  'Restore' {
    if (-not (Test-Path $backup)) { throw "没有备份（$backup）——不能凭空造一份" }
    $text = [System.IO.File]::ReadAllText($backup, [System.Text.Encoding]::UTF8)
    [System.IO.File]::WriteAllText($pkgJson, $text, $utf8)
    Assert-JsonFile $pkgJson '还原'
    if (Test-Path $junctionOff) { Move-Item -LiteralPath $junctionOff -Destination $junction }
    Remove-Item -LiteralPath $backup -Force
    Show-State '复原后（未重启）'
  }
}
