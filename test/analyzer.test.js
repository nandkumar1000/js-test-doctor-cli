import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeProject } from "../src/analyzer.js";

function withProject(files, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "js-test-doctor-"));
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

function codes(report) {
  return report.diagnostics.map(item => item.code);
}

test("finds a Jest test script whose runner is not declared", () => {
  withProject({
    "package.json": manifest({ name: "sample", scripts: { test: "jest --runInBand" } })
  }, root => {
    const report = analyzeProject(root);
    const result = report.diagnostics.find(item => item.code === "TEST_RUNNER_NOT_DECLARED");
    assert.ok(result);
    assert.equal(result.severity, "error");
    assert.equal(result.confidence, "high");
    assert.equal(result.file, "package.json");
  });
});

test("finds Vitest jsdom when jsdom is not declared", () => {
  withProject({
    "package.json": manifest({
      name: "sample",
      devDependencies: { vitest: "^3.0.0" }
    }),
    "vitest.config.ts": "export default { test: { environment: 'jsdom' } };\n"
  }, root => {
    const report = analyzeProject(root);
    const result = report.diagnostics.find(item => item.code === "VITEST_JSDOM_NOT_DECLARED");
    assert.ok(result);
    assert.equal(result.file, "vitest.config.ts");
    assert.equal(result.line, 1);
  });
});

test("finds a missing literal Jest setup file", () => {
  withProject({
    "package.json": manifest({
      name: "sample",
      devDependencies: { jest: "^30.0.0" },
      jest: { setupFilesAfterEnv: ["<rootDir>/test/setup.js"] }
    })
  }, root => {
    const report = analyzeProject(root);
    const result = report.diagnostics.find(item => item.code === "JEST_SETUP_FILE_MISSING");
    assert.ok(result);
    assert.equal(result.file, "package.json");
    assert.equal(result.confidence, "high");
  });
});

test("finds a CommonJS Jest config inside an ESM package", () => {
  withProject({
    "package.json": manifest({ name: "sample", type: "module", devDependencies: { jest: "^30.0.0" } }),
    "jest.config.js": "module.exports = { testEnvironment: 'node' };\n"
  }, root => {
    const report = analyzeProject(root);
    const result = report.diagnostics.find(item => item.code === "JEST_CONFIG_MODULE_FORMAT");
    assert.ok(result);
    assert.equal(result.file, "jest.config.js");
    assert.equal(result.line, 1);
  });
});

test("finds likely unmapped TypeScript aliases in Vitest", () => {
  withProject({
    "package.json": manifest({
      name: "sample",
      devDependencies: { vitest: "^3.0.0" },
      scripts: { test: "vitest run" }
    }),
    "tsconfig.json": manifest({ compilerOptions: { paths: { "@/*": ["src/*"] } } }),
    "vitest.config.ts": "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });\n"
  }, root => {
    const report = analyzeProject(root);
    const result = report.diagnostics.find(item => item.code === "VITEST_TYPESCRIPT_PATHS_UNMAPPED");
    assert.ok(result);
    assert.equal(result.confidence, "medium");
    assert.equal(result.file, "tsconfig.json");
  });
});

test("scans declared workspaces and reports relative package locations", () => {
  withProject({
    "package.json": manifest({ name: "root", workspaces: ["packages/*"] }),
    "packages/web/package.json": manifest({
      name: "web",
      scripts: { test: "vitest run" },
      devDependencies: { vitest: "^3.0.0" }
    })
  }, root => {
    const report = analyzeProject(root);
    assert.equal(report.projectCount, 2);
    assert.ok(report.projects.some(item => item.path === "packages/web"));
    assert.ok(report.projects.find(item => item.path === "packages/web").runners.includes("vitest"));
    assert.equal(codes(report).includes("NO_SUPPORTED_RUNNER"), false);
  });
});

test("treats regex metacharacters in workspace names as literal characters", () => {
  withProject({
    "package.json": manifest({ name: "root", workspaces: ["packages/a{2}"] }),
    "packages/a{2}/package.json": manifest({ name: "literal-workspace", devDependencies: { vitest: "^3.0.0" } })
  }, root => {
    const report = analyzeProject(root);
    assert.equal(report.projectCount, 2);
    assert.ok(report.projects.some(item => item.path === "packages/a{2}"));
  });
});

