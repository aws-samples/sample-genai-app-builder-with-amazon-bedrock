// Environment configuration for different endpoints
export const ENV = {
    // Use CloudFront distribution for chat API to ensure proper security and CORS handling
    CHAT_API_URL: typeof window !== 'undefined'
        ? window.ENV?.CHAT_API_URL || '/api/chat'
        : process.env.CHAT_API_URL || '/api/chat',

    // Use regular CloudFront URL for other API requests
    API_BASE_URL: typeof window !== 'undefined'
        ? window.ENV?.API_BASE_URL || ''
        : process.env.API_BASE_URL || '',
};

// Type for window.ENV
declare global {
    interface Window {
        ENV?: {
            CHAT_API_URL?: string;
            API_BASE_URL?: string;
            REMIX_FUNCTION_URL?: string;
            STREAMING_FUNCTION_URL?: string;
            API_GATEWAY_REST_URL?: string;
            // Cognito Configuration
            COGNITO_USER_POOL_ID?: string;
            COGNITO_USER_POOL_CLIENT_ID?: string;
            COGNITO_IDENTITY_POOL_ID?: string;
            AWS_REGION?: string;
            STACK_PREFIX?: string;
            // API Configuration from aws-exports.json
            API?: {
                REST?: {
                    RestApi?: {
                        endpoint?: string;
                    };
                };
                STREAMING?: {
                    FunctionUrl?: {
                        endpoint?: string;
                    };
                };
            };
        };
        awsExports?: any;
    }
} 
