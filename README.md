# pi-plugins

Pi extensions and skills maintained together as one package. Each extension has its own entry point under `extensions/`; the root [package manifest](package.json) declares which resources Pi loads.

## Install

```bash
pi install git:github.com/ltxgit/pi-plugins@v0.1.0
```

Use a release tag or commit in the package reference when selecting a version for multiple devices. Pi installs runtime dependencies for Git packages. Run `/reload` in an existing Pi session after changing the installed package.

Extensions share package dependencies and one release version. Use Pi's resource filters in settings to enable a subset of the declared extensions and skills on a device.

## Extensions

- [Notify](docs/notify.md): desktop and remote notifications for completed runs and blocking prompts. Its settings remain in `~/.pi/agent/notify.json` on each device.

## Development

Run from the repository root:

```bash
bun install --frozen-lockfile
bun run test
bun run typecheck
bun run format:check
```

Add an extension under `extensions/` and declare its entry point in `package.json`. Keep runtime dependencies in `dependencies`, Pi host APIs in `peerDependencies`, and SDK packages used by tests and type checking in `devDependencies`.

Licensed under [MIT](LICENSE). Notify is derived from [`@pi-unipi/notify`](https://github.com/Neuron-Mr-White/UniPi/tree/main/packages/notify); the upstream copyright notice is retained in the license.

Pi package installation, resource filtering, and dependency rules are defined in the [Pi package documentation](https://pi.dev/docs/latest/packages).
