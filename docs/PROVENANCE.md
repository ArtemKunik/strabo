# Provenance

This file audits every third-party artifact Strabo ships, vendors, or serves, and records
what would have to be true for the repository to be published under MIT. It is evidence,
not a legal opinion: the sign-off at the bottom is intentionally blank.

- Repository license: MIT (`LICENSE`, `package.json` `"license": "MIT"`, `"private": true`).
- Package contents: `package.json` `files` limits the tarball to `bin`, `dist`, `public`,
  `parsers`, and `README.md`. Dev dependencies are not shipped.
- Audit scope: direct `dependencies`, `devDependencies`, `peerDependencies`, the vendored
  grammar `.wasm` files under `parsers/vendor/`, and tracked binary assets.
- How it was produced: read each package's `package.json` `license` field and `LICENSE`
  file under `node_modules/`; ran `npm view <pkg> license repository.url version` for the
  vendored grammars and the optional peer; read the PDF's `/Info` dictionary. Versions for
  the installed runtime and dev dependencies are the resolved versions in
  `package-lock.json`; `pg` and the upstream grammar packages are not pinned by this
  repository, so their versions are the registry versions at audit time.

## Runtime dependencies

Installed by consumers; imported by `dist/` and by the served UI.

| Package | Version | License | Origin | Evidence |
| ------- | ------- | ------- | ------ | -------- |
| cytoscape | 3.34.3 | MIT | https://github.com/cytoscape/cytoscape.js | `node_modules/cytoscape/package.json`, `LICENSE`; served to the browser from `node_modules/cytoscape/dist` by `src/server.ts:41` |
| express | 5.2.1 | MIT | https://github.com/expressjs/express | `node_modules/express/package.json`, `LICENSE` |
| web-tree-sitter | 0.27.0 | MIT | https://github.com/tree-sitter/tree-sitter | `node_modules/web-tree-sitter/package.json`, `LICENSE` |
| yaml | 2.9.1 | ISC | https://github.com/eemeli/yaml | `node_modules/yaml/package.json`, `LICENSE` |
| pg (optional peer) | 8.23.0 | MIT | https://github.com/brianc/node-postgres | `npm view pg license`; not installed by default, not in the tarball, loaded only when a workspace selects Postgres |

Cytoscape is not bundled into `public/strabo.bundle.js`; the server serves its minified
`dist` from `node_modules` (`scripts/build-ui.mjs` header, `src/server.ts:41`).

## Dev dependencies

Used to build and test; excluded from the published tarball.

| Package | Version | License | Origin | Evidence |
| ------- | ------- | ------- | ------ | -------- |
| @cucumber/cucumber | 11.3.0 | MIT | https://github.com/cucumber/cucumber-js | `node_modules/@cucumber/cucumber/package.json` |
| @types/express | 5.0.6 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped | `node_modules/@types/express/package.json` |
| @types/node | 22.20.3 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped | `node_modules/@types/node/package.json` |
| esbuild | 0.28.2 | MIT | https://github.com/evanw/esbuild | `node_modules/esbuild/package.json`, `LICENSE.md` |
| jsdom | 30.1.0 | MIT | https://github.com/jsdom/jsdom | `node_modules/jsdom/package.json`, `LICENSE.txt` |
| playwright | 1.63.0 | Apache-2.0 | https://github.com/microsoft/playwright | `node_modules/playwright/package.json`, `LICENSE` |
| tree-sitter-wasm | 1.1.3 | MIT | https://github.com/Crysthamus/tree-sitter-wasm | `node_modules/tree-sitter-wasm/package.json`, `LICENSE` |
| typescript | 5.9.3 | Apache-2.0 | https://github.com/microsoft/TypeScript | `node_modules/typescript/package.json`, `LICENSE.txt` |

Playwright and TypeScript are Apache-2.0, which is permissive and MIT-compatible. Neither
is in the published `files` list, so their code is not redistributed. Apache-2.0's `NOTICE`
obligation would only apply if their code were redistributed; it is not.

Transitive dependencies installed under `node_modules/` alongside the direct ones are
governed by their own licenses; `package-lock.json` is the full tree. This audit covers the
direct artifacts named in `package.json` and the vendored assets below, which are the parts
Strabo itself redistributes.

## Vendored parser grammars

`scripts/vendor-parsers.mjs` copies prebuilt `.wasm` grammars out of the `tree-sitter-wasm`
dev dependency into `parsers/vendor/`, which **is** published. Each file traces to an
upstream grammar package:

