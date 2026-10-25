import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { expectedSkillContextPrefix } from "./skill-context-expectations.mjs";

const extensionPath = process.argv[2] ?? new URL("../extensions/skill-autocomplete.ts", import.meta.url).pathname;
const parserPath = process.argv[3] ?? new URL("../extensions/skill-reference-parser.ts", import.meta.url).pathname;
const { default: skillAutocompleteExtension } = await import(pathToFileURL(extensionPath));
const { expandSkillReferences, scanSkillReferences } = await import(pathToFileURL(parserPath));

const contextPrefix = expectedSkillContextPrefix(dirname(dirname(parserPath)));
const names = (text) => scanSkillReferences(text).map(({ name }) => name);

test("scans active references in first-occurrence order and skips escaped references", () => {
  assert.deepEqual(names(String.raw`\\[[skill:alpha]] \[[skill:beta]] [[skill:gamma]] [[skill:alpha]]`), ["alpha", "gamma", "alpha"]);
});

test("skips matching inline spans and fenced blocks, including multiline and tilde fences", () => {
  const text = [
    "active [[skill:one]] `inline [[skill:two]]`",
    "unmatched ` opener does not hide [[skill:three]]",
    "````js",
    "[[skill:four]]",
    "````",
    "   ~~~",
    "[[skill:five]]",
    "   ~~~ ",
    "[[skill:six]]",
  ].join("\n");
  assert.deepEqual(names(text), ["one", "three", "six"]);
});

test("treats backslashes as literal inside single- and multi-backtick spans", () => {
  for (const delimiter of ["`", "``"]) {
    assert.deepEqual(names(`${delimiter}[[skill:missing]]\\${delimiter} [[skill:alpha]]`), ["alpha"]);
  }
});

test("handles CRLF fences without masking later text and keeps inline spans inside unfenced regions", () => {
  const crlf = "```js\r\n[[skill:hidden]]\r\n```\r\n[[skill:visible]]";
  assert.deepEqual(names(crlf), ["visible"]);
  const crossing = "`unmatched opener\n```\n[[skill:fenced]]\n```\n[[skill:active]]`";
  assert.deepEqual(names(crossing), ["active"]);
  const tildeCrossing = "`unmatched opener\n~~~\n[[skill:fenced]]\n~~~\n[[skill:active]]`";
  assert.deepEqual(names(tildeCrossing), ["active"], "inline search stops when it crosses a tilde fence");
  assert.deepEqual(names("\\`[[skill:one]]` [[skill:two]]"), ["one", "two"]);
  assert.deepEqual(names("\\\\`[[skill:hidden]]` [[skill:visible]]"), ["visible"], "even-escaped delimiters retain code-span behavior");
});

test("fails closed on malformed active references but not code examples", () => {
  for (const malformed of ["[[skill:]]", "[[skill:two words]]", "[[skill:a/b]]", "[[skill:bad", "[[skill:a[b]]"]) {
    assert.throws(() => names(`before ${malformed}`), /Invalid skill reference/);
  }
  assert.deepEqual(names("`[[skill:]]`"), []);
});

test("resolves only registered skills, deduplicates first-reference order, and preserves source text and full bodies", () => {
  const commands = [
    { name: "skill:alpha", source: "skill", sourceInfo: { path: "/skills/alpha/SKILL.md" } },
    { name: "skill:beta", source: "skill", sourceInfo: { path: "/skills/beta/SKILL.md" } },
    { name: "skill:explicit", source: "skill", sourceInfo: { path: "/skills/explicit/SKILL.md" } },
    { name: "skill:fake", source: "prompt", sourceInfo: { path: "/prompts/fake.md" } },
  ];
  const bodies = new Map([
    ["/skills/alpha/SKILL.md", "Alpha full body\n\nwith detail."],
    ["/skills/beta/SKILL.md", "Beta body."],
    ["/skills/explicit/SKILL.md", "Explicit-only body."],
  ]);
  const readSkill = (path) => ({ body: bodies.get(path), directory: path.slice(0, path.lastIndexOf("/")) });
  const authored = "please [[skill:beta]] and [[skill:alpha]] then [[skill:beta]] [[skill:explicit]]";
  const expanded = expandSkillReferences(authored, commands, readSkill);
  assert.ok(expanded.text.startsWith(authored));
  assert.deepEqual(expanded.loaded.map(({ name }) => name), ["beta", "alpha", "explicit"]);
  assert.equal((expanded.text.match(/Beta body\./g) ?? []).length, 1);
  assert.ok(expanded.text.includes("Alpha full body\n\nwith detail."));
  assert.ok(expanded.text.includes("references relative to /skills/explicit"));
  assert.throws(() => expandSkillReferences("[[skill:fake]]", commands, readSkill), /Unknown registered skill/);
  assert.throws(() => expandSkillReferences("[[skill:unknown]]", commands, readSkill), /Unknown registered skill/);
});

