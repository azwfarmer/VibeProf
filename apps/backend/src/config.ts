import path from "node:path";
import fs from "node:fs";

const findEnvPath = () => {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "../../.env"),
    process.env.INIT_CWD ? path.resolve(process.env.INIT_CWD, ".env") : ""
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate));
};

const envPath = findEnvPath();
const projectRoot = envPath ? path.dirname(envPath) : (process.env.INIT_CWD ?? process.cwd());

const loadEnvFile = () => {
  if (!envPath) {
    return;
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^["']|["']$/g, "");

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
};

loadEnvFile();

const env = (...names: string[]) => {
  for (const name of names) {
    const value = process.env[name];
    if (value) {
      return value;
    }
  }

  return "";
};

export const config = {
  host: process.env.BACKEND_HOST ?? "0.0.0.0",
  port: Number(process.env.BACKEND_PORT ?? process.env.PORT ?? 8787),
  dbPath: path.resolve(projectRoot, process.env.AITUTOR_DB_PATH ?? "apps/backend/data/aitutor.json"),
  https: {
    certPath: process.env.HTTPS_CERT_PATH ? path.resolve(projectRoot, process.env.HTTPS_CERT_PATH) : "",
    keyPath: process.env.HTTPS_KEY_PATH ? path.resolve(projectRoot, process.env.HTTPS_KEY_PATH) : "",
    caCertPath: process.env.HTTPS_CA_CERT_PATH ? path.resolve(projectRoot, process.env.HTTPS_CA_CERT_PATH) : "",
    httpHelperPort: Number(process.env.HTTP_HELPER_PORT ?? 8788)
  },
  tutor: {
    primaryProvider: process.env.TUTOR_PRIMARY_PROVIDER ?? "anthropic",
    primaryModel: process.env.TUTOR_PRIMARY_MODEL ?? "claude-opus-4-8",
    premiumProvider: process.env.TUTOR_PREMIUM_PROVIDER ?? "anthropic",
    premiumModel: process.env.TUTOR_PREMIUM_MODEL ?? "claude-fable-5",
    fallbackProvider: process.env.TUTOR_FALLBACK_PROVIDER ?? "openai",
    fallbackModel: process.env.TUTOR_FALLBACK_MODEL ?? "gpt-5.5"
  },
  voice: {
    primaryProvider: process.env.VOICE_PRIMARY_PROVIDER ?? "openai",
    primaryModel: process.env.VOICE_PRIMARY_MODEL ?? "gpt-realtime-2",
    fallbackProvider: process.env.VOICE_FALLBACK_PROVIDER ?? "gemini",
    fallbackModel: process.env.VOICE_FALLBACK_MODEL ?? "gemini-3.1-flash-live-preview"
  },
  keys: {
    anthropic: env("ANTHROPIC_API_KEY", "anthropic_key"),
    openai: env("OPENAI_API_KEY", "openAI_key", "openai_key"),
    gemini: env("GEMINI_API_KEY", "gemini_key")
  }
};
