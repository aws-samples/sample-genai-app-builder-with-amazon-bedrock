import { createRequestHandler } from '@remix-run/node';
import * as build from './build/server/index.js';
import { Readable, pipeline } from 'stream';
import { promisify } from 'util';

const streamPipeline = promisify(pipeline);
const requestHandler = createRequestHandler(build as any);

// Dedicated streaming handler - only handles chat requests
export const handler = (globalThis as any).awslambda.streamifyResponse(
    async (event: any, responseStream: any, context: any) => {
        console.log('🚀 Streaming Lambda - handling chat request');
        console.log('📋 Event details:', {
            method: event.requestContext?.http?.method || event.httpMethod,
            path: event.rawPath || event.requestContext?.http?.path || event.path,
            bodyLength: event.body?.length || 0,
        });

        try {
            // Create request for /api/chat route (this is what Remix expects)
            const url = new URL('/api/chat', `https://${event.headers?.host || 'localhost'}`);

            const request = new Request(url.toString(), {
                method: 'POST',
                headers: new Headers(event.headers as any),
                body: event.body ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8') : undefined,
            });

            console.log('🎯 Forwarding to Remix /api/chat route');
            const response = await requestHandler(request, context);

            // Propagate Remix's actual status and content type instead of
            // hardcoding 200 + text/plain. Previously we committed the
            // response prelude with status 200 BEFORE knowing what Remix
            // returned, so validation errors (e.g. conversation-too-long)
            // reached the client as 200 + JSON body. ai-sdk then tried to
            // parse the JSON as an SSE stream and threw
            //   "Failed to parse stream string. Invalid code {"error""
            // masking the real message from the user. Propagating the
            // status lets useChat's onError surface a usable message.
            const responseHeaders: Record<string, string> = {};
            response.headers.forEach((value, key) => {
                const lower = key.toLowerCase();
                // CORS is set by the Lambda Function URL; don't duplicate.
                if (lower.startsWith('access-control-')) return;
                responseHeaders[key] = value;
            });
            if (!responseHeaders['Content-Type'] && !responseHeaders['content-type']) {
                responseHeaders['Content-Type'] = 'text/plain; charset=utf-8';
            }
            if (!responseHeaders['Cache-Control'] && !responseHeaders['cache-control']) {
                responseHeaders['Cache-Control'] = 'no-cache';
            }

            const metadata = {
                statusCode: response.status,
                headers: responseHeaders,
            };
            console.log(`📡 Remix response: status=${response.status} ct=${responseHeaders['Content-Type'] ?? responseHeaders['content-type']}`);

            const httpResponseStream = (globalThis as any).awslambda.HttpResponseStream.from(responseStream, metadata);

            if (response.body) {
                const nodeStream = Readable.fromWeb(response.body as any);
                await streamPipeline(nodeStream, httpResponseStream);
            } else {
                console.log('⚠️ No response body from Remix');
                httpResponseStream.end();
            }
        } catch (error: any) {
            console.error('❌ Streaming error:', error);
            // Best-effort error path. If we've already committed the prelude
            // via HttpResponseStream.from above, this will create a second
            // prelude which Lambda ignores; the message still goes out on
            // the body so the client sees *something*.
            const httpResponseStream = (globalThis as any).awslambda.HttpResponseStream.from(
                responseStream,
                {
                    statusCode: 500,
                    headers: {
                        'Content-Type': 'application/json; charset=utf-8',
                        'Cache-Control': 'no-cache',
                    },
                },
            );
            httpResponseStream.write(JSON.stringify({
                error: error.message || 'An unexpected error occurred',
                timestamp: new Date().toISOString()
            }));
            httpResponseStream.end();
        }
    }
);