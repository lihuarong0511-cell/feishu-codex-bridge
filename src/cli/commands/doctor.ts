import { CodexAdapter } from '../../agent/codex/adapter';
import { paths } from '../../config/paths';
import { isComplete } from '../../config/schema';
import { loadConfig } from '../../config/store';
import { printLarkCliDoctor } from './lark-cli-onboarding';

export interface DoctorOptions {
  config?: string;
}

export async function runDoctor(opts: DoctorOptions): Promise<void> {
  const configPath = opts.config ?? paths.configFile;
  const cfg = await loadConfig(configPath);
  if (!isComplete(cfg)) {
    console.log(`bridge config: 未配置或不完整 (${configPath})`);
    console.log('先运行: feishu-codex-bridge start');
    return;
  }

  console.log(`bridge config: ${cfg.accounts.app.id} (${cfg.accounts.app.tenant})`);
  const codex = new CodexAdapter();
  console.log(`codex CLI: ${(await codex.isAvailable()) ? '已安装' : '未找到'}`);
  await printLarkCliDoctor(cfg);
}
