import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { paths } from '../../config/paths';

interface CaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface CodexCli {
  command: string;
  label: string;
}

export async function ensureCodexCliOnboarded(): Promise<boolean> {
  prependManagedCodexCliToPath();
  let cli = await findCodexCli();
  if (!cli) {
    console.error('✗ 未找到 codex CLI。');
    console.error('  bridge 依赖 Codex CLI 在本机执行任务、读写项目和延续 session。');
    console.error('  已检查 CODEX_BIN、PATH、bridge 私有安装目录，以及 macOS Codex.app。');
    console.error(`  如继续自动安装，会把官方包 @openai/codex 安装到 ${paths.codexCliDir}。`);
    console.error('  该包会下载当前平台的 Codex 二进制，macOS arm64 约 200MB；网络慢时可能需要几分钟。');
    if (!process.stdin.isTTY) {
      printManualInstallAndLogin();
      return false;
    }
    const ok = await askYesNo('现在安装 codex CLI 吗? [Y/n]: ', true);
    if (!ok) {
      printManualInstallAndLogin();
      return false;
    }
    if (!(await installCodexCli())) return false;
    cli = await findCodexCli();
    if (!cli) {
      console.error('✗ codex CLI 安装后仍不可用。请重新打开终端，或检查 PATH。');
      printManualInstallAndLogin();
      return false;
    }
  }
  useCodexCli(cli);

  if (await hasCodexAuth(cli.command)) return true;

  console.error('✗ codex CLI 尚未登录或当前凭据不可用。');
  console.error('  bridge 会调用 `codex exec`，因此启动前需要先完成 Codex 登录。');
  if (!process.stdin.isTTY) {
    printManualLogin(cli.command);
    return false;
  }

  const ok = await askYesNo('现在运行 codex login 吗? [Y/n]: ', true);
  if (!ok) {
    printManualLogin(cli.command);
    return false;
  }
  const code = await inherit(cli.command, ['login'], process.env);
  if (code !== 0) {
    console.error(`✗ codex login 失败(exit ${code ?? 'unknown'})。`);
    printManualLogin(cli.command);
    return false;
  }
  if (await hasCodexAuth(cli.command)) return true;

  console.error('✗ codex login 结束后仍未检测到可用登录状态。');
  printManualLogin(cli.command);
  return false;
}

export async function printCodexCliDoctor(): Promise<void> {
  prependManagedCodexCliToPath();
  const cli = await findCodexCli();
  console.log(`codex CLI: ${cli ? `已安装 (${cli.label})` : '未安装'}`);
  if (!cli) {
    printManualInstallAndLogin();
    return;
  }
  useCodexCli(cli);
  const version = await capture(cli.command, ['--version']);
  const versionText = `${version.stdout}\n${version.stderr}`.trim();
  if (versionText) console.log(versionText.split('\n').slice(0, 3).join('\n'));

  const auth = await codexLoginStatus(cli.command);
  const envAuth = hasCodexAuthEnv();
  if (auth.ok || envAuth) {
    console.log(envAuth && !auth.ok ? 'Codex 登录状态: 检测到环境变量凭据' : 'Codex 登录状态: 可用');
    if (auth.text) console.log(auth.text.split('\n').slice(0, 8).join('\n'));
    return;
  }

  console.log('Codex 登录状态: 未完成或不可用');
  if (auth.text) console.log(auth.text.split('\n').slice(0, 8).join('\n'));
  printManualLogin(cli.command);
}

async function hasCodexAuth(command: string): Promise<boolean> {
  if (hasCodexAuthEnv()) return true;
  return (await codexLoginStatus(command)).ok;
}

async function codexLoginStatus(command: string): Promise<{ ok: boolean; text: string }> {
  const res = await capture(command, ['login', 'status']);
  const text = `${res.stdout}\n${res.stderr}`.trim();
  return { ok: res.code === 0, text };
}

function hasCodexAuthEnv(): boolean {
  return Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_ACCESS_TOKEN);
}

