import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createEcsTagSessionResolver, SESSION_TAG_KEY } from '../src/assignment.js';

const TASK_ARN = 'arn:aws:ecs:eu-west-1:123456789012:task/bd-vibe-sandbox-cluster/abc123';

/** A stand-in for the ECS task metadata endpoint v4. */
async function startMetadata(handler: (url: string) => { status: number; body: unknown }): Promise<{ server: Server; uri: string }> {
  const server = createServer((req, res) => {
    const { status, body } = handler(req.url ?? '');
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, uri: `http://127.0.0.1:${port}/v4/container-id` };
}

describe('createEcsTagSessionResolver', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it('returns the SandboxSession tag of this task', async () => {
    const started = await startMetadata((url) =>
      url.endsWith('/task') ? { status: 200, body: { TaskARN: TASK_ARN } } : { status: 404, body: {} },
    );
    server = started.server;
    const seen: string[] = [];

    const resolve = createEcsTagSessionResolver({
      metadataUri: started.uri,
      listTags: async (arn) => {
        seen.push(arn);
        return [
          { key: 'Other', value: 'x' },
          { key: SESSION_TAG_KEY, value: 'session-1' },
        ];
      },
    });

    await expect(resolve()).resolves.toBe('session-1');
    // The tags looked up are this task's own, from the metadata endpoint.
    expect(seen).toEqual([TASK_ARN]);
  });

  it('returns null when the task has not been assigned', async () => {
    const started = await startMetadata(() => ({ status: 200, body: { TaskARN: TASK_ARN } }));
    server = started.server;

    const resolve = createEcsTagSessionResolver({ metadataUri: started.uri, listTags: async () => [] });

    await expect(resolve()).resolves.toBeNull();
  });

  it('throws when the metadata endpoint is not configured', async () => {
    const resolve = createEcsTagSessionResolver({ metadataUri: '', listTags: async () => [] });

    await expect(resolve()).rejects.toThrow(/metadata/i);
  });

  it('throws when the metadata endpoint fails', async () => {
    const started = await startMetadata(() => ({ status: 500, body: {} }));
    server = started.server;

    const resolve = createEcsTagSessionResolver({ metadataUri: started.uri, listTags: async () => [] });

    await expect(resolve()).rejects.toThrow();
  });

  it('throws when the metadata has no task ARN', async () => {
    const started = await startMetadata(() => ({ status: 200, body: {} }));
    server = started.server;

    const resolve = createEcsTagSessionResolver({ metadataUri: started.uri, listTags: async () => [] });

    await expect(resolve()).rejects.toThrow(/TaskARN/);
  });

  it('propagates a tag lookup failure', async () => {
    const started = await startMetadata(() => ({ status: 200, body: { TaskARN: TASK_ARN } }));
    server = started.server;

    const resolve = createEcsTagSessionResolver({
      metadataUri: started.uri,
      listTags: async () => {
        throw new Error('AccessDenied');
      },
    });

    await expect(resolve()).rejects.toThrow('AccessDenied');
  });
});
