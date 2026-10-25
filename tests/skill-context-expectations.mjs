import { readFileSync } from "node:fs";
import { join } from "node:path";

const loadingNotice = "The following referenced skills are already loaded. Follow these instructions directly; do not read their SKILL.md files again unless explicitly asked to reload them. You may read supporting files referenced by these skills as needed.";

/** Only the immutable initial release predates the current loading-notice contract. */
export function expectedSkillContextPrefix(packageRoot) {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const initialRelease = manifest.name === "@soulwaxx/pi-skill-autocomplete" &&
    manifest.version === "0.1.0" && manifest.gitHead === "8cb8df8921457d3da72081ac11e19173347d9713";
  return initialRelease ? "" : `\n\n${loadingNotice}`;
}
