import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export interface SessionSummary {
  sessionId: string;
  mtime: number;
  preview: string;
  lineCount: number;
}

interface CodexSessionMeta {
  id?: string;
  cwd?: string;
}

interface CodexSessionFile {
  path: string;
  mtime: number;
  meta: CodexSessionMeta;
}

function codexSessionsRoot(): string {
  return join(homedir(), '.codex', 'sessions');
}

/** Return the most recent `limit` Codex sessions for the given cwd, newest first. */
export async function listRecentSessions(cwd: string, limit = 5): Promise<SessionSummary[]> {
  const files = await collectJsonlFiles(codexSessionsRoot()).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  });

  const withMeta = await Promise.all(
    files.map(async (path) => {
      try {
        const [st, meta] = await Promise.all([stat(path), readSessionMeta(path)]);
        if (!meta.id || meta.cwd !== cwd) return null;
        return { path, mtime: st.mtimeMs, meta };
      } catch {
        return null;
      }
    }),
  );

  const sorted = withMeta
    .filter((x): x is CodexSessionFile => x !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);

  return Promise.all(
    sorted.map(async (entry) => {
      const { preview, lineCount } = await summarize(entry.path);
      return {
        sessionId: entry.meta.id!,
        mtime: entry.mtime,
        preview,
        lineCount,
      };
    }),
  );
}

async function collectJsonlFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        out.push(path);
      }
    }
  };
  await walk(root);
  return out;
}

async function readSessionMeta(path: string): Promise<CodexSessionMeta> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream });
  try {
    for await (const line of rl) {
      if (!line.includes('"type":"session_meta"')) continue;
      const obj = JSON.parse(line) as {
        type?: string;
        payload?: { id?: unknown; cwd?: unknown };
      };
      if (obj.type !== 'session_meta') continue;
      return {
        id: typeof obj.payload?.id === 'string' ? obj.payload.id : undefined,
        cwd: typeof obj.payload?.cwd === 'string' ? obj.payload.cwd : undefined,
      };
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return {};
}

async function summarize(path: string): Promise<{ preview: string; lineCount: number }> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream });
  let preview = '';
  let lineCount = 0;
  try {
    for await (const line of rl) {
      lineCount++;
      if (!preview) {
        preview = extractPreview(line);
      }
      if (lineCount > 20_000) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { preview: preview || '(空会话)', lineCount };
}

function extractPreview(line: string): string {
  if (!line.includes('user_message') && !line.includes('"role":"user"')) return '';
  try {
    const obj = JSON.parse(line) as {
      type?: string;
      payload?: unknown;
    };
    const payload = obj.payload as
      | { type?: string; message?: unknown; role?: string; content?: unknown }
      | undefined;
    if (!payload) return '';
    if (payload.type === 'user_message' && typeof payload.message === 'string') {
      return payload.message.trim().slice(0, 80);
    }
    if (payload.role === 'user') {
      const text = extractTextContent(payload.content);
      if (text) return text.slice(0, 80);
    }
  } catch {
    return '';
  }
  return '';
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        return (block as { text: string }).text.trim();
      }
    }
  }
  return '';
}

/** Format a relative time like "3 小时前", "昨天", "3 天前". */
export function formatRelTime(mtime: number): string {
  const diffMs = Date.now() - mtime;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day === 1) return '昨天';
  if (day < 30) return `${day} 天前`;
  const mo = Math.floor(day / 30);
  return `${mo} 个月前`;
}
