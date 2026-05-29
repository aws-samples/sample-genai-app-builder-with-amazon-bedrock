import { type ActionFunctionArgs } from '@remix-run/node';
import { streamText } from '~/lib/.server/llm/stream-text';

// Approximate token counting (1 token ≈ 4 characters for English text)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function action({ request }: ActionFunctionArgs) {
  const { message, modelId } = (await request.json()) as { message: string; modelId?: string };

  try {
    // Count tokens in the prompt (approximate)
    const tokens = estimateTokens(message);
    console.log('🎫 Enhancer prompt tokens (estimated):', tokens);

    if (tokens > 10000) {
      return new Response(
        JSON.stringify({ error: 'Prompt too long for enhancement' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    const result = await streamText(
      [
        {
          role: 'user',
          content: `${message}\n\nCan you enhance this prompt to make it more specific, clear, actionable, and effective at producing a useful response from an AI assistant? Please respond with only an enhanced version of the prompt. No explanations.`
        }
      ],
      {
        maxTokens: 200,
        temperature: 0.7,
        modelId,
      }
    );

    // Create a transform stream to format the raw text for the AI SDK
    const transformStream = new TransformStream({
      transform(chunk, controller) {
        const text = new TextDecoder().decode(chunk);
        // Format each text chunk for the AI SDK client
        const formattedChunk = `0:${JSON.stringify(text)}\n`;
        controller.enqueue(new TextEncoder().encode(formattedChunk));
      },
    });

    const transformedStream = result.toAIStream().pipeThrough(transformStream);

    return new Response(transformedStream, {
      status: 200,
      headers: {
        contentType: 'text/plain; charset=utf-8',
        cacheControl: 'no-cache',
      },
    });
  } catch (error: unknown) {
    console.log(error);

    if (error instanceof Error && error.message?.includes('API key')) {
      throw new Response('Forbidden', {
        status: 403,
        statusText: 'Access Denied',
      });
    }

    throw new Response('Internal Server Error', {
      status: 500,
      statusText: 'Internal Server Error',
    });
  }
}
