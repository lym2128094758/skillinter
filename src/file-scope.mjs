import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const windows = process.platform === 'win32';
const appDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)));
const appState = resolve(appDirectory, '.skillinter');
const appEnv = resolve(appDirectory, '.env');
const runtimeDirs = ['src', 'web'].map(name => resolve(appDirectory, name));
const runtimeFiles = ['start.mjs', 'start.bat', 'package.json', 'config.yaml', '.npmrc'].map(name => resolve(appDirectory, name));
export const writableScope = mode => mode === 'project_write' || mode === 'full';
export const isProjectScope = mode => mode === 'project_read' || mode === 'project_write';
export const samePath = (a, b) => relative(a, b) === '';

export function inside(root, target) {
  const rel = relative(root, target);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
}

function reject(code) {
  throw Object.assign(new Error(code), {contractCode: code});
}

function safePath(path) {
  if (typeof path !== 'string' || !path.trim() || /[\x00-\x1f]/.test(path)) reject('INVALID_ARGUMENT');
  if (!windows) return;
  const localDrive = /^[a-z]:[\\/]/i.test(path);
  if (!localDrive && (/^[\\/]/.test(path) || path.includes(':'))) reject('PATH_OUTSIDE_WORKSPACE');
  for (const part of (localDrive ? path.slice(3) : path).split(/[\\/]/)) {
    if (!part || part === '.' || part === '..') continue;
    if (/[<>:"|?*]|[ .]$/.test(part) ||
        /^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³]|CONIN\$|CONOUT\$)[ ]*(?:\.|$)/i.test(part)) reject('INVALID_ARGUMENT');
  }
}

async function noLinks(target) {
  const root = parse(target).root;
  let current = root;
  let stat = await lstat(current);
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    stat = await lstat(current);
    if (stat.isSymbolicLink()) reject('SYMLINK_NOT_ALLOWED');
  }
  if (stat.isSymbolicLink()) reject('SYMLINK_NOT_ALLOWED');
  return stat;
}

export async function projectDirectory(path, state) {
  safePath(path);
  if (!isAbsolute(path)) reject('PATH_OUTSIDE_WORKSPACE');
  const target = resolve(path);
  if (!(await noLinks(target)).isDirectory()) reject('NOT_DIRECTORY');
  const physical = await realpath(target);
  if (!samePath(physical, target)) reject('SYMLINK_NOT_ALLOWED');
  if (inside(state, physical) || inside(appState, physical)) reject('PROTECTED_PATH');
  return physical;
}

export function protectedPath(scope, target) {
  return Boolean(scope.state && inside(scope.state, target)) || inside(appState, target) || samePath(appEnv, target);
}

export async function scopedPath(scope, path, {create = false, write = false} = {}) {
  safePath(path);
  const root = scope.projectPath;
  if (isProjectScope(scope.mode) && !root) reject('WORKSPACE_NOT_FOUND');
  if (!root && !isAbsolute(path)) reject('ABSOLUTE_PATH_REQUIRED');
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path);
  if (isProjectScope(scope.mode) && !inside(root, target)) reject('PATH_OUTSIDE_WORKSPACE');
  if (protectedPath(scope, target)) reject('PROTECTED_PATH');
  if (write && !writableScope(scope.mode)) reject('WRITE_NOT_ALLOWED');
  if (write && (runtimeDirs.some(dir => inside(dir, target)) || runtimeFiles.some(file => samePath(file, target)))) {
    reject('RUNTIME_PATH');
  }

  if (isProjectScope(scope.mode)) {
    const current = await projectDirectory(root, scope.state ?? appState);
    if (!samePath(current, root)) reject('PATH_OUTSIDE_WORKSPACE');
  }
  const checked = create ? dirname(target) : target;
  const stat = await noLinks(checked);
  if (create && !stat.isDirectory()) reject('NOT_DIRECTORY');
  const physical = await realpath(checked);
  if (!samePath(checked, physical)) reject('SYMLINK_NOT_ALLOWED');
  if (!create && stat.isFile() && stat.nlink > 1) reject('SYMLINK_NOT_ALLOWED');
  return {root, target, stat};
}
