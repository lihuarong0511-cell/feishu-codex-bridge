import { Command } from 'commander';
import pkg from '../../package.json';
import { runDoctor } from './commands/doctor';
import { runMigrate } from './commands/migrate';
import { runPs, runStopCli } from './commands/ps';
import {
  runSecretsGet,
  runSecretsList,
  runSecretsRemove,
  runSecretsSet,
} from './commands/secrets';
import { runService } from './commands/service';
import { runStart } from './commands/start';

const program = new Command();

program
  .name('feishu-codex-bridge')
  .description('Bridge Feishu/Lark messenger with local Codex CLI')
  .version(pkg.version, '-v, --version');

program
  .command('start')
  .description('Start the bot (runs first-run wizard if bot config is missing)')
  .option('-c, --config <path>', 'path to config file')
  .action(async (opts: { config?: string }) => {
    await runStart(opts);
  });

program
  .command('migrate')
  .description(
    'Migrate from pre-0.1.11 setup: move ~/.config/feishu-codex-bridge/* and ' +
      '~/.cache/feishu-codex-bridge/* into ~/.feishu-codex-bridge/, and rewrite ' +
      'config.json from { app } to { accounts.app }',
  )
  .option('-c, --config <path>', 'path to config file (after migration)')
  .action(async (opts: { config?: string }) => {
    await runMigrate(opts);
  });

program
  .command('ps')
  .description('List running feishu-codex-bridge start processes (this machine)')
  .action(() => {
    runPs();
  });

program
  .command('stop <target>')
  .description('Stop a running start process by short id or list index (SIGTERM, then SIGKILL after 2s)')
  .action(async (target: string) => {
    await runStopCli(target);
  });

const secrets = program
  .command('secrets')
  .description('Manage the bridge\'s encrypted secret keystore (~/.feishu-codex-bridge/secrets.enc)');

secrets
  .command('get')
  .description('Exec-provider protocol: read JSON request from stdin, write JSON response to stdout.')
  .action(async () => {
    await runSecretsGet();
  });

secrets
  .command('set')
  .description('Encrypt and store an App Secret. Prompts for the secret without echoing.')
  .requiredOption('--app-id <id>', 'App ID (e.g. cli_xxxxxxxxxxxx)')
  .action(async (opts: { appId: string }) => {
    await runSecretsSet(opts.appId);
  });

secrets
  .command('list')
  .description('List the IDs of secrets in the encrypted keystore (no secrets shown)')
  .action(async () => {
    await runSecretsList();
  });

secrets
  .command('remove')
  .description('Delete an entry from the encrypted keystore')
  .requiredOption('--app-id <id>', 'App ID to remove')
  .action(async (opts: { appId: string }) => {
    await runSecretsRemove(opts.appId);
  });

program
  .command('doctor')
  .description('Check config, codex CLI, and required platform scopes')
  .option('-c, --config <path>', 'path to config file')
  .action(async (opts: { config?: string }) => {
    await runDoctor(opts);
  });

program
  .command('service <action> [type]')
  .description('Manage macOS launchd service: install | status | logs | restart | uninstall')
  .option('-c, --config <path>', 'config path to pass to `start` when installing')
  .option('-f, --follow', 'follow logs for `service logs`')
  .action(async (action: string, type: string | undefined, opts: { config?: string; follow?: boolean }) => {
    await runService(action, type, opts);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
