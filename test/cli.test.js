import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../bin/js-test-doctor.js", import.meta.url));

function withProject(files, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "js-test-doctor-cli-"));
  try {
    for (const [relative, contents] of Object.entries(files)) {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents);
    }
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function manifest(value) {
  return JSON.stringify(value, null, 2);
}

function runCli(root, args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 5000
  });
}

test("prints valid JSON without an absolute project path", () => {
  withProject({
    "package.json": manifest({ name: "sample" })
  }, root => {
    const result = runCli(root, ["--format", "json"]);
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.tool, "js-test-doctor-cli");
    assert.equal(output.root, ".");
    assert.equal(output.projectCount, 1);
    assert.ok(output.findings.some(item => item.code === "NO_SUPPORTED_RUNNER"));
    assert.equal(output.root.includes(root), false);
  });
});

test("prints a Markdown report", () => {
  withProject({
    "package.json": manifest({ name: "sample", scripts: { test: "vitest run" } })
  }, root => {
    const result = runCli(root, ["--format", "markdown"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^# JS Test Doctor report/);
    assert.match(result.stdout, /TEST\\_RUNNER\\_NOT\\_DECLARED/);
  });
});

test("prints GitHub Actions annotations", () => {
  withProject({
    "package.json": manifest({ name: "sample", scripts: { test: "jest" } })
  }, root => {
    const result = runCli(root, ["--format", "github"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^::error file=package\.json,line=\d+,title=TEST_RUNNER_NOT_DECLARED/);
  });
});

test("prints parseable SARIF 2.1.0 output", () => {
  withProject({
    "package.json": manifest({ name: "sample", scripts: { test: "jest" } })
  }, root => {
    const result = runCli(root, ["--format", "sarif"]);
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.version, "2.1.0");
    assert.ok(output.runs[0].tool.driver.rules.some(rule => rule.id === "TEST_RUNNER_NOT_DECLARED"));
    assert.ok(output.runs[0].results.some(item => item.locations?.[0]?.physicalLocation?.artifactLocation?.uri === "package.json"));
  });
});

test("strict mode exits 1 for a high-confidence error", () => {
  withProject({
    "package.json": manifest({ name: "sample", scripts: { test: "jest" } })
  }, root => {
    const result = runCli(root, ["--strict"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /TEST_RUNNER_NOT_DECLARED/);
  });
});

test("accepts a root directory and analyzes a supplied log", () => {
  withProject({
    "app/package.json": manifest({ name: "sample", devDependencies: { vitest: "^3.0.0" } }),
    "app/failure.log": "Test failed\nReferenceError: document is not defined\n"
  }, root => {
    const result = runCli(root, ["--root", "app", "--log", "failure.log", "--format", "json"]);
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.ok(output.findings.some(item => item.code === "LOG_BROWSER_GLOBAL_MISSING"));
    const finding = output.findings.find(item => item.code === "LOG_BROWSER_GLOBAL_MISSING");
    assert.equal(finding.file, "failure.log");
    assert.equal(finding.line, 2);
  });
});

test("help and version do not scan a project", () => {
  withProject({}, root => {
    const help = runCli(root, ["--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage:/);
    const version = runCli(root, ["--version"]);
    assert.equal(version.status, 0);
    assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
  });
});

test("invalid arguments exit 2 with a useful message", () => {
  withProject({
    "package.json": manifest({ name: "sample" })
  }, root => {
    const result = runCli(root, ["--format", "yaml"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Unsupported output format/);
  });
});

test("unreadable log input exits 2 without a stack trace", () => {
  withProject({
    "package.json": manifest({ name: "sample" })
  }, root => {
    const result = runCli(root, ["--log", "missing.log"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Cannot read log file/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  });
});
