# Changelog

## 0.1.1

- Read Android/Kotlin local device stores (SharedPreferences, EncryptedSharedPreferences,
  DataStore, and raw SQLite) as data hubs, so the Structure data-flow view shows an app's
  writes and reads instead of an empty canvas.
- Fix the tier intent reading: infer a tier from a rule pattern only when it matches no file, so
  a directory shared with a declared tier (`api/**`) no longer names a tier with no node (which
  could not be drawn).
- Draw every tier a ghost edge names, so an intent edge never refers to a missing node.
- Lay the data-flow hubs in a compact grid beside the stack, sized as hubs rather than files.
- Give the Structure edge labels a collision budget, like node labels, so a hub's several edges
  no longer stack their level labels into a doubled read.

## 0.1.0

First public release.

- Scan a local repository into an interactive map of files, dependencies, and change impact.
- Structure view with tiers, support shelf, and recorded data flows, narrated from recorded facts.
- Tree-sitter parsers for TypeScript/TSX, Python, Java, Kotlin, C#, C++, Rust, and SQL.
- CLI (`strabo`), a programmatic API, and a server entry point.
- MCP integration, GitHub Action, and drift reporting.
