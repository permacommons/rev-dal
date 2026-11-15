import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { nextVersion, releaseInfo, run } from './release.mjs';

export async function publishRelease(
  tarball,
  {
    command = run,
    registry = url => fetch(url, { signal: AbortSignal.timeout(30_000) }),
    info = releaseInfo(),
    wait = setTimeout,
    repository = process.env.GITHUB_REPOSITORY,
    summaryPath = process.env.GITHUB_STEP_SUMMARY,
    sourceCommit = process.env.GITHUB_SHA,
  } = {}
) {
  const { version, tag, notesPath } = info;
  const commit = command('git', ['rev-parse', 'HEAD']);
  if (sourceCommit && sourceCommit !== commit) {
    throw new Error(
      'Checkout differs from the workflow source identity; rerun the original push run'
    );
  }
  if (!tarball) throw new Error('Provide the tested package tarball');
  const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
  if (repository !== 'permacommons/rev-dal') throw new Error('Unexpected release repository');
  const packed = JSON.parse(command('tar', ['-xOf', tarball, 'package/package.json']));
  if (packed.name !== 'rev-dal' || packed.version !== version) {
    throw new Error('Tarball does not match the release version');
  }

  // Check existing tags before any registry mutation; never move a release tag.
  const refs = command('git', ['ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
  if (refs) {
    const resolved = refs.split('\n').at(-1).split(/\s+/)[0];
    if (resolved !== commit) throw new Error(`${tag} already points to a different commit`);
  }

  const registryUrl = `https://registry.npmjs.org/rev-dal/${version}`;
  let response = await registry(registryUrl);
  if (response.status === 404) {
    const latest = await registry('https://registry.npmjs.org/rev-dal/latest');
    if (latest.ok) nextVersion((await latest.json()).version, version);
    else if (latest.status !== 404) throw new Error(`Registry lookup failed: ${latest.status}`);
    command('npm', ['publish', tarball, '--ignore-scripts', '--access', 'public', '--provenance'], {
      stdio: 'inherit',
    });
    // Wait briefly for the accepted publication to reach registry read replicas.
    for (let attempt = 0; attempt < 5; attempt++) {
      response = await registry(registryUrl);
      if (response.ok || (response.status !== 404 && response.status < 500)) break;
      await wait(2000);
    }
  }
  if (!response.ok) throw new Error(`Registry verification failed: ${response.status}`);
  const published = await response.json();
  if (published.dist?.integrity !== integrity) {
    throw new Error(`rev-dal@${version} exists with different bytes; refusing to continue`);
  }

  if (!refs) {
    command('git', ['tag', tag, commit]);
    command('git', ['push', 'origin', `refs/tags/${tag}`]);
  }
  const releases = JSON.parse(
    command('gh', ['api', '--paginate', '--slurp', `repos/${repository}/releases`])
  ).flat();
  const existing = releases.find(release => release.tag_name === tag);
  if (existing) {
    if (existing.draft || existing.prerelease)
      throw new Error('Unexpected draft/prerelease release');
  } else {
    command('gh', [
      'release',
      'create',
      tag,
      '--verify-tag',
      '--title',
      tag,
      '--notes-file',
      notesPath,
      '--repo',
      repository,
    ]);
  }
  const summary = [
    `Published rev-dal ${version}`,
    `Commit: ${commit}`,
    `Integrity: ${integrity}`,
    `npm: https://www.npmjs.com/package/rev-dal/v/${version}`,
    `GitHub: https://github.com/${repository}/releases/tag/${tag}`,
  ].join('\n\n');
  console.log(summary);
  if (summaryPath) appendFileSync(summaryPath, `${summary}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await publishRelease(process.argv[2]);
}
