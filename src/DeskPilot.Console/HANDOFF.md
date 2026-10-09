# DeskPilot.Console 交接文档

## 1. 项目背景

DeskPilot 桌面控制台是一个 .NET 10 WinForms 桌面应用，目标是"左 Chrome 右控制台"的桌面操作界面：
- **左半屏**：Chrome 状态 + 页面截图（5 秒刷新）
- **右半屏**：LLM 聊天面板 + 快捷指令按钮 + 脚本调试区

核心能力：
1. 启动独立 Chrome 实例（独立 profile，不影响用户日常 Chrome），通过 CDP 调试端口连接
2. 通过 `win-agent.exe` CLI 的持久 NDJSON 会话操作 Chrome 页面
3. 集成 OpenAI 兼容 LLM API（单 bash 工具），LLM 生成 CLI 命令执行页面操作

## 2. 技术栈

| 项 | 值 |
|---|---|
| 框架 | .NET 10 (net10.0-windows), WinForms |
| 平台 | win-x64, framework-dependent, PublishSingleFile |
| 体积 | publish 单文件 324.2 KB（目标 ≤1MB；含 15 KB 应用图标） |
| 图标 | `Assets\deskpilot.ico`（16/32/48 BMP 帧，全部可校验）|
| 依赖 | 零 NuGet 包，纯 BCL（HttpClient, System.Text.Json, WinForms） |
| CLI | `win-agent.exe exec --stdin --format ndjson` 持久会话 |
| Chrome | 独立 user-data-dir: `%LOCALAPPDATA%\DeskPilot\ChromeProfile` |
| 设置 | `%APPDATA%\DeskPilot\settings.json` (camelCase JSON) |

## 3. 工程结构

```
src/DeskPilot.Console/
├── DeskPilot.Console.csproj
├── Program.cs                  # 入口：加载设置 → 创建 Launcher/CliClient/MainForm
├── MainForm.cs                 # 主窗口：SplitContainer 左右分屏 + 菜单 + 5s 刷新 Timer
├── Chrome/
│   └── ChromeLauncher.cs       # 启动独立 Chrome + 等待调试端口
├── Cli/
│   └── CliClient.cs            # 持久 NDJSON 会话（stdin/stdout）
├── Llm/
│   ├── LlmClient.cs            # OpenAI 兼容 API 客户端
│   └── PromptBuilder.cs        # System Prompt + bash 工具定义
├── Settings/
│   ├── AppSettings.cs          # 设置模型
│   ├── SettingsStore.cs        # JSON 持久化
│   └── SettingsDialog.cs       # 设置对话框
└── UI/
    ├── ChatPanel.cs            # LLM 聊天（含工具调用循环）
    └── QuickActionPanel.cs     # 快捷按钮 + 脚本调试
```

## 4. 当前已知问题（需修复）

### 问题 1：Chrome 启动后端口检测可能误判

**现象**：用户报告 "Chrome 调试端口 9222 未就绪" 错误弹窗。

**已验证**：手动在 PowerShell 中用相同参数启动 Chrome，端口 5 秒内正常监听。

**可能原因**：
- `UseShellExecute = true` 时 `Process.Start()` 返回的进程对象可能不是 Chrome 主进程（ShellExecute 可能启动一个中间进程），导致 `IsRunning` 判断不准确
- `IsDebugPortListening()` 使用 `BeginConnect` + `WaitOne(500)` 的方式不够可靠，应改用同步 `Connect` + 超时
- 10 秒等待时间可能不够（首次启动独立 profile 时 Chrome 需要初始化）

**建议修复**：
```csharp
private bool IsDebugPortListening()
{
    try
    {
        using var client = new System.Net.Sockets.TcpClient();
        var result = client.BeginConnect("127.0.0.1", _settings.ChromeDebugPort, null, null);
        return result.AsyncWaitHandle.WaitOne(1000); // 增加超时到 1s
    }
    catch { return false; }
}
```
或将等待循环从 20×500ms 增加到 30×500ms（15 秒）。

### 问题 2：CliClient 路径解析可能失败

**现象**：`win-agent.exe` 路径硬编码为 `src/WindowsAgent.Cli/bin/Debug/net10.0-windows10.0.19041.0/win-x64/win-agent.exe`。

