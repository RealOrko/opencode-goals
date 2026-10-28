import { access, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const plugin = pathToFileURL(join(repository, "dist/index.js")).href;
const configDirectory = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode");
const configPath = join(configDirectory, "opencode.json");
const remove = process.argv.includes("--remove");
if (!remove) await access(join(repository, "dist/index.js"));
await mkdir(configDirectory, { recursive: true });
let source;
try { source = await readFile(configPath, "utf8"); }
catch (error) { if (error.code !== "ENOENT") throw error; }
// Fail safely on a commented config instead of dropping comments or settings.
const config = source ? JSON.parse(source) : { $schema: "https://opencode.ai/config.json" };
const entries = config.plugin ?? [];
if (!Array.isArray(entries)) throw new Error("⚠️ Expected plugin to be an array; config left unchanged.");
const specifier = entry => Array.isArray(entry) ? entry[0] : entry;
const alreadyInstalled = entries.some(entry => specifier(entry) === plugin);
if (alreadyInstalled === !remove) {
  console.log(remove ? "ℹ️ Plugin is already absent from global config." : "✅ Plugin is already installed globally.");
  process.exit(0);
}
if (!remove && entries.some(entry => /opencode-goal-plugin/.test(specifier(entry)))) {
  throw new Error("⚠️ Another goal plugin is configured. Remove it before installing this plugin; config left unchanged.");
}
if (!remove && config.command?.goal) throw new Error("⚠️ Global config already defines /goal; config left unchanged.");
config.plugin = remove ? entries.filter(entry => specifier(entry) !== plugin) : [...entries, plugin];
if (source) {
  const backup = `${configPath}.backup-session-goals-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
  await copyFile(configPath, backup);
  console.log(`💾 Config backup: ${backup}`);
}
const temporary = `${configPath}.session-goals-${process.pid}.tmp`;
await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
await rename(temporary, configPath);
const verified = JSON.parse(await readFile(configPath, "utf8"));
if (verified.plugin.some(entry => specifier(entry) === plugin) === remove) throw new Error("⚠️ Config verification failed.");
console.log(`${remove ? "🧹 Removed" : "✅ Installed"} ${plugin}\n🔄 Restart OpenCode for the change to take effect.`);
