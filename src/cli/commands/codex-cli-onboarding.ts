import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { delimiter } from 'node:path';
import { paths } from '../../config/paths';

interface CaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export async function ensureCodexCliOnboarded(): Promise<boolean> {
  prependManagedCodexCliToPath();
  let available = await hasCodexCli();
  if (!available) {
    console.error('✗ 未找到 codex CLI。');
    console.error('  bridge 依赖 Codex CLI 在本机执行任务、读写项目和延续 session。');
    console.error(`  将把官方包 @openai/codex 安装到 ${paths.codexCliDir}，避免写入 npm 全局目录。`);
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
    available = await hasCodexCli();
    if (!available) {
      console.error('✗ codex CLI 安装后仍不可用。请重新打开终端，或检查 PATH。');
      printManualInstallAndLogin();
      return false;
    }
  }

  if (await hasCodexAuth()) return true;

  console.error('✗ codex CLI 尚未登录或当前凭据不可用。');
  console.error('  bridge 会调用 `codex exec`，因此启动前需要先完成 Codex 登录。');
  if (!process.stdin.isTTY) {
    printManualLogin();
    return false;
  }

  const ok = await askYesNo('现在运行 codex login 吗? [Y/n]: ', true);
  if (!ok) {
    printManualLogin();
    return false;
  }
  const code = await inherit('codex', ['login'], process.env);
  if (code !== 0) {
    console.error(`✗ codex login 失败(exit ${code ?? 'unknown'})。`);
    printManualLogin();
    return false;
  }
  if (await hasCodexAuth()) return true;

  console.error('✗ codex login 结束后仍未检测到可用登录状态。');
  printManualLogin();
  return false;
}

export async function printCodexCliDoctor(): Promise<void> {
  prependManagedCodexCliToPath();
  const version = await capture('codex', ['--version']);
  const available = version.code === 0;
  console.log(`codex CLI: ${available ? '已安装' : '未安装'}`);
  if (!available) {
    printManualInstallAndLogin();
    return;
  }
  const versionText = `${version.stdout}\n${version.stderr}`.trim();
  if (versionText) console.log(versionText.split('\n').slice(0, 3).join('\n'));

  const auth = await codexLoginStatus();
  const envAuth = hasCodexAuthEnv();
  if (auth.ok || envAuth) {
    console.log(envAuth && !auth.ok ? 'Codex 登录状态: 检测到环境变量凭据' : 'Codex 登录状态: 可用');
    if (auth.text) console.log(auth.text.split('\n').slice(0, 8).join('\n'));
    return;
  }

  console.log('Codex 登录状态: 未完成或不可用');
  if (auth.text) console.log(auth.text.split('\n').slice(0, 8).join('\n'));
  printManualLogin();
}

async function hasCodexCli(): Promise<boolean> {
  const res = await capture('codex', ['--version']);
  return res.code === 0;
}

async function hasCodexAuth(): Promise<boolean> {
  if (hasCodexAuthEnv()) return true;
  return (await codexLoginStatus()).ok;
}

async function codexLoginStatus(): Promise<{ ok: boolean; text: string }> {
  const res = await capture('codex', ['login', 'status']);
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
  console.error(`  npm --cache ${paths.npmCacheDir} --prefix ${paths.codexCliDir} install @openai/codex`);
  console.error(`  export PATH="${paths.codexCliBinDir}:$PATH"`);
  console.error('  codex login');
  console.error('\n也可以按官方方式全局安装：npm install -g @openai/codex\n');
}

function printManualLogin(): void {
  console.error('\n手动修复步骤：');
  console.error('  codex login');
  console.error('  # 或使用环境变量/已有 API key，让 codex exec 能正常访问 OpenAI。\n');
}

function prependManagedCodexCliToPath(): void {
  const current = process.env.PATH ?? '';
  const parts = current.split(delimiter).filter(Boolean);
  if (!parts.includes(paths.codexCliBinDir)) {
    process.env.PATH = [paths.codexCliBinDir, ...parts].join(delimiter);
  }
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
