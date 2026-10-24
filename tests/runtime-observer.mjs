/** Test-only observer extension; production package is loaded independently from Pi settings. */
export function registerRuntimeObserver(pi, record) {
  pi.registerCommand("runtime-consume", {
    description: "Test-only consumed command",
    handler: async (args) => record({ type: "consumed_command", args }),
  });
  pi.registerCommand("runtime-extension-source", {
    description: "Test-only extension input source",
    handler: async () => pi.sendUserMessage("extension [[skill:alpha]]"),
  });
  pi.on("input", (event, ctx) => {
    record({ type: "input", text: event.text, source: event.source, mode: ctx.mode, imageCount: event.images?.length ?? 0 });
  });
}
