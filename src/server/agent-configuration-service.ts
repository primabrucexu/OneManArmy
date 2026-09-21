import {
  AGENT_ROLES,
  type AgentProfiles,
  type ProjectAgentConfiguration,
} from "./agent-configuration.js";
import type { ModelCatalogProvider } from "./codex-model-catalog.js";
import type { ConversationStore } from "./conversation-store.js";

export class AgentConfigurationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentConfigurationValidationError";
  }
}

export class AgentConfigurationService {
  constructor(
    private readonly store: ConversationStore,
    private readonly modelCatalog: ModelCatalogProvider,
  ) {}

  get(projectPath: string): Promise<ProjectAgentConfiguration> {
    return this.store.getAgentConfiguration(projectPath);
  }

  async save(
    projectPath: string,
    agents: AgentProfiles,
  ): Promise<ProjectAgentConfiguration> {
    const models = await this.modelCatalog.listModels();
    const modelMap = new Map(models.map((model) => [model.model, model]));

    for (const role of AGENT_ROLES) {
      const profile = agents[role];
      const model = modelMap.get(profile.model);
      if (model === undefined) {
        throw new AgentConfigurationValidationError(
          `${role} Agent 选择的模型当前不可用。`,
        );
      }
      if (
        !model.supportedReasoningEfforts.some(
          (option) => option.reasoningEffort === profile.reasoningEffort,
        )
      ) {
        throw new AgentConfigurationValidationError(
          `${role} Agent 的模型不支持所选推理等级。`,
        );
      }
    }

    return this.store.saveAgentConfiguration(projectPath, agents);
  }
}