async function installCodexCli(): Promise<boolean> {
  await mkdir(paths.npmCacheDir, { recursive: true });
  await mkdir(paths.codexCliDir, { recursive: true });
  console.log(`\n正在安装 codex CLI 到 bridge 私有目录：${paths.codexCliDir}`);
  console.log(`命令：npm --prefix ${paths.codexCliDir} install @openai/codex\n`);
  const code = await inherit('npm', ['--prefix', paths.codexCliDir, 'install', '@openai/codex'], {
    ...process.env,
    npm_config_cache: process.env.npm_config_cache ?? paths.npmCacheDir,
  });
  if (code === 0) return true;
  console.error(`✗ codex CLI 安装失败(exit ${code ?? 'unknown'})。`);
  console.error('  这次没有使用 npm 全局目录；如果仍失败，通常是网络、registry 或下载二进制失败。');
  return false;
}

function printManualInstallAndLogin(): void {
  console.error('\n手动修复步骤：');
  console.error('  # 如果已安装 Codex.app，优先指定它自带的 CLI：');
  console.error('  export CODEX_BIN="/Applications/Codex.app/Contents/Resources/codex"');
  console.error('  feishu-codex-bridge start');
  console.error('\n  # 或安装官方 npm 包：');
  console.error(`  npm --cache ${paths.npmCacheDir} --prefix ${paths.codexCliDir} install @openai/codex`);
  console.error(`  export PATH="${paths.codexCliBinDir}:$PATH"`);
  console.error('  codex login');
  console.error('\n也可以按官方方式全局安装：npm install -g @openai/codex\n');
}

function printManualLogin(command = 'codex'): void {
  console.error('\n手动修复步骤：');
  console.error(`  ${shellQuote(command)} login`);
  console.error('  # 或使用环境变量/已有 API key，让 codex exec 能正常访问 OpenAI。\n');
}

function prependManagedCodexCliToPath(): void {
  const current = process.env.PATH ?? '';
  const parts = current.split(delimiter).filter(Boolean);
  if (!parts.includes(paths.codexCliBinDir)) {
    process.env.PATH = [paths.codexCliBinDir, ...parts].join(delimiter);
  }
}

async function findCodexCli(): Promise<CodexCli | undefined> {
  const envBin = process.env.CODEX_BIN?.trim();
  const candidates: CodexCli[] = [
    ...(envBin ? [{ command: envBin, label: `CODEX_BIN=${envBin}` }] : []),
    { command: 'codex', label: 'PATH' },
    { command: join(paths.codexCliBinDir, 'codex'), label: 'bridge private install' },
    ...macCodexAppCandidates(),
  ];

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.command)) continue;
    seen.add(candidate.command);
    if (!(await isExecutableCandidate(candidate.command))) continue;
    const res = await capture(candidate.command, ['--version']);
    if (res.code === 0) return candidate;
  }
  return undefined;
}

function useCodexCli(cli: CodexCli): void {
  process.env.CODEX_BIN = cli.command;
}

function macCodexAppCandidates(): CodexCli[] {
  if (process.platform !== 'darwin') return [];
  const relative = join('Contents', 'Resources', 'codex');
  return [
    {
      command: join('/Applications', 'Codex.app', relative),
      label: 'Codex.app',
    },
    {
      command: join(homedir(), 'Applications', 'Codex.app', relative),
      label: '~/Applications/Codex.app',
    },
  ];
}

async function isExecutableCandidate(command: string): Promise<boolean> {
  if (!command.includes('/')) return true;
  try {
    await access(command, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function askYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
    const normalized = answer.trim().toLowerCase();
    if (!normalized) return defaultYes;
    return normalized === 'y' || normalized === 'yes';
  } finally {
    rl.close();
  }
}

function capture(command: string, args: string[]): Promise<CaptureResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      resolve({ code: 127, stdout, stderr: `${stderr}${err.message}` });
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function inherit(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: 'inherit' });
    child.on('error', () => resolve(127));
    child.on('close', (code) => resolve(code));
  });
}
