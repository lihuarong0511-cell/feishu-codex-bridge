import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const TASK_STATUSES = new Set([
  'pending',
  'assigned',
  'running',
  'blocked',
  'reviewing',
  'accepted',
  'rework',
  'done',
  'failed',
]);

const DEFAULT_PROJECTS_DIR = join(homedir(), '.openclaw', 'workspace', 'projects');

const PINYIN: Record<string, string> = {
  博: 'bo',
  物: 'wu',
  馆: 'guan',
  咖: 'ka',
  啡: 'fei',
  清: 'qing',
  吧: 'ba',
  餐: 'can',
  饮: 'yin',
  房: 'fang',
  地: 'di',
  产: 'chan',
  占: 'zhan',
  星: 'xing',
  企: 'qi',
  业: 'ye',
  策: 'ce',
  划: 'hua',
  项: 'xiang',
  目: 'mu',
  任: 'ren',
  务: 'wu',
  多: 'duo',
  对: 'dui',
  话: 'hua',
  调: 'diao',
  度: 'du',
  试: 'shi',
  验: 'yan',
  案: 'an',
  例: 'li',
  研: 'yan',
  究: 'jiu',
  资: 'zi',
  料: 'liao',
  文: 'wen',
  方: 'fang',
  复: 'fu',
  核: 'he',
  输: 'shu',
  出: 'chu',
  市: 'shi',
  场: 'chang',
  政: 'zheng',
  展: 'zhan',
  览: 'lan',
  运: 'yun',
  营: 'ying',
  活: 'huo',
  动: 'dong',
  测: 'ce',
};

export class DispatchError extends Error {}

export interface DispatchTask {
  id: string;
  title: string;
  status: string;
  instructions: string;
  sessionId?: string;
  assignedTo?: string;
  workerChatId?: string;
  supervisorChatId?: string;
  createdAt: string;
  updatedAt: string;
  output: string;
  error?: string;
}

interface DispatchBoard {
  version: number;
  project: {
    name: string;
    slug: string;
    goal: string;
    createdAt: string;
    updatedAt: string;
  };
  tasks: DispatchTask[];
}

interface WorkerInfo {
  name: string;
  chatId: string;
  updatedAt: string;
}

type Workers = Record<string, WorkerInfo>;

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface DispatchManagerOptions {
  projectsDir?: string;
  codexBin?: string;
  defaultCwd?: string;
  maxWorkers?: number;
  timeoutMs?: number;
}

export interface HandleAgentCommandOptions {
  args: string;
  chatId: string;
  reply: (text: string) => Promise<void>;
  replyCard?: (card: object, fallback: string) => Promise<void>;
  sendToChat?: (chatId: string, text: string) => Promise<void>;
  sendCardToChat?: (chatId: string, card: object, fallback: string) => Promise<void>;
  codexBin?: string;
  cwd?: string;
  projectsDir?: string;
}

export class DispatchManager {
  readonly projectsDir: string;
  readonly codexBin: string;
  readonly defaultCwd: string;
  readonly maxWorkers: number;
  readonly timeoutMs: number;

  constructor(opts: DispatchManagerOptions = {}) {
    this.projectsDir = resolve(
      expandHome(opts.projectsDir ?? process.env.FEISHU_BRIDGE_PROJECTS_DIR ?? DEFAULT_PROJECTS_DIR),
    );
    this.codexBin = opts.codexBin ?? process.env.CODEX_BIN ?? 'codex';
    this.defaultCwd = resolve(expandHome(opts.defaultCwd ?? homedir()));
    this.maxWorkers = Math.max(
      1,
      Number(opts.maxWorkers ?? process.env.FEISHU_BRIDGE_AGENT_MAX_WORKERS ?? 3) || 3,
    );
    this.timeoutMs = Math.max(
      30_000,
      Number(opts.timeoutMs ?? process.env.FEISHU_BRIDGE_AGENT_TIMEOUT_MS ?? 600_000) ||
        600_000,
    );
  }

