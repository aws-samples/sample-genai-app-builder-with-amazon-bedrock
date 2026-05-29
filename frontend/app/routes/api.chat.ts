import { type ActionFunctionArgs } from '@remix-run/node';
import { streamText, type Messages } from '~/lib/.server/llm/stream-text';
import { emitMetric } from '~/lib/.server/analytics';

// Token estimator: ~4 chars per token for text; an inlined image contributes
// ~1500 tokens to Claude vision regardless of payload size. Reference images
// arrive as base64 inside <image_attachment> markers; counting those bytes
// as text would inflate one 800KB photo to ~200K tokens and trip the
// conversation-too-long guard, which the client then misparses as an SSE
// stream ("Invalid code {\"error\"").
const IMAGE_ATTACHMENT_REGEX = /<image_attachment media_type="[^"]+">[^<]+<\/image_attachment>/g;
const TOKENS_PER_IMAGE = 1500;
const MAX_TOKENS = 200000;

function estimateTokens(content: string | Array<{ type: string; text?: string }>): number {
  if (typeof content === 'string') {
    const imageCount = content.match(IMAGE_ATTACHMENT_REGEX)?.length ?? 0;
    const textOnly = content.replace(IMAGE_ATTACHMENT_REGEX, '');
    return Math.ceil(textOnly.length / 4) + imageCount * TOKENS_PER_IMAGE;
  }
  let tokens = 0;
  for (const block of content) {
    if (block.type === 'text' && block.text) tokens += Math.ceil(block.text.length / 4);
    else if (block.type === 'image') tokens += TOKENS_PER_IMAGE;
  }
  return tokens;
}

function jsonError(status: number, error: string, details?: string) {
  return new Response(
    JSON.stringify(details ? { error, details } : { error }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

export async function action({ request }: ActionFunctionArgs) {
  try {
    if (request.method !== 'POST') return jsonError(405, 'Method not allowed');
    const contentType = request.headers.get('Content-Type');
    if (!contentType || !contentType.includes('application/json')) {
      return jsonError(400, 'Invalid content type');
    }

    // The streaming Function URL is gated by AWS_IAM (SigV4) — only callers
    // holding the Cognito-authorized identity-pool role can reach this
    // Lambda at all. The brand-template block arrives as opaque pre-rendered
    // text the client splices into its own system prompt, so there is no
    // server-side cross-user access to defend against here.
    const {
      messages,
      enableTemplate,
      modelId,
      brandTemplateBlock: clientBrandTemplateBlock,
    } = (await request.json()) as {
      messages: Messages;
      enableTemplate?: boolean;
      modelId?: string;
      brandTemplateBlock?: string;
    };

    if (!messages || !Array.isArray(messages)) return jsonError(400, 'Invalid messages format');
    if (messages.length > 100) return jsonError(400, 'Too many messages');
    for (const msg of messages) {
      if (!msg.role || !msg.content) return jsonError(400, 'Invalid message structure');
    }

    let totalTokens = 0;
    for (const msg of messages) totalTokens += estimateTokens(msg.content);
    if (totalTokens > MAX_TOKENS) {
      return jsonError(
        400,
        'Conversation too long',
        `Total tokens (${totalTokens}) exceeds Claude's limit of ${MAX_TOKENS}. Please start a new conversation.`,
      );
    }

    // Client pre-renders the <brand_template> block from the record it holds
    // and sends it via `brandTemplateBlock`. The string is opaque to the
    // server — we just splice it into the system prompt.
    const brandTemplateBlock =
      clientBrandTemplateBlock && clientBrandTemplateBlock.length > 0
        ? clientBrandTemplateBlock
        : undefined;

    console.log(
      `chat: messages=${messages.length} tokens=${totalTokens} model=${modelId || 'default'} blockChars=${brandTemplateBlock?.length ?? 0}`,
    );

    emitMetric(
      { ChatRequest: 1, MessagesInRequest: messages.length, EstimatedTokens: totalTokens },
      { Model: modelId || 'default' },
    );

    const result = await streamText(messages, { modelId, brandTemplateBlock }, enableTemplate);

    const transformStream = new TransformStream({
      transform(chunk, controller) {
        const text = new TextDecoder().decode(chunk);
        controller.enqueue(new TextEncoder().encode(`0:${JSON.stringify(text)}\n`));
      },
    });

    return new Response(result.toAIStream().pipeThrough(transformStream), {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Connection': 'keep-alive',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
      },
    });
  } catch (error) {
    console.error('Chat API Error:', error);
    return jsonError(500, 'Internal Server Error');
  }
}
