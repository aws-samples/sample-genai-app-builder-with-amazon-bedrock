import { createRequestHandler } from '@remix-run/node';
import * as build from './build/server/index.js';

const requestHandler = createRequestHandler(build as any);

// Simple, regular Lambda handler - no streaming
export const handler = async (event: any, context: any) => {
    console.log('📄 Main Lambda - handling request:', {
        method: event.requestContext?.http?.method || event.httpMethod,
        path: event.requestContext?.http?.path || event.path,
    });

    try {
        // Convert Lambda event to standard Request
        const url = new URL(
            (event.requestContext?.http?.path || event.path) +
            (event.rawQueryString ? `?${event.rawQueryString}` : ''),
            `https://${event.headers?.host || 'localhost'}`
        );

        const headers = new Headers();
        if (event.headers) {
            Object.entries(event.headers).forEach(([key, value]) => {
                if (value) headers.set(key, value as string);
            });
        }

        const request = new Request(url.toString(), {
            method: event.requestContext?.http?.method || event.httpMethod || 'GET',
            headers,
            body: event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body) : null,
        });

        // Call Remix handler
        const response = await requestHandler(request, { event, context } as any);

        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
            responseHeaders[key] = value;
        });

        // Determine if body needs base64 encoding based on Content-Type
        const contentType = response.headers.get('Content-Type');
        const isBase64Encoded = !contentType?.startsWith('text/') && !contentType?.startsWith('application/json');

        let bodyContent;
        if (response.body) {
            // For regular responses, buffer the content
            const arrayBuffer = await new Response(response.body).arrayBuffer();
            bodyContent = isBase64Encoded ? Buffer.from(arrayBuffer).toString('base64') : new TextDecoder().decode(arrayBuffer);
        } else {
            bodyContent = '';
        }

        return {
            statusCode: response.status,
            headers: responseHeaders,
            body: bodyContent,
            isBase64Encoded: isBase64Encoded,
        };
    } catch (error) {
        console.error('❌ Main Lambda error:', error);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Internal Server Error' }),
            isBase64Encoded: false,
        };
    }
}; 