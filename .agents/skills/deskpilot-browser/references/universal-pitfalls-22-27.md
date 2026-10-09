# 通用坑与处理办法（续：#22–#27）

> 接前篇 `universal-pitfalls.md`；本册覆盖坑 #22–#27，续篇 `universal-pitfalls-28-30.md`。

## 22. 附件上传：能做，但**内容不是磁盘文件**；且回读要轮询

**控件结构**：OA 的 `div.wea-upload`，内含**真实的 `<input type="file" multiple>`**（id 形如 `html5_xxx`，**每次渲染都会变，绝不能写死**，要按容器内查找）。同页常有多个 file input（多为 w=0 的隐藏项），**只取容器内可见的那个**。

**能做的路径**：CLI **没有** `DOM.setFileInputFiles`（试 `DOM.getDocument` → `UNKNOWN_METHOD`，它只暴露白名单方法、不转发任意 CDP 域）。可行的是**页面内构造 File 并赋给 `input.files`**：

```js
const dt = new DataTransfer();
dt.items.add(new File([content], name, { type: mime }));
inp.files = dt.files;                     // 浏览器允许赋值
inp.dispatchEvent(new Event('change', { bubbles: true }));
```

**必须回读 `input.files.length`**：实测有时 `ok:true` 但 `files:0`（赋值没生效），此时 OA 列表不会出现该文件。要**重试若干次**。

**回读要轮询**：赋完值 + 派发 change 后，OA 还要**异步登记/渲染**一行；实测 1200ms 时 `.wea-upload-list` 仍为空，稍后才出现 `文件名 大小`（甚至先出现带百分比的进度态）。另外容器里可能有**两个** `.wea-upload-list`，取**任一**含目标文件名即算成功。

**诚实边界（必须写进模板 note）**：文件内容是我们**在页面里构造的**，**不是从磁盘读取的真实文件**。所以这条能力只适合"验证上传链路通不通"，**不能**声称"替代人工上传真实附件"。

**教训**：能力落地时，要同时说清"**它到底做了什么**"。同样是"列表里出现了文件名"，一种是真的选了磁盘文件、一种是构造了一个同名 File —— 对外报告时若不区分，就是虚假交付。

## 23. 环境恢复别"杀光所有 worker" —— 会把托管 Chrome 一起带走

**现象**：页面级 CDP WebSocket 开始超时（`TaskCanceledException` / `The remote party closed the WebSocket connection`），但 `chrome.ensure` + `chrome.evaluate` 仍可用。

**我犯的错**：为了"清干净"，一次性 `Stop-Process` 掉**全部** `win-agent`。后果：

1. 托管 Chrome **重启**了 —— 页面全没了（只剩 `新标签页`），OA 登录会话上下文丢失；
2. `DeskPilotDevToolsEndpoint` 文件**消失**，端口从 58212 变成 **54952**；
3. 之后 `chrome.ensure({auto_start:true})` 报
   `CHROME_LAUNCH_FAILED: The managed Chrome process exited before DevTools became ready`
   —— 因为**旧 Chrome 还占着同一个 profile**，新进程一启动就退出。

**正确顺序**：

1. 先只杀**隔天**的残留（`StartTime.Date -ne today`），见 #20；
2. 若仍不行，**只关托管 Chrome 本身**（按 pid），让出 profile；
3. 再 `chrome.ensure({profile_mode:'managed', auto_start:true})` → 会**重新分配端口**并**重写 endpoint 文件**；
4. **不要**假设端口不变：恢复后先读 endpoint 文件确认新端口（实测 58212 → 54952）。

**教训**：`chrome.evaluate` 里的 "CDP 报错" 会让人想当然去重启浏览器；而 `CHROME_LAUNCH_FAILED` 的**真凶常常是"已经有一个实例占着 profile"**，不是 Chrome 坏了。**先看有几个实例，再决定关谁**。

## 24. 端点解析必须"先找活的，再启动"；并且要把结果**写回**记录文件

**现象链**（2026-09-23，一次连锁故障）：托管 Chrome 重启后 `DeskPilotDevToolsEndpoint` 文件**消失**，端口从 58212 变为 54952。于是：

1. `close-stale-tabs` / `oa-login` / `oa-open-form` 各自调 `chrome.ensure({auto_start:true})` 且**不带 endpoint** → 旧实例占着 profile → 新进程立刻退出 → `CHROME_LAUNCH_FAILED`；
2. `oa-fill-engine` 只读那个文件 → 读不到 → 传 `undefined` → 所有 `chrome.*` 不带 endpoint → `CHROME_TARGET_NOT_FOUND`；
3. **整条 oa-run 一步都走不了**（0/8），而 Chrome 本身一直健康（`/json/version` 200、页面都在）。

