import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

describe('CI Pipeline Configuration Tests', () => {

  describe('CodeBuild Buildspec', () => {
    let buildspec: any;

    beforeAll(() => {
      const content = fs.readFileSync(
        path.join(__dirname, '../lib/sandbox-container/buildspec.yml'), 'utf-8'
      );
      buildspec = yaml.parse(content);
    });

    test('IMAGE_TAG preserves environment override', () => {
      const preBuildCommands = buildspec.phases.pre_build.commands;
      const imageTagCmd = preBuildCommands.find((cmd: string) =>
        cmd.includes('IMAGE_TAG')
      );

      // Must use ${IMAGE_TAG:-...} pattern to preserve overrides from GitLab CI
      expect(imageTagCmd).toMatch(/\$\{IMAGE_TAG:-/);
      // Must NOT unconditionally assign (which would overwrite the override)
      expect(imageTagCmd).not.toMatch(/^IMAGE_TAG=\$\{CODEBUILD_RESOLVED/);
    });

    test('post_build verifies image exists after push', () => {
      const postBuildCommands = buildspec.phases.post_build.commands;
      const hasVerification = postBuildCommands.some((cmd: string) =>
        cmd.includes('manifest inspect') && cmd.includes('IMAGE_TAG')
      );

      expect(hasVerification).toBe(true);
    });

    test('builds with linux/amd64 platform for Fargate', () => {
      const buildCommands = buildspec.phases.build.commands;
      const dockerBuild = buildCommands.find((cmd: string) =>
        cmd.includes('docker build')
      );

      expect(dockerBuild).toContain('--platform linux/amd64');
    });

    test('pushes both commit-SHA tag and latest tag', () => {
      const postBuildCommands = buildspec.phases.post_build.commands;
      const pushCommands = postBuildCommands.filter((cmd: string) =>
        cmd.startsWith('docker push') || cmd.match(/^- docker push/)
      );

      // Should push $IMAGE_TAG and :latest
      const pushesImageTag = postBuildCommands.some((cmd: string) =>
        cmd.includes('docker push') && cmd.includes('$IMAGE_TAG')
      );
      const pushesLatest = postBuildCommands.some((cmd: string) =>
        cmd.includes('docker push') && cmd.includes(':latest')
      );

      expect(pushesImageTag).toBe(true);
      expect(pushesLatest).toBe(true);
    });
  });
});
