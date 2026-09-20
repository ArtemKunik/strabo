# Package-owned parser assets.

`vendor/` is **generated**, not committed. `npm run vendor:parsers` copies grammar
`.wasm` files out of the `tree-sitter-wasm` devDependency into `vendor/<language>/`, and
`prepare` runs it automatically so both local installs and published tarballs include
the assets. The script clears `vendor/` first, so removing a language actually shrinks
the package.

Grammars are **resolver-driven**: only languages with an implemented resolver are
vendored. Carrying unused grammars costs megabytes for code paths that never run.

| Path | Purpose | Size |
| ---- | ------- | ---- |
| `vendor/java/tree-sitter-java.wasm` | Java resolver | ~0.4 MB |
| `vendor/rust/tree-sitter-rust.wasm` | Rust resolver | ~1.1 MB |
| `vendor/c_sharp/tree-sitter-c_sharp.wasm` | C# resolver | ~5.1 MB |
| `vendor/kotlin/tree-sitter-kotlin.wasm` | Kotlin resolver | ~3.9 MB |
| `vendor/typescript/tree-sitter-typescript.wasm` | TypeScript/JSX (`.ts`, `.mts`, `.cts`) symbol extractor | ~1.4 MB |
| `vendor/tsx/tree-sitter-tsx.wasm` | TSX (`.tsx`) symbol extractor | ~1.5 MB |
| `vendor/sql/tree-sitter-sql.wasm` | SQL resolver and symbol extractor | ~2.4 MB |

To add a language, implement its resolver, add it to `LANGUAGES` in
`scripts/vendor-parsers.mjs` and to `GRAMMAR_LANGUAGES` in `parser-runtime.ts`, then run
`npm run vendor:parsers`.

C++ is recognised by extension and reported as unsupported until its resolver lands. COBOL and ABL are out of scope for now, and their extensions (`.cls`, `.i`, `.p`,
`.w`) are ambiguous, so they are excluded as non-source files.

`STRABO_PARSER_DIR` overrides the directory, which is useful for embedding hosts and
tests. The runtime falls back to `node_modules/tree-sitter-wasm/out/` when the vendored
assets have not been generated yet, so tests work before vendoring.
