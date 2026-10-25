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

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
  return slashes % 2 === 1;
}

/** Find explicitly authored, active [[skill:name]] references in user text. */
export function scanSkillReferences(text: string): Array<{ name: string; start: number }> {
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

  // Inline code can span prose lines but not cross a fenced-code boundary.
  for (let i = 0; i < text.length;) {
    if (inactive[i] || text[i] !== "`" || isEscaped(text, i)) { i++; continue; }
    let end = i + 1;
    while (text[end] === "`") end++;
    const delimiter = text.slice(i, end);
    let cursor = end;
    let close = -1;
    while (cursor < text.length) {
      if (inactive[cursor]) break;
      const next = text.indexOf("`", cursor);
      if (next < 0) break;
      const fencedBoundary = inactive.indexOf(1, cursor);
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
  return { text: `${text}\n\n${loadingNotice}${additions}`, loaded };
}
