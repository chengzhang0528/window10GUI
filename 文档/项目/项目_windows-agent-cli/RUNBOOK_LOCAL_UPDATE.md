# Windows Agent CLI 本地便携目录更新

Status: Active
Kind: Runbook
Scope: windows-agent-cli / 已授权本地便携组件更新
Owner: 项目维护者
Updated: 2026-09-17
Depends On:
- PRODUCT_CONTRACT.md
- CURRENT_DESIGN.md
- ../../工作流/WF-0006-部署.md

## 边界与输入

仅处理 Active DeploymentPlan 指定的本地目录与固定制品，不构建、不发布 OSS、不修改运行时或用户状态。部署前必须有当前授权、准入证据或明确豁免、目标基线与回退入口；本手册不授予新部署权限。

PowerShell 变量从计划绑定：`$taskTarget` 为目标绝对路径，`$taskPayload` 为固定 payload，`$taskArtifact` 为 ARTIFACT.json，`$taskArtifactHash` 为其 SHA-256，`$taskBackup` 为新的独立备份目录。清单 `files` 每项包含 `path/bytes/sha256/oldSha256`；oldSha256 为 null 的文件必须尚不存在。所有路径必须在相应指定根下，目标路径及其祖先不得为 reparse point；不遍历复制插件或缓存链接。

## 校验与备份

1. 核对制品清单 hash。枚举目标根内执行文件的进程；存在活动进程则停止，不强杀。清单路径拒绝绝对路径、`..` 或逃逸；各 payload 文件核对 bytes/hash，各目标文件核对 oldSha256 或不存在。
2. 备份目录必须尚不存在且不在目标目录内。只创建备份目录，按清单复制已存在旧文件，逐文件验证备份 hash 等于 oldSha256；将固定 ARTIFACT.json 一并复制到备份作为恢复清单。使用以下原生命令，不移动整个目标目录：

```powershell
New-Item -ItemType Directory -Path $taskBackup | Out-Null
foreach ($taskFile in $taskFiles) {
    if (-not $taskFile.oldSha256) { continue }
    $taskOld = Join-Path $taskTarget $taskFile.path
    $taskSaved = Join-Path $taskBackup $taskFile.path
    New-Item -ItemType Directory -Path (Split-Path $taskSaved) -Force | Out-Null
    Copy-Item -LiteralPath $taskOld -Destination $taskSaved
    if ((Get-FileHash -LiteralPath $taskSaved -Algorithm SHA256).Hash -ne $taskFile.oldSha256) { throw 'Backup hash mismatch' }
}
Copy-Item -LiteralPath $taskArtifact -Destination (Join-Path $taskBackup 'ARTIFACT.json')
```

## 激活与最小检查

立即重查目标进程、旧 hash 和 payload hash，基线变化则停止。逐个白名单文件复制，PACKAGE_MANIFEST.json 最后写入；不删除或覆盖未列出的文件。每个目标文件再验 hash，异常进入回退。

```powershell
foreach ($taskFile in ($taskFiles | Sort-Object { $_.path -eq 'PACKAGE_MANIFEST.json' })) {
    $taskDest = Join-Path $taskTarget $taskFile.path
    New-Item -ItemType Directory -Path (Split-Path $taskDest) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $taskPayload $taskFile.path) -Destination $taskDest -Force
    if ((Get-FileHash -LiteralPath $taskDest -Algorithm SHA256).Hash -ne $taskFile.sha256) { throw 'Installed hash mismatch' }
}
& (Join-Path $taskTarget 'bin/win-agent.exe') doctor
& (Join-Path $taskTarget 'bin/win-agent.exe') capabilities
```

只使用公开原生入口；doctor 外层 ok 不代替 `desktop_text.available/backend` 检查。须核对计划指定后端、capabilities、进程退出和未列文件保持不变。目录大小统计普通文件逻辑 Length，注明不包含系统共享运行时和目录外备份，不沿目录链接计数；不是磁盘分配大小。不存在 GUI 功能变更时不扩大为独立系统测试。

## 回退

仅针对本次已复制的白名单路径，先确认没有目标进程且当前 hash 为本次新值；出现未知第三方改动则停止，不能覆盖。旧文件从已核验备份复制恢复；原先不存在的新增文件只有 hash 等于本次新值时才删除。逐路径校验仍在目标内，不递归删除任何目录。

```powershell
foreach ($taskFile in $taskFiles) {
    $taskDest = Join-Path $taskTarget $taskFile.path
    if ($taskFile.oldSha256) {
        Copy-Item -LiteralPath (Join-Path $taskBackup $taskFile.path) -Destination $taskDest -Force
        if ((Get-FileHash -LiteralPath $taskDest -Algorithm SHA256).Hash -ne $taskFile.oldSha256) { throw 'Rollback hash mismatch' }
    } elseif (Test-Path -LiteralPath $taskDest) {
        if ((Get-FileHash -LiteralPath $taskDest -Algorithm SHA256).Hash -ne $taskFile.sha256) { throw 'Unknown replacement; stop rollback' }
        Remove-Item -LiteralPath $taskDest
    }
}
& (Join-Path $taskTarget 'bin/win-agent.exe') doctor
```

回退成功仍报告部署失败及恢复结果。成功更新后保留备份；活动计划移除，归档只记制品、目标、豁免和回退位置的最小事实，Git 单独收口。
