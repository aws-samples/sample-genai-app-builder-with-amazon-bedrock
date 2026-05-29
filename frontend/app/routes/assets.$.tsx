import type { LoaderFunctionArgs } from '@remix-run/node';
import { redirect } from '@remix-run/node';

export async function loader({ params }: LoaderFunctionArgs) {
    // Extract the asset path from the splat parameter
    const assetPath = params['*'];
    if (!assetPath) {
        throw new Response('Asset not found', { status: 404 });
    }
    // Redirect to the S3 origin directly using the deployed AWS region
    const s3Url = `https://${process.env.STACK_PREFIX}-static-assets-${process.env.AWS_ACCOUNT_ID}-${process.env.AWS_REGION}.s3.${process.env.AWS_REGION}.amazonaws.com/assets/${assetPath}`;
    return redirect(s3Url, 301);
} 