  async createProject(name: string, goal = ''): Promise<{ name: string; slug: string; path: string }> {
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new DispatchError('项目名称不能为空。');
    await mkdir(this.projectsDir, { recursive: true });
    const slug = await this.uniqueSlug(slugify(cleanName));
    const path = join(this.projectsDir, slug);
    await mkdir(path, { recursive: false });
    await mkdir(join(path, 'tasks'));
    await mkdir(join(path, 'progress'));
    await mkdir(join(path, 'outputs'));
    const now = nowText();
    const board: DispatchBoard = {
      version: 1,
      project: {
        name: cleanName,
        slug,
        goal: String(goal || '').trim(),
        createdAt: now,
        updatedAt: now,
      },
      tasks: [],
    };
    await writeBoard(path, board);
    await writeFile(
      join(path, 'project.md'),
      [
        `# ${cleanName}`,
        '',
        `项目目标：${board.project.goal || '未填写'}`,
        '',
        '## 运行约定',
        '',
        '- 主控对话负责拆解、分派、复核和合并。',
        '- 执行对话只处理被分配的单项任务。',
        '- task_board.json 是唯一可信任务状态源。',
        '- 执行结果必须写入 outputs/ 后再进入复核。',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(join(path, 'handoff.md'), `# ${cleanName} Handoff\n\n暂无主控复核记录。\n`, 'utf8');
    return { name: cleanName, slug, path };
  }

  async listProjects(): Promise<Array<{ name: string; slug: string; path: string; updatedAt: string }>> {
    await mkdir(this.projectsDir, { recursive: true });
    const entries = await readdir(this.projectsDir, { withFileTypes: true });
    const projects: Array<{ name: string; slug: string; path: string; updatedAt: string }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(this.projectsDir, entry.name);
      try {
        const board = await readBoard(path);
        projects.push({
          name: String(board.project?.name || entry.name),
          slug: String(board.project?.slug || entry.name),
          path,
          updatedAt: String(board.project?.updatedAt || ''),
        });
      } catch {
        // Ignore non-dispatch folders under the projects directory.
      }
    }
    projects.sort((a, b) => {
      const time = a.updatedAt.localeCompare(b.updatedAt);
      return time === 0 ? a.slug.localeCompare(b.slug) : time;
    });
    return projects;
  }

  async defaultProjectSlug(): Promise<string> {
    const projects = await this.listProjects();
    if (projects.length === 0) throw new DispatchError('还没有调度项目。先用 /agent new 项目名');
    const latest = projects[projects.length - 1];
    if (!latest) throw new DispatchError('还没有调度项目。先用 /agent new 项目名');
    return latest.slug;
  }

  async addTask(projectSlug: string, title: string, instructions: string): Promise<DispatchTask> {
    const projectPath = await this.projectPath(projectSlug);
    const board = await readBoard(projectPath);
    const cleanTitle = String(title || '').trim();
    const cleanInstructions = String(instructions || '').trim();
    if (!cleanTitle) throw new DispatchError('任务标题不能为空。');
    if (!cleanInstructions) throw new DispatchError('任务说明不能为空。');
    const id = nextTaskId(board);
    const now = nowText();
    const task: DispatchTask = {
      id,
      title: cleanTitle,
      status: 'pending',
      instructions: cleanInstructions,
      sessionId: '',
      createdAt: now,
      updatedAt: now,
      output: `outputs/${id}-result.md`,
    };
    board.tasks.push(task);
    board.project.updatedAt = now;
    await writeBoard(projectPath, board);
    await writeFile(
      join(projectPath, 'tasks', `${id}.md`),
      `# ${id} ${cleanTitle}\n\n项目：${board.project.name}\n状态：pending\n输出文件：outputs/${id}-result.md\n\n## 任务说明\n\n${cleanInstructions}\n`,
      'utf8',
    );
    return task;
  }

  async runnableTaskIds(projectSlug: string): Promise<string[]> {
    const projectPath = await this.projectPath(projectSlug);
    const board = await readBoard(projectPath);
    return board.tasks
      .filter((task) => ['pending', 'assigned', 'rework', 'blocked', 'failed'].includes(task.status))
      .map((task) => task.id);
  }

  async runTask(projectSlug: string, taskId: string, chatId = ''): Promise<DispatchTask> {
    const projectPath = await this.projectPath(projectSlug);
    let board = await readBoard(projectPath);
    const task = findTask(board, taskId);
    if (!['pending', 'assigned', 'rework', 'blocked', 'failed'].includes(task.status)) {
      throw new DispatchError(`${task.id} 当前状态是 ${task.status}，不能直接执行。`);
    }
    task.status = 'running';
    task.updatedAt = nowText();
    board.project.updatedAt = task.updatedAt;
    await writeBoard(projectPath, board);
    await appendProgress(projectPath, task.id, 'running', '开始执行。');

    const lastMessage = join(projectPath, 'progress', `${task.id}-last-message.md`);
    const args = [
      '--ask-for-approval',
      'never',
      'exec',
      '--json',
      '--cd',
      projectPath,
      '--skip-git-repo-check',
      '--sandbox',
      'workspace-write',
      '--output-last-message',
      lastMessage,
      workerPrompt(projectPath, board, task, chatId),
    ];
    const result = await runProcess(this.codexBin, args, {
      cwd: projectPath,
      timeoutMs: this.timeoutMs,
    });
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || '无错误输出').slice(-1200);
      await markFailed(projectPath, task.id, detail);
      throw new DispatchError(`${task.id} 执行失败：${detail}`);
    }

