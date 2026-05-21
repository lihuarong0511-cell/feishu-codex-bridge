import { describe, expect, it } from 'vitest';
import { buildCodexArgs } from '../src/agent/codex/adapter';

describe('codex adapter args', () => {
  it('passes reasoning effort as a Codex CLI config override', () => {
    expect(buildCodexArgs({ prompt: 'ignored', reasoningEffort: 'xhigh' }, 'hello')).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '-c',
      'model_reasoning_effort="xhigh"',
      'hello',
    ]);
  });

  it('passes reasoning effort when resuming a Codex session', () => {
    expect(
      buildCodexArgs(
        { prompt: 'ignored', sessionId: 'session-1', reasoningEffort: 'high' },
        'hello',
      ),
    ).toEqual([
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '-c',
      'model_reasoning_effort="high"',
      'session-1',
      'hello',
    ]);
  });

  it('keeps reasoning effort unset by default so Codex inherits global config', () => {
    expect(buildCodexArgs({ prompt: 'ignored' }, 'hello')).not.toContain('-c');
  });
});
