import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { registerRuntimeObserver } from "./runtime-observer.mjs";

const cwd = process.cwd();
const agentDir = process.env.PI_CODING_AGENT_DIR;
const logPath = join(cwd, "print-probe.jsonl");
const record = (entry) => appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
await mkdir(join(agentDir, "skills", "alpha"), { recursive: true });
await writeFile(join(agentDir, "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: print boundary probe\n---\nALPHA BODY SENTINEL\n");
const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
modelRuntime.registerProvider("row5-print-fake", {
  name: "Print boundary fake",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:1/v1",
  apiKey: "fake-only",
  models: [{ id: "probe", name: "Probe", api: "openai-completions", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 2048, maxTokens: 16 }],
  streamSimple(model, context) {
    record({ type: "provider", messages: context.messages });
    const stream = createAssistantMessageEventStream();
    stream.end({ role: "assistant", content: [{ type: "text", text: "fake" }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, stopReason: "stop", timestamp: Date.now() });
    return stream;
  },
});
const model = modelRuntime.getModel("row5-print-fake", "probe");
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: [(pi) => registerRuntimeObserver(pi, record)] });
await resourceLoader.reload();
const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, modelRuntime, model, noTools: true, sessionManager: SessionManager.inMemory(cwd) });
try {
  await session.prompt("Print [[skill:alpha]]");
  await session.prompt("extension [[skill:alpha]]", { source: "extension" });
} finally {
  session.dispose();
}
const records = (await readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
const inputs = records.filter((entry) => entry.type === "input");
const providers = records.filter((entry) => entry.type === "provider");
assert.equal(inputs.length, 2);
assert.ok(inputs.every((entry) => entry.mode === "print"));
assert.equal(providers.length, 2);
for (const provider of providers) {
  const user = provider.messages.filter((message) => message.role === "user").at(-1);
  assert.match(JSON.stringify(user.content), /\[\[skill:alpha\]\]/);
  assert.doesNotMatch(JSON.stringify(user.content), /ALPHA BODY SENTINEL/);
}
console.log("PASS Pi SDK print-mode/source boundary: authored and extension input remain unchanged");
