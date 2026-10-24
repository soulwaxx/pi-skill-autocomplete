import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

const extensionPath = process.argv[2];
if (!extensionPath) throw new Error("skill autocomplete extension path required");
const { default: skillAutocompleteExtension } = await import(pathToFileURL(extensionPath));
const controller = new AbortController();

async function createProvider(skills) {
  const delegated = { items: [{ value: "delegated", label: "delegated" }], prefix: "" };
  let wrappedSearches = 0;
  let wrapper;
  let providerInstallations = 0;
  const current = {
    triggerCharacters: ["@"],
    async getSuggestions() { wrappedSearches++; return delegated; },
    applyCompletion() { return { lines: ["delegated"], cursorLine: 0, cursorCol: 9 }; },
    shouldTriggerFileCompletion() { return true; },
  };
  const handlers = new Map();
  const pi = {
    on(event, handler) { handlers.set(event, handler); },
    getCommands() { return (typeof skills === "function" ? skills() : skills).map(({ name, description = "", source = "skill" }) => ({ name: `skill:${name}`, description, source })); },
  };
  const ctx = {
    mode: "tui",
    ui: { addAutocompleteProvider(factory) { providerInstallations++; wrapper = factory; } },
  };
  skillAutocompleteExtension(pi);
  await handlers.get("session_start")({}, ctx);
  return { provider: wrapper(current), delegated, handlers, ctx, current, get providerInstallations() { return providerInstallations; }, get wrappedSearches() { return wrappedSearches; } };
}

const query = async (provider, text, col = text.length, options = {}) =>
  provider.getSuggestions([text], 0, col, { signal: options.signal ?? controller.signal, force: options.force ?? false });

test("uses live public skill registry including explicit-only skills, without wrapped searches", async () => {
  const { provider, wrappedSearches } = await createProvider([
    { name: "code-review", description: "Review code" },
    { name: "hidden", source: "skill" },
    { name: "not-a-skill", source: "prompt" },
  ]);
  assert.deepEqual((await query(provider, ":")).items.map((item) => item.value), ["code-review", "hidden"]);
  assert.equal(wrappedSearches, 0);
});

test("ranks exact, prefix, substring, fuzzy name, then description with alphabetical ties", async () => {
  const { provider } = await createProvider([
    { name: "zeta", description: "needle" },
    { name: "needle-exact", description: "" },
    { name: "xneedle", description: "" },
    { name: "needle", description: "" },
    { name: "a-n-e-e-d-l-e", description: "" },
    { name: "needle-alpha", description: "" },
    { name: "desc-b", description: "needle" },
    { name: "desc-a", description: "needle" },
  ]);
  assert.deepEqual((await query(provider, ":Needle")).items.map(({ value }) => value), [
    "needle", "needle-alpha", "needle-exact", "xneedle", "a-n-e-e-d-l-e", "desc-a", "desc-b", "zeta",
  ]);
});

test("matches full descriptions while displaying a truncated description", async () => {
  const long = `short ${"x".repeat(90)} secretword`;
  const { provider } = await createProvider([{ name: "item", description: long }]);
  const item = (await query(provider, ":secretword")).items[0];
  assert.equal(item.value, "item");
  assert.ok(item.description.length <= 60);
  assert.ok(!item.description.includes("secretword"));
});

test("inserts explicit references and preserves suffix and other lines", async () => {
  const { provider } = await createProvider([{ name: "code-review" }]);
  const suggestions = await provider.getSuggestions(["before :code-review after", "suffix"], 0, 19, { signal: controller.signal, force: false });
  const result = provider.applyCompletion(["before :code-review after", "suffix"], 0, 19, suggestions.items[0], suggestions.prefix);
  assert.deepEqual(result.lines, ["before [[skill:code-review]] after", "suffix"]);
});

test("delegates non-skill autocomplete and file completion unchanged", async () => {
  const result = await createProvider([{ name: "x" }]);
  const { provider, delegated } = result;
  assert.equal(await query(provider, "@file"), delegated);
  assert.deepEqual(provider.applyCompletion(["@file"], 0, 5, { value: "file", label: "file" }, "@file"), { lines: ["delegated"], cursorLine: 0, cursorCol: 9 });
  assert.equal(provider.shouldTriggerFileCompletion(["@file"], 0, 5), true);
  assert.equal(result.wrappedSearches, 1);
});

test("excludes URL, time, and key:value colons", async () => {
  const { provider, delegated } = await createProvider([{ name: "anything" }]);
  for (const text of ["http://host:x", "12:30", "key:value"]) assert.equal(await query(provider, text), delegated);
});

test("aborted requests and aborted returned items delegate", async () => {
  const { provider, delegated } = await createProvider([{ name: "anything" }]);
  const beforeAbort = new AbortController(); beforeAbort.abort();
  assert.equal(await query(provider, ":", 1, { signal: beforeAbort.signal }), delegated);
  const afterResults = new AbortController();
  const suggestions = await query(provider, ":anything", 9, { signal: afterResults.signal });
  afterResults.abort();
  assert.equal(provider.applyCompletion([":anything"], 0, 9, suggestions.items[0], "anything").lines[0], "delegated");
});

test("completion ownership uses item identity; stale and foreign same-name items delegate", async () => {
  const { provider } = await createProvider([{ name: "same" }]);
  const suggestions = await query(provider, ":same");
  const ownedItem = suggestions.items[0];
  assert.equal(provider.applyCompletion([":same"], 0, 5, { ...ownedItem }, "same").lines[0], "delegated");
  assert.equal(provider.applyCompletion([":same"], 0, 5, ownedItem, "same").lines[0], "[[skill:same]]");
  assert.equal(provider.applyCompletion([":other"], 0, 6, ownedItem, "same").lines[0], "delegated");
  assert.equal(provider.applyCompletion([":same!"], 0, 5, ownedItem, "same").lines[0], "delegated");
  await query(provider, "@anything");
  assert.equal(provider.applyCompletion([":same"], 0, 5, ownedItem, "same").lines[0], "delegated");
});

test("delegates slash completion and supports forced empty and bare-colon results", async () => {
  const { provider, delegated } = await createProvider([{ name: "beta" }, { name: "alpha" }]);
  assert.equal(await query(provider, "/command"), delegated);
  assert.deepEqual((await query(provider, ":")).items.map(({ value }) => value), ["alpha", "beta"]);
  assert.deepEqual((await query(provider, ":absent", 8, { force: true })).items, []);
});

test("session lifecycle installs once per runtime and permits installation after shutdown", async () => {
  const fixture = await createProvider([{ name: "alpha" }]);
  await fixture.handlers.get("session_start")({}, fixture.ctx);
  assert.equal(fixture.providerInstallations, 1);
  await fixture.handlers.get("session_shutdown")();
  await fixture.handlers.get("session_start")({}, fixture.ctx);
  assert.equal(fixture.providerInstallations, 2);
});

test("registry is queried afresh on every completion request", async () => {
  let skills = [{ name: "before" }];
  const { provider } = await createProvider(() => skills);
  assert.deepEqual((await query(provider, ":")).items.map((item) => item.value), ["before"]);
  skills = [{ name: "after" }];
  assert.deepEqual((await query(provider, ":")).items.map((item) => item.value), ["after"]);
});
