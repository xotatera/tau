# Tau coding agent

Tau is a source-first fork of [Pi](https://github.com/earendil-works/pi). The upstream MIT license and authorship are retained. Its package identity is `@xotatera/tau-coding-agent`, its executable is `tau`, and its default user state is `~/.tau/agent`. No public Tau release or registry publication is implied.

## Run from source

```bash
git clone https://github.com/xotatera/tau
cd tau
npm install --ignore-scripts
./tau-test.sh --help
./tau-test.sh --version
```

The wrapper preserves the caller's working directory. Source checkout validation may require hydrating ignored model data; see the [verification record](../../docs/tau/foundation-verification.md). Build from existing model data with `npm run build:offline`. The built Node CLI is `packages/coding-agent/dist/bundle/cli.js`; the unbundled entry is `dist/cli.js`. Local consumer tests pack workspace dependencies and install them into a temporary directory without lifecycle scripts. They neither publish Tau nor overwrite `pi`.

From a separate project:

```bash
/path/to/tau/tau-test.sh
/path/to/tau/tau-test.sh -e /explicit/path/to/pi-extension.ts
/path/to/tau/tau-test.sh --isolated
/path/to/tau/tau-test.sh --isolated --sandbox-network=off
```

Trusted extensions run with the launching user's permissions. Opt-in isolation requires Linux, trusted system Node and bubblewrap. Default networking is shared: it does not protect exposed data from exfiltration or isolate host-loopback services. Other operating systems and Bun isolation refuse to run, without fallback.

Use `/login` for Tau-owned provider authentication. Importing Pi resources does **not** import Pi credentials or trust. Self-update is disabled: update the source checkout explicitly; Pi release channels are not Tau release channels.

## Import and compatibility

See [the complete compatibility/import/isolation guide](../../docs/tau/compatibility.md) for the read-only inventory, reviewed apply, separate activation, environment forwarding, dependency limits and security boundaries. Public legacy Pi extension imports remain available; hardcoded `pi` subprocesses and private module paths are not translated.

The [inherited API documentation](docs/index.md), pi.dev, Pi community, Pi gallery and Pi OSS session-sharing materials are upstream resources, not Tau-operated services. CLI examples there using `pi` describe upstream naming; use `tau` only where the documented API is supported.

## Development checks

```bash
npm run check
./test.sh
node scripts/tau-isolation-smoke.mjs
```

Run these from the repository root; the real smoke requires built Node artifacts and working Linux namespaces. See [AGENTS.md](../../AGENTS.md) and [CONTRIBUTING.md](../../CONTRIBUTING.md). Do not publish, commit or push without explicit authorization.

## License

MIT. Original Pi authorship and license notices are retained.
