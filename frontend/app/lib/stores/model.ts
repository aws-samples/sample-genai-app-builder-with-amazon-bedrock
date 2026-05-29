import { atom } from 'nanostores';

export const AVAILABLE_MODELS = [
    {
        id: 'global.anthropic.claude-sonnet-4-6',
        name: 'Claude 4.6 Sonnet',
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
