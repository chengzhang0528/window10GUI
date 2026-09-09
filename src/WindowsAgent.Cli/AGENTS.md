# Windows Agent CLI 源码入口

Scope: `src/WindowsAgent.Cli/`

修改前读取：

- `文档/项目/项目_windows-agent-cli/AGENTS.md`
- `文档/项目/项目_windows-agent-cli/PRODUCT_CONTRACT.md`
- `文档/项目/项目_windows-agent-cli/CURRENT_DESIGN.md`
- 本目录 `README.md`、目标类型和 `test-fixtures/agent-form.html`

保持这些约束：公开入口是 argv 或 JSON/NDJSON stdin/stdout，不新增 MCP Server；不暴露 HWND/COM/UIA 对象；元素和坐标引用必须短生命周期并校验观察状态；不得绕过 UAC 或把调用方确认语义下沉成控件名称猜测；不得记录输入正文、截图或秘密。

源码改动执行：

```powershell
dotnet build src\WindowsAgent.Cli\WindowsAgent.Cli.csproj --no-restore
```

涉及正式文档或入口时再执行 `npm run check:docs`。发布、自包含包、独立 SystemTest 和 Deployment 需要各自明确任务与证据。
