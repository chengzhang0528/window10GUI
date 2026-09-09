import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { supervise } from './supervisor.mjs';

async function worker(t, source) {
  const dir = await mkdtemp(join(tmpdir(), 'deskpilot-supervisor-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'worker.mjs');
  await writeFile(path, source);
  return path;
}
test('worker completion forwards a single terminal and suppresses raw stdout', async t => {
  const path = await worker(t, `console.log('private body'); process.send({type:'event',value:{event:'run.completed',status:'completed',quiescent:true}}); process.disconnect();`);
  const output = [];
  const result = await supervise({ workerPath: path, output: v => output.push(v) });
  assert.equal(result.status, 'completed');
  assert.equal(output.length, 1);
  assert.ok(!JSON.stringify(output).includes('private body'));
});
test('worker crash after dispatch synthesizes active-step unknown-effect handoff', async t => {
  const path = await worker(t, `process.send({type:'event',value:{event:'step.dispatched',run_id:'r',step:{id:'submit',status:'running',effect:'dispatched',action_dispatched:true}}},()=>process.exit(9));`);
  const result = await supervise({ workerPath: path });
  assert.equal(result.status, 'handoff');
  assert.equal(result.fault.code, 'EXECUTOR_LOST');
  assert.equal(result.fault.detected_at, 'submit');
  assert.equal(result.steps[0].effect, 'unknown');
  assert.equal(result.quiescent, false);
});
test('initialization hang produces bounded handoff without claiming desktop quiescence', async t => {
  const path = await worker(t, 'setInterval(()=>{},10000);');
  const result = await supervise({ workerPath: path, startupTimeoutMs: 250 });
  assert.equal(result.fault.code, 'DEADLINE_EXCEEDED');
  assert.equal(result.quiescent, false);
});

test('a non-quiescent worker terminal is preserved and its owned child is stopped', async t => {
  const path = await worker(t, `import {spawn} from 'node:child_process';
    const child=spawn(process.execPath,['-e','setInterval(()=>{},10000)'],{windowsHide:true,stdio:'ignore'});
    child.unref();
    process.send({type:'owned_process',pid:child.pid});
    process.send({type:'event',value:{event:'run.handoff',status:'handoff',quiescent:false,test_pid:child.pid}},()=>process.disconnect());`);
  const result = await supervise({ workerPath: path });
  assert.equal(result.quiescent, false);
  assert.ok(result.cleanup_errors.includes('UNCONFIRMED_EXECUTOR_TREE_EXIT'));
  let exited = false;
  for (let i = 0; i < 20; i++) {
    try { process.kill(result.test_pid, 0); } catch (error) { if (error.code === 'ESRCH') exited = true; }
    if (exited) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(exited, true);
});
