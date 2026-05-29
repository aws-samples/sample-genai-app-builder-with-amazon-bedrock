import type { LoaderFunction } from '@remix-run/node';
import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import { BUILD_CONFIG } from '~/lib/build-config';

export const loader: LoaderFunction = async () => {
  try {
    const region = BUILD_CONFIG.AWS_REGION;
    const stackPrefix = BUILD_CONFIG.STACK_PREFIX.toLowerCase();

    const client = new SSMClient({ region });

    const command = new GetParametersByPathCommand({
      Path: `/${stackPrefix}/metrics/`,
      Recursive: true,
    });

    const response = await client.send(command);

    const metrics: Record<string, number> = {};
    for (const param of response.Parameters || []) {
      const name = param.Name?.split('/').pop();
      if (name) {
        metrics[name] = parseInt(param.Value || '0', 10);
      }
    }

    return new Response(
      JSON.stringify({
        totalUsers: metrics['total-users'] || 0,
        websitesCreated: metrics['websites-created'] || 0,
        updatedAt: metrics['updated-at'] || 0,
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
        },
      },
    );
  } catch (error) {
    console.error('Failed to fetch metrics:', error);
    return new Response(
      JSON.stringify({ totalUsers: 0, websitesCreated: 0, updatedAt: 0 }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }
};
