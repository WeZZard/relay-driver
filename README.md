# Relay Driver

Relay actions from existing tools and scripts, then review the screen recording beside a synchronized explanation. The core supports arbitrary backend integrations; Playwright, Chrome DevTools, and cua-driver are examples.

The project provides SDK support for JavaScript, TypeScript, and Python, together with a CLI. The SDK and CLI share the walkthrough identity, evidence, and timing contracts.

Both operations submitted through SSH and scripts uploaded for remote execution must record individual events and timestamps under the same contract. The [execution requirements](docs/decisions.md#execution) and [verification contracts](docs/engineering/verification.md) define the required proof.

Status: the design in this repository is implemented. Five TypeScript packages under `packages/` — the core evidence/identity/timing primitives, the host SDK, the remote runtime, the script-side SDK, and the CLI — each ship compiled output and unit tests; a Python host SDK and script SDK live alongside them as source (not yet published to a package index); a local web viewer under `viewer/` renders a delivered package for review.

## Packages

| Package | Purpose |
| --- | --- |
| [`@wezzard/relay-driver-core`](packages/core) | Backend-independent evidence, identity, and timing primitives. |
| [`@wezzard/relay-driver-host-sdk`](packages/host-sdk) | TypeScript host SDK: drive a session over SSH and assemble the evidence package. |
| [`@wezzard/relay-driver-remote-runtime`](packages/remote-runtime) | The remote runtime: admission, capture gating, and per-call recording on the target machine. |
| [`@wezzard/relay-driver-script-sdk`](packages/script-sdk) | Script-side SDK for uploaded JavaScript, TypeScript, and Python scripts. |
| [`@wezzard/relay-driver-cli`](packages/cli) | Command-line interface: inspect sessions and executions, verify packages, serve the viewer. |

Install the one you need, for example:

```sh
npm install @wezzard/relay-driver-host-sdk
```

The CLI installs globally as `relay-driver`:

```sh
npm install -g @wezzard/relay-driver-cli
```

The Python host SDK ([`packages/host-sdk-python`](packages/host-sdk-python)) and the Python script SDK ([`packages/script-sdk/relay_script`](packages/script-sdk/relay_script)) are source-only for now; vendor them directly until they are published.

## The problem

A MOV file and a prose timestamp make the reviewer search for the evidence. A walkthrough should let the reviewer select “Increase padding,” watch the actual interaction, and inspect the resulting save confirmation. The recording, action history, and explanation need a shared, verifiable timeline.

## Design documentation

The [documentation guide](docs/CLAUDE.md) describes the design tree and its maintenance rules. Owner decisions are distinguished from architect-derived mechanisms. Open discussions live in `.plans/`.

| Document | Purpose |
| --- | --- |
| [Decisions](docs/decisions.md) | Owner-confirmed requirements. |
| [User profiles](docs/user-profiles.md) | The operator and reviewer responsibilities. |
| [User stories](docs/user-stories/index.md) | Capabilities and acceptance criteria, indexed by profile. |
| [Review experience](docs/ux/sitemap.md) | Viewer navigation, wireframes, and the review flow. |
| [Architecture](docs/arch/index.md) | Design philosophy and subsystem behavior. |
| [Engineering](docs/engineering/CLAUDE.md) | Environments, adapters, capture timing, artifact format, and verification contracts. |
| [Operations](docs/ops/README.md) | Recording, interruption recovery, export, and human review procedures. |

## Working material

Open discussions, unresolved choices, tentative proposals, execution plans, and progress live in Markdown documents under ignored `.plans/`; run reviews live in ignored `.reviews/`. Their first-level entries use a `YYYY-MM-DD-HH-MM-<name>` prefix. Keep each plan and its related open discussions in one dated Markdown file. Once a discussion is resolved, update the applicable design documents and record any owner-confirmed decision in `docs/decisions.md`. Runtime artifacts remain outside the tracked design tree.

Environment selection, remote-computer and VM lifecycle, and the walkthrough capture policy are set by the deploying organization's own governing environment policy, which this repository does not ship. Image baselines are supplied externally too; see [Environments](docs/engineering/environments.md) for the interface Relay Driver expects from that policy.

## Releasing

Cut a release with:

```sh
node scripts/bump.mjs X.Y.Z && git push --follow-tags
```

`scripts/bump.mjs` sets `X.Y.Z` as the version of all five packages (and their internal `^` dependency ranges), refreshes `package-lock.json`, commits `Release vX.Y.Z`, and creates the annotated tag `vX.Y.Z`. It refuses to run against a dirty working tree or a malformed version, and it never pushes — `git push --follow-tags` is a separate, explicit step.

Pushing the tag triggers [`.github/workflows/release.yml`](.github/workflows/release.yml), which builds, tests, and publishes the packages to npm in dependency order (core, host-sdk, remote-runtime, script-sdk, cli) using npm's [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC — no `NPM_TOKEN` secret involved), then creates the matching GitHub release.

Trusted publishing has to be configured per package on npmjs.com, and npm requires the package to already exist before you can do that. The **first** publish of a brand-new package must therefore be done by hand (`npm publish -w packages/<name> --access public` from a maintainer's machine) before its trusted publisher can be configured for this workflow.

## License

MIT — see [LICENSE](LICENSE).
