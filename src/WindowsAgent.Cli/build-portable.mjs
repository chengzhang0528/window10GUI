import { cp, mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = dirname(fileURLToPath(import.meta.url));
const repo = resolve(source, '../..');
if (process.argv.length !== 4 || process.argv[2] !== '--output') throw new Error('Usage: node build-portable.mjs --output <empty directory>');
const output = resolve(process.argv[3]);
await mkdir(output, { recursive: true });
if ((await readdir(output)).length) throw new Error('Output must be empty; preserve the existing portable package until the candidate passes.');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.error?.message ?? result.stderr + result.stdout);
  return result.stdout.trim();
}
run('dotnet', ['publish', join(source, 'WindowsAgent.Cli.csproj'), '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-p:PublishSingleFile=true', '-p:DebugType=None', '-p:DebugSymbols=false', '-o', join(output, 'bin')]);
async function put(path, value) { await mkdir(dirname(join(output, path)), { recursive: true }); await writeFile(join(output, path), value); }
async function copyText(from, to, transform = text => text) { await put(to, transform(await readFile(from, 'utf8'))); }
async function files(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === '__pycache__') continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await files(path)); else result.push(path);
  }
  return result;
}
for (const name of ['AGENTS.md', 'README.md']) await copyText(join(source, 'portable', name + '.template'), name);
await put('win-agent.cmd', '@echo off\r\n"%~dp0bin\\win-agent.exe" %*\r\n');
await put('run-flow.cmd', '@echo off\r\nnode "%~dp0flow\\run.mjs" %*\r\n');
const skillRoot = join(repo, '.agents/skills');
for (const dir of await readdir(skillRoot, { withFileTypes: true })) {
  if (!dir.isDirectory() || !dir.name.startsWith('deskpilot-')) continue;
  for (const path of await files(join(skillRoot, dir.name))) {
    let text = await readFile(path, 'utf8');
    text = text.replaceAll('../../../文档/项目/项目_windows-agent-cli/', '../../../docs/')
      .replaceAll('../../../src/DeskPilot.Flow/README.md', '../../../flow/README.md')
      .replaceAll('src\\WindowsAgent.Cli\\bin\\Debug\\net10.0-windows10.0.19041.0\\win-x64\\win-agent.exe', '.\\bin\\win-agent.exe');
    if (path.endsWith('SKILL.md')) {
      const end = text.indexOf('\n---', 4) + 4;
      text = text.slice(0, end) + '\n\nPortable paths: resolve this SKILL.md from the supplied bundle. The executable is `../../../bin/win-agent.exe`; links resolve from this file. Shell examples using `.agents/` run from the bundle root.\n' + text.slice(end);
    }
    if (dir.name === 'deskpilot-flow-evolution') {
      text = text.replace(/- Default actual website discovery[^\n]+/, '- Use the calling host\'s available model/executor. Give one agent exclusive desktop ownership. Delegate only when the user or host requests it; this bundle does not require a particular model.');
      text = text.replace(/1\. Delegate the browser run[^\n]+/, '1. Execute the browser run with the available host tools and one desktop owner. Keep the user goal, authorized effects and final state explicit.');
    }
    await put(join('.agents/skills', relative(skillRoot, path)), text);
  }
}
const docs = join(repo, '文档/项目/项目_windows-agent-cli');
for (const name of ['PRODUCT_CONTRACT.md', 'CURRENT_DESIGN.md', 'DECISION_STRUCTURED_FLOW.md']) {
  await copyText(join(docs, name), 'docs/' + name, text => text
    .replaceAll('../../WORKSPACE_STRUCTURE.md', '../AGENTS.md')
    .replaceAll('../../../src/WindowsAgent.Cli/AGENTS.md', '../AGENTS.md')
    .replaceAll('../../../src/DeskPilot.Flow/README.md', '../flow/README.md')
    .replaceAll('../../../.agents/', '../.agents/')
    .replaceAll('src/DeskPilot.Flow/', 'flow/'));
}
await copyText(join(source, 'README.md'), 'docs/CLI_REFERENCE.md', text => text
  .replace(/## Development：构建 CLI[\s\S]*?## CLI 契约/, '## CLI 契约\n\n本包已构建为自包含 Release。以下命令从包根目录执行。')
  .replace(/## Development：当前 Chrome 验证[\s\S]*/, '')
  .replaceAll('../../文档/项目/项目_windows-agent-cli/CURRENT_DESIGN.md', 'CURRENT_DESIGN.md')
  .replaceAll('../DeskPilot.Flow/README.md', '../flow/README.md')
  .replaceAll('../../.agents/', '../.agents/')
  .replaceAll('src\\WindowsAgent.Cli\\bin\\Debug\\net10.0-windows10.0.19041.0\\win-x64\\win-agent.exe', '.\\bin\\win-agent.exe')
  .replaceAll('test-fixtures\\agent-form.html', 'examples\\agent-form.html'));
await mkdir(join(output, 'examples'), { recursive: true });
await cp(join(repo, 'test-fixtures/agent-form.html'), join(output, 'examples/agent-form.html'));
const flow = join(repo, 'src/DeskPilot.Flow');
for (const name of ['data-compiler.mjs', 'flow.mjs', 'run.mjs', 'supervisor.mjs', 'transport.mjs', 'worker.mjs', 'README.md']) {
  await copyText(join(flow, name), 'flow/' + name, text => text
    .replace("const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');", "const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');")
    .replaceAll('src/WindowsAgent.Cli/bin/Debug/net10.0-windows10.0.19041.0/win-x64/win-agent.exe', 'bin/win-agent.exe')
    .replaceAll('../WindowsAgent.Cli/README.md', '../docs/CLI_REFERENCE.md')
    .replace(/在仓库根目录运行：[\s\S]*?场景入口是/, '从包根目录执行。场景入口是')
    .replaceAll('src/DeskPilot.Flow/', 'flow/')
    .replace('按 [CLI 构建说明](../docs/CLI_REFERENCE.md) 构建的 win-agent.exe', '包内 `bin/win-agent.exe`'));
}
await cp(join(flow, 'scenarios'), join(output, 'flow/scenarios'), { recursive: true });
const checksums = [];
for (const path of await files(output)) {
  const bytes = await readFile(path);
  checksums.push({ path: relative(output, path).replaceAll('\\', '/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  if (!path.endsWith('.md')) continue;
  const text = bytes.toString('utf8');
  if (text.includes(repo) || /src[\\/]WindowsAgent.Cli[\\/]bin/.test(text)) throw new Error('Source path leak: ' + path);
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
    if (/^[a-z]+:/i.test(match[1])) continue;
    const target = resolve(dirname(path), match[1]);
    const rel = relative(output, target);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Link escapes bundle: ' + path + ' -> ' + match[1]);
    await stat(target);
  }
}
await put('PACKAGE_MANIFEST.json', JSON.stringify({ source_revision: run('git', ['rev-parse', 'HEAD']), source_dirty: !!run('git', ['status', '--porcelain']), platform: 'win-x64', self_contained: true, files: checksums }, null, 2) + '\n');
console.log(JSON.stringify({ output, files: checksums.length + 1, bytes: checksums.reduce((sum, file) => sum + file.bytes, 0), links: 'passed' }));
