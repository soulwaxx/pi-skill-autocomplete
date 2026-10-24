# Implementation assessment

This assessment records the original five-file baseline, how the current implementation addresses the findings, and remaining limits. It is an implementation and test assessment, not a security certification or a claim that external release controls have been configured.

## Baseline findings and disposition

The baseline at `ac3f6328fcedcdff18c36cac7eb8d0e8ca6be0da` contained five tracked files:

| Baseline file | Finding | Resolution or disposition |
| --- | --- | --- |
| `extensions/skill-autocomplete.ts` | Completion searched name/description with one substring tier; selected text was natural language and did not guarantee loading. Explicit-only skills were rewritten into a leading `/skill:` command, so multiple selections could not reliably load multiple bodies. | `:` completion now uses Pi's registered skill commands, including explicit-only skills, and inserts `[[skill:name]]`. Search ranks exact, prefix, substring, fuzzy-name, then description-only results, with alphabetical ties. Submission expansion is in `extensions/skill-reference-parser.ts` and the input handler; it preserves authored text and appends unique, full trimmed bodies. `/` and `@` completion delegates to Pi's wrapped provider. |
| `tests/skill-autocomplete.mjs` | The small mocked test suite did not prove parser, filesystem, submission, real-Pi mode/source boundaries, ranking, or package behavior. | Tests now cover provider ranking/ownership/delegation and reference parsing/loading/failure. `tests/row5-*`, runtime probes, isolated runners, feasibility, and artifact checks add disposable fake-provider and installed-Pi coverage. They do not use a live profile or paid model. |
| `package.json` | The package was private and used an unscoped name, without a lockfile, executable gates, or a defined artifact allowlist. | It is now public-scoped `@soulwaxx/pi-skill-autocomplete@0.1.0`, with wildcard (`*`) Pi host peer ranges, Node `>=22.19.0`, locked development dependencies (including Pi `1.4.0` for tested development), scripts, and a five-file runtime package allowlist. `npm run test:artifact` checks the packed output. |
| `README.md` | The short baseline description and git-source installation command did not document the new reference syntax or guarantees. | This README documents npm installation, migration, supported behaviors, failure handling, limits, and commands. |
| `LICENSE` | The MIT license was present. | Retained unchanged. |

This table distinguishes findings in the baseline from behavior verified in the present implementation; it is not a claim that the initial tests were exhaustive.

## Behavior and failure boundaries

- Only names from Pi's live `getCommands()` registry with `source === "skill"` and a `skill:` name are eligible. There is no path syntax, filesystem discovery scan, or skill-content read while typing.
- Active references in TUI/RPC user input resolve against that registry. Explicit-only skills are eligible. Unique references load in first-reference order; loaded bodies are not recursively scanned.
- Pi's public `stripFrontmatter()` is used; each body is then trimmed. The extension appends its body and source-directory context to the user message and preserves the authored text. This guarantees the selected full body is included in the submitted message when validation succeeds, not that a model follows it or that it fits the available context. Supporting files are not eagerly read.
- The `128 KiB` cap sums UTF-8 bytes of unique trimmed bodies only. Frontmatter, prompt text, and wrapper labels/directories are excluded. The exact `131,072`-byte boundary is covered by parser tests and the benchmark.
- Escaping uses the parity of immediately preceding backslashes. Matching backtick code spans and backtick/tilde fences are ignored. Unmatched inline delimiters and unclosed fences follow parser-specific literal rules; indented code is outside the exclusion guarantee.
- Invalid, unknown, unreadable, absent-path, or oversized active references fail atomically: the extension returns `handled`, notifies, attempts to restore text, and does not send partial content to the model. This matters because Pi's input-handler runner catches thrown handler errors and can otherwise continue processing.
- For rejected TUI input, Pi's independently supplied startup `initialImages` are not restored with the text. The handler warns that retry requires relaunching with the original image. This is an explicit accepted limitation; it does not cache or reattach images. RPC clients own their attachment retention and must honor notification and `set_editor_text` events.
- RPC user prompts including queued/steered/follow-up input use the normal input hook and return the native successful `handled` disposition on rejection. Print/JSON and extension-generated input remain unchanged. Native commands consumed before this hook remain native. A registered native prompt-template invocation with active authored references is rejected; template-only input stays native and generated/body references do not activate. A leading native skill command with references is supported.

## Performance measurement

Run with `npm run bench`. This local measurement was taken on Node `v24.22.0`, macOS (`darwin`), `arm64`. Values are milliseconds, p50/p95. Completion used 25 warmups and 225 samples per registry size. Production submission-hook measurements used disposable `SKILL.md` fixtures, 15 warmups and 135 samples per case. The typing instrumentation also counts Node `readFileSync` calls and wrapped-provider skill-search calls.

| Case | p50 | p95 | Evidence |
| --- | ---: | ---: | --- |
| Completion, 10 registered skills | 0.0043 | 0.0090 | 0 wrapped-provider searches; 0 observed `readFileSync` calls |
| Completion, 100 registered skills | 0.0349 | 0.0443 | 0 wrapped-provider searches; 0 observed `readFileSync` calls |
| Completion, 1,000 registered skills | 0.2709 | 0.3280 | 0 wrapped-provider searches; 0 observed `readFileSync` calls |
| Production input hook, 1 x 4 KiB body | 0.0405 | 0.0491 | 1 actual fixture-file read per submission |
| Production input hook, 10 x 4 KiB bodies | 0.2443 | 0.3206 | 10 actual fixture-file reads per submission |
| Production input hook, 25 x 4 KiB bodies | 0.5879 | 0.6855 | 25 actual fixture-file reads per submission |
| Production input hook, exact 128 KiB body | 0.0782 | 0.0895 | 1 actual fixture-file read per submission; exact limit accepted |

These are local synthetic timings, not an SLA, a pre-change baseline comparison, or a forecast for other systems. The benchmark also prints parser-only memory-reader timings (1/10/25 references at 0.0021/0.0025, 0.0148/0.0268, and 0.0340/0.0369 ms p50/p95). Those exclude filesystem access and must not be confused with the production input-hook values above. The I/O counter reports only the explicit submissions' fixture `SKILL.md` paths; filesystem setup happens outside the timed interval.

## Remaining limitations and external evidence

- Full bodies being present is not model obedience, tokenization, context fit, or a guarantee that supporting files are opened.
- The UI may render/fold appended content according to native Pi behavior; no custom multi-skill visual block renderer is promised.
- TUI startup-image rejection recovery and RPC attachment display are bounded as described above.
- At the time this assessment was written, remote Linux/macOS CI for the then-current branch head had not been observed. The workflow matrix requests Linux/macOS and Node 22/24; check the final PR head's CI results separately rather than treating this timestamped observation as current status.
- Release tests and audits are gates, not proof of vulnerability-free code or remote permission readiness. A currently observed audit result of zero advisories (where obtained) is not a security claim.
- GitHub branch/ruleset configuration, npm scope ownership/access, trusted publisher binding, and registry write permissions were not verified or changed. See [release operations](releasing.md) before any authorized publication.
