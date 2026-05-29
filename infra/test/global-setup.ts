import * as fs from 'fs';
import * as path from 'path';

export default function globalSetup() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const stubDirs = [
    path.join(repoRoot, 'frontend', 'build', 'lambda'),
    path.join(repoRoot, 'frontend', 'build', 'lambda-authorizer'),
    path.join(repoRoot, 'frontend', 'build', 'client'),
  ];

  for (const dir of stubDirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.js'), 'exports.handler = async () => ({});');
    }
  }

  // NOTE: env vars that need to reach the synth in test workers belong in
  // `setupFiles` (infra/test/setup-env.ts), not here. Jest's globalSetup
  // runs in a separate process whose env isn't inherited by workers.
}
