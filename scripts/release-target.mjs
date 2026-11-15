import { nextVersion, output, readJson, releaseInfo, run } from './release.mjs';

const commit = run('git', ['rev-parse', 'HEAD']);
const mainCommits = run('git', ['rev-list', '--first-parent', 'origin/main']).split('\n');
if (!mainCommits.includes(commit))
  throw new Error('Release commit must be on main first-parent history');
const event = readJson(process.env.GITHUB_EVENT_PATH);
if (process.env.GITHUB_EVENT_NAME === 'push') {
  if (!event.before || /^0+$/.test(event.before)) throw new Error('Cannot compare initial push');
  const before = JSON.parse(run('git', ['show', `${event.before}:package.json`]));
  if (before.version === readJson('package.json').version) {
    output({ release: 'false' });
    process.exit(0);
  }
}
const info = releaseInfo();
// A retry must still refer to a commit that introduced this version on main.
const parent = JSON.parse(run('git', ['show', 'HEAD^:package.json']));
if (parent.version === info.version) throw new Error('Select the commit that changed the version');
nextVersion(parent.version, info.version);
output({ release: 'true', commit, ...info });
