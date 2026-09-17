# DeskPilot OSS 发布

Status: Active
Kind: Runbook
Scope: windows-agent-cli / immutable OSS publication
Owner: 项目维护者
Updated: 2026-09-17
Depends On:
- AGENTS.md
- ../../工作流/WF-0006-部署.md

## 目标与边界

本入口只通过 HTTPS 向 `shared-public-assets.oss-cn-beijing.aliyuncs.com` 的 `deskpilot/` 前缀发布已固定的不可变文件。它不构建、打包、签名、修改 Bootstrap、发布 npm Registry 或替换同键对象。

凭据只从当前进程或 Windows 用户/机器持久环境变量 `ALIYUN_ACCESSID` 和 `ALYUN_ACCESS_SECRET` 读取；命令、日志和回执不输出其值。

## 发布入口

每个对象都必须同时提供绝对文件路径、`deskpilot/` 下的固定对象键、十进制字节数和小写 SHA-256：

```powershell
npm run deploy:oss:publish -- --file <absolute-file> --key <deskpilot/versioned-key> --bytes <bytes> --sha256 <sha256>
```

入口先本地核对文件身份，再匿名回读目标键。目标不存在时才用 OSS `x-oss-forbid-overwrite: true` 上传；已存在且大小、SHA-256 一致时幂等通过，任何冲突都停止。成功必须再通过公开 HTTPS 读取完整对象并核对字节数和 SHA-256。

## 回滚与失败

本入口不写可变指针。上传前失败时目标不变；上传后匿名回读失败时保留该不可变对象，不删除、不覆盖，重试同一精确事务。只有完整发布闭包均已公开回读通过后，才可在另一个明确授权的 Deployment 中提交可变 Bootstrap 或更新部署配置。
