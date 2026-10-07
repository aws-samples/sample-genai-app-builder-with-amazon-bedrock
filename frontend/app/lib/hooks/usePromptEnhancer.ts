import { useState } from 'react';
import { templateSettingsStore } from '~/lib/stores/templateSettings';
import { selectedModelId } from '~/lib/stores/model';
import { createScopedLogger } from '~/utils/logger';
import { requestEnhancement } from '~/lib/api/enhancer-client';

const logger = createScopedLogger('usePromptEnhancement');

export function usePromptEnhancer() {
  const [enhancingPrompt, setEnhancingPrompt] = useState(false);
  const [promptEnhanced, setPromptEnhanced] = useState(false);

  const resetEnhancer = () => {
    setEnhancingPrompt(false);
    setPromptEnhanced(false);
  };

  const enhancePrompt = async (input: string, setInput: (value: string) => void) => {
    setEnhancingPrompt(true);
    setPromptEnhanced(false);

    logger.trace('Starting prompt enhancement', { inputLength: input.length });

    let response: Response;

    try {
      response = await requestEnhancement({
        message: input,
        enableTemplate: templateSettingsStore.enableTemplate.get(),
        modelId: selectedModelId.get(),
      });
    } catch (error) {
      // No token (signed out) or a network failure: leave the prompt as typed.
      logger.error('Enhancer request failed', error);
      setEnhancingPrompt(false);
      return;
    }

    logger.trace('Enhancer response received', {
      status: response.status,
      ok: response.ok
    });

    if (!response.ok) {
      // e.g. 401 from the authorizer: keep the user's prompt rather than
      // replacing it with an empty "enhancement".
      logger.error('Enhancer rejected the request', { status: response.status });
      setEnhancingPrompt(false);
      return;
    }

    const reader = response.body?.getReader();

    const originalInput = input;

    if (reader) {
      const decoder = new TextDecoder();

      let _input = '';
      let _error;

      try {
        setInput('');

        while (true) {
          const { value, done } = await reader.read();

          if (done) {
            break;
          }

          const chunk = decoder.decode(value);
          logger.trace('Received chunk', { chunkLength: chunk.length });

          // Parse the streaming format: 0:"text"\n
          const lines = chunk.split('\n').filter((line) => line.trim());
          logger.trace('Parsed lines', { lineCount: lines.length });

          for (const line of lines) {
            const match = line.match(/^0:"(.*)"/);
            if (match) {
              try {
                // Unescape the JSON string
                const unescaped = JSON.parse(`"${match[1]}"`);
                _input += unescaped;
                logger.trace('Unescaped text', { text: unescaped });
              } catch (e) {
                // If JSON parsing fails, use the raw text
                logger.trace('JSON parse failed, using raw text', { raw: match[1] });
                _input += match[1];
              }
            } else {
              logger.trace('Line did not match pattern', { line });
            }
          }

          logger.trace('Current accumulated input', { length: _input.length });

          setInput(_input);
        }
      } catch (error) {
        _error = error;
        logger.error('Error during enhancement', error);
        setInput(originalInput);
      } finally {
        if (_error) {
          logger.error('Enhancement failed', _error);
        } else {
          logger.trace('Enhancement completed', {
            originalLength: originalInput.length,
            enhancedLength: _input.length
          });
        }

        setEnhancingPrompt(false);
        setPromptEnhanced(true);

        setTimeout(() => {
          setInput(_input);
        });
      }
    }
  };

  return { enhancingPrompt, promptEnhanced, enhancePrompt, resetEnhancer };
}
