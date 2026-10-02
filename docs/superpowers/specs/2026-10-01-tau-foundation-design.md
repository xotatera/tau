# Tau foundation and Pi extension compatibility

Date: 2026-10-01
Status: Initial written spec approved; revised 2026-10-02 to include independent import and whole-process isolation with online networking by default, awaiting review of the expanded scope.

## Intent

Create Tau as a GitHub fork of earendil-works/pi, preserving Pi's small, modular core while making assembled configurations more predictable and inspectable. The user requests GitHub CLI usage, a fork named tau, all five proposed improvement areas, strict TypeScript, consistent formatting, and extensive testing. The user explicitly requires existing Pi extensions to remain useful with Tau's changes.

This spec covers the first sub-project: fork identity, independent Pi-to-Tau import, compatibility foundations, and opt-in whole-process isolation. Extension diagnostics, context provenance, shared work lifecycle, reproducible shareable profiles, and per-extension restricted-host capabilities remain roadmap goals requiring later designs. The first stage now includes a real OS boundary for the entire Tau process and its extensions; it does not claim per-extension isolation or completion of the full roadmap.

## Observed baseline

Read-only GitHub inspection found upstream main at commit 7fbbd5f4a1d982bb02d63472dde0774fa639f99b. Implementation must record its actual fork baseline, since main can advance. GitHub CLI is authenticated as xotatera. An API lookup for xotatera/tau returned 404; recheck before creation and never overwrite an existing repository.

Upstream is a TypeScript workspace monorepo. Its base configuration enables strict and erasableSyntaxOnly. Biome provides formatting and linting. Extension loaders already alias supported @earendil-works/pi-* and @mariozechner/pi-* APIs to host implementations across source, unbundled, and embedded runtimes. Extensions register handlers, tools, commands, shortcuts, and renderers through a host API; registrations already carry extension identity. Package configuration supports a custom application name and configuration directory. Package manifests use a pi resource field.

Project trust governs resource loading, not runtime isolation. Legacy extensions execute Node code inside the Pi process. Their arbitrary direct filesystem, network, and process operations cannot be constrained by simply wrapping the extension API.

## Approach and alternatives

Use an additive compatibility layer: preserve the supported public extension API, existing event semantics, and default ordering. Add future contracts and instrumentation at host boundaries rather than rewrite extension source.

Rejected alternatives:
- Automatic source migration cannot safely transform arbitrary TypeScript or hidden dependencies.
- Default out-of-process execution breaks synchronous UI integration, shared references, and unrestricted Node dependencies.
- Blanket renaming of all Pi packages and symbols creates unnecessary module-resolution and release risk.

Compatibility is targeted at the recorded upstream baseline and supported public imports, not every historical Pi release, undocumented internal import, or private distribution.

## Scope

### Included

1. Create xotatera/tau with gh, clone into /home/xota/Projects/tau, and retain an upstream remote.
2. Introduce Tau-facing CLI and application identity while retaining MIT licensing and upstream attribution.
3. Separate Tau state from Pi state.
4. Preserve supported extension module aliases, factory signatures, package discovery, and event behavior.
5. Implement explicit direct reuse and independent copy/import of existing Pi resources without copying trust or credentials.
6. Implement an opt-in, fail-closed Linux whole-process sandbox covering Tau, legacy extensions, and descendant processes.
7. Establish compatibility, transactional-import, and adversarial-isolation tests with strict type checking and formatting verification.
8. Document the compatibility boundary, sandbox limits, and future additive contracts.

### Excluded from this stage

Implementing /doctor, context inspection, general background-work tracking, shareable profile export/import, or a per-extension restricted execution host. Pi resource import and whole-process sandboxing are included. Native macOS/Windows sandbox backends are excluded; isolated mode on those platforms must fail closed with guidance, while trusted mode remains available. Publishing npm packages, creating releases, installing Tau globally, modifying the existing Pi installation, and submitting upstream issues or pull requests are also excluded.

## Identity and repository behavior

Use the GitHub fork relationship, not a fresh repository that discards history. Preserve existing authorship and license notices. Set origin to the user's fork and upstream to earendil-works/pi. Work on a dedicated feature branch, not upstream main. If the local target exists, inspect it and stop rather than overwrite files.

The primary executable is tau. The fork must not overwrite the globally installed pi command. Set the configurable application name to tau and configuration directory to .tau using the existing configuration mechanism. Update relevant help, entrypoint, development instructions, and distribution metadata for the supported first-stage artifact. Preserve internal Pi names where they are part of compatibility or avoiding needless package churn.

