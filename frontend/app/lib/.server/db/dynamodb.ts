import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Message } from 'ai';

// Initialize DynamoDB client
const client = new DynamoDBClient({
    region: process.env.AWS_REGION,
});

const docClient = DynamoDBDocumentClient.from(client);

export interface ChatHistoryItem {
    chatId: string;
    messages: Message[];
    createdAt: string;
    updatedAt: string;
    description?: string;
}

/**
 * Get chat history by chatId
 */
export async function getChatHistory(chatId: string): Promise<ChatHistoryItem | null> {
    const tableName = process.env.CHAT_HISTORY_TABLE_NAME;

    if (!tableName) {
        console.error('❌ CHAT_HISTORY_TABLE_NAME environment variable not set');
        return null;
    }

    try {
        const command = new GetCommand({
            TableName: tableName,
            Key: { chatId },
        });

        const response = await docClient.send(command);
        return response.Item as ChatHistoryItem || null;
    } catch (error) {
        console.error('❌ Error getting chat history:', error);
        return null;
    }
}

/**
 * Save or update chat history
 */
export async function saveChatHistory(
    chatId: string,
    messages: Message[],
    description?: string
): Promise<boolean> {
    const tableName = process.env.CHAT_HISTORY_TABLE_NAME;

    if (!tableName) {
        console.error('❌ CHAT_HISTORY_TABLE_NAME environment variable not set');
        return false;
    }

    try {
        const now = new Date().toISOString();

        // Check if chat exists to determine if this is create or update
        const existingChat = await getChatHistory(chatId);

        if (existingChat) {
            // Update existing chat
            const command = new UpdateCommand({
                TableName: tableName,
                Key: { chatId },
                UpdateExpression: 'SET messages = :messages, updatedAt = :updatedAt, description = :description',
                ExpressionAttributeValues: {
                    ':messages': messages,
                    ':updatedAt': now,
                    ':description': description || existingChat.description,
                },
            });

            await docClient.send(command);
        } else {
            // Create new chat
            const chatItem: ChatHistoryItem = {
                chatId,
                messages,
                createdAt: now,
                updatedAt: now,
                description,
            };

            const command = new PutCommand({
                TableName: tableName,
                Item: chatItem,
            });

            await docClient.send(command);
        }

        console.log(`✅ Successfully saved chat history for chatId: ${chatId}`);
        return true;
    } catch (error) {
        console.error('❌ Error saving chat history:', error);
        return false;
    }
}

/**
 * Generate a new unique chat ID
 */
export function generateChatId(): string {
    return `chat_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Validate chatId format
 */
export function isValidChatId(chatId: string): boolean {
    // Basic validation - chatId should be a non-empty string with reasonable length
    return typeof chatId === 'string' && chatId.length > 0 && chatId.length < 256;
} 