import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeskPilotTransport } from './transport.mjs';
import { runFlow } from './flow.mjs';
import { compileDeclarativeScenario } from './data-compiler.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
let transport;
const aborter = new AbortController();
process.on('SIGINT', () => aborter.abort());
process.on('SIGTERM', () => aborter.abort());
process.on('message', msg => { if (msg?.type === 'cancel') aborter.abort(); });
process.on('disconnect', () => aborter.abort());
const terminal = value => { if (process.connected) process.send({ type: 'event', value }); };
try {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--events') options.events = true;
    else if (['--scenario', '--case', '--executable'].includes(args[i]) && args[i + 1]) options[args[i].slice(2)] = args[++i];
    else throw new Error('usage');
  }
  if (!options.scenario) throw new Error('usage');
  // JSON.parse and complete declarative validation happen before transport
  // creation. A scenario cannot execute code by being selected as an entry.
  const source = JSON.parse(await readFile(resolve(options.scenario), 'utf8'));
  const { flow, handlers } = compileDeclarativeScenario(source, options.case ?? 'simple');
  if (process.connected) process.send({ type: 'budget', timeout_ms: flow.timeout_ms });
  transport = new DeskPilotTransport({ executable: options.executable ?? resolve(root, 'src/WindowsAgent.Cli/bin/Debug/net10.0-windows10.0.19041.0/win-x64/win-agent.exe'),
    onSpawn: ({ pid }) => { if (process.connected) process.send({ type: 'owned_process', pid }); } });
  const result = await runFlow({ flow, handlers, transport, signal: aborter.signal,
    onEvent: value => { if (!['run.completed', 'run.handoff', 'run.cancelled'].includes(value.event)) terminal(value); } });
  terminal(result);
  process.exitCode = result.status === 'completed' ? 0 : result.status === 'cancelled' ? 130 : 2;
} catch (error) {
  const cleanup = transport ? await transport.close({ cancel: true, timeoutMs: 3000 }) : { quiescent: true, errors: [] };
  const code = error.code ?? 'FLOW_INVALID';
  const reason = code === 'FLOW_INVALID' && typeof error.reason === 'string' ? error.reason.slice(0, 240) : code === 'FLOW_INVALID' && error instanceof SyntaxError ? 'invalid_json' : undefined;
  terminal({ event: 'run.handoff', status: 'handoff', quiescent: cleanup.quiescent, fault: { code, phase: 'initialization', ...(reason ? { reason } : {}) },
    usage: 'node src/DeskPilot.Flow/run.mjs --scenario <local-scenario.json> --case simple [--events] [--executable <win-agent.exe>]' });
  process.exitCode = 2;
}
if (process.connected) process.disconnect();
