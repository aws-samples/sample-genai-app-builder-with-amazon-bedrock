import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

// Initialize Secrets Manager client
const secretsClient = new SecretsManagerClient({
    region: process.env.AWS_REGION,
});

// Cache for the custom header secret (in memory, valid for Lambda container lifetime)
let customHeaderSecret: string | null = null;

/**
 * Get the custom header secret from AWS Secrets Manager
 */
export async function getCustomHeaderSecret(): Promise<string | null> {
    if (customHeaderSecret) {
        return customHeaderSecret;
    }

    const secretArn = process.env.CUSTOM_HEADER_SECRET_ARN;

    if (!secretArn) {
        console.error('❌ CUSTOM_HEADER_SECRET_ARN environment variable not set');
        return null;
    }

    try {
        const command = new GetSecretValueCommand({
            SecretId: secretArn,
        });

        const response = await secretsClient.send(command);
        customHeaderSecret = response.SecretString || null;

        if (customHeaderSecret) {
            console.log('✅ Successfully retrieved custom header secret');
        }

        return customHeaderSecret;
    } catch (error) {
        console.error('❌ Error retrieving custom header secret:', error);
        return null;
    }
}

/**
 * Validate request comes from CloudFront with correct custom header
 */
export async function validateCloudFrontRequest(request: Request): Promise<boolean> {
    const startTime = Date.now();

    try {
        const customHeader = request.headers.get('X-Custom-Header');
        const origin = request.headers.get('Origin');
        const referer = request.headers.get('Referer');
        const userAgent = request.headers.get('User-Agent');

        console.log(`[SECURITY_VALIDATION] Starting validation`, {
            hasCustomHeader: !!customHeader,
            customHeaderLength: customHeader?.length || 0,
            origin,
            referer,
            userAgent: userAgent?.substring(0, 100) + (userAgent && userAgent.length > 100 ? '...' : ''),
            timestamp: new Date().toISOString(),
        });

        if (!customHeader) {
            console.warn(`[SECURITY_VALIDATION] ❌ Missing X-Custom-Header`, {
                allHeaders: Object.fromEntries(request.headers.entries()),
                duration: Date.now() - startTime,
            });
            return false;
        }

        console.log(`[SECURITY_VALIDATION] Custom header present, retrieving expected secret`);

        const secretStartTime = Date.now();
        const expectedSecret = await getCustomHeaderSecret();
        const secretDuration = Date.now() - secretStartTime;

        if (!expectedSecret) {
            console.error(`[SECURITY_VALIDATION] ❌ Unable to retrieve expected custom header secret`, {
                secretArn: process.env.CUSTOM_HEADER_SECRET_ARN,
                secretDuration,
                totalDuration: Date.now() - startTime,
            });
            return false;
        }

        console.log(`[SECURITY_VALIDATION] Secret retrieved successfully`, {
            secretLength: expectedSecret.length,
            secretDuration,
        });

        const isValid = customHeader === expectedSecret;

        if (!isValid) {
            console.warn(`[SECURITY_VALIDATION] ❌ Invalid X-Custom-Header value`, {
                receivedLength: customHeader.length,
                expectedLength: expectedSecret.length,
                receivedPrefix: customHeader.substring(0, 8) + '...',
                expectedPrefix: expectedSecret.substring(0, 8) + '...',
                duration: Date.now() - startTime,
            });
        } else {
            console.log(`[SECURITY_VALIDATION] ✅ Valid CloudFront request detected`, {
                duration: Date.now() - startTime,
                secretDuration,
            });
        }

        return isValid;
    } catch (error) {
        console.error(`[SECURITY_VALIDATION] ❌ Error validating CloudFront request`, {
            error: error instanceof Error ? error.message : 'Unknown error',
            stack: error instanceof Error ? error.stack : undefined,
            duration: Date.now() - startTime,
        });
        return false;
    }
}

/**
 * Basic rate limiting check (simple in-memory implementation)
 * In production, consider using Redis or DynamoDB for distributed rate limiting
 */
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();

export function checkRateLimit(
    identifier: string,
    maxRequests: number = 100,
    windowMs: number = 60000 // 1 minute
): boolean {
    const now = Date.now();
    const record = rateLimitMap.get(identifier);

    if (!record || now > record.resetTime) {
        rateLimitMap.set(identifier, { count: 1, resetTime: now + windowMs });
        return true;
    }

    if (record.count >= maxRequests) {
        console.warn(`❌ Rate limit exceeded for identifier: ${identifier}`);
        return false;
    }

    record.count++;
    return true;
}

/**
 * Sanitize and validate input strings
 */
export function sanitizeInput(input: string, maxLength: number = 10000): string {
    if (!input || typeof input !== 'string') {
        return '';
    }

    // Trim and limit length
    let sanitized = input.trim().substring(0, maxLength);

    // Remove or escape potentially dangerous characters/patterns
    // This is basic sanitization - consider more sophisticated methods for production
    sanitized = sanitized
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Remove script tags
        .replace(/javascript:/gi, '') // Remove javascript: protocols
        .replace(/on\w+\s*=/gi, ''); // Remove event handlers

    return sanitized;
}

/**
 * Generate a secure response with proper headers
 */
export function createSecureResponse(
    body: string | ReadableStream,
    init?: ResponseInit
): Response {
    const headers = new Headers(init?.headers);

    // Security headers
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('X-Frame-Options', 'DENY');
    headers.set('X-XSS-Protection', '1; mode=block');
    headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

    // CORS headers (restrictive)
    headers.set('Access-Control-Allow-Origin', '*'); // Will be restricted by CloudFront
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Custom-Header, Accept, Cache-Control');
    headers.set('Access-Control-Max-Age', '3600');

    return new Response(body, {
        ...init,
        headers,
    });
} 