import { templateSettingsStore } from '~/lib/stores/templateSettings';
import { selectedModelId } from '~/lib/stores/model';
import { post } from "aws-amplify/api";
import { Amplify } from "aws-amplify";
import { fetchAuthSession } from "aws-amplify/auth";
import { ApiClientBase } from "./api-client-base";
import { getCurrentUserId } from "./user-id";

/**
 * Ensure Amplify's Auth module is configured against the CURRENT Cognito
 * pool IDs served from /api/config, not whatever was baked in at first
 * sign-in. The Identity Pool has been observed to replace on redeploy,
 * leaving Amplify holding a stale pool ID in its runtime singleton;
 * fetchAuthSession({ forceRefresh: true }) only re-mints creds against
 * that stale config, so the session token is never usable.
 *
 * Calling Amplify.configure again with the live values invalidates the
 * cached CredentialsProvider and the next fetchAuthSession mints against
 * the right pool.
 */
async function ensureAmplifyConfiguredFromLiveConfig(): Promise<void> {
    try {
        const resp = await fetch('/api/config', { cache: 'no-store' });
        if (!resp.ok) return;
        const live = await resp.json() as {
            COGNITO_USER_POOL_ID?: string;
            COGNITO_USER_POOL_CLIENT_ID?: string;
            COGNITO_IDENTITY_POOL_ID?: string;
        };
        if (!live.COGNITO_USER_POOL_ID || !live.COGNITO_USER_POOL_CLIENT_ID || !live.COGNITO_IDENTITY_POOL_ID) {
            return;
        }

        const cached = Amplify.getConfig();
        const cachedIdp = cached?.Auth?.Cognito?.identityPoolId;
        const cachedPool = cached?.Auth?.Cognito?.userPoolId;

        // Only reconfigure if a pool ID actually drifted — avoids tearing down
        // the credential provider on every request for no reason.
        if (cachedIdp === live.COGNITO_IDENTITY_POOL_ID && cachedPool === live.COGNITO_USER_POOL_ID) {
            return;
        }

        console.warn('⚠️ [Auth] Amplify config drift detected — reconfiguring with live pool IDs');
        console.warn('   cached identityPoolId:', cachedIdp);
        console.warn('   live identityPoolId:', live.COGNITO_IDENTITY_POOL_ID);

        Amplify.configure({
            Auth: {
                Cognito: {
                    userPoolId: live.COGNITO_USER_POOL_ID,
                    userPoolClientId: live.COGNITO_USER_POOL_CLIENT_ID,
                    identityPoolId: live.COGNITO_IDENTITY_POOL_ID,
                },
            },
        });

        // Drop any state Amplify may have cached against the old pool ID.
        if (typeof window !== 'undefined') {
            const pruneKeys = (storage: Storage) => {
                for (let i = storage.length - 1; i >= 0; i--) {
                    const key = storage.key(i);
                    if (!key) continue;
                    if (key.startsWith('CognitoIdentityId-') ||
                        key.startsWith('CognitoIdentityServiceProvider.') ||
                        key.startsWith('amplify-') ||
                        key.startsWith('aws-amplify-')) {
                        storage.removeItem(key);
                    }
                }
            };
            try { pruneKeys(window.localStorage); } catch { /* noop */ }
            try { pruneKeys(window.sessionStorage); } catch { /* noop */ }
        }
    } catch (err) {
        console.warn('ensureAmplifyConfiguredFromLiveConfig failed:', err);
    }
}

export class ChatApiClient extends ApiClientBase {
    private cachedFunctionUrl: string | null = null;

    constructor() {
        super();
    }

    // Get Streaming Lambda Function URL from window.ENV (loaded from /api/config)
    private getFunctionUrl(): string {
        if (window.ENV?.STREAMING_FUNCTION_URL) {
            this.cachedFunctionUrl = window.ENV.STREAMING_FUNCTION_URL;
            return this.cachedFunctionUrl;
        }

        if (this.cachedFunctionUrl) {
            return this.cachedFunctionUrl;
        }

        console.error('No streaming function URL found! Check /api/config endpoint.');
        throw new Error('Streaming function URL not configured');
    }

