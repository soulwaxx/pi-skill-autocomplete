import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expectedSkillExpansion } from "./skill-context-expectations.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const agentDir = process.env.PI_CODING_AGENT_DIR;
const settings = JSON.parse(await readFile(`${agentDir}/settings.json`, "utf8"));
const packageRoot = settings.testPackageRoot;
await mkdir(`${agentDir}/skills/alpha`, { recursive: true });
await mkdir(`${agentDir}/skills/beta`, { recursive: true });
await mkdir(`${agentDir}/skills/gamma`, { recursive: true });
await mkdir(`${agentDir}/skills/delta`, { recursive: true });
await mkdir(`${agentDir}/skills/epsilon`, { recursive: true });
await mkdir(`${agentDir}/prompts`, { recursive: true });
await writeFile(`${agentDir}/skills/alpha/SKILL.md`, "---\nname: alpha\ndescription: alpha test skill\n---\nRPC ALPHA FULL BODY SENTINEL; literal [[skill:beta]]\n");
await writeFile(`${agentDir}/skills/beta/SKILL.md`, "---\nname: beta\ndescription: beta test skill\ndisable-model-invocation: true\n---\nRPC BETA FULL BODY SENTINEL\n");
await writeFile(`${agentDir}/skills/gamma/SKILL.md`, `---\nname: gamma\ndescription: exact byte budget\n---\n${"é".repeat(65536)}\n`);
await writeFile(`${agentDir}/skills/delta/SKILL.md`, `---\nname: delta\ndescription: over byte budget\n---\n${"D".repeat(131073)}\n`);
await writeFile(`${agentDir}/skills/epsilon/SKILL.md`, "---\nname: epsilon\ndescription: unreadable file test\n---\nRPC EPSILON BODY\n");
await writeFile(`${agentDir}/prompts/drop.md`, "---\ndescription: drops args\n---\nRPC TEMPLATE OMITTED ARGS\n");
await writeFile(`${agentDir}/prompts/generated.md`, "---\ndescription: generated ref\n---\nGenerated [[skill:beta]]\n");
const extension = resolve(repoRoot, "tests/row5-rpc-extension.mjs");
const cli = resolve(repoRoot, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const proc = spawn(process.execPath, [cli, "--mode", "rpc", "--no-session", "--no-tools", "--no-mcp", "--offline", "--extension", extension, "--provider", "row5-rpc-fake", "--model", "probe"], { stdio: ["pipe", "pipe", "pipe"] });
const records = [];
let buffer = "";
let stderr = "";
proc.stdout.setEncoding("utf8").on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const index = buffer.indexOf("\n");
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line) records.push(JSON.parse(line));
  }
});
proc.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
const waitFor = async (predicate, label, afterIndex = 0) => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const found = records.slice(afterIndex).find(predicate);
    if (found) return found;
    if (proc.exitCode !== null) throw new Error(`RPC exited while waiting for ${label}: ${stderr}`);
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${label}; records=${JSON.stringify(records)} stderr=${stderr}`);
};
const send = (value) => proc.stdin.write(`${JSON.stringify(value)}\n`);
const pngChunk = (type, data) => {
  const payload = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of payload) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, payload, checksum]);
};
const imageData = (() => {
  const header = Buffer.alloc(13); header.writeUInt32BE(16, 0); header.writeUInt32BE(16, 4); header[8] = 8; header[9] = 6;
  const raw = Buffer.alloc(16 * (1 + 16 * 4));
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) raw[y * 65 + 1 + x * 4 + 3] = 255;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]).toString("base64");
})();
try {
  send({ id: "ready", type: "get_state" });
  await waitFor((record) => record.type === "response" && record.id === "ready", "RPC startup");
  const clientImages = [{ type: "image", data: imageData, mimeType: "image/png" }];
  send({ id: "blocked", type: "prompt", message: "/drop [[skill:alpha]]", images: clientImages });
  const blocked = await waitFor((record) => record.type === "response" && record.id === "blocked", "handled response");
  assert.equal(blocked.success, true);
  assert.equal(blocked.data.disposition, "handled");
  await waitFor((record) => record.type === "extension_ui_request" && record.method === "notify" && record.notifyType === "error", "error notification");
  await waitFor((record) => record.type === "extension_ui_request" && record.method === "set_editor_text" && record.text === "/drop [[skill:alpha]]", "editor restoration event");
  assert.equal(clientImages.length, 1, "RPC client retains image independently of the extension editor event");

  const successStart = records.length;
  send({ id: "success", type: "prompt", message: "resubmit [[skill:beta]] then [[skill:alpha]] and [[skill:beta]]", images: clientImages });
  const success = await waitFor((record) => record.type === "response" && record.id === "success", "success response", successStart);
  assert.equal(success.success, true);
  assert.equal(success.data.disposition, "started");
  await waitFor((record) => record.type === "agent_settled", "success settlement", successStart);

  const templateStart = records.length;
  send({ id: "generated", type: "prompt", message: "/generated" });
  const generated = await waitFor((record) => record.type === "response" && record.id === "generated", "template-only response", templateStart);
  assert.equal(generated.data.disposition, "started");
  await waitFor((record) => record.type === "agent_settled", "template-only settlement", templateStart);

  for (const [id, message] of [["escaped-template", "/drop \\[[skill:alpha]]"], ["code-template", "/drop `[[skill:alpha]]`"]]) {
    const start = records.length;
    const errorsBefore = records.filter((record) => record.type === "extension_ui_request" && record.method === "notify" && record.notifyType === "error").length;
    send({ id, type: "prompt", message });
    const response = await waitFor((record) => record.type === "response" && record.id === id, `${id} response`, start);
    assert.equal(response.data.disposition, "started", "literal-only template text is not rejected");
    await waitFor((record) => record.type === "agent_settled", `${id} settlement`, start);
    assert.equal(records.filter((record) => record.type === "extension_ui_request" && record.method === "notify" && record.notifyType === "error").length, errorsBefore);
  }

  const skillCompositionStart = records.length;
  send({ id: "native-skill", type: "prompt", message: "/skill:alpha native argument [[skill:beta]]" });
  const skillComposition = await waitFor((record) => record.type === "response" && record.id === "native-skill", "native skill composition response", skillCompositionStart);
  assert.equal(skillComposition.data.disposition, "started");
  await waitFor((record) => record.type === "agent_settled", "native skill composition settlement", skillCompositionStart);

  const bodyLiteralStart = records.length;
  send({ id: "body-literal", type: "prompt", message: "[[skill:alpha]]" });
  await waitFor((record) => record.type === "response" && record.id === "body-literal", "literal skill body response", bodyLiteralStart);
  await waitFor((record) => record.type === "agent_settled", "literal skill body settlement", bodyLiteralStart);

  const inlineCodeStart = records.length;
  const inlineCodeMessage = "`[[skill:missing]]\\` [[skill:alpha]]";
  send({ id: "inline-code-literal", type: "prompt", message: inlineCodeMessage });
  const inlineCode = await waitFor((record) => record.type === "response" && record.id === "inline-code-literal", "inline-code literal response", inlineCodeStart);
  assert.equal(inlineCode.data.disposition, "started", "unknown references inside code spans remain literal");
  await waitFor((record) => record.type === "agent_settled", "inline-code literal settlement", inlineCodeStart);

  const exactBudgetStart = records.length;
  send({ id: "exact-budget", type: "prompt", message: "[[skill:gamma]] [[skill:gamma]]" });
  const exactBudget = await waitFor((record) => record.type === "response" && record.id === "exact-budget", "exact byte budget response", exactBudgetStart);
  assert.equal(exactBudget.data.disposition, "started", "a unique 131072-byte UTF-8 body is accepted once despite repeated references");
  await waitFor((record) => record.type === "agent_settled", "exact byte budget settlement", exactBudgetStart);

  for (const [id, message] of [["oversized", "[[skill:beta]] [[skill:delta]]"], ["unreadable", "[[skill:epsilon]]"]]) {
    const start = records.length;
    send({ id, type: "prompt", message });
    const response = await waitFor((record) => record.type === "response" && record.id === id, `${id} response`, start);
    assert.equal(response.data.disposition, "handled");
    await waitFor((record) => record.type === "extension_ui_request" && record.method === "set_editor_text" && record.text === message, `${id} editor restoration`, start);
  }
  const uiFailureStart = records.length;
  send({ id: "ui-failure", type: "prompt", message: "ui-fail: [[skill:missing]]" });
  const uiFailure = await waitFor((record) => record.type === "response" && record.id === "ui-failure", "UI failure handled response", uiFailureStart);
  assert.equal(uiFailure.data.disposition, "handled", "notification and restore errors fail closed instead of falling through");

  const malformedStart = records.length;
  send({ id: "malformed", type: "prompt", message: "bad [[skill:two words]]" });
  const malformed = await waitFor((record) => record.type === "response" && record.id === "malformed", "malformed reference response", malformedStart);
  assert.equal(malformed.data.disposition, "handled");
  await waitFor((record) => record.type === "extension_ui_request" && record.method === "notify" && record.notifyType === "error", "restored error notification", malformedStart);
  await waitFor((record) => record.type === "extension_ui_request" && record.method === "set_editor_text" && record.text === "bad [[skill:two words]]", "malformed reference editor restoration", malformedStart);

  const literalStart = records.length;
  send({ id: "literal", type: "prompt", message: "escaped \\[[skill:alpha]], inline `[[skill:beta]]`, fenced:\n```\n[[skill:alpha]]\n```" });
  const literal = await waitFor((record) => record.type === "response" && record.id === "literal", "literal response", literalStart);
  assert.equal(literal.data.disposition, "started");
  await waitFor((record) => record.type === "agent_settled", "literal settlement", literalStart);

  const queueStart = records.length;
  send({ id: "starter", type: "prompt", message: "queue starter" });
  const starter = await waitFor((record) => record.type === "response" && record.id === "starter", "queue starter response", queueStart);
  assert.equal(starter.data.disposition, "started");
  send({ id: "steer", type: "prompt", message: "queued [[skill:alpha]]", streamingBehavior: "steer" });
  const steered = await waitFor((record) => record.type === "response" && record.id === "steer", "steer response", queueStart);
  assert.equal(steered.data.disposition, "queued");
  send({ id: "follow", type: "follow_up", message: "followup [[skill:beta]]" });
  const followed = await waitFor((record) => record.type === "response" && record.id === "follow", "follow-up response", queueStart);
  assert.equal(followed.data.disposition, "queued");
  await waitFor((record) => record.type === "agent_settled", "queued work settlement", queueStart);

  const rejectedQueueStart = records.length;
  send({ id: "reject-starter", type: "prompt", message: "rejection queue starter" });
  await waitFor((record) => record.type === "response" && record.id === "reject-starter", "rejection queue starter response", rejectedQueueStart);
  send({ id: "reject-queued", type: "prompt", message: "queued [[skill:missing]]", streamingBehavior: "steer" });
  const rejectedQueued = await waitFor((record) => record.type === "response" && record.id === "reject-queued", "rejected queued prompt response", rejectedQueueStart);
  assert.equal(rejectedQueued.data.disposition, "handled", "input hooks reject before a steering item enters the queue");
  await waitFor((record) => record.type === "extension_ui_request" && record.method === "set_editor_text" && record.text === "queued [[skill:missing]]", "rejected queued editor restoration", rejectedQueueStart);

  const providerLog = (await readFile("rpc-provider.jsonl", "utf8")).trim().split("\n").map(JSON.parse);
  const providerCalls = providerLog.filter((entry) => entry.type === "provider");
  const uiFailures = providerLog.find((entry) => entry.type === "ui_failure_injected" && entry.message === "ui-fail: [[skill:missing]]");
  assert.deepEqual(uiFailures?.methods.sort(), ["notify", "setEditorText"], "both real RPC UI methods threw in the input handler");
  const textOf = (message) => message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
  assert.ok(providerCalls.length >= 5, `success/template/queue cases reached the fake provider: ${providerCalls.length}`);
  assert.ok(!providerCalls.some((entry) => JSON.stringify(entry.messages).includes("/drop [[skill:alpha]]")), "handled template rejection did not call provider");
  assert.ok(!providerCalls.some((entry) => JSON.stringify(entry.messages).includes("queued [[skill:missing]]")), "queued rejected input did not reach provider");
  const user = providerCalls[0].messages.findLast((message) => message.role === "user");
  const userText = textOf(user);
  const expectedAuthored = "resubmit [[skill:beta]] then [[skill:alpha]] and [[skill:beta]]";
  const expectedExpanded = expectedSkillExpansion(packageRoot, expectedAuthored, [
    { name: "beta", directory: `${agentDir}/skills/beta`, body: "RPC BETA FULL BODY SENTINEL" },
    { name: "alpha", directory: `${agentDir}/skills/alpha`, body: "RPC ALPHA FULL BODY SENTINEL; literal [[skill:beta]]" },
  ]);
  assert.equal(userText, expectedExpanded, "provider receives exact full plaintext expansion and expected legacy/current framing");
  assert.ok(JSON.stringify(user.content).includes("RPC ALPHA FULL BODY SENTINEL"));
  assert.ok(JSON.stringify(user.content).includes("RPC BETA FULL BODY SENTINEL"));
  assert.ok(user.content.some((part) => part.type === "image"), "resubmitted RPC attachment reaches provider after transformation");
  const templateOnly = providerCalls[1].messages.findLast((message) => message.role === "user");
  assert.ok(JSON.stringify(templateOnly.content).includes("Generated [[skill:beta]]"));
  assert.ok(!JSON.stringify(templateOnly.content).includes("RPC BETA FULL BODY SENTINEL"), "template-generated reference is not activated");
  const literalProvider = providerCalls.find((entry) => JSON.stringify(entry.messages).includes("escaped \\\\[[skill:alpha]]"));
  const literalUser = literalProvider?.messages.findLast((message) => message.role === "user");
  assert.ok(!JSON.stringify(literalUser.content).includes("RPC ALPHA FULL BODY SENTINEL"));
  assert.ok(!JSON.stringify(literalUser.content).includes("RPC BETA FULL BODY SENTINEL"));
  const userMessages = (provider) => provider.messages.filter((message) => message.role === "user").map(textOf);
  const queuedSteer = expectedSkillExpansion(packageRoot, "queued [[skill:alpha]]", [
    { name: "alpha", directory: `${agentDir}/skills/alpha`, body: "RPC ALPHA FULL BODY SENTINEL; literal [[skill:beta]]" },
  ]);
  const queuedFollowUp = expectedSkillExpansion(packageRoot, "followup [[skill:beta]]", [
    { name: "beta", directory: `${agentDir}/skills/beta`, body: "RPC BETA FULL BODY SENTINEL" },
  ]);
  assert.ok(providerCalls.some((provider) => userMessages(provider).includes(queuedSteer)), "the exact queued authored message is expanded with its own alpha body in that same user message");
  assert.ok(providerCalls.some((provider) => userMessages(provider).includes(queuedFollowUp)), "the exact queued follow-up is expanded with its own beta body in that same user message");

  const serialized = (needle) => providerCalls.find((entry) => JSON.stringify(entry.messages).includes(needle));
  assert.ok(JSON.stringify(user.content).includes(`references relative to ${agentDir}/skills/alpha`), "reference context comes from registered sourceInfo.path");
  const nativeSkill = serialized("native argument");
  assert.ok(nativeSkill, "native skill plus authored references reaches provider");
  const nativeUserText = textOf(nativeSkill.messages.findLast((message) => message.role === "user"));
  const nativeSkillCard = `<skill name="alpha" location="${agentDir}/skills/alpha/SKILL.md">\nReferences are relative to ${agentDir}/skills/alpha.\n\nRPC ALPHA FULL BODY SENTINEL; literal [[skill:beta]]\n</skill>`;
  const expectedNativeUserText = `${nativeSkillCard}\n\n${expectedSkillExpansion(packageRoot, "native argument [[skill:beta]]", [
    { name: "beta", directory: `${agentDir}/skills/beta`, body: "RPC BETA FULL BODY SENTINEL" },
  ])}`;
  assert.equal(nativeUserText, expectedNativeUserText, "native skill card remains intact before the exact inline expansion framing");
  const bodyLiteralProvider = providerCalls.find((entry) => { const text = textOf(entry.messages.findLast((message) => message.role === "user")); return text.includes("RPC ALPHA FULL BODY SENTINEL") && text.includes("literal [[skill:beta]]") && !text.includes("RPC BETA FULL BODY SENTINEL"); });
  assert.ok(bodyLiteralProvider, JSON.stringify(providerCalls.map((entry) => { const text = textOf(entry.messages.findLast((message) => message.role === "user")); return { start: text.slice(0, 100), alpha: text.includes("RPC ALPHA FULL BODY SENTINEL"), beta: text.includes("RPC BETA FULL BODY SENTINEL"), literal: text.includes("literal [[skill:beta]]") }; })));
  const bodyLiteralUser = bodyLiteralProvider.messages.filter((message) => message.role === "user").at(-1);
  assert.ok(JSON.stringify(bodyLiteralUser.content).includes("literal [[skill:beta]]"));
  assert.ok(!JSON.stringify(bodyLiteralUser.content).includes("RPC BETA FULL BODY SENTINEL"), "references in loaded bodies are not recursively activated");
  const inlineCodeProvider = providerCalls.find((entry) => textOf(entry.messages.findLast((message) => message.role === "user")).includes(inlineCodeMessage));
  assert.ok(inlineCodeProvider, "inline-code sample reaches the fake provider without rejection");
  assert.ok(textOf(inlineCodeProvider.messages.findLast((message) => message.role === "user")).includes("RPC ALPHA FULL BODY SENTINEL"), "active reference after the code span loads its body");
  const exactBody = providerCalls.find((entry) => textOf(entry.messages.findLast((message) => message.role === "user")).includes("é".repeat(32)));
  assert.ok(exactBody, "exact 131072-byte UTF-8 body reaches the provider");
  assert.equal(textOf(exactBody.messages.findLast((message) => message.role === "user")), expectedSkillExpansion(packageRoot, "[[skill:gamma]] [[skill:gamma]]", [{ name: "gamma", directory: `${agentDir}/skills/gamma`, body: "é".repeat(65536) }]), "exact UTF-8 boundary expansion reaches the provider in current and legacy forms");
  assert.ok(!providerCalls.some((entry) => JSON.stringify(entry.messages).includes("ui-fail:")));
  assert.ok(Buffer.byteLength("é".repeat(65536), "utf8") === 131072, "full fixture body is at the configured byte boundary");
  assert.ok(!providerCalls.some((entry) => JSON.stringify(entry.messages).includes("[[skill:beta]] [[skill:delta]]")), "oversize multi-reference request does not reach provider with partial body content");
  assert.ok(literalUser);
  assert.ok(!JSON.stringify(literalUser.content).includes("RPC ALPHA FULL BODY SENTINEL"), "escaped/code literals do not trigger expansion");
  console.log("PASS actual Pi RPC registry/body composition, literals, byte limit, file failure, queues, and recovery");
} finally {
  proc.stdin.end();
  await Promise.race([new Promise((resolve) => proc.once("exit", resolve)), delay(3000)]);
  if (proc.exitCode === null) proc.kill("SIGKILL");
}
