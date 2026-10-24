import { appendFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { registerRuntimeObserver } from "./runtime-observer.mjs";

const record = (entry) => appendFileSync(join(process.cwd(), "rpc-provider.jsonl"), `${JSON.stringify(entry)}\n`);
export default function row5RpcProbe(pi) {
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
  registerRuntimeObserver(pi, record);
  pi.on("session_start", () => {
    try { unlinkSync(join(process.env.PI_CODING_AGENT_DIR, "skills", "epsilon", "SKILL.md")); } catch {}
  });
}