| Language | Vendored path | Upstream package | Upstream repository | License |
| -------- | ------------- | ---------------- | ------------------- | ------- |
| Java | `parsers/vendor/java/tree-sitter-java.wasm` | tree-sitter-java 0.23.5 | https://github.com/tree-sitter/tree-sitter-java | MIT |
| Rust | `parsers/vendor/rust/tree-sitter-rust.wasm` | tree-sitter-rust 0.24.0 | https://github.com/tree-sitter/tree-sitter-rust | MIT |
| C# | `parsers/vendor/c_sharp/tree-sitter-c_sharp.wasm` | tree-sitter-c-sharp 0.23.5 | https://github.com/tree-sitter/tree-sitter-c-sharp | MIT |
| Kotlin | `parsers/vendor/kotlin/tree-sitter-kotlin.wasm` | tree-sitter-kotlin 0.3.8 | https://github.com/fwcd/tree-sitter-kotlin | MIT |
| SQL | `parsers/vendor/sql/tree-sitter-sql.wasm` | @derekstride/tree-sitter-sql 0.3.11 | https://github.com/derekstride/tree-sitter-sql | MIT |
| TypeScript | `parsers/vendor/typescript/tree-sitter-typescript.wasm` | tree-sitter-typescript 0.23.2 | https://github.com/tree-sitter/tree-sitter-typescript | MIT |
| TSX | `parsers/vendor/tsx/tree-sitter-tsx.wasm` | tree-sitter-typescript 0.23.2 | https://github.com/tree-sitter/tree-sitter-typescript | MIT |
| Python | `parsers/vendor/python/tree-sitter-python.wasm` | tree-sitter-python 0.25.0 | https://github.com/tree-sitter/tree-sitter-python | MIT |
| C++ | `parsers/vendor/cpp/tree-sitter-cpp.wasm` | tree-sitter-cpp 0.23.4 | https://github.com/tree-sitter/tree-sitter-cpp | MIT |

Evidence:

- `node_modules/tree-sitter-wasm/package.json` declares `"license": "MIT"` and lists the
  upstream grammar packages as dev dependencies; `node_modules/tree-sitter-wasm/LICENSE`
  is MIT.
- `node_modules/tree-sitter-wasm/README.md` §Licenses: "The licenses for the generated
  .wasm and .scm files belong to their respective upstream grammar authors and can be
  found on their github repos. The code in this repository is licensed under MIT."
- Each vendored `.wasm` ships beside a `.sigstore.json` signature bundle in
  `tree-sitter-wasm@1.1.3`; the bundle's certificate names the build workflow
  `github.com/Crysthamus/tree-sitter-wasm/.github/workflows/publish.yaml` at the release
  tag, confirming the binary's build origin.
- The upstream package licenses above were read with
  `npm view <pkg> license repository.url version` (`MIT` for all nine paths).

Caveat: `tree-sitter-wasm` pins exact upstream grammar commits in its own build config,
which is not included in the published npm tarball. The licenses recorded here are the
upstream packages' current declared licenses, not a per-commit attestation. See the
sign-off below.

## Assets and generated files

| Artifact | Origin | License | Evidence |
| -------- | ------ | ------- | -------- |
| `public/index.html`, `public/styles.css` | First-party source in `ui/` and `ui/styles/` | MIT (repository) | Copied, and the stylesheet parts concatenated, by `scripts/build-ui.mjs` |
| `public/strabo.bundle.js`, `.map` | esbuild output of first-party `ui/` modules only; cytoscape is not bundled | MIT (repository) | `scripts/build-ui.mjs` `BUNDLED_MODULES`; tracked in git (`git ls-files public`) |
| `bin/strabo.js`, `dist/**` | First-party source in `src/` | MIT (repository) | `tsc` output; `dist/` is gitignored build output |
| `parsers/vendor/**` | Prebuilt grammar `.wasm` from `tree-sitter-wasm` | MIT (upstream, see above) | Generated, gitignored (`parsers/vendor/`) |
| `README.md`, `LICENSE` | First-party | MIT (repository) | Repository root |
| `Strabo_Standalone_App_Concept.pdf` | Concept source by Artem Kunyk, 11 pages, generated with ReportLab | Copyright Artem Kunyk | PDF `/Info` (`/Author (Artem Kunyk)`, `/Title (Strabo - Standalone App Concept)`, `/CreationDate (D:20260918074706+02'00')`); gitignored by `.gitignore:38` ("intentionally not committed"), so it is not in the repository contents that ship |

The only tracked binary asset is `public/strabo.bundle.js.map`, a first-party build
artifact. No third-party font, image, or minified library is committed.

## MIT publication question

- Strabo itself is MIT (`LICENSE`, `package.json`).
- Every runtime dependency is MIT or ISC: permissive and MIT-compatible.
- Apache-2.0 appears only in dev dependencies (Playwright, TypeScript); they are not in
  the published package, so no `NOTICE` file is redistributed.
- The vendored grammar `.wasm` files are MIT per their upstream packages.
- The concept PDF is authored by the repository owner and is gitignored; it is not part of
  the committed repository and therefore not part of a source publication.

No artifact with an incompatible license was found. Whether the repository **should** be
published under MIT remains a human decision; it is not confirmed here.

## Pending human sign-off

The audit above is complete, but the publication question is not answered until a person
confirms it. These fields are deliberately blank:

| Field | Value |
| ----- | ----- |
| Confirmed by | |
| Date (UTC) | |
| Scope confirmed | |
| Notes / exceptions | |

Checklist to confirm:

- [ ] Every runtime dependency's license is compatible with MIT redistribution.
- [ ] The vendored grammar binaries' upstream licenses are confirmed for the exact pinned
      commits (not only the upstream package's current declared license).
- [ ] The status of `Strabo_Standalone_App_Concept.pdf` is decided (keep gitignored, or
      commit with an explicit license).
- [ ] The repository may be published under MIT.