**解法（三层）**：

1. **统一端点解析**到 `endpoint.mjs` 的 `discoverLiveEndpoint()`：显式参数 → 环境变量 → 记录文件 → **扫端口**；只在**全都没有**时才让 CLI `auto_start`。
2. **扫端口要限量**：先探已知候选（快路径，命中即返回）；都不中才扫，且用**更短的探测超时**。串行探几十个端口、每个都等满超时会**把整轮拖到分钟级**（实测因此让回归超时）。
3. **探到就写回记录文件**（`writeRecordedEndpoint`）——下一次运行走"读文件"快路径。实测：文件缺失时跑一次，文件即被补回 `127.0.0.1:54952`。

**教训**：把"解析依赖位置"的逻辑**分散在四个脚本里各写一遍**，就会四处同时坏、且各自修法不同。这类基础设施应当**只有一个实现**，其余地方引用它。

## 25. 正在编辑模板字面量时，**别用 PowerShell 文本手术**

**我犯的错**：为批量替换一个标识符，用 `Get-Content -Raw` + 正则 + `Set-Content -NoNewline` 改一个含中文注释和模板字面量的 `.mjs`。结果：

- 文件变成 **Latin-1 乱码**（中文注释全毁），且**换行被吞**，`node --check` 报 `Unexpected token ')'`；
- 该文件**未被 git 跟踪**，没有可恢复版本；
- 我只好从内存里的"字节→latin1→utf8"部分还原，再**整文件重写**才救回来。

**正确做法**：
- 改代码用**编辑工具**（按字面量精确替换），不用 shell 拼字符串；
- 批量替换若确需脚本，**明确指定 UTF-8**（`-Encoding utf8`），且**先备份**；
- 改完立刻 `node --check` + 跑一次运行时自检 —— 本例正是自检把乱码拦下的。

**教训**：`Set-Content` 默认编码在 Windows PowerShell 上不是 UTF-8。**用文本工具改文本，用代码工具改代码**；把 shell 当成"通用字符串替换器"会静默毁掉文件。

## 26. 标签页累积 → `AMBIGUOUS_CHROME_TARGET`（"单跑总过、套件时好时坏"的真因）

**症状**：同一个场景**单独跑 4/4 通过**，放进套件却随机失败，且失败场景每轮不同。引擎有时 1.3s 就失败。

**根因**：每次开单都会**多留一个标签页**（实测每跑一次 +1，累积到 **44 个页面**；其中 11 个 Chrome 内建新标签页（chrome 协议的 newtab）、约 20 个重复门户页、多个表单页）。引擎用 `chrome.attach({url_contains:'static4form'})` 绑定表单页，**匹配到多个**时报：

```
AMBIGUOUS_CHROME_TARGET: More than one Chrome page target matched; pass target_id.
```

**为什么清理没解决**：
1. `close-stale-tabs` 只清 `static4form`，门户页/空白页持续累积；
2. `window.close()` **只对脚本打开的标签有效** —— 实测 126 次尝试、页面数一动不动；
3. CLI **没有** `Target.closeTarget` / `chrome.close`（都是 `UNKNOWN_METHOD`），所以"关标签"这条根本不通用。

**解法（三层，缺一不可）**：

1. **引擎自己挑最新的那个**，不要让 CLI 因歧义而失败：先 `chrome.targets` 列候选，取**最后一个**（表单页按打开顺序，后者更新），再按 `target_id` 精确 attach。
2. **清理要轮换目标**：早前每轮都取 `matches[matches.length - 1]`，而数组顺序稳定 → **反复操作同一个标签**（`closed` 里同一个 id 出现三次），其余一个没碰。改为每轮取"还没试过的"。
3. **清理的成败判据要选对**：不是"还剩几个页面"，而是"**还有没有多个会命中表单模式的目标**"。只要该模式匹配数 ≤1，就没有歧义；余下的门户/空白页是浏览器拒绝关闭的用户标签，**不影响**引擎，属可接受残留。
   这里两种错误写法我都踩过：一律 `clean` → 放过真残留、attach 报歧义；一律 `incomplete` → 前置步骤失败、**整轮 0/8**。

**附带一条**：清理时**必须保护一个门户页**（/wui/index.html）。把它一起清掉会让登录脚本落到空白/陌生标签上，报 `password_not_found`，同样卡死整轮。

**验证**：修后 `static4form` 匹配数稳定为 **1**，套件从 **0/8 恢复到 7~8/8**，且一次套件跑完页面数**零增长**。

