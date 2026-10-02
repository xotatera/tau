# Tau foundation verification

Original foundation baseline: `7fbbd5f4a1d982bb02d63472dde0774fa639f99b`. The later Pi rebase target is `9fba660cf1caca0ade5bea72269352416e595a19`; figures below describe the original foundation gate unless noted.
Environment: Linux, Node v26.10.0, npm 12.1.0, bubblewrap 0.13.0.
Fork: https://github.com/xotatera/tau (parent earendil-works/pi verified).
Branch: feat/tau-foundation; isolated worktree `.worktrees/tau-foundation`.

## Baseline

- `npm ci --ignore-scripts`: exit 0. Existing dependency warnings: autoevals package-manager engine preference, deprecated node-domexception/prebuild-install, one reported high-severity vulnerability. No automatic audit fix or dependency changes performed.
- Initial `npm run check`: failed because ignored `packages/ai/src/providers/data/` was missing. `npm run check:model-data` independently reproduced missing amazon-bedrock.json and prescribed hydration.
- Initial `./test.sh`: failed on missing generated JSON and missing build artifacts, before any Tau product edits. Full output retained in plan scratch workspace `baseline-tests.log`.
- `npm run hydrate:model-data`: exit 0, using an empty environment/fresh temporary HOME and anonymous public catalog endpoints. Only ignored generated model data changed; tracked generated wrappers were not edited.
- Hydrated `npm run check`: exit 0; Biome applied no fixes; pinned/runtime dependency checks, entry graphs, both generated-lock validations, TypeScript, and browser smoke passed.
- `npm run build:offline`: exit 0 under isolated HOME/credential-free environment; 74-file Node bundle built.
- Hydrated/built `./test.sh`: exit 0 under repository's credentials-free wrapper. Coding-agent: 303 files passed, 6 skipped; 2,654 tests passed, 50 skipped. AI: 1,231 passed, 859 skipped (live/offline-dependent coverage not claimed). Other workspace/script tests passed; full output retained in `baseline-tests-hydrated.log`.
- Minimal real bubblewrap namespace/capability probe: exit 0 with user/PID/mount/network namespaces and dropped capabilities. This establishes backend feasibility only, not Tau's future sandbox policy or adversarial-test acceptance.

## Implementation

Tasks 2–7 passed their implementation gates in the isolated worktree. A fresh-context independent review identified four P1 defects and one recovery retry defect. All were reproduced with synthetic inputs; targeted regression tests passed after fixes and the credential-isolated full suite passed. No claim of universal security or portability follows.

- Tau identity/state/source wrapper: root static checks, lock generation checks, source CLI tests and full credential-isolated `./test.sh` passed. Upstream host-state fixtures were migrated to Tau paths; unchanged legacy extension fixtures were tested separately.
- Legacy API/resource behavior: unchanged earendil and mario fixtures, host identity/alias mutation probes, factory/reload/input/tool lifecycle tests, and real modular SDK plus bundled Node consumer probes passed.
- Updater: hostile upstream response, inherited managed-install/Windows cleanup and self-alias rejection probes passed; ordinary configured extension-only updates remain covered.
- Import: 58 focused tests passed, including dry-run nonmutation, source removal, descriptor/symlink/FIFO boundaries, source mutation, conflicts/idempotence, shared settings lock, journal crash states, ENOSPC/EACCES and recovery before SDK discovery. Packaged imported legacy fixtures load after deleting synthetic Pi sources.
- Isolation: real Linux bubblewrap tests cover source and bundled Node entrypoints, unchanged imported fixture after source deletion, selected writes, hidden files/credentials/Pi paths, symlink escape, process views, descendant reads, filesystem sockets, explicit-offline abstract sockets and TCP loopback. SIGTERM terminates isolated descendant heartbeat without fallback. The supported-platform refusal tests are simulations; they do not constitute execution on other operating systems.
- Local subscription lifecycle: production ModelRuntime, a loopback OAuth/token/provider fixture, callback/manual URL instructions, file-backed Tau auth, fresh runtime instance, refresh, streamed output, cancellation, selected API-key/proxy forwarding and actual CONNECT proxy traffic passed. Explicit-offline retry produced an error without new server requests or policy relaxation. No real provider credentials, paid model calls or real subscription claims.
- Final Task 7 gate: `npm run check`, credential-free `npm run build:offline`, `node --test scripts/tau-isolation-smoke.test.mjs scripts/tau-source-cli.test.ts scripts/tau-extension-consumer.test.mjs`, direct `node scripts/tau-isolation-smoke.mjs`, packaged extension consumer, and `./test.sh` all exited 0. Git diff whitespace check passed.

- Review corrective pass: isolated policy rejects synthetic physical Pi npm installations and their parent/child selection; the default isolated bash executes `ls`, `grep`, `find` and `git` from individually mounted system executables/libraries; same-batch import names honor `error` or stable first-wins `skip` before apply and again at activation; eval harness overrides/restores inherited Tau state and session paths before discovery, with Docker package paths pointed at Tau; mutating apply recovers a valid pending journal after checking a stable reviewed hash, while dry run remains read-only. Each behavior had a failing test before the fix. Final focused import, eval, isolation tests passed; final `npm run check` clean; final `./test.sh` exited 0 with coding-agent 319 files passing, 2,790 tests passing and 50 skipped. Real Docker eval image execution remains unverified because Docker is not installed here; package identity and harness behavior are covered by static checks and focused tests.

After the Pi rebase, upstream removed the published npm shrinkwrap; Tau retains its generated installer lock while following that removal. The rebased tree passed `npm run check`, `npm run build:offline`, `./test.sh` (coding-agent 320 files and 2,801 tests passed; 50 skipped), the real isolation smoke, and the packaged legacy-extension consumer. Rehydration of ignored model data from public catalog sources was required for current upstream model-ID and catalog tests. No paid provider calls were made.

Original foundation evidence remains in the ignored plan workspace `.superpowers/sdd/2026-10-01-tau-foundation/`: task6-consumer.log, task6-full-tests.log, task7-offline-build.log, task7-consumer.log, task7-full-tests.log, task7-smoke.log, final-review.md, final-fix-gate.log, final-fix-full-tests.log and progress.md. The foundation commit and this rebase were user-authorized; no push or publication was authorized.

## Limits and follow-up

Only this Linux system-Node/bubblewrap layout and local synthetic provider endpoints were exercised. Actual Bun compiled binaries, SEA executables, Windows/macOS runtimes and sandbox implementations, other Linux distribution/library layouts, real subscriptions and arbitrary third-party extensions were not verified. Hidden-file protections are not a promise to detect secrets embedded in deliberately allowed code. Networking-on intentionally permits loopback/services, abstract sockets and exfiltration of exposed data. Isolation is whole-process, not per-extension, and does not fully observe private background work.

Baseline dependency warnings remain recorded above; no automatic dependency audit repair was performed. Pi community/gallery/public services and historical API docs remain upstream references, not Tau-operated services. The broader diagnostics/context-provenance/work-lifecycle/profile/capability roadmap remains deferred.
