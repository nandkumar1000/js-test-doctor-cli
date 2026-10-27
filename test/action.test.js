import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ACTION_PATH = fileURLToPath(new URL("../action/run.js", import.meta.url));
const ACTION_YML_PATH = fileURLToPath(new URL("../action.yml", import.meta.url));

function withProject(files, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "js-test-doctor-action-"));
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

function runAction(root, inputs = {}) {
  return spawnSync(process.execPath, [ACTION_PATH], {
    cwd: root,
    encoding: "utf8",
    timeout: 5000,
    env: {
      ...process.env,
      INPUT_ROOT: inputs.root ?? ".",
      INPUT_LOG: inputs.log ?? "",
      INPUT_STRICT: inputs.strict ?? "false"
    }
  });
}

function manifest(value) {
  return JSON.stringify(value, null, 2);
}

test("composite action uses its checked-in runner and maps inputs through env", () => {
  const action = fs.readFileSync(ACTION_YML_PATH, "utf8");
  assert.match(action, /using: composite/);
  assert.match(action, /GITHUB_ACTION_PATH\/action\/run\.js/);
  assert.match(action, /INPUT_ROOT:\s*\$\{\{ inputs\.root \}\}/);
  assert.match(action, /INPUT_LOG:\s*\$\{\{ inputs\.log \}\}/);
  assert.match(action, /INPUT_STRICT:\s*\$\{\{ inputs\.strict \}\}/);
  assert.doesNotMatch(action, /npx/);
});

test("action handles project paths with spaces and strict mode", () => {
  withProject({
    "web app/package.json": manifest({ name: "sample", scripts: { test: "jest" } })
  }, root => {
    const result = runAction(root, { root: "web app", strict: "true" });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /::error file=package\.json/);
    assert.match(result.stdout, /TEST_RUNNER_NOT_DECLARED/);
  });
});

test("action analyzes an optional saved log and leaves strict mode opt-in", () => {
  withProject({
    "app/package.json": manifest({ name: "sample", devDependencies: { vitest: "^3.0.0" } }),
    "app/failed test.log": `No "default" export is defined on the "./api" mock. Did you forget to return it from "vi.mock"?\n`
  }, root => {
    const result = runAction(root, { root: "app", log: "failed test.log" });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /LOG_VITEST_MOCK_EXPORT_MISSING/);
  });
});

test("action rejects an invalid strict input", () => {
  withProject({
    "package.json": manifest({ name: "sample" })
  }, root => {
    const result = runAction(root, { strict: "sometimes" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /strict must be 'true' or 'false'/);
  });
});
