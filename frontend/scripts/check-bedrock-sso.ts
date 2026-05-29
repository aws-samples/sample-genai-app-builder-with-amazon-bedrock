import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { getAWSRegion } from '~/lib/.server/llm/api-key';

/**
 * Local SSO/credential smoke test — invokes a Bedrock model once and prints the result.
 * Uses the AWS SDK's default credential chain (SSO, env vars, config files).
 */
async function checkBedrockConnection() {
    console.log('Attempting to connect to AWS Bedrock...');

    const region = getAWSRegion();
    console.log(`Using AWS Region: ${region}`);

    const client = new BedrockRuntimeClient({ region });
    const modelId = 'anthropic.claude-3-5-sonnet-20241022-v2:0';
    const testPrompt = 'Hi';

    console.log(`Invoking ${modelId} with prompt: "${testPrompt}"`);

    const command = new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
            anthropic_version: 'bedrock-2023-05-31',
            messages: [{ role: 'user', content: [{ type: 'text', text: testPrompt }] }],
            max_tokens: 100,
        }),
    });

    try {
        const response = await client.send(command);
        const body = JSON.parse(new TextDecoder().decode(response.body));
        const text = body.content?.[0]?.text ?? '(no text content)';
        console.log('Invocation successful.');
        console.log('Response excerpt:', text.substring(0, 50) + '...');
    } catch (error) {
        console.error('Invocation failed:', error);
        console.log('Check credentials (SSO/env/config) and model access in the region.');
        process.exitCode = 1;
    }
}

checkBedrockConnection();
