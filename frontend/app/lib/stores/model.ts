import { atom } from 'nanostores';

export const AVAILABLE_MODELS = [
    // Starter model (index 0 is the default — see selectedModelId below).
    //
    // 4.6 Sonnet rather than 5: 5 is markedly slower to first token on the same
    // prompt, which is the latency a user actually feels when they press send.
    // Both are selectable; this only decides where a new chat starts.
    {
        id: 'global.anthropic.claude-sonnet-4-6',
        name: 'Claude 4.6 Sonnet',
    },
    {
        id: 'global.anthropic.claude-sonnet-5',
        name: 'Claude 5 Sonnet',
    },
    {
        id: 'global.anthropic.claude-opus-4-8',
        name: 'Claude 4.8 Opus',
    },
    // // Too slow
    // {
    //     id: 'global.anthropic.claude-opus-4-6-v1',
    //     name: 'Claude 4.6 Opus',
    // },
    // // Nova models require a different backend format — uncomment when supported
    // {
    //     id: 'global.amazon.nova-2-lite-v1:0',
    //     name: 'Nova 2 Lite',
    // },
    // {
    //     id: 'global.amazon.nova-micro-v1:0',
    //     name: 'Nova Micro',
    // },
    // {
    //     id: 'global.amazon.nova-pro-v1:0',
    //     name: 'Nova Pro',
    // },
    // // Too unreliable
    // {
    //     id: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    //     name: 'Claude 4.5 Haiku',
    // },
] as const;

export const selectedModelId = atom<string>(AVAILABLE_MODELS[0].id);

export function getSelectedModel() {
    const modelId = selectedModelId.get();
    return AVAILABLE_MODELS.find((model) => model.id === modelId) || AVAILABLE_MODELS[0];
}
