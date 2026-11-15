import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseInfo, run } from './release.mjs';

const tarball = resolve(process.argv[2]);
const directory = mkdtempSync(join(tmpdir(), 'rev-dal-package-'));
try {
  writeFileSync(join(directory, 'package.json'), '{"private":true,"type":"module"}\n');
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], {
    cwd: directory,
    stdio: 'inherit',
  });
  const pkgDirectory = join(directory, 'node_modules/rev-dal');
  const pkg = JSON.parse(readFileSync(join(pkgDirectory, 'package.json'), 'utf8'));
  const source = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(pkg.version, source.version);
  assert.equal(pkg.name, source.name);
  assert.equal(pkg.exports['./setup-db-grants.sql'], './setup-db-grants.sql');
  const modules = readdirSync(join(pkgDirectory, 'dist/lib'))
    .filter(name => name.endsWith('.js'))
    .map(name => name.slice(0, -3));
  assert.ok(modules.length > 0);
  assert.ok(existsSync(join(pkgDirectory, 'dist/index.d.ts')));
  for (const name of modules) {
    assert.ok(existsSync(join(pkgDirectory, `dist/lib/${name}.d.ts`)), `Missing types for ${name}`);
  }
  const imports = ['rev-dal', ...modules.map(name => `rev-dal/lib/${name}`)];
  writeFileSync(
    join(directory, 'smoke.mjs'),
    `for (const name of ${JSON.stringify(imports)}) await import(name);\n` +
      `import { readFileSync } from 'node:fs';\n` +
      `readFileSync(new URL(import.meta.resolve('rev-dal/setup-db-grants.sql')));\n`
  );
  run('node', ['smoke.mjs'], { cwd: directory, stdio: 'inherit' });
  writeFileSync(
    join(directory, 'smoke.mts'),
    `import createDal from 'rev-dal';\n` +
      `import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';\n` +
      modules.map(name => `import 'rev-dal/lib/${name}';\n`).join('') +
      'const dal: DataAccessLayer = createDal();\nvoid dal;\n'
  );
  const tsc = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
  run(
    'node',
    [tsc, '--noEmit', '--module', 'NodeNext', '--target', 'ES2022', '--skipLibCheck', 'smoke.mts'],
    { cwd: directory, stdio: 'inherit' }
  );
  // Ordinary commits need no release notes; a prepared version must have valid notes.
  if (readdirSync('releases').includes(`${pkg.version}.md`)) releaseInfo();
  console.log(
    `Validated ${pkg.name}@${pkg.version}: ${imports.length} module exports and SQL export`
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
