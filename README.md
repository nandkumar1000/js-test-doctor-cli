# JS Test Doctor

[![CI](https://github.com/nandkumar1000/js-test-doctor-cli/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/nandkumar1000/js-test-doctor-cli/actions/workflows/ci.yml)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Find common Jest and Vitest setup problems before they waste your afternoon.**
JS Test Doctor scans project configuration and can diagnose selected errors from
a saved test log. It gives each finding a code, confidence level, location when
available, explanation, and suggested next step.

The scanner is local and read-only: it does not run your tests or project
scripts, evaluate JavaScript configuration, edit files, or send telemetry.

## Quick start

Requires Node.js 22 or later.

```sh
npx --yes js-test-doctor-cli
```

Scan a workspace package or include a saved test log:

```sh
npx --yes js-test-doctor-cli --root ./apps/web
npx --yes js-test-doctor-cli --log ./test-output.txt
```

## Example

Given a project with Jest 30 declared and a Jest config that selects `jsdom`
without declaring its environment package, the doctor reports:

```text
[ERROR, high confidence] JEST_JSDOM_NOT_DECLARED: Jest requests jsdom but does not declare its environment package
  jest.config.js:2
  The Jest config selects jsdom, but jest-environment-jsdom is not declared in the package manifests.
  Next: Install jest-environment-jsdom as a development dependency compatible with the project's Jest version.
```

## What it checks

- Whether test scripts use Jest or Vitest that the package declares.
- Missing `jest-environment-jsdom`, `jsdom`, or `happy-dom` dependencies for
  configured environments.
- Literal Jest and Vitest setup-file paths that do not exist.
- Common Jest CommonJS config syntax in an ESM package.
- TypeScript path aliases that may not be mapped by the test runner.
- Conflicting lockfiles and `packageManager`/lockfile mismatches.
- Common failures in a supplied test log, including test discovery, browser
  globals, module resolution, Jest mock-factory scope, missing Vitest mock
  exports, and mock state leaks.
- Root packages and declared npm, pnpm, and Yarn workspaces.

Configuration checks are static heuristics. The doctor does not load or execute
JavaScript config files.

## Use in CI

Emit GitHub Actions annotations and fail the job on high-confidence errors:

```yaml
- name: Diagnose test setup
  run: npx --yes js-test-doctor-cli --format github --strict
```

JS Test Doctor is also available as a composite GitHub Action. After the first
tagged action release, add this step after checking out your project and making
Node.js 22 or later available:

```yaml
- name: Diagnose test setup
  uses: nandkumar1000/js-test-doctor-cli@v0.1.0
  with:
    root: .
    strict: true
```

The action runs the checked-in CLI directly, without downloading it from npm.
Its `strict` input defaults to `false`; set it to `true` to fail on
high-confidence errors. Pin the action to a full commit SHA in production.

For machine-readable output, use JSON or SARIF:

```sh
npx --yes js-test-doctor-cli --format json
npx --yes js-test-doctor-cli --format sarif > js-test-doctor.sarif
```

SARIF output follows version 2.1.0. Uploading it to GitHub Code Scanning takes
an additional workflow step, requires `security-events: write`, and depends on
Code Scanning being available for the repository. See [GitHub's SARIF upload
guide](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/integrate-with-existing-tools/upload-sarif-file).

## Options

| Option | Description |
| --- | --- |
| `--root <path>` | Project directory to scan. Defaults to the current directory. |
| `--log <path>` | Also inspect a saved test log (maximum 2 MiB). |
| `--format <format>` | `text` (default), `json`, `markdown`, `github`, or `sarif`. |
| `--strict` | Exit with status 1 when a high-confidence error is found. |
| `--help` | Show command help. |
| `--version` | Show the CLI version. |

Exit codes: `0` for a successful scan, `1` for a high-confidence error with
`--strict`, and `2` for invalid arguments or unreadable input.

## Safety and limitations

- The package has no third-party runtime dependencies.
- The scanner reads manifests, lockfiles, TypeScript settings, test
  configuration, and an optional log. It skips symlinked inputs and limits
  configuration and log file sizes.
- The scanner itself makes no network requests, runs no project code, and
  changes no project files. `npx` may contact npm to download the CLI; shell
  redirection in the SARIF example writes the report file you requested.
- Findings are best-effort static checks, not a replacement for running tests.
  Dynamic configuration, custom runners, unusual workspace layouts, and other
  test frameworks may not be recognized.
- Log analysis reports patterns, not excerpts from the log.

## Development

No third-party development dependencies are required.

```sh
npm test
npm run check
```

Issues and contributions: [GitHub repository](https://github.com/nandkumar1000/js-test-doctor-cli).

## License

[MIT](LICENSE)
