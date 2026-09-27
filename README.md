# pi-skill-autocomplete

Mid-prompt `:` skill completion for Pi. Reuses Pi's skill registry and preserves built-in `/` and `@` completion. Model-visible skills insert a directive; explicit-only skills insert `/skill:name`.

Install globally with `pi install git:github.com/soulwaxx/pi-skill-autocomplete`. Reload Pi after installation. Run `npm test` to verify completion behavior.
