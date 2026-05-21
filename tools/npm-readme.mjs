import { existsSync } from 'node:fs';
import { copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const readmePath = join(root, 'README.md');
const backupPath = join(root, '.README.md.npm-pack-backup');
const zhReadmePath = join(root, 'README.zh.md');
const zhBackupPath = join(root, '.README.zh.md.npm-pack-backup');
const modePath = join(root, '.npm-readme-mode');

const npmOnlyTransforms = [
  [/^\[中文 README\]\(\.\/README\.zh\.md\)\n{1,2}/m, ''],
];

async function transform(mode) {
  if (existsSync(backupPath) || existsSync(zhBackupPath)) {
    const activeMode = await readMode();
    if (activeMode === mode) return;
    await restore();
  }

  const original = await readFile(readmePath, 'utf8');
  await writeFile(backupPath, original);
  if (existsSync(zhReadmePath)) {
    await rename(zhReadmePath, zhBackupPath);
  }

  let next = original;
  for (const [pattern, replacement] of npmOnlyTransforms) {
    next = next.replace(pattern, replacement);
  }
  next = next.replace(/\n{3,}/g, '\n\n');

  await writeFile(readmePath, next);
  await writeFile(modePath, mode);
}

async function prepack() {
  if ((await readMode()) === 'publish') return;
  await transform('pack');
}

async function postpack() {
  const mode = await readMode();
  if (mode === 'publish' && process.env.npm_config_dry_run !== 'true') return;
  if (mode !== 'pack' && mode !== 'publish') return;
  await restore();
}

async function restore() {
  if (existsSync(backupPath)) {
    await copyFile(backupPath, readmePath);
    await rm(backupPath, { force: true });
  }
  if (existsSync(zhBackupPath)) {
    await rename(zhBackupPath, zhReadmePath);
  }
  await rm(modePath, { force: true });
}

async function readMode() {
  if (!existsSync(modePath)) return undefined;
  return (await readFile(modePath, 'utf8')).trim();
}

const action = process.argv[2];
if (action === 'prepublish') {
  await transform('publish');
} else if (action === 'prepack') {
  await prepack();
} else if (action === 'postpack') {
  await postpack();
} else if (action === 'postpublish' || action === 'restore') {
  await restore();
} else {
  console.error('usage: node tools/npm-readme.mjs <prepublish|prepack|postpack|postpublish|restore>');
  process.exit(1);
}