    const sessionId = extractSessionId(result.stdout);
    const body = await readFile(lastMessage, 'utf8').catch(() => result.stdout);
    const outputPath = join(projectPath, 'outputs', `${task.id}-result.md`);
    const existingOutput = await readFile(outputPath, 'utf8').catch(() => '');
    if (!existingOutput.trim()) {
      await writeFile(
        outputPath,
        [
          `# ${task.id} ${task.title}`,
          '',
          `项目：${board.project.name}`,
          '状态：reviewing',
          `Codex session：${sessionId || '未捕获'}`,
          `更新时间：${nowText()}`,
          '',
          '## 执行结果',
          '',
          body.trim() || '执行完成，但没有生成正文。',
          '',
        ].join('\n'),
        'utf8',
      );
    }

    board = await readBoard(projectPath);
    const updated = findTask(board, task.id);
    updated.status = 'reviewing';
    updated.sessionId = sessionId;
    updated.updatedAt = nowText();
    board.project.updatedAt = updated.updatedAt;
    await writeBoard(projectPath, board);
    await appendProgress(projectPath, task.id, 'reviewing', `执行完成，结果写入 outputs/${task.id}-result.md`);
    return updated;
  }

  async registerWorker(projectSlug: string, name: string, chatId: string): Promise<WorkerInfo> {
    const projectPath = await this.projectPath(projectSlug);
    const cleanName = normalizeWorkerName(name);
    if (!cleanName) throw new DispatchError('执行对话名称不能为空。');
    const workers = await readWorkers(projectPath);
    const now = nowText();
    workers[cleanName] = { name: cleanName, chatId: String(chatId || '').trim(), updatedAt: now };
    await writeWorkers(projectPath, workers);
    await appendProgress(projectPath, 'workers', 'worker', `登记执行对话 ${cleanName} -> ${workers[cleanName].chatId || 'unknown'}`);
    return workers[cleanName];
  }

  async assignTask(
    projectSlug: string,
    taskId: string,
    workerName: string,
    supervisorChatId = '',
  ): Promise<{ projectPath: string; board: DispatchBoard; task: DispatchTask; worker: WorkerInfo }> {
    const projectPath = await this.projectPath(projectSlug);
    const cleanWorkerName = normalizeWorkerName(workerName);
    if (!cleanWorkerName) throw new DispatchError('执行对话名称不能为空。');
    const workers = await readWorkers(projectPath);
    const worker = workers[cleanWorkerName];
    if (!worker?.chatId) {
      throw new DispatchError(
        `没有找到执行对话：${cleanWorkerName}。先在目标对话发 /agent worker ${cleanWorkerName} ${projectSlug}`,
      );
    }
    const board = await readBoard(projectPath);
    const task = findTask(board, taskId);
    if (!['pending', 'assigned', 'rework', 'blocked', 'failed'].includes(task.status)) {
      throw new DispatchError(`${task.id} 当前状态是 ${task.status}，不能分派。`);
    }
    task.status = 'assigned';
    task.assignedTo = worker.name;
    task.workerChatId = worker.chatId;
    task.supervisorChatId = String(supervisorChatId || '').trim();
    task.updatedAt = nowText();
    board.project.updatedAt = task.updatedAt;
    await writeBoard(projectPath, board);
    await appendProgress(projectPath, task.id, 'assigned', `分派给 ${worker.name} (${worker.chatId})`);
    return { projectPath, board, task, worker };
  }

  async markTask(projectSlug: string, taskId: string, status: string): Promise<DispatchTask> {
    const normalized = String(status || '').trim().toLowerCase();
    if (!TASK_STATUSES.has(normalized)) {
      throw new DispatchError(`状态必须是：${[...TASK_STATUSES].sort().join(', ')}`);
    }
    const projectPath = await this.projectPath(projectSlug);
    const board = await readBoard(projectPath);
    const task = findTask(board, taskId);
    task.status = normalized;
    task.updatedAt = nowText();
    board.project.updatedAt = task.updatedAt;
    await writeBoard(projectPath, board);
    await appendProgress(projectPath, task.id, normalized, '主控手动更新状态。');
    return task;
  }

  async taskResultText(projectSlug: string, taskId: string, maxChars = 2800): Promise<string> {
    const { task, text } = await this.taskResult(projectSlug, taskId, maxChars);
    return `任务：${task.id} ${task.title}\n状态：${task.status}\n结果文件：${task.output}\n\n${text}`;
  }

  async taskResult(
    projectSlug: string,
    taskId: string,
    maxChars = 2800,
  ): Promise<{ board: DispatchBoard; task: DispatchTask; text: string }> {
    const projectPath = await this.projectPath(projectSlug);
    const board = await readBoard(projectPath);
    const task = findTask(board, taskId);
    const outputRel = String(task.output || `outputs/${task.id}-result.md`);
    const outputPath = resolve(projectPath, outputRel);
    if (!outputPath.startsWith(`${projectPath}/`) && outputPath !== projectPath) {
      throw new DispatchError('任务结果路径不合法。');
    }
    const body = (await readFile(outputPath, 'utf8').catch(() => '')).trim();
    if (!body) throw new DispatchError(`${task.id} 还没有可读取的结果文件：${outputRel}`);
    const text =
      body.length > maxChars
        ? `${body.slice(0, Math.max(0, maxChars - 24)).trimEnd()}\n\n[结果过长，已截断]`
        : body;
    return { board, task, text };
  }

  async statusText(projectSlug = ''): Promise<string> {
    if (!projectSlug) {
      const projects = await this.listProjects();
      if (projects.length === 0) return '还没有调度项目。用法：/agent new 项目名';
      return `调度项目：\n${projects.slice(-8).map((p) => `- ${p.slug}：${p.name}`).join('\n')}`;
    }
    const projectPath = await this.projectPath(projectSlug);
    const board = await readBoard(projectPath);
    const counts: Record<string, number> = {};
    for (const task of board.tasks) counts[task.status] = (counts[task.status] || 0) + 1;
    const stats = Object.entries(counts).map(([k, v]) => `${k}:${v}`).join('，') || '无任务';
    const rows = board.tasks.slice(-10).map((task) => `- ${task.id} [${task.status}] ${task.title}`);
    return `项目：${board.project.name}\n目录：${projectPath}\n任务统计：${stats}\n${rows.length ? rows.join('\n') : '暂无任务'}`;
  }

  async statusCard(projectSlug: string): Promise<object> {
    const projectPath = await this.projectPath(projectSlug);
    const board = await readBoard(projectPath);
    return agentBoardCard(projectPath, board);
  }

  async uniqueSlug(base: string): Promise<string> {
    const slug = base || 'project';
    let candidate = slug;
    let index = 2;
    while (await exists(join(this.projectsDir, candidate))) {
      candidate = `${slug}-${index}`;
      index++;
    }
    return candidate;
  }

  async projectPath(slug: string): Promise<string> {
    const clean = String(slug || '').trim() || await this.defaultProjectSlug();
    const path = resolve(this.projectsDir, clean);
    if (!path.startsWith(`${this.projectsDir}/`) && path !== this.projectsDir) {
      throw new DispatchError('项目 slug 不合法。');
    }
    if (!await exists(join(path, 'task_board.json'))) throw new DispatchError(`没有找到调度项目：${clean}`);
    return path;
  }
}

