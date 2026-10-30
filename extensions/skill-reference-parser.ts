import { createHash } from "node:crypto";

export interface RegisteredSkill {
  name: string;
  source: string;
  sourceInfo?: { path?: string };
}

export interface ExpandedSkill {
  name: string;
  body: string;
  directory: string;
}

const DISPLAY_START = "<!-- pi-skill-autocomplete:v1 -->";
const DISPLAY_END = "<!-- /pi-skill-autocomplete:v1 -->";

function readDisplayFrame(markdown: string, start: number): { names: string[]; appendixStart: number } | undefined {
  const headerEnd = markdown.indexOf("\n", start);
  if (headerEnd < 0) return undefined;
  const header = markdown.slice(start + DISPLAY_START.length, headerEnd).trim();
  const match = header.match(/^names=([^\s]+) bytes=(0|[1-9][0-9]*) sha256=([a-f0-9]{64})$/);
  if (!match) return undefined;
  const encodedNames = match[1].split(",");
  let names: string[];
  try { names = encodedNames.map((name) => decodeURIComponent(name)); } catch { return undefined; }
  if (names.some((name, index) => !name || encodeURIComponent(name) !== encodedNames[index])) return undefined;
  const byteLength = Number(match[2]);
  if (!Number.isSafeInteger(byteLength)) return undefined;
  const payloadStart = headerEnd + 1;
  let payloadEnd = payloadStart;
  let bytes = 0;
  while (payloadEnd < markdown.length && bytes < byteLength) {
    const codePoint = markdown.codePointAt(payloadEnd);
    if (codePoint === undefined) return undefined;
    const char = String.fromCodePoint(codePoint);
    bytes += Buffer.byteLength(char, "utf8");
    payloadEnd += char.length;
  }
  if (bytes !== byteLength || payloadEnd + DISPLAY_END.length + 1 !== markdown.length || markdown.slice(payloadEnd, payloadEnd + DISPLAY_END.length + 1) !== `\n${DISPLAY_END}`) return undefined;
  const payload = markdown.slice(payloadStart, payloadEnd);
  // This detects accidental frame damage; it is not an authenticity signature.
  if (createHash("sha256").update(`${encodedNames.join(",")}\n${payload}`, "utf8").digest("hex") !== match[3]) return undefined;
  const appendixStart = start > 0 && markdown.slice(start - 2, start) === "\n\n" ? start - 2 : start;
  return { names, appendixStart };
}