Use @xotatera/tau-coding-agent as the Tau CLI package identity; do not publish under an upstream-owned package scope. Keep other workspace package identities unchanged in this stage. The implementation plan must account for CLI package references in workspace, shrinkwrap, bundling, and install-lock tooling. Preserve public Pi import compatibility through host aliases regardless of that package identity. Package publication is not authorized by this spec.

Self-update must never direct a Tau installation to install upstream Pi. Before Tau release artifacts exist, report that automatic Tau updates are unavailable and provide source-checkout guidance. No automatic release or package publication is performed in this stage.

## Configuration and state isolation

Tau defaults to ~/.tau/agent for user resources, credentials, trust records, settings, and sessions, and .tau for project resources. Keep Pi's ~/.pi and .pi trees unchanged. Application-derived TAU_CODING_AGENT_DIR and TAU_CODING_AGENT_SESSION_DIR overrides continue to work through the existing configuration helpers.

Audit remaining PI_* settings individually. Preserve documented compatibility settings where they intentionally control integration behavior, but do not allow legacy state-directory settings to silently select Pi's writable state. Document supported legacy overrides and any deliberate non-support.

Users may explicitly select existing extension files or packages using Tau's supported resource-path configuration or extension-loading options. Label this direct reuse, not import: it intentionally remains dependent on the source files. Do not implicitly scan or execute Pi's user or project extension directories. Reuse respects Tau's existing resource-source trust rules and never inherits a Pi trust decision.

Tau must also provide the independent import workflow below. No automatic credential copy, migration, deletion, or writes to Pi-managed files. In trusted mode, extensions can still access Pi paths directly through Node APIs. In isolated mode, the OS sandbox must deny those accesses within the threat model below.

## Independent Pi-to-Tau import

### CLI and selection

Provide `tau import pi [--from <agent-dir>] [--project <project-dir>] [--select <id> ...] [--preferences] [--on-conflict error|skip] [--apply --plan-hash <sha256>]`. Omitting --from uses ~/.pi/agent only for this explicit import operation. Default behavior is a dry run that prints a content-free plan hash without persisting it; apply requires that hash from the reviewed dry run. Re-inventory and compare the hash before staging so changed source/settings/options require a new review. --project adds resources from that project's .pi directory; it is never inferred from the current working directory. Destination is Tau's user agent directory, independent of the selected source scope.

Inventory supported extensions, skills, prompts, themes, configured local resource paths, and installed package snapshots. Produce stable resource IDs from type and source-relative location. Without --select, select all supported inventoried resources, but require --apply to write them. Unsupported or unresolved dependencies are blocking diagnostics unless the affected resource is explicitly deselected. Present source paths, intended destination paths, file counts, sizes, hashes, exclusions, and diagnostics; never print source file contents, credential values, or full settings objects.

Preferences are opt-in and limited to validated defaultProvider, defaultModel, defaultThinkingLevel, and theme. Theme is copied/rebased if it refers to a supported imported local theme. Do not copy arbitrary settings keys, system prompts, AGENTS/CLAUDE instruction files, MCP configuration, model endpoints, shell commands, environment values, or executable trust settings. Users may explicitly select additional extension-support files through a package snapshot, subject to the exclusions and source-root rules below.

### Independent snapshots and compatibility

Store imported resources in content-addressed, Tau-owned generation directories under <tau-agent-dir>/imports/pi/. Materialize files as new copies, not hardlinks or source symlinks; rewrite supported resource-path settings to those copies. Keep existing pi package manifest fields unchanged. Preserve complete local package contents needed by declared entrypoints and reviewed installed dependency files; do not run extension factories, package installs, dependency lifecycle scripts, or model calls during inventory, copy, or validation.

For installed npm/git packages, snapshot the actual available package resource tree and dependency files and record declared source, resolved version or commit when available, and content hashes. Do not claim a mutable tag or uninstalled declaration is a reproducible snapshot. Missing dependencies or unresolved package locations block that resource; import must never silently retain a source-Pi path or fetch code from the network. Test that supported imported packages remain runnable after the Pi source tree is removed.

Allow safe symlinks only when their canonical target remains within that selected resource/package root; materialize the target as a regular copied entry. Reject escaping links, cycles, device nodes, FIFOs, sockets, path traversal, unsupported file kinds, and source/destination overlap. File manifests use normalized relative paths; revalidate canonical containment and hashes during apply. Source mutation invalidates the plan and requires a new dry run rather than accepting stale approval. Do not infer dependencies from arbitrary dynamic imports; unresolved dependencies are reported, and successful fixture coverage is not a universal portability guarantee.

