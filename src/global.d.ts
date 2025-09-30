/**
 * Global type declarations for the project
 */

// Export all types from types.ts to make them globally available
export * from './types';

// Global type augmentations
declare global {
  // Re-export all types from types.ts
  export {
    ChatMessage,
    OpenAIContentBlock,
    FunctionDefinition,
    ToolDefinition,
    ToolChoice,
    ChatCompletionRequest,
    ErrorResponse,
    AzureConfig,
    AnthropicContentBlock,
    AnthropicMessage,
    AnthropicMessagesRequest,
    AnthropicTool,
    ExtendedAnthropicContentBlock,
    ExtendedChatMessage,
    ExtendedAnthropicMessagesRequest,
  } from './types';

  // Logger interface for consistent logging
  interface Logger {
    info(message: string, data?: Record<string, any>): void;
    error(message: string, error?: Error | Record<string, any>): void;
    warn(message: string, data?: Record<string, any>): void;
  }

  // Environment variables
  interface Env {
    GatewayToken: KVNamespace;
    ACCOUNT_ID: string;
    GATEWAY_ID: string;
    AZURE_RESOURCE: string;
    AZURE_API_VERSION: string;
  }
}