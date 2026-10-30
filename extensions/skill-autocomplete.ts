/**
 * Mid-prompt skill autocomplete
 *
 * Lets you reference a skill from anywhere inside a prompt. Type `:` at a token
 * boundary to open a picker of every loaded skill. Selecting a completion
 * inserts an explicit reference:
 *
 *   review this PR, :cod   ->   review this PR, [[skill:code-review]]
 *
 * Authored references are expanded from Pi's registered skill files at
 * submission time, including skills hidden from model invocation.
 *
 * Harmony contract:
 * - Stacks ONE autocomplete provider on top of pi's built-in one via
 *   ctx.ui.addAutocompleteProvider. Every non-`:` case delegates to the wrapped
 *   provider unchanged, so `@` file and `/` command completion are untouched.
 * - Expands explicit references only for interactive TUI and RPC user input.
 *   Skill files are read synchronously at submission, never while typing. No
 *   skill content is elevated to the system prompt.
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compactSkillReferenceDisplay, expandSkillReferences } from "./skill-reference-parser.ts";
import { fuzzyMatch } from "@earendil-works/pi-tui";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	AutocompleteSuggestions,
} from "@earendil-works/pi-tui";

const TRIGGER = ":";
const MAX_DESC = 60;
const SKILL_NAME_CHARS = /[A-Za-z0-9-]/;
// A colon only starts a skill token at a real boundary — never inside
// `http://`, `12:30`, `key:value`, etc. — so normal typing is not hijacked.
const BOUNDARY_BEFORE = /[\s(\[{,]/;

interface Detected {
	/** Column of the triggering colon on the current line. */
	colonCol: number;
	/** Text typed after the colon (may be empty right after the colon). */
	query: string;
}

/** Detect a `:query` skill token ending at the cursor, or null. */
function detectToken(line: string, col: number): Detected | null {
	let i = col - 1;
	while (i >= 0 && SKILL_NAME_CHARS.test(line[i])) i--;
	if (i < 0 || line[i] !== TRIGGER) return null;
	const isBoundary = i === 0 || BOUNDARY_BEFORE.test(line[i - 1]);
	if (!isBoundary) return null;
	return { colonCol: i, query: line.slice(i + 1, col) };
}

function truncate(text: string): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > MAX_DESC ? `${oneLine.slice(0, MAX_DESC - 1)}…` : oneLine;
}

interface LoadedSkill {
	name: string;
	description: string;
}

function loadedSkills(pi: ExtensionAPI): LoadedSkill[] {
	return pi.getCommands()
		.filter((command) => command.source === "skill" && command.name.startsWith("skill:"))
		.map((command) => ({
			name: command.name.slice("skill:".length),
			description: command.description ?? "",
		}));
}