export async function handleAgentCommand(opts: HandleAgentCommandOptions): Promise<void> {
  const { args, chatId, reply, replyCard, sendToChat, sendCardToChat, codexBin, cwd, projectsDir } = opts;
  const manager = new DispatchManager({ codexBin, defaultCwd: cwd, projectsDir });
  const raw = String(args || '').trim();
  if (!raw) {
    await reply(agentHelp());
    return;
  }

  const [firstLine = '', ...bodyLines] = raw.split(/\r?\n/);
  const body = bodyLines.join('\n').trim();
  const parts = firstLine.trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] || 'status').toLowerCase();
  try {
    if (sub === 'help' || sub === '帮助') {
      await reply(agentHelp());
      return;
    }
    if (['new', 'start', 'project'].includes(sub)) {
      const name = parts.slice(1).join(' ').trim();
      if (!name) {
        await reply('用法：/agent new 项目名\n项目目标');
        return;
      }
      const project = await manager.createProject(name, body);
      await reply(
        `已创建调度项目。\n项目：${project.name}\nslug：${project.slug}\n目录：${project.path}\n下一步：/agent add 任务标题\n任务说明`,
      );
      return;
    }
    if (sub === 'list' || sub === 'projects') {
      await reply(await manager.statusText());
      return;
    }
    if (sub === 'status' || sub === 'board') {
      const projectSlug = parts[1] || await manager.defaultProjectSlug().catch(() => '');
      if (projectSlug && replyCard) {
        await replyCard(await manager.statusCard(projectSlug), await manager.statusText(projectSlug));
      } else {
        await reply(await manager.statusText(projectSlug));
      }
      return;
    }
    if (sub === 'worker' || sub === 'join') {
      if (!parts[1]) {
        await reply('用法：/agent worker 执行对话名 [项目slug]');
        return;
      }
      const projectSlug = parts[2] || await manager.defaultProjectSlug();
      const worker = await manager.registerWorker(projectSlug, parts[1], chatId);
      await reply(`已登记执行对话。\n名称：${worker.name}\n项目：${projectSlug}\nchat：${worker.chatId}\n等待主控用 /agent assign T-001 ${worker.name} ${projectSlug} 分派任务。`);
      return;
    }
    if (sub === 'add' || sub === 'task') {
      const title = parts.slice(1).join(' ').trim();
      if (!title || !body) {
        await reply('用法：/agent add 任务标题\n任务说明');
        return;
      }
      const projectSlug = await manager.defaultProjectSlug();
      const task = await manager.addTask(projectSlug, title, body);
      await reply(`已登记任务：${task.id} [${task.status}]\n标题：${task.title}\n项目：${projectSlug}\n任务文件：tasks/${task.id}.md`);
      return;
    }
    if (sub === 'run') {
      if (!parts[1]) {
        await reply('用法：/agent run T-001 或 /agent run all [项目slug]');
        return;
      }
      const target = parts[1].toUpperCase();
      const projectSlug = parts[2] || await manager.defaultProjectSlug();
      if (target === 'ALL') {
        const taskIds = (await manager.runnableTaskIds(projectSlug)).slice(0, manager.maxWorkers);
        if (taskIds.length === 0) {
          await reply(`项目 ${projectSlug} 没有可执行任务。`);
          return;
        }
        await reply(`已启动 ${taskIds.length} 个执行对话：${taskIds.join(', ')}\n完成后会回写 outputs/ 并通知主控复核。`);
        for (const taskId of taskIds) {
          void runAndNotify(manager, projectSlug, taskId, chatId, reply, replyCard, sendToChat, sendCardToChat);
        }
        return;
      }
      await reply(`已启动执行对话：${target}\n完成后会回写 outputs/${target}-result.md 并通知主控复核。`);
      void runAndNotify(manager, projectSlug, target, chatId, reply, replyCard, sendToChat, sendCardToChat);
      return;
    }
    if (sub === 'assign' || sub === 'send') {
      if (!parts[1] || !parts[2]) {
        await reply('用法：/agent assign T-001 执行对话名 [项目slug]');
        return;
      }
      const projectSlug = parts[3] || await manager.defaultProjectSlug();
      const assigned = await manager.assignTask(projectSlug, parts[1].toUpperCase(), parts[2], chatId);
      const text = assignmentMessage(assigned.projectPath, assigned.board, assigned.task);
      const card = agentAssignmentCard(assigned.projectPath, assigned.board, assigned.task);
      if (sendCardToChat) {
        await sendCardToChat(assigned.worker.chatId, card, text);
      } else if (sendToChat) {
        await sendToChat(assigned.worker.chatId, text);
      }
      const fallback = `已分派任务：${assigned.task.id}\n项目：${projectSlug}\n执行对话：${assigned.worker.name}\n目标 chat：${assigned.worker.chatId}\n${sendCardToChat || sendToChat ? '已推送到执行对话。' : '当前运行时未提供跨聊天发送能力。'}`;
      if (replyCard) {
        await replyCard(agentAssignResultCard(projectSlug, assigned.task, assigned.worker), fallback);
      } else {
        await reply(fallback);
      }
      return;
    }
    if (sub === 'result' || sub === 'show' || sub === 'review') {
      if (!parts[1]) {
        await reply('用法：/agent result T-001 [项目slug]');
        return;
      }
      const projectSlug = parts[2] || await manager.defaultProjectSlug();
      if (replyCard) {
        const result = await manager.taskResult(projectSlug, parts[1].toUpperCase());
        await replyCard(
          agentTaskReviewCard(projectSlug, result.board, result.task, result.text),
          await manager.taskResultText(projectSlug, parts[1].toUpperCase()),
        );
      } else {
        await reply(await manager.taskResultText(projectSlug, parts[1].toUpperCase()));
      }
      return;
    }
    if (sub === 'mark') {
      if (!parts[1] || !parts[2]) {
        await reply('用法：/agent mark T-001 accepted|rework|done [项目slug]');
        return;
      }
      const projectSlug = parts[3] || await manager.defaultProjectSlug();
      const task = await manager.markTask(projectSlug, parts[1].toUpperCase(), parts[2]);
      await reply(`已更新任务：${task.id} -> ${task.status}`);
      return;
    }
    await reply(agentHelp());
  } catch (err) {
    await reply(`调度命令失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

async function runAndNotify(
  manager: DispatchManager,
  projectSlug: string,
  taskId: string,
  chatId: string,
  reply: (text: string) => Promise<void>,
  replyCard: ((card: object, fallback: string) => Promise<void>) | undefined,
  sendToChat: ((chatId: string, text: string) => Promise<void>) | undefined,
  sendCardToChat: ((chatId: string, card: object, fallback: string) => Promise<void>) | undefined,
): Promise<void> {
  try {
    const task = await manager.runTask(projectSlug, taskId, chatId);
    const result = await manager.taskResult(projectSlug, task.id);
    const fallback = `调度任务已完成：${projectSlug}/${task.id}\n状态：${task.status}\n结果：${task.output}\n下一步：主控读取结果并复核。`;
    const card = agentTaskReviewCard(projectSlug, result.board, result.task, result.text);
    if (replyCard) {
      await replyCard(card, fallback);
    } else {
      await reply(fallback);
    }
    if (task.supervisorChatId && task.supervisorChatId !== chatId) {
      const supervisorText = `执行对话已完成任务：${projectSlug}/${task.id}\n状态：${task.status}\n结果：${task.output}\n下一步：/agent result ${task.id} ${projectSlug}`;
      if (sendCardToChat) {
        await sendCardToChat(task.supervisorChatId, card, supervisorText);
      } else if (sendToChat) {
        await sendToChat(task.supervisorChatId, supervisorText);
      }
    }
  } catch (err) {
    await reply(`调度任务失败：${projectSlug}/${taskId}\n${err instanceof Error ? err.message : String(err)}`);
  }
}

function agentHelp(): string {
  return [
    '多对话调度命令：',
    '/agent new 项目名',
    '项目目标',
    '/agent add 任务标题',
    '任务说明',
    '/agent worker 执行对话名 [项目slug]',
    '/agent assign T-001 执行对话名 [项目slug]',
    '/agent run T-001',
    '/agent run all [项目slug]',
    '/agent status [项目slug]',
    '/agent result T-001 [项目slug]',
    '/agent mark T-001 accepted|rework|done [项目slug]',
    '',
    '约定：主控负责分派和复核；执行对话只处理被分配任务并写 outputs。',
  ].join('\n');
}

function assignmentMessage(projectPath: string, board: DispatchBoard, task: DispatchTask): string {
  return `你收到一个执行任务。\n项目：${board.project.name}\n项目 slug：${board.project.slug}\n项目目录：${projectPath}\n任务：${task.id} ${task.title}\n输出文件：${task.output || `outputs/${task.id}-result.md`}\n\n任务说明：\n${task.instructions}\n\n执行方式：\n/agent run ${task.id} ${board.project.slug}\n\n完成后主控会用：\n/agent result ${task.id} ${board.project.slug}`;
}

function workerPrompt(projectPath: string, board: DispatchBoard, task: DispatchTask, chatId: string): string {
  return `你是 feishu-codex-bridge 多对话调度系统中的执行对话，不是主控。
只完成当前任务，不要改动其它任务，不要删除用户或其它执行对话的文件。
完成后必须把结果写入指定输出文件，并在最终回复里给出简短完成摘要。

飞书 chat_id：${chatId || 'unknown'}
项目：${board.project.name}
项目目录：${projectPath}
任务ID：${task.id}
任务标题：${task.title}
任务说明：
${task.instructions}

必须写入结果文件：outputs/${task.id}-result.md
结果文件必须包含：核心结论、执行过程摘要、产出或发现、风险/阻塞、下一步建议。`;
}

function runProcess(command: string, args: string[], opts: { cwd: string; timeoutMs: number }): Promise<ProcessResult> {
  return new Promise((resolveProcess) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolveProcess({ code: 124, stdout, stderr: `${stderr}\n执行超时` });
    }, opts.timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProcess({ code: 127, stdout, stderr: err.message });
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProcess({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function readBoard(projectPath: string): Promise<DispatchBoard> {
  try {
    return JSON.parse(await readFile(join(projectPath, 'task_board.json'), 'utf8')) as DispatchBoard;
  } catch {
    throw new DispatchError(`读取任务板失败：${projectPath}`);
  }
}

async function writeBoard(projectPath: string, board: DispatchBoard): Promise<void> {
  await mkdir(dirname(join(projectPath, 'task_board.json')), { recursive: true });
  const tmp = join(projectPath, `task_board.json.tmp-${process.pid}`);
  await writeFile(tmp, `${JSON.stringify(board, null, 2)}\n`, 'utf8');
  await rename(tmp, join(projectPath, 'task_board.json'));
}

async function readWorkers(projectPath: string): Promise<Workers> {
  try {
    return JSON.parse(await readFile(join(projectPath, 'workers.json'), 'utf8')) as Workers;
  } catch {
    return {};
  }
}

async function writeWorkers(projectPath: string, workers: Workers): Promise<void> {
  const tmp = join(projectPath, `workers.json.tmp-${process.pid}`);
  await writeFile(tmp, `${JSON.stringify(workers, null, 2)}\n`, 'utf8');
  await rename(tmp, join(projectPath, 'workers.json'));
}

function findTask(board: DispatchBoard, taskId: string): DispatchTask {
  const normalized = String(taskId || '').trim().toUpperCase();
  const task = board.tasks.find((item) => item.id === normalized);
  if (!task) throw new DispatchError(`没有找到任务：${taskId}`);
  return task;
}

function nextTaskId(board: DispatchBoard): string {
  let max = 0;
  for (const task of board.tasks) {
    const m = String(task.id || '').match(/^T-(\d{3})$/);
    if (m?.[1]) max = Math.max(max, Number(m[1]));
  }
  return `T-${String(max + 1).padStart(3, '0')}`;
}

async function markFailed(projectPath: string, taskId: string, error: string): Promise<void> {
  const board = await readBoard(projectPath);
  const task = findTask(board, taskId);
  task.status = 'failed';
  task.error = String(error || '').slice(-1200);
  task.updatedAt = nowText();
  board.project.updatedAt = task.updatedAt;
  await writeBoard(projectPath, board);
  await appendProgress(projectPath, task.id, 'failed', task.error);
}

async function appendProgress(projectPath: string, taskId: string, statusText: string, note: string): Promise<void> {
  const path = join(projectPath, 'progress', `${taskId}.md`);
  const old = await readFile(path, 'utf8').catch(() => '');
  await writeFile(path, `${old}- ${nowText()} [${statusText}] ${note}\n`, 'utf8');
}

function extractSessionId(stdout: string): string {
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const evt = JSON.parse(line) as { thread_id?: unknown; session_id?: unknown; sessionId?: unknown };
      const id = evt.thread_id || evt.session_id || evt.sessionId;
      if (typeof id === 'string' && id) return id;
    } catch {
      // Ignore non-Codex JSON lines.
    }
  }
  return '';
}

function slugify(value: string): string {
  const words: string[] = [];
  let ascii = '';
  for (const char of String(value || '').toLowerCase()) {
    if (/^[a-z0-9]$/.test(char)) {
      ascii += char;
      continue;
    }
    if (ascii) {
      words.push(ascii);
      ascii = '';
    }
    if (PINYIN[char]) words.push(PINYIN[char]);
  }
  if (ascii) words.push(ascii);
  return words.join('-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'project';
}

function normalizeWorkerName(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function nowText(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return `${homedir()}${path.slice(1)}`;
  return path;
}

function shell(title: string, elements: object[]): object {
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: title } },
    body: {
      elements: [
        { tag: 'markdown', content: `**${escapeMd(title)}**` },
        HR,
        ...elements,
      ],
    },
  };
}

function divMd(content: string): object {
  return { tag: 'markdown', content };
}

function actions(buttons: Array<{ text: string; value: Record<string, unknown>; style?: 'primary' | 'danger' | 'default' }>): object {
  return {
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: 'small',
    columns: buttons.map((spec) => ({
      tag: 'column',
      width: 'auto',
      elements: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: spec.text },
          type: spec.style ?? 'default',
          behaviors: [{ type: 'callback', value: spec.value }],
        },
      ],
    })),
  };
}

const HR: object = { tag: 'hr' };

function agentBoardCard(projectPath: string, board: DispatchBoard): object {
  const counts: Record<string, number> = {};
  for (const task of board.tasks) counts[task.status] = (counts[task.status] || 0) + 1;
  const rows = board.tasks.slice(-8);
  const elements: object[] = [
    divMd(`项目：**${escapeMd(board.project.name)}**\nslug：\`${escapeCode(board.project.slug)}\`\n目录：\`${escapeCode(projectPath)}\``),
    divMd(`任务统计：${Object.entries(counts).map(([k, v]) => `${escapeMd(k)}:${v}`).join('，') || '无任务'}`),
    HR,
  ];
  if (rows.length === 0) {
    elements.push(divMd('暂无任务。'));
  } else {
    for (const task of rows) {
      elements.push(divMd(`**${task.id}** [${escapeMd(task.status)}] ${escapeMd(task.title)}\n输出：\`${escapeCode(task.output)}\``));
      elements.push(
        actions([
          { text: '查看结果', value: { cmd: 'agent.result', arg: `${task.id} ${board.project.slug}` } },
          { text: '通过', value: { cmd: 'agent.mark', arg: `${task.id} accepted ${board.project.slug}` }, style: 'primary' },
          { text: '返工', value: { cmd: 'agent.mark', arg: `${task.id} rework ${board.project.slug}` }, style: 'danger' },
        ]),
      );
    }
  }
  return shell('多对话调度任务板', elements);
}

