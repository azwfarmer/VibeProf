import { config } from "../config.js";
import { now } from "../ids.js";
import type { ModelStatus, ProviderName } from "../types.js";

const hasKey = (provider: ProviderName) => {
  if (provider === "anthropic") return Boolean(config.keys.anthropic);
  if (provider === "openai") return Boolean(config.keys.openai);
  if (provider === "gemini") return Boolean(config.keys.gemini);
  return true;
};

const status = (
  role: ModelStatus["role"],
  provider: ProviderName,
  model: string,
  capabilities: ModelStatus["capabilities"],
  message?: string
): ModelStatus => {
  const available = hasKey(provider);

  return {
    id: `${provider}:${model}:${role}`,
    provider,
    model,
    role,
    capabilities,
    available,
    lastCheckedAt: now(),
    message: message ?? (available ? "Configured" : `Missing ${provider.toUpperCase()} API key`)
  };
};

export const getModelStatuses = (): ModelStatus[] => [
  status("primary-tutor", config.tutor.primaryProvider as ProviderName, config.tutor.primaryModel, {
    vision: true,
    structuredJson: true,
    tools: true,
    realtimeAudio: false
  }),
  status("premium-tutor", config.tutor.premiumProvider as ProviderName, config.tutor.premiumModel, {
    vision: true,
    structuredJson: true,
    tools: true,
    realtimeAudio: false
  }),
  status("fallback-tutor", config.tutor.fallbackProvider as ProviderName, config.tutor.fallbackModel, {
    vision: true,
    structuredJson: true,
    tools: true,
    realtimeAudio: false
  }),
  status("primary-voice", config.voice.primaryProvider as ProviderName, config.voice.primaryModel, {
    vision: false,
    structuredJson: false,
    tools: false,
    realtimeAudio: true
  }),
  status("fallback-voice", config.voice.fallbackProvider as ProviderName, config.voice.fallbackModel, {
    vision: false,
    structuredJson: false,
    tools: false,
    realtimeAudio: true
  }),
  status("local-mock", "mock", "local-tutor-demo", {
    vision: false,
    structuredJson: true,
    tools: false,
    realtimeAudio: false
  }, "Always available local demo route")
];

export const selectTutorModel = (preferPremium = false) => {
  const statuses = getModelStatuses();
  const orderedRoles: ModelStatus["role"][] = preferPremium
    ? ["premium-tutor", "primary-tutor", "fallback-tutor", "local-mock"]
    : ["primary-tutor", "fallback-tutor", "local-mock"];

  return orderedRoles
    .map((role) => statuses.find((candidate) => candidate.role === role))
    .find((candidate): candidate is ModelStatus => Boolean(candidate?.available))!;
};
