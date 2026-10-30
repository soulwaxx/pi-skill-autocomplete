import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Markdown as PiMarkdown } from "../node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-T726RZZU.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { expectedSkillExpansion, isInitialRelease } from "./skill-context-expectations.mjs";

const extensionPath = process.argv[2] ?? new URL("../extensions/skill-autocomplete.ts", import.meta.url).pathname;
const parserPath = process.argv[3] ?? new URL("../extensions/skill-reference-parser.ts", import.meta.url).pathname;
const { default: skillAutocompleteExtension } = await import(pathToFileURL(extensionPath));
const { compactSkillReferenceDisplay, expandSkillReferences, scanSkillReferences } = await import(pathToFileURL(parserPath));

const packageRoot = dirname(dirname(parserPath));
const initialRelease = isInitialRelease(packageRoot);
const names = (text) => scanSkillReferences(text).map(({ name }) => name);

test("returns immediately when no skill reference opener is present", () => {
  assert.deepEqual(scanSkillReferences("ordinary prose without references"), []);
});

test("scans active references in first-occurrence order and skips escaped references", () => {
  assert.deepEqual(names(String.raw`\\[[skill:alpha]] \[[skill:beta]] [[skill:gamma]] [[skill:alpha]]`), ["alpha", "gamma", "alpha"]);
});

test("scans long runs of unrelated inline delimiters without losing active references", () => {
  for (const count of [1000, 4000, 16000]) {
    const noClose = `prose \`${"`` x ".repeat(count)} [[skill:alpha]]`;
    assert.deepEqual(names(noClose), ["alpha"], `unclosed delimiter run of ${count}`);

    const validClose = `\`\`${"x ` ".repeat(count)}\`\``;
    assert.deepEqual(names(validClose), [], `closed delimiter run of ${count}`);
    assert.deepEqual(names(`${validClose} [[skill:beta]]`), ["beta"], `active reference after ${count} delimiters`);
  }
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
  assert.equal(expanded.text, expectedSkillExpansion(packageRoot, authored, [{ name: "grilling", body, directory: "/skills/grilling" }]));
  assert.deepEqual(expanded.loaded, [{ name: "grilling", body, directory: "/skills/grilling" }]);
  assert.equal(expandSkillReferences("No active reference: `[[skill:grilling]]`", commands, () => {
    assert.fail("literal references must not load skills or add loading guidance");
  }), undefined);
});

test("malformed display markers at column zero return unchanged without looping", () => {
  if (initialRelease) return;
  for (const malformed of [
    "<!-- pi-skill-autocomplete:v1 -->",
    "<!-- pi-skill-autocomplete:v1 --> names=alpha",
    ["<!-- pi-skill-autocomplete:v1 --> not-a-header", "payload", "<!-- /pi-skill-autocomplete:v1 -->"].join("\\n"),
  ]) assert.equal(compactSkillReferenceDisplay(malformed), malformed);
});

test("compacts only the outer terminal frame despite body marker and header-looking literals", () => {
  if (initialRelease) return;
  const body = [
    "before marker <!-- pi-skill-autocomplete:v1 -->",
    `<!-- pi-skill-autocomplete:v1 --> names=forged bytes=0 sha256=${"0".repeat(64)}`,
    "literal <!-- /pi-skill-autocomplete:v1 --> after start marker",
  ].join("\n");
  const framed = expandSkillReferences("authored [[skill:outer]]", [{ name: "skill:outer", source: "skill", sourceInfo: { path: "/outer/SKILL.md" } }], () => ({ body, directory: "/outer" }));
  assert.equal(compactSkillReferenceDisplay(framed.text), "authored [[skill:outer]]\n\nSkills loaded: `outer`");
  assert.ok(framed.text.includes(body), "both marker-like strings remain intact in provider-visible body text");
});

