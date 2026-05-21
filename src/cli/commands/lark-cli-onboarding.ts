import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { delimiter } from 'node:path';
import { paths } from '../../config/paths';
import type { AppConfig, TenantBrand } from '../../config/schema';
import { resolveAppSecret } from '../../config/secret-resolver';

interface CaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface LarkCliConfig {
  appId?: string;
  brand?: TenantBrand;
}

export async function ensureLarkCliOnboarded(cfg: AppConfig): Promise<boolean> {
  prependManagedLarkCliToPath();
  let available = await hasLarkCli();
  if (!available) {
    console.error('✗ 未找到 lark-cli。');
    console.error('  bridge 依赖 Lark CLI 让 Codex 读写飞书消息、云文档、日历等资源。');
    console.error(`  将把官方包 @larksuite/cli 安装到 ${paths.larkCliDir}，并继续复用当前 bridge 的飞书应用。`);
    if (!process.stdin.isTTY) {
      printManualInstallAndBind(cfg);
      return false;
    }
    const ok = await askYesNo('现在安装 lark-cli 吗? [Y/n]: ', true);
    if (!ok) {
      printManualInstallAndBind(cfg);
      return false;
    }
    if (!(await installLarkCli())) return false;
    available = await hasLarkCli();
    if (!available) {
      console.error('✗ lark-cli 安装后仍不在 PATH 中。请重新打开终端，或检查 npm global bin 是否在 PATH。');
      printManualInstallAndBind(cfg);
      return false;
    }
  }

  const current = await readLarkCliConfig();
  if (current?.appId === cfg.accounts.app.id && current.brand === cfg.accounts.app.tenant) {
    await printAuthHint();
    return true;
  }

  if (current?.appId) {
    console.error(
      `⚠️  lark-cli 当前配置的是 ${current.appId} (${current.brand ?? 'unknown'}),` +
        `但 bridge 使用的是 ${cfg.accounts.app.id} (${cfg.accounts.app.tenant})。`,
    );
    console.error('  为避免多个应用混用，bridge 要求 Lark CLI 与 bridge 使用同一个应用。');
    if (!process.stdin.isTTY) {
      printManualInstallAndBind(cfg);
      return false;
    }
    const ok = await askYesNo('是否把 lark-cli 切换到 bridge 当前应用? [Y/n]: ', true);
    if (!ok) {
      printManualInstallAndBind(cfg);
      return false;
    }
  } else {
    console.log('未检测到 lark-cli 应用配置，将复用 bridge 当前应用完成初始化。');
  }

  const bound = await configureLarkCliWithBridgeApp(cfg);
  if (!bound) return false;
  await printAuthHint();
  return true;
}

export async function printLarkCliDoctor(cfg: AppConfig): Promise<void> {
  prependManagedLarkCliToPath();
  const available = await hasLarkCli();
  console.log(`lark-cli: ${available ? '已安装' : '未安装'}`);
  if (!available) {
    printManualInstallAndBind(cfg);
    return;
  }
  const version = await capture('lark-cli', ['--version']);
  if (version.code === 0) console.log(version.stdout.trim());

  const current = await readLarkCliConfig();
  const expected = `${cfg.accounts.app.id} (${cfg.accounts.app.tenant})`;
  if (!current?.appId) {
    console.log(`配置: 未配置，期望使用 bridge 应用 ${expected}`);
  } else {
    const same = current.appId === cfg.accounts.app.id && current.brand === cfg.accounts.app.tenant;
    console.log(`配置: ${current.appId} (${current.brand ?? 'unknown'})${same ? ' ✓' : `，期望 ${expected}`}`);
  }

  const auth = await capture('lark-cli', ['auth', 'status']);
  const authText = `${auth.stdout}\n${auth.stderr}`.trim();
  const userMissing = /no logged-in users|no user logged in|user identity is missing|not configured|not logged/i.test(authText);
  console.log(auth.code === 0 && !userMissing ? 'OAuth 用户身份: 可用' : 'OAuth 用户身份: 未完成或不可用');
  if (authText) console.log(authText.split('\n').slice(0, 12).join('\n'));
}

async function hasLarkCli(): Promise<boolean> {
  const res = await capture('lark-cli', ['--version']);
  return res.code === 0;
}

