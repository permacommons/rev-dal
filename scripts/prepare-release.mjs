import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { nextVersion, output, readJson, run } from './release.mjs';

const requested = process.argv[2];
const notes = process.env.RELEASE_NOTES?.trim();
if (!notes) throw new Error('Provide release notes in RELEASE_NOTES');
const version = nextVersion(readJson('package.json').version, requested);
const notesPath = `releases/${version}.md`;
if (existsSync(notesPath)) throw new Error(`Release notes already exist: ${notesPath}`);
run('npm', ['version', version, '--no-git-tag-version', '--ignore-scripts']);
mkdirSync('releases', { recursive: true });
writeFileSync(notesPath, `# ${version}\n\n${notes}\n`);
writeFileSync(
  process.env.RUNNER_TEMP
    ? `${process.env.RUNNER_TEMP}/release-pr.md`
    : '/tmp/rev-dal-release-pr.md',
  `${readFileSync(notesPath, 'utf8')}\nMerging this PR publishes rev-dal ${version} after release validation.\n`
);
output({ version, branch: `release/v${version}` });
