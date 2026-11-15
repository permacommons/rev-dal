import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { publishRelease } from './publish-release.mjs';
import { nextVersion, parseVersion, releaseInfo } from './release.mjs';

test('stable version selection is explicit and strictly increasing', () => {
  assert.equal(nextVersion('0.2.3', 'patch'), '0.2.4');
  assert.equal(nextVersion('0.2.3', 'minor'), '0.3.0');
  assert.equal(nextVersion('0.2.3', 'major'), '1.0.0');
  assert.equal(nextVersion('0.1.0', '0.2.0'), '0.2.0');
  for (const value of ['0.2.3', '0.2.2', '0.1.99', '0.2.4-rc.1', 'v1.0.0', '01.2.3', 'x']) {
    assert.throws(() => nextVersion('0.2.3', value));
  }
  assert.throws(() => parseVersion('9007199254740992.0.0'));
});

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rev-dal-release-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: 'rev-dal',
      version: '0.1.0',
      scripts: { version: 'exit 1', prepare: 'exit 1' },
    })
  );
  writeFileSync(
    join(directory, 'package-lock.json'),
    JSON.stringify({
      name: 'rev-dal',
      version: '0.1.0',
      lockfileVersion: 3,
      packages: { '': { name: 'rev-dal', version: '0.1.0' } },
    })
  );
  return directory;
}

test('preparation updates both manifests without running lifecycle scripts', t => {
  const directory = fixture(t);
  const prepare = fileURLToPath(new URL('./prepare-release.mjs', import.meta.url));
  const notes = 'Typed model lookup.\n\nMigration: retain the existing imports.';
  const result = execFileSync('node', [prepare, 'minor'], {
    cwd: directory,
    env: { ...process.env, RELEASE_NOTES: notes, RUNNER_TEMP: directory, GITHUB_OUTPUT: '' },
    encoding: 'utf8',
  });
  assert.equal(JSON.parse(result).branch, 'release/v0.2.0');
  assert.deepEqual(releaseInfo(directory), {
    version: '0.2.0',
    tag: 'v0.2.0',
    notesPath: 'releases/0.2.0.md',
  });
  assert.equal(readFileSync(join(directory, 'releases/0.2.0.md'), 'utf8'), `# 0.2.0\n\n${notes}\n`);
  const lock = JSON.parse(readFileSync(join(directory, 'package-lock.json'), 'utf8'));
  lock.packages[''].version = '0.1.0';
  writeFileSync(join(directory, 'package-lock.json'), JSON.stringify(lock));
  assert.throws(() => releaseInfo(directory), /versions differ/);
});

test('releases require version-specific notes', t => {
  const directory = fixture(t);
  assert.throws(() => releaseInfo(directory), /ENOENT/);
  mkdirSync(join(directory, 'releases'));
  writeFileSync(join(directory, 'releases/0.1.0.md'), '# Wrong version\n\nNotes.\n');
  assert.throws(() => releaseInfo(directory), /invalid release notes/);
});