function makeProvider(
	pi: ExtensionAPI,
	current: AutocompleteProvider,
): AutocompleteProvider {
	let generation = 0;
	const owned = new WeakMap<AutocompleteItem, { generation: number; signal: AbortSignal; lines: string[]; cursorLine: number; cursorCol: number; prefix: string }>();

	const matchSkills = (
		query: string,
		signal: AbortSignal,
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): AutocompleteItem[] => {
		const generationAtStart = generation;
		const q = query.toLowerCase();
		const ranked = loadedSkills(pi).flatMap((skill) => {
			const name = skill.name.toLowerCase();
			const description = skill.description.toLowerCase();
			let tier: number;
			if (q === "") tier = 0;
			else if (name === q) tier = 0;
			else if (name.startsWith(q)) tier = 1;
			else if (name.includes(q)) tier = 2;
			else if (fuzzyMatch(q, name).matches) tier = 3;
			else if (description.includes(q)) tier = 4;
			else return [];
			return [{ skill, tier }];
		});
		ranked.sort((a, b) => a.tier - b.tier || (a.skill.name < b.skill.name ? -1 : a.skill.name > b.skill.name ? 1 : 0));
		if (signal.aborted || generationAtStart !== generation) return [];
		return ranked.map(({ skill }) => {
			const item: AutocompleteItem = {
				value: skill.name,
				label: skill.name,
				description: skill.description ? truncate(skill.description) : undefined,
			};
			owned.set(item, {
				generation: generationAtStart,
				signal,
				lines: [...lines],
				cursorLine,
				cursorCol,
				prefix: query,
			});
			return item;
		});
	};

	return {
		triggerCharacters: [...(current.triggerCharacters ?? []), TRIGGER],

		async getSuggestions(
			lines,
			cursorLine,
			cursorCol,
			options,
		): Promise<AutocompleteSuggestions | null> {
			const line = lines[cursorLine] ?? "";
			const token = detectToken(line, cursorCol);
			generation++;
			if (token) {
				if (options.signal.aborted) return current.getSuggestions(lines, cursorLine, cursorCol, options);
				const items = matchSkills(token.query, options.signal, lines, cursorLine, cursorCol);
				if (options.signal.aborted) return current.getSuggestions(lines, cursorLine, cursorCol, options);
				// Only claim the dropdown when we actually match something (or the
				// bare colon was typed / Tab forced it); otherwise stay out of the way.
				if (items.length > 0 || token.query === "" || options.force) {
					return { items, prefix: token.query };
				}
			}
			return current.getSuggestions(lines, cursorLine, cursorCol, options);
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			const line = lines[cursorLine] ?? "";
			const token = detectToken(line, cursorCol);
			const owner = owned.get(item);
			if (
				token && owner && !owner.signal.aborted && owner.generation === generation &&
				owner.cursorLine === cursorLine && owner.cursorCol === cursorCol &&
				owner.prefix === prefix && owner.lines.length === lines.length &&
				owner.lines.every((value, index) => value === lines[index]) &&
				token.query === prefix
			) {
				const next = [...lines];
				const insertion = `[[skill:${item.value}]]`;
				next[cursorLine] =
					line.slice(0, token.colonCol) + insertion + line.slice(cursorCol);
				return {
					lines: next,
					cursorLine,
					cursorCol: token.colonCol + insertion.length,
				};
			}
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return (
				current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ??
				true
			);
		},
	};
}

export default function skillAutocompleteExtension(pi: ExtensionAPI): void {
	pi.registerMarkdownTransformer((markdown, context) =>
		context.messageType === "user" ? compactSkillReferenceDisplay(markdown) : markdown,
	);
	pi.on("input", (event, ctx) => {
		if ((ctx.mode !== "tui" && ctx.mode !== "rpc") || event.source === "extension") {
			return { action: "continue" };
		}
		try {
			const expanded = expandSkillReferences(event.text, pi.getCommands(), (path) => {
				const body = stripFrontmatter(readFileSync(path, "utf8")).trim();
				return { body, directory: dirname(path) };
			});
			return expanded ? { action: "transform", text: expanded.text } : { action: "continue" };
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			const imageWarning = ctx.mode === "tui" && (event.images?.length ?? 0) > 0
				? " Retry requires relaunching Pi with the original image attachment."
				: "";
			try { ctx.ui.notify(`${reason}.${imageWarning}`, "error"); } catch { /* Keep the input blocked if notification fails. */ }
			try {
				if (ctx.mode === "tui") ctx.ui.pasteToEditor(event.text);
				else ctx.ui.setEditorText(event.text);
			} catch { /* Recovery failure must not submit the rejected input. */ }
			return { action: "handled" };
		}
	});
	let installed = false;

	pi.on("session_start", async (_event, ctx) => {
		if (installed || ctx.mode !== "tui") return;
		ctx.ui.addAutocompleteProvider((current) => makeProvider(pi, current));
		installed = true;
	});

	// A fresh runtime is rebuilt on reload/switch, so allow re-install afterwards.
	pi.on("session_shutdown", async () => {
		installed = false;
	});
}