test("covers encoded names with the frame digest and summarizes resolver-supported names safely", () => {
  if (initialRelease) return;
  const ordinaryNames = ["obsidian-second-brain.wiki-vault", "wiki_name+tag", "wiki-ノート", "namespace:tool"];
  const commands = ordinaryNames.map((name) => ({ name: `skill:${name}`, source: "skill", sourceInfo: { path: `/${name}/SKILL.md` } }));
  const expanded = expandSkillReferences(ordinaryNames.map((name) => `[[skill:${name}]]`).join(" "), commands, (path) => ({ body: `body ${path}`, directory: path.slice(0, path.lastIndexOf("/")) }));
  assert.deepEqual(expanded.loaded.map(({ name }) => name), ordinaryNames);
  const ordinaryDisplay = compactSkillReferenceDisplay(expanded.text).split("\n\nSkills loaded: ")[1];
  const renderPiMarkdown = (text) => new PiMarkdown(text, 0, 0, { code: (content) => `<code>${content}</code>` }).render(160)[0].trim();
  assert.equal(renderPiMarkdown(`Skills loaded: ${ordinaryDisplay}`), "Skills loaded: <code>obsidian-second-brain.wiki-vault</code>, <code>wiki_name+tag</code>, <code>wiki-ノート</code>, <code>namespace:tool</code>");

  const backtickNames = ["`alpha", "alpha`", "`both`", "wiki`quoted"];
  const encoded = backtickNames.map(encodeURIComponent).join(",");
  const payload = "The referenced skills are loaded.";
  const digest = createHash("sha256").update(`${encoded}\n${payload}`, "utf8").digest("hex");
  const framed = `<!-- pi-skill-autocomplete:v1 --> names=${encoded} bytes=${Buffer.byteLength(payload)} sha256=${digest}\n${payload}\n<!-- /pi-skill-autocomplete:v1 -->`;
  const rendered = renderPiMarkdown(compactSkillReferenceDisplay(framed).trimStart());
  assert.equal(rendered, "Skills loaded: <code>`alpha</code>, <code>alpha`</code>, <code>`both`</code>, <code>wiki`quoted</code>");

  const header = expanded.text.match(/<!-- pi-skill-autocomplete:v1 --> names=([^ ]+)/)?.[1];
  assert.ok(header);
  for (const corrupted of ["changed-name", header.split(",").reverse().join(","), `${header},${header.split(",")[0]}`]) {
    const damaged = expanded.text.replace(`names=${header}`, `names=${corrupted}`);
    assert.equal(compactSkillReferenceDisplay(damaged), damaged, `names mutation ${corrupted} must invalidate the frame`);
  }
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
    registerMarkdownTransformer(handler) { this.markdownTransformer = handler; },
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
    assert.equal(result.text, expectedSkillExpansion(packageRoot, event.text, [{ name: "alpha", body: "Full registered body.", directory: root }]));
    if (!initialRelease) {
      assert.equal(pi.markdownTransformer(result.text, { messageType: "user" }), `${event.text}\n\nSkills loaded: \`alpha\``);
      assert.equal(pi.markdownTransformer(result.text, { messageType: "assistant" }), result.text);
    } else {
      assert.equal(pi.markdownTransformer, undefined, "initial retained package has no transformer API use");
    }
    assert.ok(result.text.includes("Full registered body."));
    const literalUnknownAndActive = handler({ ...event, text: "`[[skill:missing]]\\` [[skill:alpha]]" }, ctx("rpc"));
    assert.equal(literalUnknownAndActive.action, "transform", "unknown reference inside code is literal while the following active reference loads");
    assert.ok(literalUnknownAndActive.text.includes("Full registered body."));
    if (!initialRelease) assert.equal(pi.markdownTransformer(literalUnknownAndActive.text, { messageType: "user" }), "`[[skill:missing]]\\` [[skill:alpha]]\n\nSkills loaded: `alpha`");
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
    if (!initialRelease) {
      const authoredNearMatch = "literal <!-- pi-skill-autocomplete:v1 --> names=alpha";
      assert.equal(pi.markdownTransformer(authoredNearMatch, { messageType: "user" }), authoredNearMatch);
      const invalid = `${result.text}x`;
      assert.equal(compactSkillReferenceDisplay(invalid), invalid, "invalid trailing structure passes through unchanged");
      const bodyMarker = `full body <!-- pi-skill-autocomplete:v1 --> names=forged bytes=0 sha256=${"0".repeat(64)}\n<!-- /pi-skill-autocomplete:v1 --> stays visible`;
      const framedMarker = expandSkillReferences("[[skill:alpha]]", [{ name: "skill:alpha", source: "skill", sourceInfo: { path } }], () => ({ body: bodyMarker, directory: root }));
      assert.equal(compactSkillReferenceDisplay(framedMarker.text), "[[skill:alpha]]\n\nSkills loaded: `alpha`");
      const nativePlusInline = framedMarker.text.replace("[[skill:alpha]]", "/skill:native argument");
      assert.equal(compactSkillReferenceDisplay(nativePlusInline), "/skill:native argument\n\nSkills loaded: `alpha`", "appendix validates independently of a native skill prefix");
      assert.equal(compactSkillReferenceDisplay(JSON.parse(JSON.stringify({ content: framedMarker.text })).content), "[[skill:alpha]]\n\nSkills loaded: `alpha`", "self-contained framing compacts after serialization/restoration");
    }
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
