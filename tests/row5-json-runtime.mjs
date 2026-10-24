import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const agentDir = process.env.PI_CODING_AGENT_DIR;
await mkdir(`${agentDir}/skills/alpha`, { recursive: true });
await writeFile(`${agentDir}/skills/alpha/SKILL.md`, "---\nname: alpha\ndescription: json boundary test\n---\nJSON BODY MUST NOT BE APPENDED\n");
const proc = spawn(process.execPath, [
  resolve(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
  "--mode", "json", "--offline", "--no-session", "--no-tools", "--no-mcp",
  "--extension", resolve(root, "tests/row5-rpc-extension.mjs"),
  "--provider", "row5-rpc-fake", "--model", "probe", "JSON [[skill:alpha]]",
], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
let stdout = "";
let stderr = "";
proc.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
proc.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
const exit = await new Promise((resolveExit, reject) => {
  const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error(`JSON mode timed out: ${stderr}`)); }, 15000);
  proc.once("exit", (code, signal) => { clearTimeout(timer); resolveExit({ code, signal }); });
});
assert.equal(exit.code, 0, `JSON mode failed: ${stderr}`);
const lines = stdout.trim().split("\n").filter(Boolean).map(JSON.parse);
assert.ok(lines.length > 0, "JSON mode emitted session events");
const entries = (await readFile("rpc-provider.jsonl", "utf8")).trim().split("\n").map(JSON.parse);
const input = entries.find((entry) => entry.type === "input");
assert.ok(input);
assert.equal(input.mode, "json");
const providers = entries.filter((entry) => entry.type === "provider");
assert.equal(providers.length, 1);
assert.ok(JSON.stringify(providers[0].messages).includes("JSON [[skill:alpha]]"));
assert.ok(!JSON.stringify(providers[0].messages).includes("JSON BODY MUST NOT BE APPENDED"));
assert.ok(!JSON.stringify(providers[0].messages).includes("JSON BODY MUST NOT BE APPENDED"));
console.log("PASS actual Pi CLI JSON mode leaves authored references unchanged");
