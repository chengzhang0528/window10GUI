# 通用坑与处理办法（续：#28–#30）

> 接前篇 `universal-pitfalls.md`；本册覆盖坑 #28–#30（末册）。

## 28. DSH 沙箱禁止 Node 子进程管道 → 所有 Flow 脚本（transport.mjs）都跑不起来

**现象**：在 DSH 的 workspace-write 沙箱下执行 `node src/DeskPilot.Flow/oa-login.mjs`，PowerShell 报
`Program 'node.exe' failed to run: Access is denied`。两次隔离探针证明根因不在脚本：

```js
spawnSync('cmd', ['/c','echo','hi'], {encoding:'utf8'})   // → {status:null, error:'EPERM'}
spawn('cmd', ['/c','echo','yo'], {stdio:['pipe','pipe','pipe']})  // → Error: spawn EPERM
```

同一沙箱里 `node --version`、纯文件读写全部正常。

**根因**：受限模式下进程不能打开命名管道，而 Windows 的匿名管道建立在命名管道之上，因此 Node
`child_process` 的默认 `stdio:'pipe'` 一律 `EPERM`。`transport.mjs` 正是用
`spawn(win-agent, ['exec','--stdin','--format','ndjson'], {stdio:['pipe','pipe','pipe']})` 与 CLI 通信，
于是**全部 Flow 脚本（oa-run / oa-open-form / oa-login / close-stale-tabs / 探查器）在该沙箱下都不可用**；
而报错文本指向 `node.exe`，极易被误判成"node 坏了 / 脚本有 bug"。

**解法（按优先级）**：
1. **改用宿主原生 DeskPilot 工具**：只读用 `deskpilot_run`（`chrome.targets` / `chrome.query` /
   `screen.capture_window` …），写动作用 `deskpilot_batch`。这些调用在宿主进程内完成，不经 Node 管道，
   不受该限制。实测同一次任务用 `deskpilot_batch` 走完"attach 目录页 → `chrome.wait` 等目录条目 →
   `chrome.evaluate` 点条目 → 回读新标签页渲染"，全程零 EPERM。
2. 确实必须跑脚本时，**对该条命令一次性提权重试**（更宽的 sandbox 模式），不要反复重试或改写脚本。
3. **不要**试图"让脚本不捕获输出"来绕过：win-agent 是双向 NDJSON 协议，去掉管道脚本即失效。

**验证**：`node --version` 正常 **且** `spawnSync` 返回 `error:'EPERM'`，两条同时成立即可判定为沙箱边界，
而非代码缺陷；此时继续在该沙箱里调试脚本只是浪费轮次。

## 29. DSH 会话 transcript 是**多帧拼接 zstd**：一次解压只给你第一帧

**背景**：需要从"太长而无法继续"的旧会话里恢复上下文时，直接读 transcript 文件。

**现象**：`%APPDATA%\DSH Desktop\dsh-home\sessions\--<项目>--\session-<id>\session.v4.jsonl.zstd`
解压出来**只有 207 字节**——恰好是那一行会话头 `{"type":"session","version":4,...}`，
看起来像"会话是空的"。实测一个 1.43MB 的文件只解出 207 字节。

**根因**：该文件是**每次追加写一帧 zstd** 的**多帧拼接**格式。Node 的 `zlib.zstdDecompressSync`
**和** `zlib.createZstdDecompress()` 都**只解第一帧**就结束（后者命中帧尾即 `end`），
不会自动跨帧继续。

**解法**：按 zstd 帧 magic `28 B5 2F FD` 扫出所有帧起点，逐帧 `zstdDecompressSync` 再拼接。
帧数据里也可能出现同样的 4 字节，所以"切点解压失败就把边界往后并"直到成功；
解不出的候选起点直接跳过。实测：534 帧 → 6.5MB / 1856 条记录，与文件大小相符。

```js
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const starts = [];
for (let i = 0; i + 4 <= buf.length; i++)
  if (buf[i]===MAGIC[0] && buf[i+1]===MAGIC[1] && buf[i+2]===MAGIC[2] && buf[i+3]===MAGIC[3]) starts.push(i);
if (!starts.length || starts[0] !== 0) starts.unshift(0);
const out = [];
for (let i = 0; i < starts.length; ) {
  let j = i + 1, got = null;
  while (j <= starts.length) {                       // 失败就把边界往后并
    const end = j < starts.length ? starts[j] : buf.length;
    try { got = zstdDecompressSync(buf.subarray(starts[i], end)); break; } catch { j++; }
  }
  if (got) { out.push(got); i = j; } else i++;
}
const text = Buffer.concat(out).toString('utf8');
```

**配套判据**：会话记录信封是 `{type, seq, time, data}` —— 内容在 **`data`** 里
（`data.role` / `data.content`），不在顶层。直接读 `r.role` 会得到 0 条"人类消息"，
从而误判"这个会话没有用户输入"。
`type: "user/message" | "assistant/message"` 是最省 token 的入口；
`type: "turn/end"` 的 `reason.kind: "error"` 才是"会话为什么死了"的答案
（实测两份 transcript 都终结于 `CONTEXT_WINDOW_EXCEEDED`, 665K/665K 消息 tokens）。

**教训**：**"解压出来是空的"要先怀疑格式，而不是怀疑数据**；同理，
任何"读到的比预期少一个数量级"的观测，都值得先验证读取方式本身。

---

## 30. PowerShell 处理 UTF-8 数据文件的两个默认值会静默毁掉内容（实测 2026-10-08）

把 skill 的步骤/配置写成 JSON 再由脚本读取时，`pwsh` 侧有两个默认值会**静默**出错，且症状看起来像"内容本来就错"：

| 操作 | 默认行为 | 后果 |
|---|---|---|
| `Get-Content -Raw <file>` | 按 **ANSI**（本机 GBK）解码 | UTF-8 中文变乱码（`采购`→`閲囪喘`），随后 `ConvertFrom-Json` 报 `Invalid object passed in` |
| `Set-Content -Encoding UTF8` | **写入 BOM** | `JSON.parse` 直接抛 `Unexpected token '\uFEFF'` |

**规则**：读写数据文件显式指定编码 —— 读用 `-Encoding UTF8`；写用 `-Encoding utf8NoBOM`（或干脆用编辑器/写文件工具落盘）。

更稳的做法：**别用 shell 做"读入-变换-写回"**。本例中我本想用 pwsh 把 46 步的序列派生一份变体，
结果两个默认值叠加导致**整条变换静默失败**（只写出 3 步），失败信息被埋在一条 `ConvertFrom-Json` 异常里 ——
与 §28 的结论一致：**结构化数据的加工交给他能报错的程序，不要交给 shell 的文本管道**。








