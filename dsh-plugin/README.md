# DeskPilot dsh 插件

本目录是独立版本的薄插件：提供四个工具、每会话一个 CLI 进程、DeskPilot Skills 和可选的 `/deskpilot`、`/dp` 命令。CLI 源码仍在 `src/WindowsAgent.Cli`，不进入 npm 包。插件采用 MIT；CLI 和第三方组件许可分别处理。

## 在当前机器接入已有便携包

前置条件：Windows 10 build 19041+ x64、已登录可交互桌面、已安装 dsh 和 pnpm，以及 `D:\win-agent\bin\win-agent.exe`。从仓库根目录执行：

```powershell
dsh plugin --profile web add .\dsh-plugin
```

安装只贡献默认禁用的插件行。在 web profile 自己的 `cordis.patch.yml` 中启用并指定现有公开入口：

```yaml
- id: deskpilot
  disabled: false
  config:
    command: 'D:\win-agent\bin\win-agent.exe'
```

退出并重新打开 dsh 宿主，在新会话调用 `deskpilot_doctor`。成功标志是返回的 `response.ok=true`；首次缺少 .NET 时可能联网并请求 Windows UAC。不要指向内部 `bin/app/win-agent.exe`。安装插件不会自动修改正在运行的宿主或便携包。

## 修改后验证

在仓库根目录运行，前置条件为 Node.js、Windows PowerShell 5.1；挂载检查另需上述 dsh peer 依赖可解析：

```powershell
npm --prefix dsh-plugin test
npm pack ./dsh-plugin --dry-run
```

预期为测试通过，npm 清单只有插件源码、补丁、README 和 LICENSE，没有 CLI 二进制或 node_modules。真实候选的宿主检查见 `test/host-smoke.mjs`，需要显式指定候选公开入口与宿主安装目录；它只运行能力与 doctor，不操作现有桌面应用。

## 准备预算与失败处理

`setupTimeoutMs` 默认 900000，仅收到原生入口的准备信号才启用；`timeoutMs` 默认 130000，`doctorTimeoutMs` 默认 60000。插件先探测就绪，再发送业务请求。准备期间的取消只停止等待，不承诺系统安装已撤销。

独立准备预算需要配套新版原生入口。旧入口在运行时已具备时仍可连接；没有结构化准备事件时，插件不会猜测安装状态或自动延长普通启动预算。

`DESKPILOT_RUNTIME_SETUP_FAILED`、`DESKPILOT_RUNTIME_SETUP_TIMEOUT`、`DESKPILOT_TIMEOUT` 和 `DESKPILOT_NO_RESPONSE` 分别表示准备失败、准备超时、普通请求超时与退出无响应。错误保留最多 4096 字节 stderr 尾部并标记截断；先检查原因，不能自动重放写操作。

## 按需下载与发布边界

没有可复用的相邻便携包且未显式设置 `command` 时，部署者可配置 `asset` 的固定 `version`、`platform=win-x64`、`url`、`bytes`、`sha256`。资产必须是完整便携 ZIP，含公开入口、内部应用、自举文件、许可证、Skills 和 `PACKAGE_MANIFEST.json`，不能只上传约 34 MB 的内部 exe。

当前没有随插件配置已发布的默认资产地址。正式二进制通道为既定 OSS；没有配置时会明确报缺失，不尝试 GitHub 或其他来源。下载只在首次工具使用时发生，后续复用校验过的版本缓存；npm 更新仍由宿主包管理器负责。完整 ZIP、解包目录和首次 .NET 下载量应分别计算。

本目录的构建、测试和 `npm pack` 是 Development，不会发布 npm、上传 OSS、修改 profile 或更新 `D:\win-agent`。远端发布须另有命名目标和授权。