Known auth, trust, session, debug-log, credential, environment, and repository-secret files are excluded, including auth.json, trust.json, sessions/, .env and .env.*, .ssh/, .aws/, .git/, and private-key files. Exclusions apply inside package snapshots too. If an excluded file is required for a selected resource, block it rather than quietly make a broken snapshot. Arbitrary secrets embedded in extension code cannot be detected reliably; warn users about that limit and do not claim automatic secret removal.

### Transaction and conflicts

Default conflicts are errors; --on-conflict skip leaves existing destination resources/preferences untouched. This stage has no overwrite/replace mode. Content-identical imports are idempotent; deduplicate resources and configuration entries by canonical snapshot identity.

Hold an exclusive Tau import/settings lock. Stage files under Tau on the same filesystem, validate hashes and manifests, and prepare merged settings against the locked current settings. Publish the immutable generation with rename, then replace settings atomically using a same-directory temporary file. Maintain a content-free transaction journal with hashes and states to recover the multi-file operation; do not claim the generation and settings renames are one atomic transaction.

Startup and subsequent mutating import/activation operations must reconcile an incomplete journal before discovering resources: either finish a fully validated publication or retain the old settings and remove only importer-owned staging/unreferenced generation paths. Read-only dry runs never perform recovery writes; they report an incomplete-journal diagnostic and require recovery through startup or a mutating operation before producing an applicable plan. Never roll back another writer's newer settings or remove unowned paths. Detect concurrent settings changes, disk-full/permission errors, crashes at every publication step, and unavailable locks. Import failure must leave a coherent previously usable Tau configuration and must not modify Pi's source tree.

Copied code receives no imported trust grant. Inventory/apply never executes it. Activation is separately authorized by `tau import activate <import-id>` after showing its resource summary and validating unchanged hashes; do not add newly copied executable resources to active settings before that decision. This activation command also uses the lock/journal protocol. Reuse of a denied-trust Pi project does not imply consent to activate its extensions.

## Whole-process isolation

### Modes and boundary

Trusted mode remains the default for compatibility and is explicitly unrestricted. Add `tau --isolated [--sandbox-network=on|off] [--sandbox-env <NAME> ...] ...`; isolated mode defaults to network on. Online provider subscriptions are the primary use case: normal login, token refresh, streaming, and custom endpoints must work without opting into network access. Network off is an explicit offline mode, not the normal sandbox default. A trusted bootstrap launcher must establish the OS boundary before the Tau runtime reads user/project settings or imports extensions. It may inspect its own installation metadata and validate explicit paths. User-supplied code preloaded into the already-running parent interpreter is outside this child boundary; the launcher must not forward such preloads or ambient descriptors to the sandbox. The same boundary covers extension top-level code, tools, direct Node filesystem/process/network calls, and descendant processes. Wrapping only bash/read/write tools does not satisfy this requirement.

The first backend targets Linux bubblewrap. Read-only inspection found /usr/bin/bwrap version 0.13.0 on this host; availability is not evidence that user namespaces work. Require a real preflight and runtime probes. Missing backend, unsupported platform, unavailable namespaces, invalid mounts, or failed preflight produce a nonzero result before user code loads, never a retry in trusted mode.

### Exposure policy

Build an allowlist namespace, not a whole-host bind with a few blacklisted paths. Expose only the selected project directory and Tau state as writable, the Tau installation/runtime dependency closure as read-only, minimal required system runtime files, private temporary storage, and private process/device views. Reject a project/root selection that would expose the host home directory, filesystem root, or Pi-managed state; hide project .pi directories even inside otherwise allowed projects. Canonicalize paths and reject overlap/escape before launch. Do not mount Pi's user state, known Pi installation roots, host credential stores, SSH-agent sockets, Docker sockets, host /run, or host process views. Files copied by the user into an explicitly allowed project are outside the hidden-source confidentiality guarantee.

Use user/mount/PID/IPC/UTS namespace separation, dropped capabilities, and parent-death cleanup. Create a separate network namespace only for explicit network off; network on shares network access. Keep only required stdio descriptors; close inherited auxiliary descriptors. Construct a sanitized environment from an explicit allowlist, stripping Pi state overrides, NODE_OPTIONS/preload settings, ambient proxy/credential variables, agents, and unrelated host configuration. Use a private HOME and explicit Tau state mapping. Tau-owned subscription credentials stored in approved Tau state remain available for login and refresh; never automatically copy or expose Pi authentication files.