async function installLarkCli(): Promise<boolean> {
  await mkdir(paths.npmCacheDir, { recursive: true });
  await mkdir(paths.larkCliDir, { recursive: true });
  console.log(`\n正在安装 lark-cli 到 bridge 私有目录：${paths.larkCliDir}`);
  console.log(`命令：npm --prefix ${paths.larkCliDir} install @larksuite/cli\n`);
  const code = await inherit('npm', ['--prefix', paths.larkCliDir, 'install', '@larksuite/cli'], {
    ...process.env,
    npm_config_cache: process.env.npm_config_cache ?? paths.npmCacheDir,
  });
  if (code === 0) return true;
  console.error(`✗ lark-cli 安装失败(exit ${code ?? 'unknown'})。`);
  console.error('  这次没有使用 npm 全局目录；如果仍失败，通常是网络、registry 或下载二进制失败。');
  return false;
}

async function configureLarkCliWithBridgeApp(cfg: AppConfig): Promise<boolean> {
  let secret: string;
  try {
    secret = await resolveAppSecret(cfg);
  } catch (err) {
    console.error(`✗ 无法读取 bridge App Secret: ${(err as Error).message}`);
    return false;
  }

  const res = await capture(
    'lark-cli',
    [
      'config',
      'init',
      '--app-id',
      cfg.accounts.app.id,
      '--brand',
      cfg.accounts.app.tenant,
      '--app-secret-stdin',
    ],
    { stdin: `${secret}\n` },
  );
  if (res.code !== 0) {
    console.error('✗ lark-cli 配置失败。');
    const detail = `${res.stderr}\n${res.stdout}`.trim();
    if (detail) console.error(detail);
    printManualInstallAndBind(cfg);
    return false;
  }
  console.log(`✓ lark-cli 已绑定到 bridge 当前应用 ${cfg.accounts.app.id}`);
  return true;
}

async function readLarkCliConfig(): Promise<LarkCliConfig | undefined> {
  const res = await capture('lark-cli', ['config', 'show']);
  const text = `${res.stdout}\n${res.stderr}`;
  return parseLarkCliConfigShow(text);
}

export function parseLarkCliConfigShow(text: string): LarkCliConfig | undefined {
  const appId = /"appId"\s*:\s*"([^"]+)"/.exec(text)?.[1];
  if (!appId) return undefined;
  const rawBrand = /"brand"\s*:\s*"([^"]+)"/.exec(text)?.[1];
  const brand = rawBrand === 'lark' ? 'lark' : rawBrand === 'feishu' ? 'feishu' : undefined;
  return { appId, ...(brand ? { brand } : {}) };
}

async function printAuthHint(): Promise<void> {
  const res = await capture('lark-cli', ['auth', 'status']);
  const text = `${res.stdout}\n${res.stderr}`;
  if (
    res.code === 0 &&
    !/no logged-in users|no user logged in|user identity is missing|not configured|not logged/i.test(text)
  ) {
    return;
  }
  console.log('\n提示：lark-cli 已安装并绑定同一个应用，但还没有用户 OAuth。');
  console.log('需要读你的聊天记录、云文档、日历等个人资源时，Codex 会引导你运行：');
  console.log('  lark-cli auth login --recommend');
  console.log('也可以现在手动运行，授权会进入系统 keychain，不写入 bridge 配置。\n');
}

function printManualInstallAndBind(cfg: AppConfig): void {
  console.error('\n手动修复步骤：');
  console.error(`  npm --cache ${paths.npmCacheDir} --prefix ${paths.larkCliDir} install @larksuite/cli`);
  console.error(`  export PATH="${paths.larkCliBinDir}:$PATH"`);
  console.error(`  printf '<你的 App Secret>\\n' | lark-cli config init --app-id ${cfg.accounts.app.id} --brand ${cfg.accounts.app.tenant} --app-secret-stdin`);
  console.error('  lark-cli auth login --recommend   # 可选：需要访问个人资源时再做');
  console.error('\n注意：这里必须使用 bridge 当前应用，不要运行 `lark-cli config init --new` 新建第二个应用。\n');
}

function prependManagedLarkCliToPath(): void {
  const current = process.env.PATH ?? '';
  const parts = current.split(delimiter).filter(Boolean);
  if (!parts.includes(paths.larkCliBinDir)) {
    process.env.PATH = [paths.larkCliBinDir, ...parts].join(delimiter);
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

function capture(
  command: string,
  args: string[],
  opts: { stdin?: string } = {},
): Promise<CaptureResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
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
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

function inherit(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: 'inherit' });
    child.on('error', () => resolve(127));
    child.on('close', (code) => resolve(code));
  });
}
