import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolService } from '../src/services/tool.service';

const baseTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localmind-fs-'));
const workspaceRoot = path.join(baseTmp, 'workspace');
const outsideDir = path.join(baseTmp, 'outside');

fs.mkdirSync(path.join(workspaceRoot, 'sub', 'nested'), { recursive: true });
fs.writeFileSync(path.join(workspaceRoot, 'sub', 'readme.txt'), 'hello');
fs.mkdirSync(outsideDir, { recursive: true });
fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'outside');

after(() => {
  fs.rmSync(baseTmp, { recursive: true, force: true });
});

function createSymlinkSafe(target: string, linkPath: string, type?: 'dir' | 'file'): boolean {
  try {
    fs.symlinkSync(target, linkPath, type);
    return true;
  } catch {
    // On some restricted Windows environments without Developer Mode/privileges, symlink creation may fail.
    return false;
  }
}

test('normal directory listing returns files and subdirectories with accurate metadata', async () => {
  const toolService = new ToolService();
  const origCwd = process.cwd();
  process.chdir(workspaceRoot);
  try {
    const entries = await toolService.executeTool({
      name: 'list_directory_safe',
      arguments: { dirPath: 'sub' },
    });
    assert.ok(Array.isArray(entries));
    const readme = entries.find((e: any) => e.name === 'readme.txt');
    const nested = entries.find((e: any) => e.name === 'nested');
    assert.ok(readme && readme.isDirectory === false && readme.isSymlink === false && readme.sizeBytes === 5);
    assert.ok(nested && nested.isDirectory === true && nested.isSymlink === false);
  } finally {
    process.chdir(origCwd);
  }
});

test('parent traversal and absolute paths outside workspace are rejected', async () => {
  const toolService = new ToolService();
  const origCwd = process.cwd();
  process.chdir(workspaceRoot);
  try {
    await assert.rejects(
      () => toolService.executeTool({ name: 'list_directory_safe', arguments: { dirPath: '../outside' } }),
      /Path traversal/i
    );
    await assert.rejects(
      () => toolService.executeTool({ name: 'list_directory_safe', arguments: { dirPath: outsideDir } }),
      /Path traversal|outside/i
    );
  } finally {
    process.chdir(origCwd);
  }
});

test('external symlinks, nested symlinks, dangling symlinks, and symlink entries are handled safely', async () => {
  const extLink = path.join(workspaceRoot, 'ext-link');
  const nestedLink = path.join(workspaceRoot, 'sub', 'nested-ext');
  const danglingLink = path.join(workspaceRoot, 'dangling-link');
  const fileLink = path.join(workspaceRoot, 'sub', 'file-link.txt');

  const canSymlink =
    createSymlinkSafe(outsideDir, extLink, 'dir') &&
    createSymlinkSafe(outsideDir, nestedLink, 'dir') &&
    createSymlinkSafe(path.join(outsideDir, 'missing-target.txt'), danglingLink, 'file') &&
    createSymlinkSafe(path.join(outsideDir, 'secret.txt'), fileLink, 'file');

  if (!canSymlink) {
    return;
  }

  const toolService = new ToolService();
  const origCwd = process.cwd();
  process.chdir(workspaceRoot);
  try {
    await assert.rejects(
      () => toolService.executeTool({ name: 'list_directory_safe', arguments: { dirPath: 'ext-link' } }),
      /Symbolic link/i
    );
    await assert.rejects(
      () => toolService.executeTool({ name: 'list_directory_safe', arguments: { dirPath: 'sub/nested-ext' } }),
      /Symbolic link/i
    );
    await assert.rejects(
      () => toolService.executeTool({ name: 'list_directory_safe', arguments: { dirPath: 'dangling-link' } }),
      /Symbolic link/i
    );

    const subEntries = await toolService.executeTool({
      name: 'list_directory_safe',
      arguments: { dirPath: 'sub' },
    });
    const symlinkEntry = subEntries.find((e: any) => e.name === 'file-link.txt');
    assert.ok(symlinkEntry);
    assert.equal(symlinkEntry.isSymlink, true);
    assert.equal(symlinkEntry.isDirectory, false);
    assert.equal(symlinkEntry.sizeBytes, null);
  } finally {
    process.chdir(origCwd);
  }
});