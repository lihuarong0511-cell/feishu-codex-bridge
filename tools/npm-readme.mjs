import { existsSync } from 'node:fs';
import { copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const readmePath = join(root, 'README.md');
const backupPath = join(root, '.README.md.npm-pack-backup');
const zhReadmePath = join(root, 'README.zh.md');
const zhBackupPath = join(root, '.README.zh.md.npm-pack-backup');

const npmOnlyTransforms = [
  [/^\[中文 README\]\(\.\/README\.zh\.md\)\n{1,2}/m, ''],
];

async function prepack() {
  if (existsSync(backupPath)) await postpack();
  if (existsSync(zhBackupPath)) await postpack();

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
}

async function postpack() {
  if (existsSync(backupPath)) {
    await copyFile(backupPath, readmePath);
    await rm(backupPath, { force: true });
  }
  if (existsSync(zhBackupPath)) {
    await rename(zhBackupPath, zhReadmePath);
  }
}

const action = process.argv[2];
if (action === 'prepack') {
  await prepack();
} else if (action === 'postpack') {
  await postpack();
} else {
  console.error('usage: node tools/npm-readme.mjs <prepack|postpack>');
  process.exit(1);
}
