import { describe, expect, it } from 'vitest';
import { parseLarkCliConfigShow } from '../src/cli/commands/lark-cli-onboarding';

describe('lark-cli onboarding', () => {
  it('parses app id and brand from config show output', () => {
    expect(
      parseLarkCliConfigShow(`{
  "appId": "cli_123",
  "appSecret": "****",
  "brand": "feishu"
}

Config file path: /Users/me/.lark-cli/config.json`),
    ).toEqual({ appId: 'cli_123', brand: 'feishu' });
  });

  it('returns undefined when lark-cli is not configured', () => {
    expect(
      parseLarkCliConfigShow(`{
  "ok": false,
  "error": {
    "type": "config",
    "message": "not configured"
  }
}`),
    ).toBeUndefined();
  });
});
