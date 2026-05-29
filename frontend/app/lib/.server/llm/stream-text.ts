import { streamText as _streamText } from 'ai';
import { getAWSRegion } from '~/lib/.server/llm/api-key';
import { MAX_TOKENS } from './constants';
import { getSystemPrompt, getGenAIICSystemPrompt } from './prompts';
import { emitMetric } from '~/lib/.server/analytics';

interface ToolResult<Name extends string, Args, Result> {
  toolCallId: string;
  toolName: Name;
  args: Args;
  result: Result;
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
  toolInvocations?: ToolResult<string, unknown, unknown>[];
}

export type Messages = Message[];

export type StreamingOptions = Omit<Parameters<typeof _streamText>[0], 'model'>;

// Data leakage protection: Input sanitization
function sanitizeInput(content: string): string {
  return content
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[REDACTED-EMAIL]') // Emails
    .replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, '[REDACTED-PHONE]'); // Phone numbers
}

// Data leakage protection: Output filtering
function filterOutput(content: string): string {
  return content
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[REDACTED-EMAIL]') // Any emails
    .replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, '[REDACTED-PHONE]'); // Any phone numbers
}

export async function streamText(messages: Messages, options?: StreamingOptions & { modelId?: string; brandTemplateBlock?: string }, enableTemplate?: boolean) {
  const region = getAWSRegion();

  // Convert messages to Bedrock format with input sanitization
  const useTemplate = enableTemplate ?? false;
  // The brand-template precedence rules only ride along when a skill is
  // actually attached. Skipping them on bare requests trims ~350 tokens
  // off every chat turn — Jack flagged this in MR review.
  const hasBrandTemplate = !!options?.brandTemplateBlock;
  var systemPrompt = useTemplate
    ? getGenAIICSystemPrompt(undefined, hasBrandTemplate)
    : getSystemPrompt(undefined, hasBrandTemplate);
  console.log(`Using system prompt with useTemplate=${useTemplate} hasBrandTemplate=${hasBrandTemplate}`);

  // Append the attached brand template block (if any) so the generator honors
  // the user's design tokens and principles. Kept at the end so it follows
  // the primary authoring rules but precedes conversation history.
  if (options?.brandTemplateBlock) {
    systemPrompt = `${systemPrompt}\n\n${options.brandTemplateBlock}`;
    console.log(`📎 Attached brand template block: ${options.brandTemplateBlock.length} chars`);
  }

  // Use provided modelId or fall back to default
  const modelId = options?.modelId || "us.anthropic.claude-3-5-sonnet-20241022-v2:0";
  console.log(`Using model: ${modelId}`);

  // Data leakage protection: Sanitize all user inputs
  // Extract embedded image markers and convert to Bedrock multimodal content blocks
  const imageMarkerRegex = /<image_attachment media_type="([^"]+)">([^<]+)<\/image_attachment>/g;

  const bedrockMessages = messages.map(msg => {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

    // Check for embedded image markers
    const images: Array<{ mediaType: string; data: string }> = [];
    let match;
    while ((match = imageMarkerRegex.exec(content)) !== null) {
      images.push({ mediaType: match[1], data: match[2] });
    }
    imageMarkerRegex.lastIndex = 0;

    // Strip image markers from text content
    const textContent = content.replace(imageMarkerRegex, '').replace(/\n{3,}/g, '\n\n');
    const sanitizedText = msg.role === 'user' ? sanitizeInput(textContent) : textContent;

    if (images.length === 0) {
      return {
        role: msg.role,
        content: [{ type: "text", text: sanitizedText }]
      };
    }

    // Build multimodal content: images first, then text
    const blocks: Array<Record<string, any>> = [];
    for (const img of images) {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: img.mediaType, data: img.data }
      });
    }
    blocks.push({ type: "text", text: sanitizedText });

    return { role: msg.role, content: blocks };
  });

  const command = new (await import("@aws-sdk/client-bedrock-runtime")).InvokeModelWithResponseStreamCommand({
    modelId,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: MAX_TOKENS,
      messages: bedrockMessages,
      system: systemPrompt,
      temperature: 0.0
    }),
    // Bedrock Guardrail configuration
    guardrailIdentifier: process.env.BEDROCK_GUARDRAIL_ID,
    guardrailVersion: process.env.BEDROCK_GUARDRAIL_VERSION,
  });

  const client = new (await import("@aws-sdk/client-bedrock-runtime")).BedrockRuntimeClient({ region });
  const response = await client.send(command);

  return {
    toAIStream: () => {
      const stream = new ReadableStream({
        async start(controller) {
          let fullResponse = '';
          let inputTokens = 0;
          let outputTokens = 0;

          try {
            if (response.body) {
              for await (const event of response.body) {
                if (event.chunk?.bytes) {
                  const chunk = JSON.parse(new TextDecoder().decode(event.chunk.bytes));

                  if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
                    // Data leakage protection: Filter output before sending
                    const filteredText = filterOutput(chunk.delta.text);
                    fullResponse += filteredText;
                    controller.enqueue(new TextEncoder().encode(filteredText));
                  }

                  // Capture token usage from Bedrock response
                  if (chunk.type === 'message_delta' && chunk.usage) {
                    outputTokens = chunk.usage.output_tokens || 0;
                  }
                  if (chunk['amazon-bedrock-invocationMetrics']) {
                    inputTokens = chunk['amazon-bedrock-invocationMetrics'].inputTokenCount || 0;
                    outputTokens = chunk['amazon-bedrock-invocationMetrics'].outputTokenCount || 0;
                  }
                }
              }
            }

            // Analytics: count artifacts (websites created) and emit metrics
            const artifactCount = (fullResponse.match(/<boltArtifact/g) || []).length;
            emitMetric(
              { WebsiteCreated: artifactCount, InputTokens: inputTokens, OutputTokens: outputTokens },
              { Model: modelId },
            );

            controller.close();
          } catch (error) {
            console.error("Error during Bedrock streaming:", error);
            controller.error(error);
          }
        },
      });

      return stream;
    },
  };
}