**风险**：
- 如果用户未构建过 WindowsAgent.Cli 的 Debug 版本，路径不存在
- `FindRepoRoot()` 从 `AppContext.BaseDirectory` 向上查找 `AGENTS.md`，publish 后单文件 exe 的 BaseDirectory 是 publish 目录，找不到仓库根

**建议修复**：
- 在设置对话框中增加 CLI 路径的"浏览"按钮
- 增加更多候选路径（Release 目录、当前目录旁）
- 首次启动时如果找不到 CLI，弹出设置对话框引导用户指定

### 问题 3：首次启动无引导

**现象**：`Program.cs` 中如果 settings 为 null 只创建默认值，不弹出设置对话框。用户必须手动通过菜单打开设置。

**建议修复**：
```csharp
var settings = Settings.SettingsStore.Load();
if (settings == null || string.IsNullOrEmpty(settings.LlmApiKey))
{
    // 弹出设置对话框
    using var dialog = new Settings.SettingsDialog(settings ?? new Settings.AppSettings());
    if (dialog.ShowDialog() != DialogResult.OK || dialog.Result == null)
        return; // 用户取消则退出
    settings = Settings.SettingsStore.Save(dialog.Result);
}
```

### 问题 4：MainForm 中 Chrome 启动在 UI 线程阻塞

**现象**：`InitializeChrome()` 在构造函数中同步调用 `_chromeLauncher.Launch()`，内部有 `Thread.Sleep` 循环（最多 10 秒），会冻结 UI。

**建议修复**：改为异步初始化，在 `OnLoad` 中用 `async void` 或 `Task.Run` 启动，UI 显示"正在启动 Chrome..."。

### 问题 5：CliClient 的 stdin/stdout 读取可能死锁

**现象**：`SendAsync` 中 `lock (_lock)` 保护写入，但 `ReadLineAsync` 在锁外。如果 CLI 输出大量 stderr（未重定向到独立流），可能阻塞。

**建议修复**：
- stderr 用 `BeginErrorReadLine` 异步读取并丢弃（或收集到日志）
- 考虑用 `ReadLineAsync` 的取消令牌避免永久阻塞

### 问题 6：截图刷新可能累积内存

**现象**：`RefreshChromeStatusAsync` 每 5 秒截图，`Image.FromFile(path)` 锁定文件直到 Image 被 GC。多次刷新后可能文件锁冲突或内存增长。

**建议修复**：
- 截图后先 `File.ReadAllBytes` → `new MemoryStream` → `Image.FromStream`，避免文件锁
- 或限制只保留最近一张截图

## 5. 构建与运行

```powershell
# 构建
dotnet build src/DeskPilot.Console/DeskPilot.Console.csproj

# 运行
dotnet run --project src/DeskPilot.Console
# 或
npm run deskpilot

# 发布单文件
dotnet publish src/DeskPilot.Console/DeskPilot.Console.csproj -c Release
# 输出: bin/Release/net10.0-windows/win-x64/publish/deskpilot-console.exe (~324KB)
```

> publish 目录只含 exe + pdb 是**预期结果**：`PublishSingleFile=true` 会把托管 dll、deps.json、
> runtimeconfig.json 一并打包进 exe 内部，因此该 exe 可独立运行，无需同目录附带的 dll。

## 6. 前置条件

1. 已安装 .NET 10 Desktop Runtime（framework-dependent）
2. 已安装 Chrome（默认路径或设置中指定）
3. `win-agent.exe` 已构建（`dotnet build src/WindowsAgent.Cli`）或在设置中指定路径
4. LLM API Key 已配置（设置对话框）

## 7. 约束

- 不修改 `src/WindowsAgent.Cli/`、`src/DeskPilot.Flow/`、`dsh-plugin/`
- 不引入 NuGet 包（保持零依赖）
- 不影响用户日常 Chrome（独立 profile）
- 单文件 publish ≤ 1MB

## 8. 验证清单

- [ ] `dotnet build` 零错误零警告
- [ ] 应用启动后 Chrome 独立窗口出现，端口 9222 监听
- [ ] 用户日常 Chrome 不受影响（可同时运行）
- [ ] 快捷按钮"页面标题"能返回当前页面标题
- [ ] LLM 聊天能生成并执行 CLI 命令
- [ ] 关闭应用后 Chrome 实例被清理
- [ ] `dotnet publish` 单文件 ≤ 1MB（当前 324.2 KB，PASS）
- [ ] `npm run check:docs` 通过
