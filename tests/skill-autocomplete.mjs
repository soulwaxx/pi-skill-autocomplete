import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

const extensionPath = process.argv[2];
if (!extensionPath) throw new Error("skill autocomplete extension path required");

const { default: skillAutocompleteExtension } = await import(
  pathToFileURL(extensionPath),
);
const controller = new AbortController();

const systemPrompt = `
<available_skills>
  <skill>
    <name>code-review</name>
    <description>Review code changes</description>
  </skill>
</available_skills>`;

async function createProvider() {
  const skillItems = [
    {
      value: "skill:code-review",
      label: "skill:code-review",
      description: "Review code changes",
    },
    {
      value: "skill:grilling",
      label: "skill:grilling",
      description: "Interrogate a plan",
    },
  ];
  const delegated = {
    items: [{ value: "delegated", label: "delegated" }],
    prefix: "",
  };
  const current = {
    triggerCharacters: ["@"],
    async getSuggestions(lines) {
      if (lines[0] === "/skill:") {
        return { items: skillItems, prefix: "/skill:" };
      }
      return delegated;
    },
    applyCompletion() {
      return { lines: ["delegated"], cursorLine: 0, cursorCol: 9 };
    },
    shouldTriggerFileCompletion() {
      return true;
    },
  };
  const handlers = new Map();
  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
  };
  let wrapper;
  const ctx = {
    mode: "tui",
    getSystemPrompt: () => systemPrompt,
    ui: {
      addAutocompleteProvider(factory) {
        wrapper = factory;
      },
    },
  };

  skillAutocompleteExtension(pi);
  await handlers.get("session_start")({}, ctx);
  assert.ok(wrapper);
  return { provider: wrapper(current), delegated };
}

const options = { signal: controller.signal };

test("lists model-hidden skills from pi's built-in skill registry", async () => {
  const { provider } = await createProvider();
  const suggestions = await provider.getSuggestions(["ciao :"], 0, 6, options);

  assert.deepEqual(
    suggestions.items.map((item) => item.value),
    ["code-review", "grilling"],
  );
  assert.equal(suggestions.prefix, "");
});

test("filters the complete skill registry", async () => {
  const { provider } = await createProvider();
  const suggestions = await provider.getSuggestions(
    ["ciao :grill"],
    0,
    11,
    options,
  );

  assert.deepEqual(suggestions.items.map((item) => item.value), ["grilling"]);
});

test("uses a directive for model-visible skills", async () => {
  const { provider } = await createProvider();
  const suggestions = await provider.getSuggestions(
    ["ciao :code"],
    0,
    10,
    options,
  );
  const result = provider.applyCompletion(
    ["ciao :code"],
    0,
    10,
    suggestions.items[0],
    suggestions.prefix,
  );

  assert.deepEqual(result.lines, ["ciao use the `code-review` skill"]);
  assert.equal(result.cursorCol, result.lines[0].length);
});

test("uses an explicit leading invocation for model-hidden skills", async () => {
  const { provider } = await createProvider();
  const suggestions = await provider.getSuggestions(
    ["ciao :grill"],
    0,
    11,
    options,
  );
  const result = provider.applyCompletion(
    ["ciao :grill"],
    0,
    11,
    suggestions.items[0],
    suggestions.prefix,
  );

  assert.deepEqual(result.lines, ["/skill:grilling ciao "]);
  assert.equal(result.cursorCol, result.lines[0].length);
});

test("delegates unrelated completion", async () => {
  const { provider, delegated } = await createProvider();
  assert.equal(
    await provider.getSuggestions(["@file"], 0, 5, options),
    delegated,
  );
  assert.deepEqual(
    provider.applyCompletion(
      ["@file"],
      0,
      5,
      { value: "file", label: "file" },
      "@file",
    ),
    { lines: ["delegated"], cursorLine: 0, cursorCol: 9 },
  );
});
