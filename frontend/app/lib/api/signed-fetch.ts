import { ChatApiClient } from './chat-api-client';

let chatApiClient: ChatApiClient | null = null;

// Initialize the chat API client
export async function initializeChatApiClient() {
    if (!chatApiClient) {
        chatApiClient = new ChatApiClient();
    }
    return chatApiClient;
}

// Custom fetch function that intercepts chat requests
export async function signedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    // Check if this is a chat request
    if (url.includes('/api/chat') && init?.method === 'POST') {
        // Initialize chat client if needed
        const client = await initializeChatApiClient();

        // Extract the request body
        const body = init.body;
        let requestData;

        if (typeof body === 'string') {
            requestData = JSON.parse(body);
        } else if (body instanceof FormData) {
            // Handle FormData if needed
            requestData = Object.fromEntries(body.entries());
        } else {
            requestData = body;
        }

        // Use our streaming client to make the request.
        // Forward attachedSkillId out of the body — useChat places it there
        // from the `body` config on the hook. Without this extraction the
        // signedFetch interceptor would drop the attachment on the floor.
        //
        // brandTemplateBlock is the pre-rendered <brand_template> XML block
        // the client builds right before send. Passing it through means
        // the server doesn't need to re-fetch the skill from DDB — it
        // just splices the block into the system prompt.
        const reader = await client.streamChat(requestData.messages || [], {
            signal: init?.signal || undefined,
            attachedSkillId: requestData.attachedSkillId,
            brandTemplateBlock: requestData.brandTemplateBlock,
        });

        if (!reader) {
            throw new Error('Failed to get stream reader');
        }

        // Create a ReadableStream from the reader
        const stream = new ReadableStream({
            start(controller) {
                function pump(): Promise<void> {
                    return reader!.read().then(({ done, value }) => {
                        if (done) {
                            controller.close();
                            return;
                        }
                        controller.enqueue(value);
                        return pump();
                    });
                }
                return pump();
            }
        });

        // Return a Response object that useChat expects
        return new Response(stream, {
            status: 200,
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Transfer-Encoding': 'chunked',
            },
        });
    }

    // For non-chat requests, use regular fetch
    return fetch(input, init);
} 