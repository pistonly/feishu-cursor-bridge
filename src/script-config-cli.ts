import { loadScriptConfig } from "./script-config.js";

const [command, key] = process.argv.slice(2);

if (command !== "get" || !key) {
  console.error("用法: tsx src/script-config-cli.ts get <key>");
  process.exit(1);
}

const config = loadScriptConfig();
const value = config[key as keyof typeof config];

if (value == null) {
  process.exit(1);
}

process.stdout.write(String(value));
