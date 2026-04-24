# @superlog/cli

[![npm](https://img.shields.io/npm/v/@superlog/cli?color=2E4BFF&label=npm)](https://www.npmjs.com/package/@superlog/cli)
[![npm downloads](https://img.shields.io/npm/dm/@superlog/cli?color=2E4BFF)](https://www.npmjs.com/package/@superlog/cli)
[![CI](https://img.shields.io/github/actions/workflow/status/superloglabs/cli/ci.yml?branch=main&label=CI)](https://github.com/superloglabs/cli/actions)
[![License: MIT](https://img.shields.io/badge/license-MIT-2E4BFF)](LICENSE)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-2E4BFF)](package.json)

Instrument your project and start shipping observability in under a minute.

```sh
npx @superlog/cli
```

---

## What it does

`superlog init` detects your stack, writes the OTel instrumentation, and points your spans at [Superlog](https://superlog.sh) — your project starts receiving traces, logs, and metrics immediately.

From there, Superlog surfaces error patterns as issues, lets your AI tools query telemetry over MCP, and can propose fixes via a managed agent that opens PRs against your repo.

## Usage

```sh
# One-shot setup (no install needed)
npx @superlog/cli

# Or install globally
npm i -g @superlog/cli
superlog init
```

### Options

```
superlog init [--cwd <path>]

  --cwd   Project directory to instrument (default: current directory)
```

### Agent management (macOS)

Superlog can run a local on-host agent via launchd:

```sh
superlog agent install \
  --endpoint https://intake.superlog.sh \
  --token <ingest-token> \
  --project-id <project-id> \
  --service-name <my-service>

superlog agent status
superlog agent uninstall
```

## Requirements

- Node.js ≥ 20
- A [Superlog](https://superlog.sh) account (the CLI walks you through sign-up)

## Publishing a new version

Tag a release — CI handles the rest:

```sh
npm version patch   # or minor / major
git push origin main --tags
```

## License

MIT
