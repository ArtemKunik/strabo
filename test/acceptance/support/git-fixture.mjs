import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Create a Git-backed fixture for timeline/compare scenarios.
 *
 * It lives under `test/fixtures/timeline-repo`, which is gitignored by the outer
 * repository, so committing and then dirtying files here never touches Strabo's own tree.
 */
export function ensureTimelineRepo() {
  const root = path.resolve('test/fixtures/timeline-repo');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), "import { b } from './b.ts';\nexport const a = b;\n");
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'export const b = 1;\n');

  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  if (!fs.existsSync(path.join(root, '.git'))) {
    git('init', '-q');
    git('config', 'user.email', 'acceptance@example.com');
    git('config', 'user.name', 'Acceptance');
  }
  git('add', '.');
  try {
    git('commit', '-q', '-m', 'initial import');
  } catch {
    // Nothing to commit on a re-run; the history already exists.
  }

  // Leave an uncommitted change so comparing a revision with the working tree has impact.
  const file = path.join(root, 'src', 'b.ts');
  const content = fs.readFileSync(file, 'utf8');
  if (!content.includes('// acceptance change')) {
    fs.appendFileSync(file, '// acceptance change\n');
  }
}
