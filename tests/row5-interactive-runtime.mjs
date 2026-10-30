import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  InteractiveMode,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { registerRuntimeObserver } from "./runtime-observer.mjs";
import { expectedSkillExpansion } from "./skill-context-expectations.mjs";

process.env.PI_OFFLINE = "1";
process.exit = () => {}; // Keep assertions visible; InteractiveMode's normal shutdown exits the host process.
const cwd = process.cwd();
const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();
const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
const packageRoot = settings.packages[0];
const logPath = join(cwd, "interactive-provider.jsonl");
const record = (entry) => appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
mkdirSync(join(agentDir, "skills", "alpha"), { recursive: true });
writeFileSync(join(agentDir, "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: interactive host probe\n---\nALPHA BODY SENTINEL\n");
const imagePath = join(cwd, "startup-attachment.png");
writeFileSync(imagePath, readFileSync(join(import.meta.dirname, "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/assets/clankolas.png")));
const imageData = readFileSync(imagePath).toString("base64");

class FakeTerminal {
  input;
  output = "";
  get columns() { return 80; }
  get rows() { return 24; }
  get kittyProtocolActive() { return false; }
  start(onInput) { this.input = onInput; }
  stop() {}
  async drainInput() {}
  write(data) { this.output += data; }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  setProgramStatus() {}
  send(data) {
    assert.ok(this.input, "InteractiveMode has started the injected terminal");
    this.input(data);
  }
  type(text) {
    for (const character of text) this.send(character);
  }
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    let entries = [];
    try { entries = (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); } catch {}
    if (predicate(entries)) return entries;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function startHost({ initialMessage, initialImages }) {
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  modelRuntime.registerProvider("row5-interactive-fake", {
    name: "Interactive host fake",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "fake-only",
    models: [{ id: "probe", name: "Probe", api: "openai-completions", input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 8192, maxTokens: 32 }],
    streamSimple(model, context) {
      record({ type: "provider", messages: context.messages });
      const stream = createAssistantMessageEventStream();
      stream.end({ role: "assistant", content: [{ type: "text", text: "offline fake" }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
      return stream;
    },
  });
  const createRuntime = async ({ cwd: sessionCwd, agentDir: sessionAgentDir, sessionManager }) => {
    const services = await createAgentSessionServices({
      cwd: sessionCwd,
      agentDir: sessionAgentDir,
      modelRuntime,
      resourceLoaderOptions: { extensionFactories: [(pi) => registerRuntimeObserver(pi, record)] },
    });
    return {
      ...(await createAgentSessionFromServices({ services, sessionManager, model: modelRuntime.getModel("row5-interactive-fake", "probe"), noTools: "all" })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
  const terminal = new FakeTerminal();
  const mode = new InteractiveMode(runtime, { terminal, tuiMode: "regular", quietStartup: true, initialMessage, initialImages });
  const running = mode.run();
  return { terminal, running, runtime };
}

async function stopHost(host) {
  host.terminal.send("\x03");
  await new Promise((resolve) => setTimeout(resolve, 40));
  host.terminal.send("\x03");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await host.runtime.dispose();
}

if (!["success", "abort", "attachment-retry"].includes(process.argv[2])) {
await rm(logPath, { force: true });
const failed = await startHost({ initialMessage: "draft [[skill:missing]]", initialImages: [{ type: "image", data: imageData, mimeType: "image/png" }] });
try {
  const rejectionDeadline = Date.now() + 5000;
  while (Date.now() < rejectionDeadline && !failed.terminal.output.includes("Unknown registered skill: missing")) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(failed.terminal.output.includes("Unknown registered skill: missing"), "Pi displayed the package's fail-closed TUI error");
  let rejectedEntries = [];
  try { rejectedEntries = (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); } catch {}
  assert.equal(rejectedEntries.filter((entry) => entry.type === "provider").length, 0, "handled rejection stops before the observer and provider");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(failed.terminal.output.includes("relaunching Pi with"));
  assert.ok(failed.terminal.output.includes("original image attachment"), "TUI displays the startup-image retry warning");
  failed.terminal.type("newer-typed DELETE-ME");
  for (let index = 0; index < "DELETE-ME".length; index++) failed.terminal.send("\x7f");
  failed.terminal.send("\x1b[200~newer-pasted\x1b[201~");
  for (let index = 0; index < "newer-pasted".length + "newer-typed  ".length; index++) failed.terminal.send("\x1b[D");
  for (let index = 0; index < "[[skill:missing]]".length; index++) failed.terminal.send("\x7f");
  failed.terminal.type("[[skill:alpha]]");
  failed.terminal.send("\r");
  const resubmitted = await waitFor((entries) => entries.some((entry) => entry.type === "provider"), "corrected editor submission reaching fake provider");
  const provider = resubmitted.findLast((entry) => entry.type === "provider");
  const submitted = JSON.stringify(provider.messages.filter((message) => message.role === "user"));
  assert.match(submitted, /draft/);
  assert.match(submitted, /newer-typed/);
  assert.match(submitted, /newer-pasted/);
  assert.match(submitted, /ALPHA BODY SENTINEL/);
  assert.doesNotMatch(submitted, /DELETE-ME/);
  console.log("PASS real InteractiveMode error/recovery preserves draft and newer typed/pasted content through corrected fake-provider submission");
} finally {
  await stopHost(failed);
}
}

if (process.argv[2] === "attachment-retry") {
  await rm(logPath, { force: true });
  const retryHost = await startHost({ initialMessage: "image draft [[skill:missing]]", initialImages: [{ type: "image", data: imageData, mimeType: "image/png" }] });
  try {
    const imageRejectDeadline = Date.now() + 5000;
    while (Date.now() < imageRejectDeadline && !retryHost.terminal.output.includes("Unknown registered skill: missing")) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(retryHost.terminal.output.includes("Unknown registered skill: missing"), "image-bearing prompt was rejected by the package");
    await new Promise((resolve) => setTimeout(resolve, 30));
    for (let index = 0; index < "[[skill:missing]]".length; index++) retryHost.terminal.send("\x7f");
    retryHost.terminal.send("\r");
    const retried = await waitFor((items) => items.some((entry) => entry.type === "provider"), "resubmitted text after image recovery");
    const secondProvider = retried.findLast((entry) => entry.type === "provider");
    const secondUser = JSON.stringify(secondProvider.messages.filter((message) => message.role === "user"));
    assert.match(secondUser, /image draft/);
    assert.doesNotMatch(secondUser, /\[\[skill:missing\]\]/, "the test resubmission removes the rejected reference");
    assert.doesNotMatch(secondUser, /ALPHA BODY SENTINEL/);
    assert.doesNotMatch(secondUser, /image\/png|\"type\":\"image\"/, "text-only editor recovery cannot reattach startup initialImages");
    console.log("LIMITATION real InteractiveMode rejection restores text, but a corrected resubmission cannot recover separately supplied initialImages");
  } finally {
    await stopHost(retryHost);
  }

  await rm(logPath, { force: true });
  const filePrompt = `file draft @${imagePath} [[skill:missing]]`;
  const fileBytes = readFileSync(imagePath);
  const fileHost = await startHost({ initialMessage: filePrompt });
  try {
    const fileRejectDeadline = Date.now() + 5000;
    while (Date.now() < fileRejectDeadline && !fileHost.terminal.output.includes("Unknown registered skill: missing")) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(fileHost.terminal.output.includes("Unknown registered skill: missing"), "file-path prompt was rejected by the package");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(readFileSync(imagePath).compare(fileBytes), 0, "probe never reads the host clipboard and fixture bytes are unchanged");
    for (let index = 0; index < "[[skill:missing]]".length; index++) fileHost.terminal.send("\x7f");
    fileHost.terminal.send("\r");
    const retriedFilePrompt = await waitFor((items) => items.some((entry) => entry.type === "provider"), "file-path resubmission");
    const secondFileProvider = retriedFilePrompt.findLast((entry) => entry.type === "provider");
    const secondFileUser = JSON.stringify(secondFileProvider.messages.filter((message) => message.role === "user"));
    assert.ok(secondFileUser.includes(`@${imagePath}`));
    assert.equal(readFileSync(imagePath).compare(fileBytes), 0);
    console.log("PASS real InteractiveMode recovery and corrected resubmission preserve an existing image-path reference and unchanged fixture bytes");
  } finally {
    await stopHost(fileHost);
  }
}

if (process.argv[2] === "abort") {
  await rm(logPath, { force: true });
  const aborted = await startHost({ initialMessage: "abort draft [[skill:missing]]", initialImages: [{ type: "image", data: imageData, mimeType: "image/png" }] });
  try {
    const abortRejectDeadline = Date.now() + 5000;
    while (Date.now() < abortRejectDeadline && !aborted.terminal.output.includes("Unknown registered skill: missing")) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(aborted.terminal.output.includes("Unknown registered skill: missing"), "abort probe first produced a handled package rejection");
    aborted.terminal.send("\x03");
    aborted.terminal.type("after [[skill:alpha]]");
    aborted.terminal.send("\r");
    const entries = await waitFor((items) => items.some((entry) => entry.type === "provider"), "post-clear provider call");
    const nextProvider = entries.findLast((entry) => entry.type === "provider");
    assert.ok(JSON.stringify(nextProvider.messages).includes("after [[skill:alpha]]"), "synchronous recovery leaves no stale draft after a deliberate clear");
    assert.ok(JSON.stringify(nextProvider.messages).includes("ALPHA BODY SENTINEL"));
    console.log("PASS real InteractiveMode rejection recovery is synchronous; Ctrl+C clear is not followed by stale-draft restoration");
  } finally {
    await stopHost(aborted);
  }
}

if (process.argv[2] === "success") {
await rm(logPath, { force: true });
const successful = await startHost({ initialMessage: "success [[skill:alpha]]", initialImages: [{ type: "image", data: imageData, mimeType: "image/png" }] });
try {
  const entries = await waitFor((items) => items.some((entry) => entry.type === "provider"), "successful InteractiveMode provider call");
  const provider = entries.find((entry) => entry.type === "provider");
  const userText = provider.messages.findLast((message) => message.role === "user").content
    .filter((part) => part.type === "text").map((part) => part.text).join("");
  assert.equal(userText, expectedSkillExpansion(packageRoot, "success [[skill:alpha]]", [
    { name: "alpha", directory: `${agentDir}/skills/alpha`, body: "ALPHA BODY SENTINEL" },
  ]));
  assert.equal((userText.match(/ALPHA BODY SENTINEL/g) ?? []).length, 1);
  assert.ok(JSON.stringify(provider.messages).includes('"type":"image"'));
  successful.terminal.type("/runtime-extension-source");
  successful.terminal.send("\r");
  const extensionInputRecords = await waitFor((items) => items.some((entry) => entry.type === "input" && entry.source === "extension"), "TUI extension-origin input");
  const extensionInput = extensionInputRecords.find((entry) => entry.type === "input" && entry.source === "extension");
  assert.equal(extensionInput.mode, "tui");
  const providerAfterExtension = await waitFor((items) => items.filter((entry) => entry.type === "provider").length > 1, "extension-origin provider response");
  const extensionProvider = providerAfterExtension.filter((entry) => entry.type === "provider").at(-1);
  const extensionUser = extensionProvider.messages.filter((message) => message.role === "user").at(-1);
  assert.ok(JSON.stringify(extensionUser.content).includes("extension [[skill:alpha]]"));
  assert.ok(!JSON.stringify(extensionUser.content).includes("ALPHA BODY SENTINEL"), "TUI extension-source input is not transformed");
  successful.terminal.type("/runtime-consume [[skill:alpha]]");
  successful.terminal.send("\r");
  const commandRecords = await waitFor((items) => items.some((entry) => entry.type === "consumed_command"), "consumed extension command");
  assert.ok(!commandRecords.some((entry) => entry.type === "input" && entry.text.startsWith("/runtime-consume")), "consumed extension command bypasses the input hook");
  const beforeQuit = commandRecords.length;
  successful.terminal.type("/quit");
  successful.terminal.send("\r");
  await new Promise((resolve) => setTimeout(resolve, 150));
  const afterQuit = (await readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(!afterQuit.slice(beforeQuit).some((entry) => entry.type === "input" && entry.text.startsWith("/quit")), "built-in quit command bypasses the input hook");
  console.log("PASS real InteractiveMode successful transformation preserves separately supplied initialImages");
  console.log("PASS real InteractiveMode consumed extension and built-in commands bypass input hooks");
} finally {
  await stopHost(successful);
}
}
