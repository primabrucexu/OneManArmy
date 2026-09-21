import type { Runner } from "./app.js";
import {
  ConversationStore,
  type ConversationListResult,
  type ConversationUiPatch,
  type PersistedConversation,
} from "./conversation-store.js";

export class DiscussionService {
  constructor(
    private readonly runner: Runner,
    private readonly store: ConversationStore,
  ) {}

  list(projectPath: string): Promise<ConversationListResult> {
    return this.store.list(projectPath);
  }

  get(projectPath: string, conversationId: string): Promise<PersistedConversation> {
    return this.store.get(projectPath, conversationId);
  }

  updateUiState(
    projectPath: string,
    conversationId: string,
    patch: ConversationUiPatch,
  ): Promise<PersistedConversation> {
    return this.store.updateUiState(projectPath, conversationId, patch);
  }

  async sendMessage(
    projectPath: string,
    message: string,
    conversationId?: string,
  ): Promise<PersistedConversation> {
    const conversation = await this.store.beginMessage(
      projectPath,
      message,
      conversationId,
    );

    try {
      const result = await this.runner.discussRequirements(
        projectPath,
        message,
        conversation.threadId ?? undefined,
        conversation.agentConfigSnapshot?.agents.requirements,
      );
      return await this.store.completeMessage(projectPath, conversation.id, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.failMessage(projectPath, conversation.id, message);
      throw error;
    }
  }
}
