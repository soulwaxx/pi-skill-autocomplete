/**
 * Mid-prompt skill autocomplete
 *
 * Lets you reference a skill from anywhere inside a prompt. Type `:` at a token
 * boundary to open a picker of every loaded skill. Model-visible skills become
 * a directive phrase:
 *
 *   review this PR, :cod   ->   review this PR, use the `code-review` skill
 *
 * Skills with disable-model-invocation are absent from the system prompt, so a
 * directive cannot activate them. Selecting one instead moves its explicit
 * `/skill:name` invocation to the start while preserving the surrounding text.
 *
 * Harmony contract:
 * - Stacks ONE autocomplete provider on top of pi's built-in one via
 *   ctx.ui.addAutocompleteProvider. Every non-`:` case delegates to the wrapped
 *   provider unchanged, so `@` file and `/` command completion are untouched.
 * - Queries the wrapped built-in provider with `/skill:` to reuse pi's complete
 *   skill registry, including skills hidden from model invocation. The current
 *   system prompt identifies which skills can safely use a directive phrase.
 *   Registers no tools, hooks no model events, writes nothing. TUI-only.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	AutocompleteSuggestions,
} from "@earendil-works/pi-tui";

const TRIGGER = ":";
const MAX_DESC = 60;
const SKILL_NAME_CHARS = /[A-Za-z0-9-]/;
const SKILL_ENTRY =
	/<skill>\s*<name>([\s\S]*?)<\/name>\s*<description>([\s\S]*?)<\/description>/g;
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

function unescapeXml(str: string): string {
	return str
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

interface LoadedSkill {
	name: string;
	description: string;
}

/** Parse the <available_skills> block from the current system prompt. */
function loadedSkills(ctx: ExtensionContext): LoadedSkill[] {
	const prompt = ctx.getSystemPrompt();
	const skills: LoadedSkill[] = [];
	for (const m of prompt.matchAll(SKILL_ENTRY)) {
		skills.push({
			name: unescapeXml(m[1].trim()),
			description: unescapeXml(m[2].trim()),
		});
	}
	return skills;
}

function makeProvider(
	ctx: ExtensionContext,
	current: AutocompleteProvider,
): AutocompleteProvider {
	let allSkillNames = new Set<string>();

	const matchSkills = async (
		query: string,
		signal: AbortSignal,
	): Promise<AutocompleteItem[]> => {
		const command = "/skill:";
		const suggestions = await current.getSuggestions(
			[command],
			0,
			command.length,
			{ signal, force: false },
		);
		const items = (suggestions?.items ?? [])
			.filter((item) => item.value.startsWith("skill:"))
			.map((item) => {
				const name = item.value.slice("skill:".length);
				return { value: name, label: name, description: item.description };
			});
		const available =
			items.length > 0
				? items
				: loadedSkills(ctx).map((skill) => ({
						value: skill.name,
						label: skill.name,
						description: skill.description || undefined,
					}));
		allSkillNames = new Set(available.map((item) => item.value));

		const q = query.toLowerCase();
		return available
			.filter(
				(item) =>
					q === "" ||
					item.value.toLowerCase().includes(q) ||
					item.description?.toLowerCase().includes(q),
			)
			.map((item) => ({
				...item,
				description: item.description
					? truncate(item.description)
					: undefined,
			}));
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
			if (token) {
				const items = await matchSkills(token.query, options.signal);
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
			if (token && allSkillNames.has(item.value)) {
				const modelVisible = new Set(loadedSkills(ctx).map((skill) => skill.name));
				const next = [...lines];
				if (!modelVisible.has(item.value)) {
					const command = `/skill:${item.value} `;
					next[cursorLine] =
						line.slice(0, token.colonCol) + line.slice(cursorCol);
					next[0] = command + (next[0] ?? "");
					return {
						lines: next,
						cursorLine,
						cursorCol:
							cursorLine === 0
								? command.length + token.colonCol
								: token.colonCol,
					};
				}

				const insertion = `use the \`${item.value}\` skill`;
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
				false
			);
		},
	};
}

export default function skillAutocompleteExtension(pi: ExtensionAPI): void {
	let installed = false;

	pi.on("session_start", async (_event, ctx) => {
		if (installed || ctx.mode !== "tui") return;
		ctx.ui.addAutocompleteProvider((current) => makeProvider(ctx, current));
		installed = true;
	});

	// A fresh runtime is rebuilt on reload/switch, so allow re-install afterwards.
	pi.on("session_shutdown", async () => {
		installed = false;
	});
}