    // Regular API calls via API Gateway (for non-streaming)
    async chat(message: string): Promise<any> {
        const headers = await this.getHeaders();
        const restOperation = post({
            apiName: "RestApi",
            path: "/chat",
            options: {
                headers,
                body: {
                    message: message
                }
            },
        });

        const response = await restOperation.response;
        const data = (await response.body.json()) as any;

        return data;
    }

    // Helper method to make the actual streaming request
    private async makeStreamingRequest(
        streamingEndpoint: string,
        messages: any[],
        enableTemplate: boolean,
        modelId: string,
        region: string,
        forceRefresh: boolean = false,
        signal?: AbortSignal,
        attachedSkillId?: string,
        brandTemplateBlock?: string,
    ): Promise<Response> {
        const startTime = Date.now();
        console.log('🔐 [makeStreamingRequest] Starting request', {
            forceRefresh,
            messagesCount: messages.length,
            endpoint: streamingEndpoint.substring(0, 50) + '...',
        });

        console.log('📋 [Auth] Fetching session...', forceRefresh ? '(FORCED REFRESH)' : '(using cache)');

        // Reconfigure Amplify against the live pool IDs before every request so
        // that a pool replacement on the backend doesn't leave us signing with
        // credentials that no longer resolve to a real role.
        await ensureAmplifyConfiguredFromLiveConfig();

        const session = await fetchAuthSession({
            forceRefresh,
            // Extend session duration to 1 hour for longer chat sessions
            sessionDuration: 3600
        });

        const credentials = session.credentials;
        const now = new Date();
        const expiresIn = credentials?.expiration
            ? Math.floor((new Date(credentials.expiration).getTime() - now.getTime()) / 1000)
            : null;

        console.log('🔑 [Auth] Credentials received:', {
            hasCredentials: !!credentials,
            accessKeyId: credentials?.accessKeyId?.substring(0, 15) + '...',
            hasSecretKey: !!credentials?.secretAccessKey,
            hasSessionToken: !!credentials?.sessionToken,
            expiration: credentials?.expiration,
            expiresInSeconds: expiresIn,
            isExpired: expiresIn !== null && expiresIn < 0,
        });

        if (!credentials) {
            throw new Error('Authentication failed: No AWS credentials available. Please sign in again.');
        }

        if (expiresIn !== null && expiresIn < 0) {
            console.warn('⚠️ [Auth] Credentials are EXPIRED!', {
                expiredSeconds: Math.abs(expiresIn),
            });
        }

        // Use AWS SDK to sign the request with SigV4
        console.log('📦 [Signing] Loading signing libraries...');
        const { SignatureV4 } = await import('@aws-sdk/signature-v4');
        const { Sha256 } = await import('@aws-crypto/sha256-js');
        
        // Add small delay to avoid clock skew issues
        if (forceRefresh) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        const url = new URL(streamingEndpoint);
        // Keep the body shape lean but pass attachedSkillId when present so
        // the streaming Lambda can hydrate the brand template and inject it
        // into the system prompt. Without this the skill attachment is a
        // no-op despite the UI showing the chip.
        //
        // userId is the Cognito sub the client already knows. The server
        // uses it to key the (userId, skillId) DDB GetItem directly, so we
        // don't need to parse auth headers or forward the ID token
        // separately.
        //
        // brandTemplateBlock is the pre-rendered <brand_template> XML the
        // client composes from the skill record it already holds in
        // memory. Sending the rendered block avoids a server-side DDB
        // fetch (which had its own bundling-polyfill class of bugs) —
        // the server just splices the block into the system prompt.
        const userId = await getCurrentUserId();
        const body = JSON.stringify(
            attachedSkillId
                ? {
                    messages,
                    enableTemplate,
                    modelId,
                    attachedSkillId,
                    ...(userId ? { userId } : {}),
                    ...(brandTemplateBlock ? { brandTemplateBlock } : {}),
                }
                : { messages, enableTemplate, modelId, ...(userId ? { userId } : {}) }
        );

        console.log('📝 [Signing] Preparing request object:', {
            method: 'POST',
            hostname: url.hostname,
            path: url.pathname + url.search,
            bodyLength: body.length,
            contentType: 'application/json',
        });

        const signer = new SignatureV4({
            service: 'lambda',
            region: region,
            credentials: {
                accessKeyId: credentials.accessKeyId!,
                secretAccessKey: credentials.secretAccessKey!,
                sessionToken: credentials.sessionToken,
            },
            sha256: Sha256,
            // Ensure consistent timestamp for signature calculation
            systemClockOffset: 0,
        });

        // SigV4 for Lambda Function URLs requires `Host` (or HTTP/2
        // `:authority`) in the SignedHeaders list. AWS returns
        // `'Host' or ':authority' must be a 'SignedHeader' in the AWS
        // Authorization.` otherwise. The `@aws-sdk/signature-v4` signer only
        // signs headers present in the `headers` object — it will NOT add
        // Host itself even if `hostname` is set. So we have to put it in.
        //
        // `Content-Length` is a forbidden fetch header: the browser silently
        // substitutes its own value. Signing it with a value we computed
        // produces a signature mismatch (403). Leave it out entirely —
        // `x-amz-content-sha256` covers body integrity.
        const request = {
            method: 'POST',
            hostname: url.hostname,
            path: url.pathname + url.search,
            protocol: url.protocol,
            headers: {
                'Content-Type': 'application/json',
                'Host': url.hostname,
            },
            body,
        };

        console.log('✍️ [Signing] Signing request with SigV4...');
        const signedRequest = await signer.sign(request);
        console.log('✅ [Signing] Request signed successfully');

        // DEBUG: Log signature components
        const authHeader = signedRequest.headers?.['authorization'] as string | undefined;
        const signedHeadersMatch = authHeader?.match(/SignedHeaders=([^,]+)/);
        console.log('🔍 [Debug] Signature components:', {
            timestamp: signedRequest.headers?.['x-amz-date'],
            contentHash: signedRequest.headers?.['x-amz-content-sha256'],
            authHeader,
            actuallySigned: signedHeadersMatch?.[1],
            bodyLength: body.length,
        });

        // Convert signed headers to fetch-compatible format.
        // Strip `Host` and `Content-Length` before handing to fetch() — both
        // are forbidden fetch headers; the browser refuses to send them with
        // a value we set and substitutes its own. The browser's Host value
        // always equals `url.hostname`, which matches what the signer used,
        // so the server-side canonical request reconstructs identically and
        // the signature validates.
        const FORBIDDEN_HEADERS = new Set(['host', 'content-length']);
        const fetchHeaders: Record<string, string> = {};
        if (signedRequest.headers) {
            for (const [key, value] of Object.entries(signedRequest.headers)) {
                if (FORBIDDEN_HEADERS.has(key.toLowerCase())) {
                    continue;
                }
                fetchHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
            }
        }

        console.log('📋 [Signing] Signed headers:', Object.keys(fetchHeaders));

        console.log('🚀 [Fetch] Making HTTP request...');
        const fetchStartTime = Date.now();
        const response = await fetch(streamingEndpoint, {
            method: 'POST',
            headers: fetchHeaders,
            body,
            signal,
        });

        const fetchDuration = Date.now() - fetchStartTime;
        const totalDuration = Date.now() - startTime;

        console.log('📡 [Fetch] Response received:', {
            status: response.status,
            statusText: response.statusText,
            fetchDuration: `${fetchDuration}ms`,
            totalDuration: `${totalDuration}ms`,
        });

        return response;
    }

