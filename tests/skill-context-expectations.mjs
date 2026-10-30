import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export const loadingNotice = "The following referenced skills are already loaded. Follow these instructions directly; do not read their SKILL.md files again unless explicitly asked to reload them. You may read supporting files referenced by these skills as needed.";

/** Identify only the immutable initial package fixture, never by API presence or version alone. */
export function isInitialRelease(packageRoot) {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  return manifest.name === "@soulwaxx/pi-skill-autocomplete" &&
    manifest.version === "0.1.0" && manifest.gitHead === "8cb8df8921457d3da72081ac11e19173347d9713";
}

export function expectedSkillExpansion(packageRoot, authored, loaded) {
  const additions = loaded.map(({ name, directory, body }) => `\n\n--- Skill ${name} (references relative to ${directory}) ---\n${body}`).join("");
  if (isInitialRelease(packageRoot)) return `${authored}${additions}`;
  const payload = `${loadingNotice}${additions}`;
  const names = loaded.map(({ name }) => encodeURIComponent(name)).join(",");
  const digest = createHash("sha256").update(`${names}\n${payload}`, "utf8").digest("hex");
  return `${authored}\n\n<!-- pi-skill-autocomplete:v1 --> names=${names} bytes=${Buffer.byteLength(payload, "utf8")} sha256=${digest}\n${payload}\n<!-- /pi-skill-autocomplete:v1 -->`;
}

/** Legacy input expansion had no loading-notice prefix. */
export function expectedSkillContextPrefix(packageRoot) {
  return isInitialRelease(packageRoot) ? "" : `\n\n${loadingNotice}`;
}
