import { loadConfig } from "./config.js";

const command = process.argv[2];
const config = loadConfig();

switch (command) {
  case "discover":
  case "replay":
  case "handoff":
    console.error(`${command} is being implemented; target=${config.demoBaseUrl}`);
    process.exitCode = 2;
    break;
  default:
    console.error("Usage: pnpm <discover|replay|demo:handoff>");
    process.exitCode = 2;
}