    // Streaming API calls via Lambda Function URL (for chat streaming)
    async streamChat(
        messages: any[],
        options?: { signal?: AbortSignal; attachedSkillId?: string; brandTemplateBlock?: string },
    ): Promise<ReadableStreamDefaultReader<Uint8Array> | null> {
        // Use Lambda Function URL with SigV4 for Cognito auth
        console.log('🔐 Using Cognito auth - using Lambda Function URL with SigV4');
        return this.streamChatViaCognito(messages, options);
    }

    // Streaming via Lambda Function URL for Cognito auth (requires SigV4)
    private async streamChatViaCognito(
        messages: any[],
        options?: { signal?: AbortSignal; attachedSkillId?: string; brandTemplateBlock?: string },
    ): Promise<ReadableStreamDefaultReader<Uint8Array> | null> {
        const maxRetries = 1;
        let lastError: Error | null = null;

        try {
            console.log('🔐 Starting streamChat (Cognito)...');

            // Get the streaming endpoint from window.ENV
            console.log('🎯 Getting streaming endpoint...');
            const streamingEndpoint = this.getFunctionUrl();
            const enableTemplate = templateSettingsStore.get().enableTemplate;
            const modelId = selectedModelId.get();
            console.log('🎯 Streaming endpoint:', streamingEndpoint);
            console.log('🤖 Selected model:', modelId);

            // Get region from window.ENV (loaded from /api/config)
            const region = window.ENV?.AWS_REGION;
            if (!region) {
                throw new Error('Configuration error: AWS_REGION not configured. Please check your deployment settings.');
            }
            console.log('🌍 Using region:', region);

            // Try request with retry logic for auth failures
            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                try {
                    const forceRefresh = attempt > 0; // Force refresh on retry
                    console.log(`\n🔄 [Attempt ${attempt + 1}/${maxRetries + 1}] Starting request...`, {
                        willForceRefresh: forceRefresh,
                    });

                    const response = await this.makeStreamingRequest(
                        streamingEndpoint,
                        messages,
                        enableTemplate,
                        modelId,
                        region,
                        forceRefresh,
                        options?.signal,
                        options?.attachedSkillId,
                        options?.brandTemplateBlock,
                    );

                    console.log(`✅ [Attempt ${attempt + 1}] Response received:`, {
                        status: response.status,
                        statusText: response.statusText,
                        ok: response.ok,
                    });

                    if (!response.ok) {
                        const responseText = await response.text();
                        console.error(`❌ [Attempt ${attempt + 1}] Error response:`, {
                            status: response.status,
                            body: responseText,
                        });

                        // Check if it's an auth error that we should retry
                        if (response.status === 403 && attempt < maxRetries) {
                            console.warn(`⚠️ [Retry] 403 error detected, will retry with fresh credentials...`);
                            lastError = new Error(`Authentication failed (attempt ${attempt + 1}/${maxRetries + 1})`);
                            continue; // Retry with fresh credentials
                        }

                        // Prefer a server-provided error message when the
                        // response body is JSON (e.g. api.chat.ts validation
                        // errors like "Conversation too long"). Falls back
                        // to a status-specific human message when the body
                        // isn't JSON or is empty.
                        let errorMessage = `Request failed with status ${response.status}`;
                        try {
                            const parsed = JSON.parse(responseText) as { error?: string; details?: string };
                            if (parsed.error) {
                                errorMessage = parsed.details
                                    ? `${parsed.error}: ${parsed.details}`
                                    : parsed.error;
                            }
                        } catch {
                            // non-JSON body; use status-based fallback below
                            if (response.status === 403) {
                                errorMessage = 'Authentication failed: Your session may have expired. Please refresh the page and try again.';
                            } else if (response.status === 500) {
                                errorMessage = 'Server error: The chat service encountered an error. Please try again.';
                            } else if (response.status === 429) {
                                errorMessage = 'Rate limit exceeded: Too many requests. Please wait a moment and try again.';
                            } else if (response.status >= 500) {
                                errorMessage = 'Server error: The service is temporarily unavailable. Please try again later.';
                            }
                        }

                        throw new Error(errorMessage);
                    }

                    // Success!
                    if (attempt > 0) {
                        console.log(`🎉 [Success] Request succeeded after ${attempt + 1} attempts!`);
                    } else {
                        console.log('🎉 [Success] Request succeeded on first attempt!');
                    }
                    return response.body?.getReader() || null;

                } catch (error) {
                    console.error(`❌ [Attempt ${attempt + 1}] Exception caught:`, error);

                    // If it's an abort error, don't retry
                    if (error instanceof Error && error.name === 'AbortError') {
                        console.log('🛑 [Abort] Request was aborted by user');
                        throw error;
                    }

                    lastError = error as Error;

                    // If this was our last attempt, throw
                    if (attempt >= maxRetries) {
                        console.error(`💥 [Failed] All ${maxRetries + 1} attempts exhausted`);
                        throw error;
                    }

                    console.warn(`⚠️ [Retry] Attempt ${attempt + 1} failed, will retry...`, {
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }

            // If we get here, all retries failed
            throw lastError || new Error('Request failed after retries');

        } catch (error) {
            console.error('💥 Error in streamChat:', error);

            // Enhance error message if it's generic
            if (error instanceof Error && !error.message.includes('Authentication') && !error.message.includes('Configuration')) {
                throw new Error(`Chat request failed: ${error.message}`);
            }

            throw error;
        }
    }
} 