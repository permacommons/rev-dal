import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

export const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
export const run = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: 'utf8', ...options })?.trim() ?? '';

export function parseVersion(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Expected a stable version (X.Y.Z), received: ${version}`);
  }
  const parts = version.split('.').map(Number);
  if (parts.some(part => !Number.isSafeInteger(part))) throw new Error('Version is too large');
  return parts;
}

export function nextVersion(current, requested) {
  const parts = parseVersion(current);
  const index = ['major', 'minor', 'patch'].indexOf(requested);
  if (index >= 0) {
    parts[index]++;
    parts.fill(0, index + 1);
    requested = parts.join('.');
  }
  const next = parseVersion(requested);
  const firstDifference = next.findIndex((part, i) => part !== parseVersion(current)[i]);
  if (firstDifference < 0 || next[firstDifference] < parseVersion(current)[firstDifference]) {
    throw new Error(`Release version ${requested} must be greater than ${current}`);
  }
  return requested;
}

export function releaseInfo(directory = '.') {
  const pkg = readJson(`${directory}/package.json`);
  const lock = readJson(`${directory}/package-lock.json`);
  parseVersion(pkg.version);
  if (pkg.name !== 'rev-dal' || pkg.private) throw new Error('Expected the public rev-dal package');
  if (lock.version !== pkg.version || lock.packages[''].version !== pkg.version) {
    throw new Error('Package and lockfile versions differ');
  }
  const notesPath = `releases/${pkg.version}.md`;
  const notes = readFileSync(`${directory}/${notesPath}`, 'utf8').trim();
  if (!notes.startsWith(`# ${pkg.version}\n`) || notes.length < pkg.version.length + 10) {
    throw new Error(`Missing or invalid release notes in ${notesPath}`);
  }
  return { version: pkg.version, tag: `v${pkg.version}`, notesPath };
}

export function output(values) {
  for (const [key, value] of Object.entries(values)) {
    if (/\r|\n/.test(String(value))) throw new Error(`Multiline output: ${key}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
  console.log(JSON.stringify(values));
}
