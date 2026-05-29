import { json } from '@remix-run/node';

export async function loader() {
    console.log('🏥 Health check called via GET');

    return json(
        {
            status: 'ok',
            timestamp: new Date().toISOString(),
            message: 'API Gateway is working'
        },
        {
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Amz-Date, X-Api-Key, X-Amz-Security-Token, X-Amz-User-Agent',
                'Access-Control-Max-Age': '3600',
            },
        }
    );
}

export async function action({ request }: { request: Request }) {
    console.log('🏥 Health check called via', request.method);

    // Handle OPTIONS requests for CORS preflight
    if (request.method === 'OPTIONS') {
        console.log('🔧 OPTIONS request received for health check');

        return new Response(null, {
            status: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Amz-Date, X-Api-Key, X-Amz-Security-Token, X-Amz-User-Agent',
                'Access-Control-Max-Age': '3600',
            },
        });
    }

    return json(
        {
            status: 'ok',
            method: request.method,
            timestamp: new Date().toISOString(),
            message: 'API Gateway is working'
        },
        {
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Amz-Date, X-Api-Key, X-Amz-Security-Token, X-Amz-User-Agent',
                'Access-Control-Max-Age': '3600',
            },
        }
    );
} 