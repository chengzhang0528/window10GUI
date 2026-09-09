import { fork, execFile } from 'node:child_process';

/** Survives a scene worker crash; never prints worker stdout/secret error text. */
export function supervise({ workerPath, args = [], events = false, output = () => {}, signal, startupTimeoutMs = 15000 }) {
  return new Promise(resolve => {
    const worker = fork(workerPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let terminal = null, ownedPid = null, timer, settling = false, last = null;
    let watchdog = false;
    const steps = new Map();
    worker.stdout.resume(); worker.stderr.resume();
    const arm = ms => { clearTimeout(timer); timer = setTimeout(() => { watchdog = true; void finish('DEADLINE_EXCEEDED'); }, ms); };
    arm(startupTimeoutMs);
    const abort = () => { try { worker.send({ type: 'cancel' }); } catch {} arm(5000); };
    signal?.addEventListener('abort', abort, { once: true });
    worker.on('message', msg => {
      if (settling) return;
      if (msg?.type === 'owned_process' && Number.isInteger(msg.pid) && msg.pid > 0) ownedPid = msg.pid;
      if (msg?.type === 'budget' && Number.isInteger(msg.timeout_ms) && msg.timeout_ms > 0) arm(msg.timeout_ms + 7000);
      if (msg?.type !== 'event' || !msg.value?.event) return;
      last = msg.value;
      if (last.step) steps.set(last.step.id, last.step);
      if (['run.completed', 'run.handoff', 'run.cancelled'].includes(last.event)) terminal = last;
      else if (events) output(last);
    });
    worker.on('error', () => { void finish('EXECUTOR_LOST'); });
    worker.on('exit', () => { void finish('EXECUTOR_LOST'); });
    async function killPid(pid) {
      if (!pid) return false;
      if (process.platform !== 'win32') {
        try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; }
      }
      return new Promise(done => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 3000 }, error => done(!error)));
    }
    async function finish(code) {
      if (settling) return;
      settling = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (!terminal) {
        // A tracked live CLI tree can be stopped. Missing/vanished parent is
        // not proof that its helper stopped: preserve quiescent=false.
        await killPid(ownedPid);
        const snapshot = [...steps.values()].map(s => ({ ...s, status: s.status === 'succeeded' ? s.status : 'failed',
          effect: s.effect === 'dispatched' ? 'unknown' : s.effect }));
        terminal = { event: signal?.aborted ? 'run.cancelled' : 'run.handoff', status: signal?.aborted ? 'cancelled' : 'handoff',
          run_id: last?.run_id ?? null, flow_id: last?.flow_id ?? null, revision: last?.revision ?? null,
          quiescent: false, fault: { code: watchdog ? 'DEADLINE_EXCEEDED' : code, detected_at: snapshot.at(-1)?.id ?? 'worker', phase: 'worker' },
          steps: snapshot, resume: { automatic: false, requires: ['confirm_executor_exit', 'fresh_context', 'reconcile_unknown_effects'] } };
      } else if (!terminal.quiescent) await killPid(ownedPid);
      // Force-kill acknowledgement is not the transport's verified shutdown
      // protocol. A crashed worker cannot upgrade its handoff to quiescent.
      if (!terminal.quiescent) terminal.cleanup_errors = [...new Set([...(terminal.cleanup_errors ?? []), 'UNCONFIRMED_EXECUTOR_TREE_EXIT'])];
      if (worker.exitCode === null && worker.signalCode === null) await killPid(worker.pid);
      output(terminal); resolve(terminal);
    }
    if (signal?.aborted) abort();
  });
}