test("preserves complete skill bodies with the context expected for the tested release", () => {
  const commands = [{ name: "skill:grilling", source: "skill", sourceInfo: { path: "/skills/grilling/SKILL.md" } }];
  const authored = "Define requirements using [[skill:grilling]] [[skill:grilling]]";
  const body = "Ask one question at a time.\nSee references/interview.md and literal [[skill:missing]].";
  let reads = 0;
  const expanded = expandSkillReferences(authored, commands, () => {
    reads++;
    return { body, directory: "/skills/grilling" };
  });
  assert.equal(reads, 1);
  assert.equal(expanded.text, `${authored}${contextPrefix}\n\n--- Skill grilling (references relative to /skills/grilling) ---\n${body}`);
  assert.deepEqual(expanded.loaded, [{ name: "grilling", body, directory: "/skills/grilling" }]);
  assert.equal(expandSkillReferences("No active reference: `[[skill:grilling]]`", commands, () => {
    assert.fail("literal references must not load skills or add loading guidance");
  }), undefined);
});

test("counts unique UTF-8 body bytes after caller-provided frontmatter stripping at exact limit", () => {
  const commands = [{ name: "skill:large", source: "skill", sourceInfo: { path: "/large/SKILL.md" } }];
  const body = "é".repeat(65536);
  const readSkill = () => ({ body, directory: "/large" });
  assert.equal(Buffer.byteLength(body, "utf8"), 131072);
  assert.ok(expandSkillReferences("[[skill:large]] [[skill:large]]", commands, readSkill));
  assert.throws(() => expandSkillReferences("[[skill:large]]", commands, () => ({ body: `${body}x`, directory: "/large" })), /131072 UTF-8 bytes/);
});

test("the production input hook transforms active TUI/RPC references and leaves other sources untouched", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-reference-handler-"));
  const path = join(root, "SKILL.md");
  mkdirSync(root, { recursive: true });
  writeFileSync(path, "---\nname: alpha\ndescription: registry test\n---\nFull registered body.\n");
  const handlers = new Map();
  const pi = {
    on(event, handler) { handlers.set(event, handler); },
    getCommands() { return [{ name: "skill:alpha", source: "skill", sourceInfo: { path } }]; },
  };
  skillAutocompleteExtension(pi);
  const uiCalls = [];
  const ctx = (mode) => ({ mode, ui: {
    notify: (...args) => uiCalls.push(["notify", ...args]),
    pasteToEditor: (text) => uiCalls.push(["paste", text]),
    setEditorText: (text) => uiCalls.push(["set", text]),
  } });
  try {
    const handler = handlers.get("input");
    const event = { text: "before [[skill:alpha]] after", source: "interactive", images: [{ type: "image", data: "x", mimeType: "image/png" }] };
    const result = handler(event, ctx("tui"));
    assert.equal(result.action, "transform");
    assert.equal(result.text, `${event.text}${contextPrefix}\n\n--- Skill alpha (references relative to ${root}) ---\nFull registered body.`);
    assert.ok(result.text.includes("Full registered body."));
    const literalUnknownAndActive = handler({ ...event, text: "`[[skill:missing]]\\` [[skill:alpha]]" }, ctx("rpc"));
    assert.equal(literalUnknownAndActive.action, "transform", "unknown reference inside code is literal while the following active reference loads");
    assert.ok(literalUnknownAndActive.text.includes("Full registered body."));
    assert.equal("images" in result, false, "Pi preserves input attachments when transformed images are omitted");
    assert.deepEqual(handler({ ...event, source: "extension" }, ctx("tui")), { action: "continue" });
    assert.deepEqual(handler({ ...event, text: "nothing", source: "interactive" }, ctx("print")), { action: "continue" });
    const rejected = handler({ ...event, text: "[[skill:missing]]" }, ctx("rpc"));
    assert.deepEqual(rejected, { action: "handled" });
    const failingUi = ctx("rpc");
    failingUi.ui.notify = () => { throw new Error("notify failed"); };
    failingUi.ui.setEditorText = () => { throw new Error("restore failed"); };
    assert.deepEqual(handler({ ...event, text: "[[skill:missing]]" }, failingUi), { action: "handled" }, "UI recovery failures never escape as fail-open input");
    assert.deepEqual(uiCalls, [["notify", "Unknown registered skill: missing.", "error"], ["set", "[[skill:missing]]"]]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejection is atomic on registered-path and file-reading failures", () => {
  const commands = [{ name: "skill:one", source: "skill", sourceInfo: { path: "/one/SKILL.md" } }, { name: "skill:two", source: "skill", sourceInfo: { path: "/two/SKILL.md" } }];
  assert.throws(() => expandSkillReferences("[[skill:one]] [[skill:two]]", commands, (path) => {
    if (path.startsWith("/two")) throw new Error("unreadable");
    return { body: "would have loaded", directory: "/one" };
  }), /unreadable/);
  assert.throws(() => expandSkillReferences("/template [[skill:one]]", [{ name: "template", source: "prompt" }, ...commands], () => ({ body: "body", directory: "/one" })), /prompt-template/);
});
