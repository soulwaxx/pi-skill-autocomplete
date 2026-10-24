import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, getAgentDir, InteractiveMode, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { registerRuntimeObserver } from "./runtime-observer.mjs";

process.env.PI_OFFLINE = "1";
process.exit = () => {};
const cwd = process.cwd();
const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();
const logPath = join(cwd, "row8-provider.jsonl");
const record = (entry) => appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
mkdirSync(join(agentDir, "skills", "alpha"), { recursive: true });
writeFileSync(join(agentDir, "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: autocomplete integration\n---\nHOST ALPHA BODY SENTINEL\n");

class FakeTerminal {
  input; output = "";
  get columns() { return 80; } get rows() { return 24; } get kittyProtocolActive() { return false; }
  start(onInput) { this.input = onInput; } stop() {} async drainInput() {}
  write(data) { this.output += data; } moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
  send(data) { assert.ok(this.input); this.input(data); }
  type(text) { for (const c of text) this.send(c); }
}
async function waitFor(predicate, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    let entries = [];
    try { entries = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); } catch {}
    if (predicate(entries)) return entries;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
modelRuntime.registerProvider("row8-fake", {
  name: "Row8 fake", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "fake-only",
  models: [{ id: "probe", name: "Probe", api: "openai-completions", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 8192, maxTokens: 32 }],
  streamSimple(model, context) {
    record({ type: "provider", messages: context.messages });
    const stream = createAssistantMessageEventStream();
    stream.end({ role: "assistant", content: [{ type: "text", text: "offline fake" }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
    return stream;
  },
});
const createRuntime = async ({ cwd: sessionCwd, agentDir: sessionAgentDir, sessionManager }) => {
  const services = await createAgentSessionServices({ cwd: sessionCwd, agentDir: sessionAgentDir, modelRuntime, resourceLoaderOptions: { extensionFactories: [(pi) => registerRuntimeObserver(pi, record)] } });
  return { ...(await createAgentSessionFromServices({ services, sessionManager, model: modelRuntime.getModel("row8-fake", "probe"), noTools: "all" })), services };
};
const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
const terminal = new FakeTerminal();
const mode = new InteractiveMode(runtime, { terminal, tuiMode: "regular", quietStartup: true });
mode.run();
try {
  await new Promise((resolve) => setTimeout(resolve, 50));
  terminal.type(":alpha");
  await new Promise((resolve) => setTimeout(resolve, 150));
  terminal.send("\t");
  await new Promise((resolve) => setTimeout(resolve, 50));
  terminal.send("\r");
  const entries = await waitFor((items) => items.some((entry) => entry.type === "provider"), "fake provider request");
  const userMessages = entries.find((entry) => entry.type === "provider").messages.filter((message) => message.role === "user");
  const content = JSON.stringify(userMessages);
  assert.ok(content.includes("[[skill:alpha]]"), "real TUI Tab selection inserts the explicit skill reference");
  assert.ok(content.includes("HOST ALPHA BODY SENTINEL"), "the submitted reference loads its registered full skill body");
  console.log("PASS real Pi InteractiveMode autocomplete selection inserts [[skill:alpha]] and submits its skill body to the fake provider");
} finally {
  terminal.send("\x03"); await new Promise((resolve) => setTimeout(resolve, 30)); terminal.send("\x03");
  await runtime.dispose();
}