**教训**：当一个套件"单跑通过、合跑失败"时，优先怀疑**跨用例的共享资源状态**（这里是浏览器标签），而不是逐个用例找 bug。**"关不掉的东西"要么消除它的影响，要么就别让它影响判据** —— 不要因为它关不掉就把整个判据判成失败。

---

## 27. `chrome.targets` 的 `url` 是陈旧元数据；且"下拉打不开"多半是遮挡，不是渲染时序

这一条合并了 2026-09-24 一次长排查的两个根因 —— 它们表面上都伪装成"Ant Design 下拉没渲染好"。

### 27.1 target 元数据的 `url` 不等于页内 `location.href`

**现象**：`chrome.targets` 里某个 target 报着
`static4form/index.html?...workflowid=2211`，
但用 `chrome.evaluate` 读那个 target 的 `location.href`，得到的却是
门户页地址（`#/main/workflow/add`），
`rows/inputs/selects` **全为 0**。实测同时存在 **5 个**这种"披着表单元数据的门户页"。

**根因**：OA（泛微 e-cology）是 **hash 路由 SPA**，切页走 `history.pushState`，**不产生真实导航**。
`chrome.targets` 的 `url` 停在**最后一次真实导航**的地址上，于是与当前页面完全脱节。
目标页每跑一轮就多一个，越攒越多。

**三重危害**（都很隐蔽）：
1. 按 `url.includes('static4form')` 挑目标会**挑中陈旧页**，并把它当作本次结果上报成功 —— 假阳性。
2. 引擎 attach 到门户页后，后面每个字段都 `CHROME_ELEMENT_NOT_FOUND`，表现为"整张表单全崩"。
3. **不带 `target_id` 的 `chrome.evaluate`/`chrome.attach` 会附着到"最近使用的页面"**，
   几十个门户页抢这个位置时，探针会**随机**落到门户页上 —— 于是同一个探针"时对时错"，
   极易被误判成竞态。

**做法**：
- 凡是要**认定某个 target 是什么页面**，一律用 `chrome.evaluate({target_id, expression:'(()=>({href:location.href}))()'})` 读**页内真实地址**复核，不要信元数据。
- 认定"表单真的开了"至少要**页面渲染出内容**（`rows>0 || inputs>0 || selects>0`），不能只看"标签页在"。
- 清理残留时也按 **live 地址**判定，否则会一直去清那些其实是门户页的幻影 target。

### 27.2 可信点击打不开下拉 —— 先查遮挡，别急着怀疑渲染时序

**现象**：一个 `.ant-select` 用 `chrome.click` 点不开，`pick` 报 `not_found(0 dropdowns)`；
但页面内 JS 合成 `s.click()` 却**能**打开（能列出 23 个候选）。

**关键判据**（一行就能定性，优先做这个）：
```js
const r = el.getBoundingClientRect();
const hit = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
hit.closest('.ant-select')   // false ⇒ 有东西盖住了它
```
本例返回的是 `DIV.ant-modal-wrap.wea-browser-modal`（**2560×1313、opacity:1、z-index:1050**）——
一个**残留的「多人力资源」多选弹窗盖住了整张表单**。可信点击的坐标落在遮罩上，所以下拉永远不打开；
而 JS 合成事件绕过了命中测试，所以看起来"能开"。**这就是"探针能过、引擎全崩"的真因。**

**顺带两个坑**：
- `document.hasFocus()` / `visibility_state` 都是正常的 —— **"后台标签页不渲染下拉"这个假设是错的**，别往那个方向排查。
- 关弹窗时不能 `querySelector('button')` 找「取消」：Ant Design 把两字按钮渲染成 **`取 消`**（中间有空格，
  `/取\s*消/` 能匹配），而**一个 wrap 里可能叠着两组弹窗体**（实测 25 个 button），
  取到的第一个「取消」属于内层体，点了**什么也关不掉**。要取**最靠后 `.ant-modal` 的 footer 里最后一个**那个按钮。

**做法**：
- 点击前先 `unblock()`：探明并关掉遮挡（取消 → X → Esc，**每步都回读确认**）。
- 把"固定 `delay(900)` 等它渲染"换成**点击后回读确认下拉真的打开了**（轮询 ≤10×200ms）；
  打不开就**如实记 `open_timeout`**，不要静默错选 —— 前者能一眼定位，后者会把排查带偏几小时。

**教训**：**"元素存在但 width/height 为 0"和"元素被盖住"是两种完全不同的故障**，后者不会改变元素的任何
几何或样式属性。遇到"点了没反应"，**先做命中测试**，再谈时序。

