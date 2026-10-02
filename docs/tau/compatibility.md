# Tau compatibility, import and isolation

## Identity and trusted reuse

Tau is a fork of Pi, not a replacement installation. `tau-test.sh` runs this checkout; a built local package exposes `tau`, not `pi`. The host package is `@xotatera/tau-coding-agent`; core Pi package names, public extension API aliases and `pi` package-manifest fields are retained. The MIT license and upstream attribution remain intact.

User state defaults to `~/.tau/agent`, project resources to `.tau/`. `TAU_CODING_AGENT_DIR` and `TAU_CODING_AGENT_SESSION_DIR` select Tau-owned state/session locations. Inherited `PI_CODING_AGENT_DIR` does not redirect Tau state. `PI_PACKAGE_DIR` remains an asset compatibility override, not an executable identity or sandbox installation selector.

In trusted mode, explicitly select a supported resource instead of implicitly searching Pi:

```bash
tau -e /explicit/path/to/pi-extension.ts
```

A configured local package can retain its existing `pi` manifest and supported installed dependencies. Project trust is evaluated by Tau; copied Pi trust is never treated as approval. Trusted extensions can read files, spawn processes and use credentials with the launching user's permissions. Self-update aliases refuse with a source-checkout instruction. Explicit installed-extension updates remain separate from application self-update.

## Independent import

All examples use `tau`; substitute `/path/to/tau/tau-test.sh` when running from source. Use a synthetic or explicitly selected Pi source until you have reviewed its contents.

```bash
# Read-only: no destination, lock, recovery write or extension execution.
tau import pi --from /path/to/pi/agent
# Explicit project source; project resources are never inferred from cwd.
tau import pi --from /path/to/pi/agent --project /path/to/project
# Optional selection/preferences; repeat --select for more IDs.
tau import pi --from /path/to/pi/agent --select user:extension:extensions/probe.ts --preferences
```

The report gives a content-free plan `id`, resource paths, intended destinations, hashes, sizes and diagnostics. Inspect it. Repeat exactly the same selection/options when applying:

```bash
tau import pi --from /path/to/pi/agent --apply --plan-hash <reviewed-plan-id>
tau import activate <import-id-from-apply>
```

`--apply` re-inventories and rejects a stale hash. It creates an **inactive** content-addressed snapshot under `<tau-agent-dir>/imports/pi/`; it does not execute or enable extensions. Activation is a separate command that validates the receipt and generation before merging active resource paths. Identical content imports are idempotent, even after settings change.

The default conflict policy is `--on-conflict error`. `--on-conflict skip` preserves existing conflicting values/resources. There is no replacement mode. `--preferences` allows only `defaultProvider`, `defaultModel`, `defaultThinkingLevel` and `theme`; local theme paths must refer to selected themes and are rebased. No auth, trust, sessions, models configuration, instruction files, known credential stores or known secret-file classes are imported. Embedded secrets in otherwise legitimate source code cannot be detected reliably.

Copies are new regular files, not hardlinks or source symlinks. Contained symlinks are materialized; escaping links, cycles, special files, overlapping roots, missing dependencies and unavailable package locations fail closed. The importer snapshots supported available package/dependency trees without installs, scripts or downloads. It records available version/commit provenance, but does not infer arbitrary dynamic dependencies or promise every extension is portable. Filesystem/git layouts outside the supported cases require manual migration. Independence is tested by deleting the synthetic Pi source before loading imported fixtures.

Settings and imports share a lock. The importer uses durable journals and atomic individual renames, not a claim of a multi-file atomic filesystem transaction. Startup reconciles pending journals before resource discovery; recovery preserves old usable settings or validates the new generation, never restores stale state over a newer settings writer. Corrupt journals/hashes fail closed. A dry run reports pending recovery without performing it. Keep importer-owned metadata intact; do not manually delete guessed recovery targets.

## Whole-process Linux isolation

```bash
# Default: shared networking, private filesystem/process views.
tau --isolated
# Explicit offline namespace. --offline alone is NOT this boundary.
tau --isolated --sandbox-network=off
# Only explicitly selected allowed existing variables are forwarded.
tau --isolated --sandbox-env OPENAI_API_KEY --sandbox-env HTTPS_PROXY
```

Requirements: Linux user/mount/PID namespaces, `/usr/bin/bwrap`, canonical `/usr/bin/node`, supported ELF libraries and an installed/source runtime dependency closure. Unsupported layouts, missing namespaces, Bun and non-Linux isolation refuse without running user extensions or falling back to trusted mode. Run from a project separate from the installation and Tau state. Selecting `/`, host home, overlapping roots, known Pi roots or an unsupported special-file tree is rejected.

The namespace exposes only selected project and Tau agent state writable, installation/declared dependency trees and individual required system files read-only, private `/proc`, `/dev`, `/tmp` and `HOME`. A bounded command set (`bash`, `ls`, `grep`, `find`, `git` and common filesystem/text helpers) and its resolved ELF libraries is mounted individually; arbitrary host executables are not available. Project `.pi` and known credential-store directories are hidden; hidden-path symlink aliases are rejected. Existing sockets/device files in selected trees are rejected. Host credential stores, unselected filesystem sockets and Pi state are not mounted. Known npm Pi installations inside a selected root also cause refusal, including projects containing them in `node_modules`; use a project root without a physical Pi installation, or import resources separately. Direct source-Pi reuse is unavailable; import first. Ordinary files the user deliberately places in an allowed project are outside the hidden-source guarantee.

The child drops ambient environment credentials, proxies and preload settings. `--sandbox-env` accepts a finite list of provider API-key/endpoint variables and uppercase proxy variables, not wildcards or arbitrary environment forwarding. Names are validated, values must already exist, and summaries print names only. `HOME`, `PATH`, `NODE_OPTIONS`, `LD_*`, shell startup variables, `PI_*`, `TAU_*` and unsupported names are rejected. The launcher itself is trusted: preloads that ran before it started are outside the child boundary.

Networking defaults to **on** to support subscription login, token refresh and streaming. It is not endpoint filtering, host-loopback/service isolation, or protection against exfiltration of allowed files. Abstract network-namespace sockets are reachable in online mode. Explicit `off` denies TCP/loopback and host abstract sockets and never relaxes after a provider failure.

Provider auth is stored in writable Tau state, not copied from Pi. A browser may be unavailable inside the private namespace: use the authorization URL/manual flow; online localhost callbacks remain reachable. Local-only tests exercise authorization/callback, token exchange, refresh after restart, persisted auth, streaming, cancellation and explicitly selected proxy settings. No live subscription/provider claims follow from those synthetic tests.

This is **one boundary around the entire Tau process**, not per-extension isolation. Extensions can affect each other and modify allowed project/state, including Tau credentials. Private background work outside host hooks is not fully observable. Hardcoded `pi` commands, fixed Pi paths, private imports, independently installed compiled-ESM copies of host libraries and unsupported historical APIs may fail. macOS/Windows sandbox support and actual Bun/SEA runtime validation are not provided.

## Verification and roadmap

See [foundation-verification.md](foundation-verification.md). Remaining roadmap: extension diagnostics, context provenance, shared work lifecycle, reproducible profiles and finer per-extension capabilities. Pi's gallery, community, public APIs and services are upstream resources, not Tau-operated infrastructure.
