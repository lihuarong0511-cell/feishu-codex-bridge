import { describe, expect, it } from 'vitest';
import { buildLaunchdPlist, collectLaunchdEnv } from '../src/cli/commands/service';

describe('launchd service plist', () => {
  it('carries allowlisted MCP token environment variables into the service process', () => {
    const env = collectLaunchdEnv({
      PATH: '/usr/bin',
      OBSIDIAN_LOCAL_REST_API_KEY: 'obsidian-secret',
      OPENAI_API_KEY: 'must-not-leak',
    });
    const plist = buildLaunchdPlist({
      nodePath: '/node',
      entryPath: '/bridge.mjs',
      workingDirectory: '/work',
      pathEnv: '/usr/bin',
      env,
    });

    expect(plist).toContain('<key>OBSIDIAN_LOCAL_REST_API_KEY</key>');
    expect(plist).toContain('<string>obsidian-secret</string>');
    expect(plist).not.toContain('OPENAI_API_KEY');
    expect(plist).not.toContain('must-not-leak');
  });
});
