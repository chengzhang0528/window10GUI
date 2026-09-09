import { fileURLToPath } from 'node:url';
import { supervise } from './supervisor.mjs';

const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
process.on('SIGTERM', () => controller.abort());
const result = await supervise({
  workerPath: fileURLToPath(new URL('./worker.mjs', import.meta.url)), args: process.argv.slice(2),
  events: process.argv.includes('--events'), signal: controller.signal,
  output: value => process.stdout.write(`${JSON.stringify(value)}\n`)
});
process.exitCode = result.status === 'completed' ? 0 : result.status === 'cancelled' ? 130 : 2;
