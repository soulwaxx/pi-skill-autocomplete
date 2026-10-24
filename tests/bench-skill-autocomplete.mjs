import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const extensionPath = process.argv[2];
if (!extensionPath) throw new Error("skill autocomplete extension path required");
const { default: extension } = await import(pathToFileURL(extensionPath));
const { expandSkillReferences } = await import("../extensions/skill-reference-parser.ts");
const piTui = await import("@earendil-works/pi-tui");
const signal = new AbortController().signal;
const results = [];
const originalReadFileSync = fs.readFileSync;
const readCounts = new Map();
let typingReadCalls = 0;
fs.readFileSync = function (path, ...args) {
  typingReadCalls++;
  const result = originalReadFileSync.call(this, path, ...args);
  const key = typeof path === "string" ? path : path?.toString();
  if (readCounts.has(key)) readCounts.set(key, readCounts.get(key) + 1);
  return result;
};
syncBuiltinESMExports();

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { p50Ms: +sorted[Math.floor(sorted.length * 0.5)].toFixed(4), p95Ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(4) };
}

for (const size of [10, 100, 1000]) {
  const commands = Array.from({ length: size }, (_, i) => ({
    name: `skill:skill-${String(i).padStart(4, "0")}`,
    description: `Description for representative skill ${i}`,
    source: "skill",
  }));
  let provider;
  let wrappedSearches = 0;
  const pi = { on(event, handler) { if (event === "session_start") this.start = handler; }, getCommands() { return commands; } };
  const ctx = { mode: "tui", ui: { addAutocompleteProvider(factory) { provider = factory({ triggerCharacters: [], async getSuggestions() { wrappedSearches++; return null; }, applyCompletion() { throw new Error("unexpected delegation"); } }); } } };
  extension(pi);
  await pi.start({}, ctx);
  const samples = [];
  for (let i = 0; i < 250; i++) {
    const start = performance.now();
    await provider.getSuggestions([":skill-09"], 0, 9, { signal, force: false });
    const elapsed = performance.now() - start;
    if (i >= 25) samples.push(elapsed);
  }
  results.push({ registrySize: size, typing: summarize(samples), wrappedSkillSearches: wrappedSearches, observedNodeReadFileSyncCalls: typingReadCalls });
}

const body = "x".repeat(4096);
for (const references of [1, 10, 25]) {
  const submissionCommands = Array.from({ length: references }, (_, i) => ({ name: `skill:measure-${i}`, source: "skill", sourceInfo: { path: `/benchmark/${i}/SKILL.md` } }));
  const input = submissionCommands.map(({ name }) => `[[${name}]]`).join(" ");
  const samples = [];
  let bodyReaderCalls = 0;
  for (let i = 0; i < 150; i++) {
    const start = performance.now();
    expandSkillReferences(input, submissionCommands, () => { bodyReaderCalls++; return { body, directory: "/benchmark" }; });
    const elapsed = performance.now() - start;
    if (i >= 15) samples.push(elapsed);
  }
  results.push({ uniqueSubmissionSkills: references, submission: summarize(samples), bodyBytesPerSkill: Buffer.byteLength(body), bodyReaderCallsPerRun: bodyReaderCalls / 150, note: "parser-only timing with in-memory body reader; not filesystem evidence" });
}

const submissionIoResults = [];
const fixtureRoot = fs.mkdtempSync(join(tmpdir(), "skill-autocomplete-bench-"));
function makeProductionInputCase(count, bodySize) {
  const commands = [];
  const references = [];
  for (let index = 0; index < count; index++) {
    const filePath = join(fixtureRoot, `skill-${count}-${bodySize}-${index}`, "SKILL.md");
    fs.mkdirSync(join(fixtureRoot, `skill-${count}-${bodySize}-${index}`), { recursive: true });
    const body = "x".repeat(bodySize);
    fs.writeFileSync(filePath, `---\nname: measure-${index}\ndescription: benchmark\n---\n${body}\n`);
    readCounts.set(filePath, 0);
    commands.push({ name: `skill:measure-${index}`, source: "skill", sourceInfo: { path: filePath } });
    references.push(`[[skill:measure-${index}]]`);
  }
  const handlers = [];
  const pi = { on(event, handler) { if (event === "input") handlers.push(handler); }, getCommands() { return commands; } };
  extension(pi);
  return { handler: handlers[0], commands, text: references.join(" "), paths: commands.map((command) => command.sourceInfo.path) };
}
const productionCases = [1, 10, 25].map((count) => makeProductionInputCase(count, 4096));
productionCases.push(makeProductionInputCase(1, 131072));
try {
  for (const [index, benchCase] of productionCases.entries()) {
    const ctx = { mode: "rpc", ui: { notify() {}, setEditorText() {} } };
    const samples = [];
    const iterations = 150;
    for (let run = 0; run < iterations; run++) {
      const start = performance.now();
      const result = await benchCase.handler({ text: benchCase.text, source: "rpc" }, ctx);
      const elapsed = performance.now() - start;
      if (result?.action !== "transform") throw new Error(`production input hook did not transform benchmark case ${index}`);
      const targetBodyBytesEach = index === 3 ? 131072 : 4096;
      const loadedBodyOccurrences = result.text.split("x".repeat(targetBodyBytesEach)).length - 1;
      if (loadedBodyOccurrences !== benchCase.commands.length) throw new Error(`production input hook loaded ${loadedBodyOccurrences} bodies; expected ${benchCase.commands.length}`);
      if (run >= 15) samples.push(elapsed);
    }
    submissionIoResults.push({ uniqueSkills: benchCase.commands.length, loadedBodyBytesPerSubmission: benchCase.commands.length * (index === 3 ? 131072 : 4096), loadedBodiesPerSubmission: benchCase.commands.length, targetBodyBytesEach: index === 3 ? 131072 : 4096, measuredAfterWarmup: samples.length, warmups: 15, p50Ms: +[...samples].sort((a,b)=>a-b)[67].toFixed(4), p95Ms: +[...samples].sort((a,b)=>a-b)[128].toFixed(4), exactBoundary: index === 3, readCallsPerSubmission: benchCase.paths.reduce((sum, path) => sum + readCounts.get(path), 0) / iterations, rawFileBytesPerSubmission: benchCase.paths.reduce((sum, path) => sum + fs.statSync(path).size, 0), totalInstrumentedReads: benchCase.paths.reduce((sum, path) => sum + readCounts.get(path), 0) });
  }
} finally {
  fs.readFileSync = originalReadFileSync;
  syncBuiltinESMExports();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

fs.readFileSync = originalReadFileSync;
syncBuiltinESMExports();
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, completionWarmups: 25, completionSamples: 225, parserWarmups: 15, parserSamples: 135, results, productionInputHook: submissionIoResults, fsReadInstrumentation: "node:fs readFileSync monkeypatch synchronized to ESM imports; typing totals include all calls, submission counts track disposable SKILL.md paths" }, null, 2));

// Keep dependency usage explicit: the production matcher is backed by Pi's exported utility.
if (typeof piTui.fuzzyMatch !== "function") throw new Error("Pi fuzzyMatch export unavailable");
