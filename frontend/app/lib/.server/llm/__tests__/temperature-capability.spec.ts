import { describe, expect, it } from 'vitest';
import { modelSupportsTemperature } from '../stream-text';

// Guards the fix for the ValidationException newer Bedrock Claude models throw
// when a request includes the deprecated `temperature` parameter. stream-text
// must only send `temperature` for models that still accept it.
describe('modelSupportsTemperature', () => {
  it('returns false for models that deprecated temperature (Claude 5 / 4.8)', () => {
    expect(modelSupportsTemperature('global.anthropic.claude-sonnet-5')).toBe(false);
    expect(modelSupportsTemperature('global.anthropic.claude-opus-4-8')).toBe(false);
  });

  it('returns true for older models that still accept temperature', () => {
    expect(modelSupportsTemperature('global.anthropic.claude-sonnet-4-6')).toBe(true);
    expect(modelSupportsTemperature('global.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(true);
    expect(modelSupportsTemperature('us.anthropic.claude-3-5-sonnet-20241022-v2:0')).toBe(true);
    expect(modelSupportsTemperature('global.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(true);
  });

  it('defaults to false (omit temperature) for an unknown/future model id', () => {
    expect(modelSupportsTemperature('global.anthropic.claude-opus-5')).toBe(false);
    expect(modelSupportsTemperature('some.other.model')).toBe(false);
  });
});
