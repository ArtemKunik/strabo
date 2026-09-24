# Using Strabo

Install, configure, and run the standalone server. Feature detail lives in
[FEATURES.md](./FEATURES.md); headless surfaces live in [CLI.md](./CLI.md);
internals and limits live in [DESIGN.md](./DESIGN.md).

## Install and run

Requires Node 22+. The quickest route is the npm package, `strabo-map`, which installs the
`strabo` command:

```sh
npx strabo-map /path/to/repo
npm install -g strabo-map && strabo /path/to/repo
```

The Terminal screen needs the optional native module `node-pty`. An install that could not
build it still maps, reviews, and reports; only the Terminal names the missing module.

To run from a clone of this repository instead:

```sh
npm install          # also builds dist/ and vendors the parser .wasm files (prepare)
npm start            # maps the repository you are standing in
```

Open `http://localhost:3000` (the default `PORT`). The server scans the root, builds the
graph, and serves the interactive map.

To map a different repository, pass its path or set `STRABO_ROOT`:

```sh
npm start -- /path/to/repo
# `npm start` is `node bin/strabo.js`, so this is the same thing
node bin/strabo.js /path/to/repo
```

The root is resolved from the path argument, then `STRABO_ROOT`, then the working
directory. The resolved root and scan ceiling are printed at startup, so a run against
the wrong directory is visible rather than silent. Use `STRABO_SCAN_CEILING` to allow
scanning repositories outside the start root; see [Environment](#environment).

### Build from source

```sh
# install; the `prepare` script also builds dist/ and vendors the parser .wasm files
npm install

# typecheck + build (tsc, then the UI bundle)
npm run typecheck
npm run build
# or just the UI bundle
npm run build:ui
```

See [Install and run](#install-and-run) to start the server.

## Environment

| Variable             | Meaning                                                        |
| -------------------- | -------------------------------------------------------------- |
| `STRABO_ROOT`        | Repository root to scan and serve. Overridden by a path argument; defaults to the working directory. |
| `STRABO_CONFIG`      | Path to a Strabo config file (workspace repositories, catalogue, integrations). |
| `STRABO_SCAN_CEILING`| Filesystem boundary Strabo may read from. Defaults to root; narrowing it is editable at runtime from **Settings**. |
| `STRABO_ALLOW_CEILING_WIDENING` | Startup-only `1`/`true` (or `--allow-ceiling-widening`) permits **Settings** to widen `scanCeiling` beyond its startup value. Off by default; never accepted from a request and never persisted, so a request cannot grant itself a wider boundary. |
| `STRABO_HOST` | Interface the server binds (`--host` overrides it). Defaults to `127.0.0.1`; set `0.0.0.0` only to expose the server deliberately. |
| `STRABO_CACHE_DIR`   | Where scan artifacts are persisted. Defaults to an OS temp dir. |
| `STRABO_STATE_DIR`   | Where known repositories, settings, and check baselines are persisted. Defaults to `STRABO_CACHE_DIR`. |
| `STRABO_AUTO_REBUILD`| `0`/`false`/`off` stops the server from rebuilding a stale graph in the background when a request observes `HEAD` moving. On by default. |
| `STRABO_TERMINAL_DAEMON` | `1`/`true` (or `--terminal-daemon`) runs terminal sessions in a detached `strabo-termd` daemon so they survive a server restart. Off by default. |
| `STRABO_PARSER_DIR`  | Directory holding grammar `.wasm` assets. Defaults to `parsers/vendor`. |
| `STRABO_RISK`        | `1` or `online` enables CVE/license lookup via OSV.dev and deps.dev. Off by default. |
| `STRABO_RISK_DENY`   | Comma-separated SPDX ids the license policy denies. Defaults to strong copyleft. |
| `STRABO_NARRATOR_ENDPOINT` | Chat-completions endpoint for the opt-in LLM narrator. Must be `https:` or loopback. Off unless set with a model. |
| `STRABO_NARRATOR_MODEL` | Model name to request from the narrator endpoint. |
| `STRABO_NARRATOR_KEY_ENV` | Environment variable holding the narrator API key. Defaults to `STRABO_NARRATOR_API_KEY`. |
| `STRABO_NARRATOR_BUDGET` | Maximum narrator requests per server session. Defaults to 20. |
| `STRABO_NARRATOR_SEND_SOURCE` | `1`/`true` also sends recorded source snippets, not just evidence. Off by default. |
| `PORT`               | HTTP port for the standalone server.                           |

The narrator variables back the opt-in setup described under
[LLM narrator](./FEATURES.md#llm-narrator-opt-in).

## Choosing a repository

The **Open folder…** dialog (the `⋯` menu beside the repository picker) browses the filesystem server-side and scans the
folder you pick. A browser cannot hand the server a filesystem path, so the listing is
served by `GET /api/strabo/browse` and is strictly bounded by `STRABO_SCAN_CEILING`.
By default the ceiling is the start root, so the dialog only shows that repository; set
`STRABO_SCAN_CEILING` to a parent directory to scan siblings, for example:
```powershell
$env:STRABO_ROOT = "D:\work\my-repo"
$env:STRABO_SCAN_CEILING = "D:\work"
node bin/strabo.js
```

Opened repositories are remembered (outside the scanned tree, so they never dirty it) and
the **Repository** selector reopens the last one on load. `GET /api/strabo/repositories`
lists them, `POST` remembers a selection, and `DELETE ?root=` forgets one. Every path is
still resolved through the scan ceiling, so remembering a path can never widen what Strabo
may read.

The **Open folder…** dialog browses the filesystem through `GET /api/strabo/browse`, which
is bounded by the same ceiling. When the dialog reaches the ceiling its **Up** button is
disabled and a note names the boundary and the `STRABO_SCAN_CEILING` variable that set it,
so the limit is visible rather than looking like a broken control. The ceiling can also be
changed while the server runs from **Settings** (see below).

## Settings

The toolbar's **Settings** button opens a floating window with four groups: **Appearance**
and **Rendering** (browser preferences), **Server** (the scan ceiling and the online risk
lookup), and **Narrator** (the opt-in setup described under
[LLM narrator](./FEATURES.md#llm-narrator-opt-in)).

**Appearance** preferences are stored in `localStorage` under `strabo.settings.v1` and
applied immediately:

| Preference | Meaning |
| ---------- | ------- |
| Theme | `System`, the neutral `Dark`/`Light` pair, or a colour theme (`Nord`, `Dracula`, `Solarized Dark`/`Light`, `Gruvbox Dark`/`Light`, `Monokai`). `System` follows `prefers-color-scheme` and updates live. |
| Reduce motion | Collapse the app's transitions and the member-map playback; also follows the OS preference. |
| Default detail | Whether the map opens in **Directories** or **Files** mode, unless a URL mode or a per-repository preference overrides it. |
| Show node labels | Hide every node label for a cleaner map. Directory-island labels are a separate layer and are unaffected. |
| Large-file threshold (lines) | The line count the large-file lens treats as "large". Defaults to 300; a positive integer. |

The theme is applied as `data-theme` on `<html>`; the surface, ink, border, and canvas
colours are CSS custom properties, so both the chrome and the Cytoscape graph re-skin
together (the graph stylesheet reads `--graph-*` at runtime). Every theme is a full token
set in `ui/styles/themes-dark.css` or `ui/styles/themes-light.css` (the default dark set is
`ui/styles/tokens.css`), so the terminal, the graph, and the panels all follow. Reduce motion
sets `data-reduce-motion`, which the graph viewport also honours.

**Rendering** chooses the map's renderer: **GPU rendering (WebGL2)** on draws on the GPU,
off on the 2D canvas. Cytoscape fixes its renderer when the map is constructed, so changing
this reloads the page and says so before it is clicked; when the browser exposes no WebGL2
context the toggle is disabled and names that reason. Diagnostics reports the renderer
actually in use.

**Server settings** are read from `GET /api/strabo/settings` and written with
`PUT /api/strabo/settings`:

| Field | Editable | Meaning |
| ----- | -------- | ------- |
| `workspaceRoot` | no | The start root the process was launched with. |
| `scanCeiling` | yes | The boundary every path is resolved through. `null` resets it to the startup value. |
| `allowCeilingWidening` | no | Startup-only permission, shown read-only. Set it with `STRABO_ALLOW_CEILING_WIDENING` or `--allow-ceiling-widening`. |
| `riskOnline` | yes | Whether OSV.dev / deps.dev lookups are enabled (`STRABO_RISK`). |
| `configPath`, `riskDeniedLicenses` | no | The workspace config path and the denied-license policy, shown for reference. |

A ceiling update takes effect immediately for the graph, browse, and repository routes. It
is process-local: a restart returns to `STRABO_SCAN_CEILING`. **Narrowing** the boundary is
always allowed. **Widening** it beyond the ceiling in force is refused unless the process
was started with `STRABO_ALLOW_CEILING_WIDENING=1` (or `--allow-ceiling-widening`), so a
default process cannot grow its own read boundary at runtime — not directly, and not by
persisting the permission, since the flag is never accepted from a request and never
written to the settings file. A body carrying `allowCeilingWidening` is refused with
`400`. Treat the server as an operator tool and do not expose it to untrusted users. The
requested path must name an existing directory; anything else is rejected with `400` and
the ceiling is left unchanged.

The standalone server binds `127.0.0.1` by default (`STRABO_HOST` / `--host` overrides it;
`0.0.0.0` listens on every interface and logs a warning saying so). API routes additionally
refuse a `Host` header that names anything other than the server itself (loopback, or the
configured interface), so a malicious page cannot reach the server through DNS rebinding:
a rebinding domain resolves to 127.0.0.1 but arrives with the attacker's Host, which never
matches.

## Terminal

The **Terminal** tab (beside **Graph**) runs shell and agent sessions in the app; the
[multi-session terminal](./FEATURES.md#terminal-multi-session) feature detail lives in
FEATURES.md. Sessions normally live in the server process and end when it restarts; set
`STRABO_TERMINAL_DAEMON=1` (or `--terminal-daemon`) to run them in the detached `strabo-termd`
daemon instead, so they survive a restart and are reconnected to on the way back up. When the
daemon cannot start the server falls back to the in-process registry. These global shortcuts
are ignored while typing in a field:

| Shortcut | Action |
| -------- | ------ |
| `Ctrl+Shift+T` | Open the Terminal and start a new shell. |
| `Ctrl+Shift+W` | Close the active session. |
| `Ctrl+Shift+R` | Open the Terminal's run-presets menu. |

## Review and History

The **Review** and **History** tabs (beside **Graph** and **Terminal**) open the pending change
set and the recorded Git history as full-screen views; the
[Review and History tabs](./FEATURES.md#review-and-history-tabs) detail lives in FEATURES.md.
They show the same evidence as the floating Review and Timeline panels, read from what the app
already loaded. **Escape** returns either tab to the map.