For API-key or corporate-proxy workflows, --sandbox-env explicitly forwards a named provider/proxy variable chosen by the user; display the variable name, never its value. Reject reserved state/loader/process-injection variables, including HOME, PATH, NODE_OPTIONS, LD_PRELOAD, LD_LIBRARY_PATH, BASH_ENV, ENV, and PI_*/TAU_* state overrides. No wildcard or whole-environment forwarding. A forwarded secret is intentionally available to all extensions within this process boundary; that is not per-extension secret isolation. Custom endpoints use Tau-owned provider configuration; do not widen filesystem mounts to recover hidden Pi configuration.

Network on is the default for provider use. It does not enforce domain filtering, block reachable localhost services or network-namespace-scoped abstract Unix sockets, or prevent an extension from transmitting data it can read. Hidden filesystem-backed host sockets stay inaccessible because their paths are not mounted, but no general host-service isolation is claimed with shared networking. Print the effective filesystem, credential-variable names, and network exposure before execution without printing secrets.

Explicit network off must deny IP/host-loopback connections and host network-namespace sockets while retaining filesystem/process isolation. No automatic switch back to online mode if a provider request fails. A provider-only egress broker is future work, not part of first-stage guarantees.

Legacy extensions run unchanged inside this sandbox and can use Node/system APIs within the exposed environment. Extensions depending on hidden Pi files, external paths, daemons, or network services may fail; report the unmet boundary without broadening mounts or falling back. Direct source-Pi reuse is rejected in isolated mode; independently import resources first.

### Acceptance and limits

Actual sandbox subprocess tests must show supported imported extensions/tools work with default online networking while hidden Pi filesystem state, unselected host credentials, host process views, and hidden filesystem-backed sockets remain inaccessible. Test direct Node calls, top-level factory side effects, symlink escapes, and spawned descendants, not just host-mediated tools. Repeat the filesystem/process denial tests with explicit network off and separately verify IP/loopback/network-namespace socket denial only in that mode. Use trusted-mode controls where safe, with synthetic files and local servers only.

Positive default-mode tests must exercise the production authentication/provider paths against local mock OAuth/provider endpoints: authorization URL and callback, token exchange and refresh, persisted Tau auth reused on restart, streamed responses, cancellation, custom endpoints, and explicitly forwarded synthetic API-key/proxy variables. Verify Pi auth remains unchanged and synthetic credentials never appear in logs/reports. No real provider subscriptions, tokens, or paid requests are used. A callback bound to localhost is reachable in default network-on mode; explicit offline mode may fail provider operations clearly without relaxing its policy.

Sandbox failure is fail-closed behavior, not a reason to skip isolation acceptance. On this Linux target, working end-to-end sandbox probes are required before first-stage completion; if namespaces are unavailable, report a blocked acceptance gate and request an explicitly approved alternative backend. Unsupported-platform refusal tests do not establish native macOS/Windows isolation.

This is a process boundary, not a VM, kernel-exploit defense, or separation between mutually untrusted extensions. It does not protect the selected writable project or Tau state from extensions granted access to them. A future restricted host can provide finer per-extension grants.

## Extension compatibility contract

### Imports and packages

Retain all presently supported public legacy aliases found in the upstream loader and virtual-module registry. Ensure source, unbundled Node, and bundled Node resolutions refer to the same Tau host implementations rather than accidentally loading a second copy of upstream Pi. Compile fixture types against the supported public declarations as well as exercising runtime loading.

Continue accepting existing pi package resource manifests unchanged. Any future tau-specific metadata is additive and optional; no extension needs a new manifest merely to run.

Extensions that spawn a hardcoded pi executable, use private internal imports, depend on a specific ~/.pi path, or rely on undocumented host state are not automatically made Tau-native. Document these limitations and exercise representative cases so they do not fail silently in compatibility diagnostics later.

### API and events

Preserve factory signatures, existing API methods, handler arguments and results, ordering, short-circuit behavior, error propagation, and unsubscribe behavior at the recorded upstream baseline. Do not impose new ordering contracts on legacy extensions.

Retain transactional loading behavior: a failed extension must not leave active event subscriptions or queued runtime registrations behind. Preserve existing cache invalidation, reload cleanup, and stale-context protections.

Additive API fields must not require existing extensions to adopt them. New metadata must not claim complete dependencies or capabilities for extensions that did not declare them.

### Future integration boundary

These are design constraints for subsequent stages, not features delivered by this stage:
- Diagnostics inspect legacy registrations, with undeclared dependencies labeled unknown.
- Context provenance attributes observable host transformations, without claiming visibility into arbitrary extension internals.
- Lifecycle tracking covers host-mediated operations; private detached work needs extension participation.
- Profiles support legacy manifests and explicit reproducible snapshots of local resources.
- A future restricted extension host is opt-in and never silently falls back to unrestricted execution. Whole-process isolation is already required in this first stage; finer per-extension grants remain later work.

