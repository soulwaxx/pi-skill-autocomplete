import { appendFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { registerRuntimeObserver } from "./runtime-observer.mjs";

const record = (entry) => appendFileSync(join(process.cwd(), "rpc-provider.jsonl"), `${JSON.stringify(entry)}\n`);
const repoRoot = join(import.meta.dirname, "..");
export default async function row5RpcProbe(pi) {
  pi.registerProvider("row5-rpc-fake", {
    name: "Row5 RPC fake",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "fake-only",
    models: [{ id: "probe", name: "Probe", api: "openai-completions", input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 8192, maxTokens: 32 }],
    streamSimple(model, context) {
      record({ type: "provider", messages: context.messages });
      const stream = createAssistantMessageEventStream();
      setTimeout(() => stream.end({ role: "assistant", content: [{ type: "text", text: "offline fake" }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, stopReason: "stop", timestamp: Date.now() }), 120);
      return stream;
    },
  });
  const packageRoot = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), "utf8")).testPackageRoot;
  if (packageRoot) {
    pi.on("input", (event, ctx) => {
      if (event.text !== "ui-fail: [[skill:missing]]") return;
      const methods = [];
      const originalNotify = ctx.ui.notify;
      const originalSetEditorText = ctx.ui.setEditorText;
      ctx.ui.notify = (message, type) => {
        if (!String(message).includes("Unknown registered skill: missing")) return originalNotify(message, type);
        methods.push("notify");
        ctx.ui.notify = originalNotify;
        throw new Error("test-only notify failure");
      };
      ctx.ui.setEditorText = (text) => {
        if (text !== event.text) return originalSetEditorText(text);
        methods.push("setEditorText");
        ctx.ui.setEditorText = originalSetEditorText;
        record({ type: "ui_failure_injected", message: event.text, methods });
        throw new Error("test-only setEditorText failure");
      };
    });
  }
  registerRuntimeObserver(pi, record);
  if (packageRoot) {
    const extensionDir = mkdtempSync(join(repoRoot, ".row5-rpc-production-extension-"));
    try {
      for (const file of ["skill-autocomplete.ts", "skill-reference-parser.ts"]) {
        writeFileSync(join(extensionDir, file), readFileSync(join(packageRoot, "extensions", file)));
      }
      const productionExtension = await import(pathToFileURL(join(extensionDir, "skill-autocomplete.ts")).href);
      productionExtension.default(pi);
    } finally {
      rmSync(extensionDir, { recursive: true, force: true });
    }
  }
  pi.on("session_start", () => {
    try { unlinkSync(join(process.env.PI_CODING_AGENT_DIR, "skills", "epsilon", "SKILL.md")); } catch {}
  });
}
