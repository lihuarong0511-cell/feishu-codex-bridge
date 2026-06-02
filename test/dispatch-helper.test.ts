import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DispatchManager, handleAgentCommand } from '../src/dispatch/helper';

async function fakeCodex(path: string, result: string, threadId = '33333333-3333-3333-3333-333333333333'): Promise<string> {
  await writeFile(
    path,
    [
      '#!/bin/sh',
      'while [ "$1" != "" ]; do',
      '  if [ "$1" = "--output-last-message" ]; then',
      '    shift',
      `    printf '${result}\\n' > "$1"`,
      '  fi',
      '  shift || exit 0',
      'done',
      `printf '{"thread_id":"${threadId}"}\\n'`,
      '',
    ].join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return path;
}

describe('dispatch helper', () => {
  it('creates a project, runs a worker, and writes output for review', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-dispatch-'));
    const manager = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: 'codex',
      defaultCwd: root,
      maxWorkers: 2,
      timeoutMs: 30_000,
    });

    const project = await manager.createProject('【企业策划】多对话调度试验', '验证闭环');
    expect(project.slug).toBe('qi-ye-ce-hua-duo-dui-hua-diao-du-shi-yan');
    await stat(join(project.path, 'task_board.json'));
    await stat(join(project.path, 'tasks'));
    await stat(join(project.path, 'progress'));
    await stat(join(project.path, 'outputs'));

    const task = await manager.addTask(project.slug, '案例调研', '整理一个案例');
    expect(task).toMatchObject({ id: 'T-001', status: 'pending' });
    await expect(readFile(join(project.path, 'tasks', 'T-001.md'), 'utf8')).resolves.toMatch(/案例调研/);

    const runner = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: await fakeCodex(join(root, 'fake-codex'), 'worker result'),
      defaultCwd: root,
      maxWorkers: 2,
      timeoutMs: 30_000,
    });
    const result = await runner.runTask(project.slug, 'T-001', 'oc_worker');

    expect(result).toMatchObject({
      id: 'T-001',
      status: 'reviewing',
      sessionId: '33333333-3333-3333-3333-333333333333',
    });
    await expect(readFile(join(project.path, 'outputs', 'T-001-result.md'), 'utf8')).resolves.toMatch(/worker result/);
  });

  it('preserves worker-written output and returns it through result command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-dispatch-preserve-'));
    const manager = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: 'codex',
      defaultCwd: root,
    });
    const project = await manager.createProject('worker preserve', '验证保留 worker 输出文件');
    await manager.addTask(project.slug, '输出保留', '写入结果文件');
    const fakePreserveCodex = join(root, 'fake-preserve-codex');
    await writeFile(
      fakePreserveCodex,
      [
        '#!/bin/sh',
        'mkdir -p outputs',
        "printf 'worker file result\\n' > outputs/T-001-result.md",
        'while [ "$1" != "" ]; do',
        '  if [ "$1" = "--output-last-message" ]; then',
        '    shift',
        "    printf 'short chat summary\\n' > \"$1\"",
        '  fi',
        '  shift || exit 0',
        'done',
        'printf \'{"thread_id":"44444444-4444-4444-4444-444444444444"}\\n\'',
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(fakePreserveCodex, 0o755);

    const runner = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: fakePreserveCodex,
      defaultCwd: root,
    });
    await runner.runTask(project.slug, 'T-001', 'oc_worker');
    await expect(readFile(join(project.path, 'outputs', 'T-001-result.md'), 'utf8')).resolves.toBe('worker file result\n');

    const replies: string[] = [];
    await handleAgentCommand({
      args: `result T-001 ${project.slug}`,
      chatId: 'oc_test',
      codexBin: fakePreserveCodex,
      cwd: root,
      projectsDir: join(root, 'projects'),
      reply: async (text) => {
        replies.push(text);
      },
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/任务：T-001 输出保留/);
    expect(replies[0]).toMatch(/worker file result/);
  });

  it('preserves task board updates when multiple workers finish concurrently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-dispatch-concurrent-'));
    const manager = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: 'codex',
      defaultCwd: root,
      timeoutMs: 30_000,
    });
    const project = await manager.createProject('concurrent workers', '验证并发任务板回写');
    await manager.addTask(project.slug, '并发任务 A', 'write result A');
    await manager.addTask(project.slug, '并发任务 B', 'write result B');

    const fakeConcurrentCodex = join(root, 'fake-concurrent-codex');
    await writeFile(
      fakeConcurrentCodex,
      [
        '#!/bin/sh',
        'sleep 0.1',
        'prompt="${@: -1}"',
        'case "$prompt" in',
        "  *T-001*) tid='T-001'; sid='11111111-1111-1111-1111-111111111111' ;;",
        "  *T-002*) tid='T-002'; sid='22222222-2222-2222-2222-222222222222' ;;",
        "  *) tid='unknown'; sid='00000000-0000-0000-0000-000000000000' ;;",
        'esac',
        'while [ "$1" != "" ]; do',
        '  if [ "$1" = "--output-last-message" ]; then',
        '    shift',
        '    printf "worker result %s\\n" "$tid" > "$1"',
        '  fi',
        '  shift || exit 0',
        'done',
        'printf \'{"thread_id":"%s"}\\n\' "$sid"',
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(fakeConcurrentCodex, 0o755);

    const runner = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: fakeConcurrentCodex,
      defaultCwd: root,
      timeoutMs: 30_000,
    });
    await Promise.all([
      runner.runTask(project.slug, 'T-001', 'oc_worker_a'),
      runner.runTask(project.slug, 'T-002', 'oc_worker_b'),
    ]);

    const board = JSON.parse(await readFile(join(project.path, 'task_board.json'), 'utf8'));
    expect(board.tasks).toMatchObject([
      {
        id: 'T-001',
        status: 'reviewing',
        sessionId: '11111111-1111-1111-1111-111111111111',
      },
      {
        id: 'T-002',
        status: 'reviewing',
        sessionId: '22222222-2222-2222-2222-222222222222',
      },
    ]);
  });

  it('preserves failed task states when multiple workers fail concurrently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-dispatch-concurrent-fail-'));
    const manager = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: 'codex',
      defaultCwd: root,
      timeoutMs: 30_000,
    });
    const project = await manager.createProject('concurrent failed workers', '验证并发失败回写');
    await manager.addTask(project.slug, '失败任务 A', 'fail A');
    await manager.addTask(project.slug, '失败任务 B', 'fail B');

    const fakeFailingCodex = join(root, 'fake-failing-codex');
    await writeFile(
      fakeFailingCodex,
      [
        '#!/bin/sh',
        'sleep 0.1',
        'prompt="${@: -1}"',
        'case "$prompt" in',
        "  *T-001*) tid='T-001' ;;",
        "  *T-002*) tid='T-002' ;;",
        "  *) tid='unknown' ;;",
        'esac',
        'printf "worker failed %s\\n" "$tid" >&2',
        'exit 42',
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(fakeFailingCodex, 0o755);

    const runner = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: fakeFailingCodex,
      defaultCwd: root,
      timeoutMs: 30_000,
    });
    const results = await Promise.allSettled([
      runner.runTask(project.slug, 'T-001', 'oc_worker_a'),
      runner.runTask(project.slug, 'T-002', 'oc_worker_b'),
    ]);

    expect(results).toMatchObject([
      { status: 'rejected' },
      { status: 'rejected' },
    ]);
    const board = JSON.parse(await readFile(join(project.path, 'task_board.json'), 'utf8'));
    expect(board.tasks).toMatchObject([
      {
        id: 'T-001',
        status: 'failed',
        error: expect.stringContaining('worker failed T-001'),
      },
      {
        id: 'T-002',
        status: 'failed',
        error: expect.stringContaining('worker failed T-002'),
      },
    ]);
  });

  it('assigns a task to a registered worker chat and sends an interactive assignment card', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-dispatch-cross-chat-'));
    const manager = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: 'codex',
      defaultCwd: root,
    });
    const project = await manager.createProject('cross chat assign', '验证跨聊天分派');
    await manager.addTask(project.slug, '跨聊天任务', '把任务推送到登记的执行对话');

    const workerReplies: string[] = [];
    await handleAgentCommand({
      args: `worker east ${project.slug}`,
      chatId: 'oc_worker',
      cwd: root,
      projectsDir: join(root, 'projects'),
      reply: async (text) => {
        workerReplies.push(text);
      },
    });
    expect(workerReplies[0]).toMatch(/已登记执行对话/);

    const assignReplies: Array<{ card?: object; fallback: string }> = [];
    const sentCards: Array<{ chatId: string; card: object; fallback: string }> = [];
    await handleAgentCommand({
      args: `assign T-001 east ${project.slug}`,
      chatId: 'oc_supervisor',
      cwd: root,
      projectsDir: join(root, 'projects'),
      reply: async (text) => {
        assignReplies.push({ fallback: text });
      },
      replyCard: async (card, fallback) => {
        assignReplies.push({ card, fallback });
      },
      sendCardToChat: async (chatId, card, fallback) => {
        sentCards.push({ chatId, card, fallback });
      },
    });

    expect(assignReplies).toHaveLength(1);
    expect(assignReplies[0]?.fallback).toMatch(/已分派任务：T-001/);
    expect(sentCards).toHaveLength(1);
    expect(sentCards[0]?.chatId).toBe('oc_worker');
    expect(sentCards[0]?.card).toMatchObject({ schema: '2.0' });
    const sentCardCallbacks = callbackValues(sentCards[0]?.card);
    expect(sentCardCallbacks).toContainEqual({ cmd: 'agent.run', arg: `T-001 ${project.slug}` });
    expect(sentCardCallbacks).toContainEqual({ cmd: 'agent.status', arg: project.slug });
    expect(sentCards[0]?.fallback).toMatch(/\/agent run T-001/);

    const assignedBoard = JSON.parse(await readFile(join(project.path, 'task_board.json'), 'utf8'));
    expect(assignedBoard.tasks[0]).toMatchObject({
      status: 'assigned',
      assignedTo: 'east',
      workerChatId: 'oc_worker',
      supervisorChatId: 'oc_supervisor',
    });
  });

  it('renders result review cards as CardKit 2.0 callback cards', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-dispatch-review-card-'));
    const manager = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: 'codex',
      defaultCwd: root,
    });
    const project = await manager.createProject('review card', '验证复核卡');
    await manager.addTask(project.slug, '复核按钮', '生成待复核结果');
    await writeFile(join(project.path, 'outputs', 'T-001-result.md'), 'review body\n', 'utf8');
    await manager.markTask(project.slug, 'T-001', 'reviewing');

    const cards: Array<{ card: object; fallback: string }> = [];
    await handleAgentCommand({
      args: `result T-001 ${project.slug}`,
      chatId: 'oc_supervisor',
      cwd: root,
      projectsDir: join(root, 'projects'),
      reply: async () => undefined,
      replyCard: async (card, fallback) => {
        cards.push({ card, fallback });
      },
    });

    expect(cards).toHaveLength(1);
    expect(cards[0]?.card).toMatchObject({ schema: '2.0' });
    const callbacks = callbackValues(cards[0]?.card);
    expect(callbacks).toContainEqual({ cmd: 'agent.mark', arg: `T-001 accepted ${project.slug}` });
    expect(callbacks).toContainEqual({ cmd: 'agent.mark', arg: `T-001 rework ${project.slug}` });
    expect(callbacks).toContainEqual({ cmd: 'agent.mark', arg: `T-001 done ${project.slug}` });
    expect(callbacks).toContainEqual({ cmd: 'agent.status', arg: project.slug });
  });

  it('does not render premature result or review actions for non-reviewable board tasks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-dispatch-board-actions-'));
    const manager = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: 'codex',
      defaultCwd: root,
    });
    const project = await manager.createProject('board action states', '验证任务板按钮状态');
    await manager.addTask(project.slug, '待执行任务', 'pending task');
    await manager.addTask(project.slug, '执行中任务', 'running task');
    await manager.markTask(project.slug, 'T-002', 'running');

    const cards: Array<{ card: object; fallback: string }> = [];
    await handleAgentCommand({
      args: `status ${project.slug}`,
      chatId: 'oc_supervisor',
      cwd: root,
      projectsDir: join(root, 'projects'),
      reply: async () => undefined,
      replyCard: async (card, fallback) => {
        cards.push({ card, fallback });
      },
    });

    expect(cards).toHaveLength(1);
    const callbacks = callbackValues(cards[0]?.card);
    expect(callbacks).toContainEqual({ cmd: 'agent.run', arg: `T-001 ${project.slug}` });
    expect(callbacks).toContainEqual({ cmd: 'agent.status', arg: project.slug });
    expect(callbacks).not.toContainEqual({ cmd: 'agent.result', arg: `T-001 ${project.slug}` });
    expect(callbacks).not.toContainEqual({ cmd: 'agent.result', arg: `T-002 ${project.slug}` });
    expect(callbacks).not.toContainEqual({ cmd: 'agent.run', arg: `T-002 ${project.slug}` });
    expect(callbacks).not.toContainEqual({ cmd: 'agent.mark', arg: `T-001 accepted ${project.slug}` });
    expect(callbacks).not.toContainEqual({ cmd: 'agent.mark', arg: `T-002 accepted ${project.slug}` });
    expect(callbacks).not.toContainEqual({ cmd: 'agent.mark', arg: `T-001 rework ${project.slug}` });
    expect(callbacks).not.toContainEqual({ cmd: 'agent.mark', arg: `T-002 rework ${project.slug}` });
  });

  it('rejects stale single-task run clicks before sending a launch acknowledgement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-dispatch-run-preflight-'));
    const manager = new DispatchManager({
      projectsDir: join(root, 'projects'),
      codexBin: 'codex',
      defaultCwd: root,
    });
    const project = await manager.createProject('run preflight', '验证旧卡防误触');
    await manager.addTask(project.slug, '已待复核任务', 'reviewing task');
    await writeFile(join(project.path, 'outputs', 'T-001-result.md'), 'review body\n', 'utf8');
    await manager.markTask(project.slug, 'T-001', 'reviewing');

    const replies: string[] = [];
    await handleAgentCommand({
      args: `run T-001 ${project.slug}`,
      chatId: 'oc_worker',
      codexBin: await fakeCodex(join(root, 'fake-codex'), 'should not run'),
      cwd: root,
      projectsDir: join(root, 'projects'),
      reply: async (text) => {
        replies.push(text);
      },
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]).toBe('调度命令失败：T-001 当前状态是 reviewing，不能直接执行。');
    expect(replies[0]).not.toMatch(/已启动/);
    await expect(readFile(join(project.path, 'outputs', 'T-001-result.md'), 'utf8')).resolves.toBe('review body\n');
  });
});

function callbackValues(card: unknown): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    const behaviors = record.behaviors;
    if (Array.isArray(behaviors)) {
      for (const behavior of behaviors) {
        if (
          behavior &&
          typeof behavior === 'object' &&
          (behavior as Record<string, unknown>).type === 'callback' &&
          (behavior as Record<string, unknown>).value &&
          typeof (behavior as Record<string, unknown>).value === 'object'
        ) {
          found.push((behavior as Record<string, unknown>).value as Record<string, unknown>);
        }
      }
    }
    for (const value of Object.values(record)) visit(value);
  };
  visit(card);
  return found;
}
