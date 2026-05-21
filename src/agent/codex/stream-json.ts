import type { AgentEvent } from '../types';

interface CodexUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  message?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
}

interface CodexRawEvent {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: CodexUsage;
}

export function* translateEvent(
  raw: unknown,
  seenToolIds: Set<string> = new Set<string>(),
): Generator<AgentEvent> {
  if (!raw || typeof raw !== 'object') return;
  const evt = raw as CodexRawEvent;

  if (evt.type === 'thread.started') {
    yield { type: 'system', sessionId: evt.thread_id };
    return;
  }

  if (evt.type === 'turn.completed') {
    if (evt.usage) {
      yield {
        type: 'usage',
        inputTokens: evt.usage.input_tokens,
        outputTokens: evt.usage.output_tokens,
      };
    }
    yield { type: 'done', sessionId: evt.thread_id };
    return;
  }

  const item = evt.item;
  if (!item) return;

  if (item.type === 'command_execution') {
    const id = item.id ?? `cmd-${seenToolIds.size + 1}`;
    if (!seenToolIds.has(id)) {
      seenToolIds.add(id);
      yield {
        type: 'tool_use',
        id,
        name: 'Shell',
        input: { command: item.command ?? '' },
      };
    }
    if (evt.type === 'item.completed') {
      yield {
        type: 'tool_result',
        id,
        output: item.aggregated_output ?? '',
        isError: typeof item.exit_code === 'number' && item.exit_code !== 0,
      };
    }
    return;
  }

  if (evt.type === 'item.completed' && item.type === 'agent_message') {
    if (item.text) yield { type: 'text', delta: item.text };
    return;
  }

  if (evt.type === 'item.completed' && item.type === 'error') {
    const message = item.message ?? item.text ?? 'codex error';
    if (isKnownNonFatalNoise(message)) return;
    const id = item.id ?? `codex-error-${seenToolIds.size + 1}`;
    if (!seenToolIds.has(id)) {
      seenToolIds.add(id);
      yield {
        type: 'tool_use',
        id,
        name: 'Codex',
        input: { event: 'error' },
      };
    }
    yield {
      type: 'tool_result',
      id,
      output: message,
      isError: true,
    };
    return;
  }
}

function isKnownNonFatalNoise(message: string): boolean {
  return message.includes('[features].codex_hooks') && message.includes('deprecated');
}