test("reports conflicting lockfiles and a packageManager mismatch", () => {
  withProject({
    "package.json": manifest({
      name: "sample",
      packageManager: "pnpm@10.0.0",
      devDependencies: { vitest: "^3.0.0" }
    }),
    "package-lock.json": "{\"lockfileVersion\": 3}\n",
    "yarn.lock": "# yarn lockfile v1\n"
  }, root => {
    const report = analyzeProject(root);
    assert.ok(codes(report).includes("MULTIPLE_LOCKFILES"));
    assert.ok(codes(report).includes("PACKAGE_MANAGER_LOCKFILE_MISMATCH"));
  });
});

test("excludes negated workspace patterns", () => {
  withProject({
    "package.json": manifest({ name: "root", workspaces: ["packages/*", "!packages/legacy"] }),
    "packages/app/package.json": manifest({ name: "app", devDependencies: { vitest: "^3.0.0" } }),
    "packages/legacy/package.json": manifest({ name: "legacy", devDependencies: { jest: "^30.0.0" } })
  }, root => {
    const report = analyzeProject(root);
    assert.equal(report.projects.some(item => item.name === "app"), true);
    assert.equal(report.projects.some(item => item.name === "legacy"), false);
  });
});

test("returns a finding for malformed package.json without throwing", () => {
  withProject({
    "package.json": "{\n  \"name\": \"broken\",\n  \"scripts\": {\n"
  }, root => {
    const report = analyzeProject(root);
    const result = report.diagnostics.find(item => item.code === "PACKAGE_JSON_INVALID");
    assert.ok(result);
    assert.equal(result.line, 1);
  });
});

test("uses the log file and line for a browser-global failure", () => {
  withProject({
    "package.json": manifest({ name: "sample", devDependencies: { vitest: "^3.0.0" } }),
    "test-output.txt": "RUN tests/view.test.ts\nReferenceError: document is not defined\n"
  }, root => {
    const report = analyzeProject(root, { logPath: "test-output.txt" });
    const result = report.diagnostics.find(item => item.code === "LOG_BROWSER_GLOBAL_MISSING");
    assert.ok(result);
    assert.equal(result.file, "test-output.txt");
    assert.equal(result.line, 2);
  });
});

test("explains the common Jest mock factory scope error in a supplied log", () => {
  withProject({
    "package.json": manifest({ name: "sample", devDependencies: { jest: "^30.0.0" } }),
    "test-output.txt": "The module factory of `jest.mock()` is not allowed to reference any out-of-scope variables. Invalid variable access: client\n"
  }, root => {
    const report = analyzeProject(root, { logPath: "test-output.txt" });
    const finding = report.diagnostics.find(item => item.code === "LOG_JEST_MOCK_FACTORY_SCOPE");
    assert.ok(finding);
    assert.equal(finding.severity, "error");
    assert.equal(finding.line, 1);
    assert.match(finding.fix, /inside the jest\.mock factory/);
  });
});

test("explains a missing Vitest mock export in a supplied log", () => {
  withProject({
    "package.json": manifest({ name: "sample", devDependencies: { vitest: "^3.0.0" } }),
    "test-output.txt": `No "default" export is defined on the "./api" mock. Did you forget to return it from "vi.mock"?\n`
  }, root => {
    const report = analyzeProject(root, { logPath: "test-output.txt" });
    const finding = report.diagnostics.find(item => item.code === "LOG_VITEST_MOCK_EXPORT_MISSING");
    assert.ok(finding);
    assert.equal(finding.severity, "error");
    assert.equal(finding.line, 1);
    assert.match(finding.fix, /importOriginal/);
  });
});

test("does not execute project setup code or modify project files", () => {
  withProject({
    "package.json": manifest({
      name: "sample",
      devDependencies: { vitest: "^3.0.0" }
    }),
    "vitest.config.ts": "export default { test: { setupFiles: ['./test/setup.js'] } };\n",
    "test/setup.js": "require('node:fs').writeFileSync('executed.marker', 'bad');\n"
  }, root => {
    const before = fs.readFileSync(path.join(root, "package.json"), "utf8");
    const report = analyzeProject(root);
    assert.ok(report);
    assert.equal(fs.existsSync(path.join(root, "executed.marker")), false);
    assert.equal(fs.readFileSync(path.join(root, "package.json"), "utf8"), before);
  });
});

test("does not follow workspace patterns into node_modules", () => {
  withProject({
    "package.json": manifest({ name: "root", workspaces: ["**/*"] }),
    "node_modules/hidden/package.json": manifest({ name: "hidden", devDependencies: { jest: "^30.0.0" } })
  }, root => {
    const report = analyzeProject(root);
    assert.equal(report.projectCount, 1);
    assert.equal(report.projects.some(item => item.name === "hidden"), false);
  });
});
