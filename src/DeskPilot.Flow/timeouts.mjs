/*
 * DeskPilot 调用超时基线（deskpilot-oa-fill 资产）
 *
 * 这些值来自实测，不是估计。治理原则：给"快则秒回、慢则失败"的操作配一个
 * 与其量级相称的超时；超时定得过大，失败就会被当成长等待，白耗时间且掩盖问题。
 *
 * 实测（2026-09-23，Chrome 151，本机）：
 *   固定开销：每启动一次 win-agent 进程约 7s（进程启动 + CDP 握手）
 *             —— 因此 1 条 evaluate = 8.0s，而 5 条 = 12.2s。批处理能摊薄它。
 *   chrome.ensure（Chrome 已就绪）    1.2s
 *   chrome.ensure（冷启动 managed）   3.5s
 *   chrome.evaluate（短表达式）       ~1s（在固定开销之外的增量）
 *   chrome.targets                   ~1s（同上）
 *   登录提交（evaluate 长脚本）        数秒
 *
 * 由此定基线：单条请求 15s 足够（约 2 倍余量）；整条链路 60s。
 * 超时触发即视为失败并报错，不做静默重试。
 */
export const TIMEOUTS = {
  // 单条 chrome.* 请求：固定开销 7s + 操作增量，取 15s（约 2x 余量）
  request: 15_000,
  // 需要等页面异步渲染的单条请求（打开弹窗、等 modal 出现）
  requestUi: 20_000,
  // 连接/启动 Chrome：冷启动实测 3.5s，取 20s（约 6x 余量，覆盖机器繁忙）
  ensure: 20_000,
  // 整条链路（校验→开表单→填单）预算
  flow: 60_000,
  // 关闭会话
  close: 3_000
};

/** 把毫秒渲染成便于日志阅读的形式 */
export function ms(v) {
  return `${v}ms`;
}
