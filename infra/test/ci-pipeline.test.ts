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

  describe('GitLab CI Pipeline', () => {
    let pipeline: any;

    beforeAll(() => {
      const content = fs.readFileSync(
        path.join(__dirname, '../../.gitlab-ci.yml'), 'utf-8'
      );
      pipeline = yaml.parse(content);
    });

    test('deploy-production depends on build-sidecar-image', () => {
      const deployJob = pipeline['deploy-production'];
      const needs = deployJob.needs;

      const sidecarDep = needs.find((n: any) =>
        n.job === 'build-sidecar-image'
      );

      expect(sidecarDep).toBeDefined();
      expect(sidecarDep.artifacts).toBe(true);
    });

    test('deploy-production verifies image before CDK deploy', () => {
      const deployScript = pipeline['deploy-production'].script.join('\n');

      // Image verification must come BEFORE cdk deploy
      const verifyIndex = deployScript.indexOf('describe-images');
      const cdkDeployIndex = deployScript.indexOf('cdk deploy');

      expect(verifyIndex).toBeGreaterThan(-1);
      expect(cdkDeployIndex).toBeGreaterThan(-1);
      expect(verifyIndex).toBeLessThan(cdkDeployIndex);
    });

    test('build-sidecar-image passes IMAGE_TAG as commit SHA', () => {
      const buildJob = pipeline['build-sidecar-image'];
      const script = buildJob.script.join('\n');

      expect(script).toContain('IMAGE_TAG');
      expect(script).toContain('CI_COMMIT_SHA');
    });

    test('build-sidecar-image exports SIDECAR_IMAGE_URI artifact', () => {
      const buildJob = pipeline['build-sidecar-image'];

      expect(buildJob.artifacts).toBeDefined();
      expect(buildJob.artifacts.reports.dotenv).toBeDefined();
    });

    test('stages are in correct order', () => {
      const stages = pipeline.stages;
      const buildIdx = stages.indexOf('build');
      const testIdx = stages.indexOf('test');
      const deployIdx = stages.indexOf('deploy');
      const postDeployIdx = stages.indexOf('post-deploy');

      expect(buildIdx).toBeLessThan(testIdx);
      expect(testIdx).toBeLessThan(deployIdx);
      expect(deployIdx).toBeLessThan(postDeployIdx);
    });
  });
});