/** Replace only a complete, integrity-checked generated appendix in display Markdown. */
export function compactSkillReferenceDisplay(markdown: string): string {
  let search = markdown.length;
  while (true) {
    if (search <= 0) return markdown;
    const start = markdown.lastIndexOf(DISPLAY_START, search - 1);
    if (start < 0) return markdown;
    const frame = readDisplayFrame(markdown, start);
    if (frame) {
      const summary = frame.names.map((name) => {
        const longestBacktickRun = Math.max(0, ...Array.from(name.matchAll(/`+/g), ([run]) => run.length));
        const fence = "`".repeat(longestBacktickRun + 1);
        const content = name.startsWith("`") || name.endsWith("`") ? ` ${name} ` : name;
        return `${fence}${content}${fence}`;
      }).join(", ");
      return `${markdown.slice(0, frame.appendixStart)}\n\nSkills loaded: ${summary}`;
    }
    search = start;
  }
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
  return slashes % 2 === 1;
}

/** Find explicitly authored, active [[skill:name]] references in user text. */
export function scanSkillReferences(text: string): Array<{ name: string; start: number }> {
  if (!text.includes("[[skill:")) return [];
  const inactive = new Uint8Array(text.length);
  let offset = 0;
  let fence: { character: string; length: number } | undefined;
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    const end = newline < 0 ? text.length : newline;
    const rawLine = text.slice(offset, end);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const fullEnd = newline < 0 ? end : newline + 1;
    const closing = line.match(/^ {0,3}(`+|~+)[ \t]*$/);
    if (fence) {
      inactive.fill(1, offset, fullEnd);
      if (closing && closing[1][0] === fence.character && closing[1].length >= fence.length) fence = undefined;
    } else {
      const opening = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/);
      if (opening && !(opening[1][0] === "`" && opening[2].includes("`"))) {
        fence = { character: opening[1][0], length: opening[1].length };
        inactive.fill(1, offset, fullEnd);
      }
    }
    offset = fullEnd;
  }

  const nextFenceBoundary = new Int32Array(text.length + 1);
  nextFenceBoundary.fill(-1);
  let nextBoundary = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    if (inactive[i]) nextBoundary = i;
    nextFenceBoundary[i] = nextBoundary;
  }
  for (let i = 0; i < text.length;) {
    if (inactive[i] || text[i] !== "`" || isEscaped(text, i)) { i++; continue; }
    let end = i + 1;
    while (text[end] === "`") end++;
    const delimiter = text.slice(i, end);
    let cursor = end;
    let close = -1;
    const fencedBoundary = nextFenceBoundary[cursor] ?? -1;
    while (cursor < text.length) {
      if (inactive[cursor]) break;
      const next = text.indexOf("`", cursor);
      if (next < 0) break;
      if (fencedBoundary >= 0 && fencedBoundary <= next) break;
      let nextEnd = next + 1;
      while (text[nextEnd] === "`") nextEnd++;
      if (!inactive[next] && text.slice(next, nextEnd) === delimiter) {
        close = nextEnd;
        break;
      }
      cursor = nextEnd;
    }
    if (close < 0) { i = end; continue; }
    inactive.fill(1, i, close);
    i = close;
  }

  const references: Array<{ name: string; start: number }> = [];
  const opener = /\[\[skill:/g;
  for (const match of text.matchAll(opener)) {
    const start = match.index;
    if (inactive[start] || isEscaped(text, start)) continue;
    const close = text.indexOf("]]", start + match[0].length);
    const end = close < 0 ? text.length : close + 2;
    const name = text.slice(start + match[0].length, close < 0 ? text.length : close);
    const reference = text.slice(start, end);
    if (!name || close < 0 || /[\s\[\]\\/]/.test(name)) throw new Error(`Invalid skill reference: ${reference}`);
    references.push({ name, start });
  }
  return references;
}

/** Resolve and append unique reference bodies; callers provide Pi's live registry. */
export function expandSkillReferences(
  text: string,
  commands: RegisteredSkill[],
  readSkill: (path: string) => { body: string; directory: string },
  maxBytes = 131072,
): { text: string; loaded: ExpandedSkill[] } | undefined {
  const references = scanSkillReferences(text);
  if (references.length === 0) return undefined;
  const leadingCommand = text.match(/^\/([^\s/]+)/)?.[1];
  if (leadingCommand && commands.some((command) => command.source === "prompt" && command.name === leadingCommand)) {
    throw new Error("Skill references cannot be used in native prompt-template invocations");
  }
  const skills = new Map(commands
    .filter((command) => command.source === "skill" && command.name.startsWith("skill:"))
    .map((command) => [command.name.slice("skill:".length), command]));
  const loaded: ExpandedSkill[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const { name } of references) {
    if (seen.has(name)) continue;
    seen.add(name);
    const command = skills.get(name);
    if (!command?.sourceInfo?.path) throw new Error(`Unknown registered skill: ${name}`);
    const skill = readSkill(command.sourceInfo.path);
    bytes += Buffer.byteLength(skill.body, "utf8");
    if (bytes > maxBytes) throw new Error(`Referenced skill bodies exceed ${maxBytes} UTF-8 bytes`);
    loaded.push({ name, ...skill });
  }
  const additions = loaded.map(({ name, directory, body }) =>
    `\n\n--- Skill ${name} (references relative to ${directory}) ---\n${body}`,
  ).join("");
  const loadingNotice = "The following referenced skills are already loaded. Follow these instructions directly; do not read their SKILL.md files again unless explicitly asked to reload them. You may read supporting files referenced by these skills as needed.";
  const payload = `${loadingNotice}${additions}`;
  const names = loaded.map(({ name }) => encodeURIComponent(name)).join(",");
  const digest = createHash("sha256").update(`${names}\n${payload}`, "utf8").digest("hex");
  const envelope = `${DISPLAY_START} names=${names} bytes=${Buffer.byteLength(payload, "utf8")} sha256=${digest}\n${payload}\n${DISPLAY_END}`;
  return { text: `${text}\n\n${envelope}`, loaded };
}
