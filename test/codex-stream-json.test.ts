import { describe, expect, it } from 'vitest';
import { translateEvent } from '../src/agent/codex/stream-json';

describe('codex stream-json translator', () => {
  it('maps thread, shell tool, final message, and usage events', () => {
    const seen = new Set<string>();
    const events = [
      ...translateEvent({ type: 'thread.started', thread_id: 'thread-1' }, seen),
      ...translateEvent(
        {
          type: 'item.started',
          item: {
            id: 'item_1',
            type: 'command_execution',
            command: '/bin/zsh -lc pwd',
            status: 'in_progress',
          },
        },
        seen,
      ),
      ...translateEvent(
        {
          type: 'item.completed',
          item: {
            id: 'item_1',
            type: 'command_execution',
            command: '/bin/zsh -lc pwd',
            aggregated_output: '/tmp/project\n',
            exit_code: 0,
            status: 'completed',
          },
        },
        seen,
      ),
      ...translateEvent(
        {
          type: 'item.completed',
          item: { id: 'item_2', type: 'agent_message', text: 'done' },
        },
        seen,
      ),
      ...translateEvent(
        {
          type: 'turn.completed',
          usage: { input_tokens: 10, output_tokens: 2 },
        },
        seen,
      ),
    ];

    expect(events).toEqual([
      { type: 'system', sessionId: 'thread-1' },
      {
        type: 'tool_use',
        id: 'item_1',
        name: 'Shell',
        input: { command: '/bin/zsh -lc pwd' },
      },
      {
        type: 'tool_result',
        id: 'item_1',
        output: '/tmp/project\n',
        isError: false,
      },
      { type: 'text', delta: 'done' },
      { type: 'usage', inputTokens: 10, outputTokens: 2 },
      { type: 'done', sessionId: undefined },
    ]);
  });

  it('ignores known non-fatal Codex config noise', () => {
    const events = [
      ...translateEvent({
        type: 'item.completed',
        item: {
          id: 'item_0',
          type: 'error',
          message: '`[features].codex_hooks` is deprecated. Use `[features].hooks` instead.',
        },
      }),
    ];

    expect(events).toEqual([]);
  });
});