function agentAssignmentCard(projectPath: string, board: DispatchBoard, task: DispatchTask): object {
  return shell('执行任务', [
    divMd(`项目：**${escapeMd(board.project.name)}**\nslug：\`${escapeCode(board.project.slug)}\`\n目录：\`${escapeCode(projectPath)}\``),
    HR,
    divMd(`任务：**${task.id} ${escapeMd(task.title)}**\n状态：\`${escapeCode(task.status)}\`\n输出：\`${escapeCode(task.output)}\``),
    divMd(`任务说明：\n${escapeMd(task.instructions).slice(0, 1200)}`),
    actions([
      { text: '开始执行', value: { cmd: 'agent.run', arg: `${task.id} ${board.project.slug}` }, style: 'primary' },
      { text: '查看任务板', value: { cmd: 'agent.status', arg: board.project.slug } },
    ]),
  ]);
}

function agentAssignResultCard(projectSlug: string, task: DispatchTask, worker: WorkerInfo): object {
  return shell('任务已分派', [
    divMd(`任务：**${task.id} ${escapeMd(task.title)}**\n项目：\`${escapeCode(projectSlug)}\`\n执行对话：\`${escapeCode(worker.name)}\`\n目标 chat：\`${escapeCode(worker.chatId)}\``),
    actions([
      { text: '查看任务板', value: { cmd: 'agent.status', arg: projectSlug }, style: 'primary' },
      { text: '查看结果', value: { cmd: 'agent.result', arg: `${task.id} ${projectSlug}` } },
    ]),
  ]);
}

function agentTaskReviewCard(projectSlug: string, board: DispatchBoard, task: DispatchTask, resultText: string): object {
  return shell('任务待复核', [
    divMd(`任务：**${task.id} ${escapeMd(task.title)}**\n项目：\`${escapeCode(projectSlug)}\`\n状态：\`${escapeCode(task.status)}\`\n输出：\`${escapeCode(task.output)}\``),
    HR,
    divMd(resultText.slice(0, 2500)),
    actions([
      { text: '通过', value: { cmd: 'agent.mark', arg: `${task.id} accepted ${board.project.slug}` }, style: 'primary' },
      { text: '返工', value: { cmd: 'agent.mark', arg: `${task.id} rework ${board.project.slug}` }, style: 'danger' },
      { text: '归档完成', value: { cmd: 'agent.mark', arg: `${task.id} done ${board.project.slug}` } },
      { text: '任务板', value: { cmd: 'agent.status', arg: board.project.slug } },
    ]),
  ]);
}

function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, '\\$1');
}

function escapeCode(s: string): string {
  return s.replace(/`/g, "'");
}
