/* 托管 Chrome 端点解析（共用）。
 *
 * 为什么需要它（2026-09-23 实测的教训）：
 *   多个脚本原先各自调用 `chrome.ensure({ profile_mode:'managed', auto_start:true })`
 *   **且不带 endpoint**。当本机已经有一个托管 Chrome 占着同一个 profile 时，
 *   新进程会立刻退出，报：
 *     CHROME_LAUNCH_FAILED: The managed Chrome process exited before DevTools became ready.
 *   —— 而那个**已存在的实例其实完全健康**。结果「清理残留标签页 / 登录 / 打开表单」
 *   会依次卡死，整条 oa-run 一步都走不了。
 *   诱因很常见：Chrome 重启后 `DeskPilotDevToolsEndpoint` 文件会短暂/长期消失，
 *   端口也会变（实测 58212 → 54952）。
 *
 * 正确顺序：**先找活着的实例，找不到才启动新的**。
 *   1) 环境变量 DESKPILOT_ENDPOINT
 *   2) profile 目录下记录的 DeskPilotDevToolsEndpoint
 *   3) 扫常见端口段（端口会随实例重建而变）
 *   4) 都没有 → 返回 null，由调用方决定是否 auto_start 真启动
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_PORT_STARTS = [54952, 58210];

/** profile 目录下端点文件的路径 */
export function endpointFilePath() {
  return join(process.env.LOCALAPPDATA ?? '', 'WindowsAgent', 'ChromeProfile', 'DeskPilotDevToolsEndpoint');
}

/** 读 profile 目录里记录的端点（不校验存活） */
export function readRecordedEndpoint() {
  try {
    const f = endpointFilePath();
    if (!existsSync(f)) return null;
    const raw = readFileSync(f, 'utf8').trim().replace(/\/$/, '');
    return raw || null;
  } catch {
    return null;
  }
}

/**
 * 把探到的端点**写回记录文件**。
 * 为什么：托管 Chrome 重启后该文件会消失，导致后续每次运行都要扫端口（慢且脆）。
 * 探到活的就补写回去，让下一次运行走"读文件"这条快路径。
 */
export function writeRecordedEndpoint(ep) {
  try {
    if (!ep) return;
    writeFileSync(endpointFilePath(), String(ep).trim(), 'utf8');
  } catch { /* 写不进去也不影响本次运行 */ }
}

/**
 * 找一个**活着**的托管 Chrome 端点。
 * @param {(method: string, params: object, opts?: object) => Promise<any>} request transport.request
 * @param {{ timeoutMs: number, portStarts?: number[], scanSpan?: number, explicit?: string }} opts
 * @returns {Promise<string|null>}
 */
export async function discoverLiveEndpoint(request, { timeoutMs, portStarts = DEFAULT_PORT_STARTS, scanSpan = 12, explicit } = {}) {
  const probeAlive = async (ep) =>
    !!(await request('chrome.evaluate', { endpoint: ep, expression: '(() => ({ url: location.href }))()' }, { timeoutMs })
      .catch(() => null));

  const cands = [];
  if (explicit) cands.push(String(explicit).replace(/\/$/, ''));
  if (process.env.DESKPILOT_ENDPOINT) cands.push(process.env.DESKPILOT_ENDPOINT.replace(/\/$/, ''));
  const recorded = readRecordedEndpoint();
  if (recorded) cands.push(recorded);

  // 1) 先探"已知候选"（显式/环境变量/记录文件）。命中就返回，不扫端口 —— 常见情况下这是零开销。
  for (const ep of [...new Set(cands)]) {
    if (await probeAlive(ep)) return ep;
  }

  // 2) 都没有才扫端口。**必须限定总量**：串行探 24 个端口、每个都等超时的话，
  //    会把整轮拖到分钟级（实测一次回归因此超时）。所以：
  //    · 用更短的探测超时（真正的实例几百毫秒就回应）
  //    · 只扫较小的范围
  const QUICK = Math.min(timeoutMs ?? 1500, 1500);
  const probeQuick = async (ep) =>
    !!(await request('chrome.evaluate', { endpoint: ep, expression: '1' }, { timeoutMs: QUICK }).catch(() => null));

  for (const start of portStarts) {
    for (let p = start; p < start + scanSpan; p++) {
      const ep = 'http://127.0.0.1:' + p;
      if (await probeQuick(ep)) { writeRecordedEndpoint(ep); return ep; }
    }
  }
  return null;
}