test('release targets use merged main commits and ignore non-version changes', t => {
  const directory = fixture(t);
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: directory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Release test');
  git('config', 'user.email', 'release-test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('add', '.');
  git('commit', '-m', 'Initial version');
  const before = git('rev-parse', 'HEAD');
  git('switch', '-c', 'release/v0.2.0');
  for (const name of ['package.json', 'package-lock.json']) {
    const path = join(directory, name);
    const json = JSON.parse(readFileSync(path, 'utf8'));
    json.version = '0.2.0';
    if (json.packages) json.packages[''].version = '0.2.0';
    writeFileSync(path, JSON.stringify(json));
  }
  mkdirSync(join(directory, 'releases'));
  writeFileSync(join(directory, 'releases/0.2.0.md'), '# 0.2.0\n\nFirst versioned release.\n');
  git('add', '.');
  git('commit', '-m', 'Prepare release');
  const branchHead = git('rev-parse', 'HEAD');
  git('switch', 'main');
  git('merge', '--no-ff', '--no-edit', 'release/v0.2.0');
  const merged = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', merged);
  const eventPath = join(directory, 'event.json');
  writeFileSync(eventPath, JSON.stringify({ before }));
  const target = () =>
    execFileSync('node', [fileURLToPath(new URL('./release-target.mjs', import.meta.url))], {
      cwd: directory,
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_EVENT_NAME: 'push',
        GITHUB_OUTPUT: '',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  assert.equal(JSON.parse(target()).commit, merged);
  git('checkout', branchHead);
  assert.throws(target, /first-parent history/);
  git('checkout', 'main');
  writeFileSync(eventPath, JSON.stringify({ before: merged }));
  assert.deepEqual(JSON.parse(target()), { release: 'false' });
});

function publication(
  t,
  {
    statuses = [200],
    refs = '',
    releases = [],
    differentBytes = false,
    sourceCommit = 'a'.repeat(40),
    packedVersion = '0.2.0',
    latestVersion = '0.1.0',
    relativeTarball = false,
  } = {}
) {
  const directory = fixture(t);
  const tarball = join(directory, 'package.tgz');
  writeFileSync(tarball, 'test artifact bytes');
  const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
  const calls = [];
  t.mock.method(console, 'log', () => undefined);
  return {
    calls,
    tarball,
    run: () =>
      publishRelease(relativeTarball ? relative(process.cwd(), tarball) : tarball, {
        info: { version: '0.2.0', tag: 'v0.2.0', notesPath: 'releases/0.2.0.md' },
        wait: async () => undefined,
        repository: 'permacommons/rev-dal',
        summaryPath: '',
        sourceCommit,
        command: (command, args) => {
          calls.push([command, ...args]);
          if (command === 'tar') return JSON.stringify({ name: 'rev-dal', version: packedVersion });
          if (command === 'git' && args[0] === 'rev-parse') return 'a'.repeat(40);
          if (command === 'git' && args[0] === 'ls-remote') return refs;
          if (command === 'gh' && args[0] === 'api') return JSON.stringify([releases]);
          return '';
        },
        registry: async () => {
          const status = statuses.shift();
          assert.ok(status, 'Unexpected extra registry request');
          return {
            status,
            ok: status === 200,
            json: async () => ({
              version: latestVersion,
              dist: { integrity: differentBytes ? 'conflict' : integrity },
            }),
          };
        },
      }),
  };
}

test('publication retries complete GitHub steps without republishing matching npm bytes', async t => {
  const { run, calls } = publication(t);
  await run();
  assert.equal(
    calls.some(([command]) => command === 'npm'),
    false
  );
  assert.ok(calls.some(([command, subcommand]) => command === 'git' && subcommand === 'push'));
  assert.ok(calls.some(([command, subcommand]) => command === 'gh' && subcommand === 'release'));
});

test('a complete release retry performs no write operations', async t => {
  const { run, calls } = publication(t, {
    refs: `${'a'.repeat(40)}\trefs/tags/v0.2.0`,
    releases: [{ tag_name: 'v0.2.0', draft: false, prerelease: false }],
  });
  await run();
  assert.equal(
    calls.some(([command]) => command === 'npm'),
    false
  );
  assert.equal(
    calls.some(([command, subcommand]) => command === 'git' && subcommand === 'push'),
    false
  );
  assert.equal(
    calls.some(([command, subcommand]) => command === 'gh' && subcommand === 'release'),
    false
  );
});

test('registry errors are not treated as an absent package', async t => {
  const { run, calls } = publication(t, { statuses: [503] });
  await assert.rejects(run(), /verification failed: 503/);
  assert.equal(
    calls.some(([command]) => command === 'npm' || command === 'gh'),
    false
  );
});

test('conflicting registry bytes cannot create tags or releases', async t => {
  const { run, calls } = publication(t, { differentBytes: true });
  await assert.rejects(run(), /different bytes/);
  assert.equal(
    calls.some(([command]) => command === 'npm' || command === 'gh'),
    false
  );
  assert.equal(
    calls.some(([command, subcommand]) => command === 'git' && subcommand === 'tag'),
    false
  );
});

test('a conflicting tag blocks registry publication', async t => {
  const { run, calls } = publication(t, { refs: `${'b'.repeat(40)}\trefs/tags/v0.2.0` });
  await assert.rejects(run(), /different commit/);
  assert.equal(
    calls.some(([command]) => command === 'npm' || command === 'gh'),
    false
  );
});

test('new publication tolerates registry propagation before completing GitHub steps', async t => {
  const { run, calls } = publication(t, { statuses: [404, 404, 404, 200] });
  await run();
  assert.equal(calls.filter(([command]) => command === 'npm').length, 1);
  assert.ok(calls.some(([command, subcommand]) => command === 'gh' && subcommand === 'release'));
});

test('relative artifact paths are passed to npm as absolute local paths', async t => {
  const { run, calls, tarball } = publication(t, {
    statuses: [404, 404, 200],
    relativeTarball: true,
  });
  await run();
  const publish = calls.find(([command]) => command === 'npm');
  assert.ok(isAbsolute(publish[2]));
  assert.equal(publish[2], tarball);
});

test('a mismatched workflow identity cannot attest an older checkout', async t => {
  const { run, calls } = publication(t, { sourceCommit: 'b'.repeat(40) });
  await assert.rejects(run(), /workflow source identity/);
  assert.equal(
    calls.some(([command]) => command === 'npm' || command === 'gh'),
    false
  );
});

test('an artifact for another version cannot be published', async t => {
  const { run, calls } = publication(t, { packedVersion: '0.3.0' });
  await assert.rejects(run(), /Tarball does not match/);
  assert.equal(
    calls.some(([command]) => command === 'npm' || command === 'gh'),
    false
  );
});

test('an absent old version cannot replace a newer npm latest', async t => {
  const { run, calls } = publication(t, { statuses: [404, 200], latestVersion: '0.3.0' });
  await assert.rejects(run(), /must be greater/);
  assert.equal(
    calls.some(([command]) => command === 'npm' || command === 'gh'),
    false
  );
});