## Testing and acceptance criteria

Use unchanged extension fixture source wherever testing legacy compatibility. Fixtures must use both supported package-name families and the APIs they claim to exercise, not merely check alias keys.

Required automated coverage:
- Tau help/version and application/configuration identity.
- Default and overridden Tau state paths, project paths, session paths, and no host writes to Pi state.
- Legacy package resource discovery and explicit extension path reuse.
- Source, unbundled Node, and bundled Node loading with supported public imports and shared host identity.
- Tools, commands, flags, shortcuts, renderers, provider registration, and supported UI registration behavior.
- Multiple-extension event order, transformation chains, short-circuit behavior, exceptions, and unsubscribe semantics compared to the upstream baseline.
- Failed factory rollback, cache behavior, reload cleanup, and stale-context rejection.
- Type-level extension fixtures and strict checking of new code.
- Tau update behavior never targeting an upstream package or release.
- Import dry run has zero source/destination writes and no code execution; independent activation is required.
- Copy independence after removing Pi sources; safe path rebasing and complete supported dependency snapshots.
- Conflict/idempotence handling, source mutation, symlink traversal, secret exclusions, concurrent settings changes, and crash recovery at every journal state.
- Real Linux sandbox probes deny hidden Pi filesystem/unselected credential access, hidden filesystem-backed host sockets, host process visibility, and descendant escapes while supported imported legacy extensions work with networking enabled by default.
- Production-path mock OAuth/login/refresh/restart and streaming/custom-endpoint tests pass in default isolated mode; synthetic API-key/proxy forwarding is explicit and redacted.
- Explicit network-off probes deny IP/loopback/network-namespace socket access without silently enabling networking.
- Fail-closed sandbox preflight and unsupported-platform behavior before extension evaluation.

Use the repository's faux provider and suite harness for agent integration tests. Run targeted tests after changes, npm run check, and ./test.sh for non-live regression coverage. Inspect the test wrapper and check scripts before execution; do not invoke live-provider test suites or expose credentials. Run packaging smoke tests in isolated temporary directories with controlled environment settings. Exercise interactive behavior following the repository's interactive-testing skill where applicable.

Biome is the formatter; do not add a competing formatter. Require no explicit any in newly introduced Tau code and use unknown plus validation at untrusted boundaries. Avoid a repository-wide formatting or typing rewrite as part of this foundation.

Record every executed check, result, and any skipped platform/runtime with its reason. A skipped supported-runtime test is a stated verification gap, not a passing result. Passing tests reduce risk; they do not establish zero bugs or a security boundary.

Acceptance requires a runnable Tau artifact, independent import/activation with crash-safe recovery, isolated default state, working representative unchanged extensions in trusted and Linux isolated modes, real sandbox-denial probes, retained attribution, and all required locally executable checks passing. If baseline tests fail before changes, diagnose and report them separately; do not hide failures by deleting tests or lowering assertions.

## Error handling and operational safety

Stop on repository-name collision, unexpected local directory contents, missing GitHub permissions, or incompatible runtime prerequisites. Do not overwrite an existing repository or installation, force-push, publish packages, or run dependency lifecycle scripts without explicit authorization.

Install dependencies with lifecycle scripts disabled. Keep dependency versions and lockfiles consistent with upstream rules. Inspect new or changed dependencies rather than treating lockfile changes as formatting noise.

## Review and execution gates

This written spec requires user approval. After approval, write and self-review a concrete implementation plan based on actual upstream files, then request plan review and execution-method selection. Creating the GitHub fork and modifying product code begin only after those gates.

Do not create a commit in the user's directories merely to store this pre-fork document. Once a working repository exists, copy the approved spec into its docs/superpowers/specs directory. Any commits or pushes follow explicit user authorization and repository rules.

## Self-review

- Expanded scope includes independent import and real whole-process isolation in the first stage; finer extension capabilities and the other roadmap features remain separate.
- Compatibility distinguishes supported public behavior from undocumented internals and sandbox exposure requirements.
- Direct reuse and independent copy/import are distinct; copied code is not activated by import alone.
- Multi-file publication uses locking/journaling/recovery rather than claiming impossible cross-file atomicity.
- Trusted mode remains unrestricted; isolated mode launches before settings/extensions and fails closed.
- Linux sandbox acceptance requires actual filesystem/process denial probes in both network modes, positive online-provider probes by default, and network-denial probes only for explicit offline mode; unsupported platform gaps are explicit.
- Fork creation, implementation, publishing, and commit permissions remain explicit.
