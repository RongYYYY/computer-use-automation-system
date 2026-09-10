import "dotenv/config";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", override: false, quiet: true });

export interface AppConfig {
  readonly openaiApiKey: string | undefined;
  readonly openaiModel: string;
  readonly demoBaseUrl: string;
}

export function loadConfig(): AppConfig {
  return {
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiModel: process.env.OPENAI_MODEL?.trim() || "gpt-6-astra",
    demoBaseUrl: process.env.DEMO_BASE_URL?.trim() || "http://127.0.0.1:4317",
  };
}
