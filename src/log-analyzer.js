import fs from "node:fs";
import path from "node:path";

const MAX_LOG_BYTES = 2 * 1024 * 1024;

function lineFor(text, pattern) {
  const match = pattern.exec(text);
  return match ? text.slice(0, match.index).split(/\r?\n/).length : null;
}

const LOG_RULES = [
  {
    code: "LOG_JEST_MOCK_FACTORY_SCOPE",
    pattern: /The module factory of .* is not allowed to reference any out-of-scope variables/i,
    severity: "error",
    confidence: "high",
    title: "Jest mock factory captures an out-of-scope variable",
    message: "The supplied log reports that a jest.mock factory references a variable outside the scope Jest permits for hoisted factories.",
    fix: "Move dependency creation inside the jest.mock factory. If you use Jest's mock-prefixed variable exception, make sure the value is initialized before the factory runs."
  },
  {
    code: "LOG_VITEST_MOCK_EXPORT_MISSING",
    pattern: /No ["'][^"'\r\n]+["'] export is defined on the ["'][^"'\r\n]+["'] mock/i,
    severity: "error",
    confidence: "high",
    title: "Vitest mock does not provide an imported export",
    message: "The supplied log reports that an imported named or default export is missing from a vi.mock factory result.",
    fix: "Return the missing export from the vi.mock factory. For a partial mock, await importOriginal() and spread the original module before overriding selected exports."
  },
  {
    code: "LOG_NO_TESTS_FOUND",
    pattern: /(?:No test files found|No test files matched|No tests found|No test suite found)/i,
    severity: "warning",
    confidence: "high",
    title: "The test runner did not find tests",
    message: "The supplied log reports that no test files or suites matched the runner's discovery rules.",
    fix: "Check the working directory, test file names, and the runner's include or testMatch settings."
  },
  {
    code: "LOG_BROWSER_GLOBAL_MISSING",
    pattern: /(?:ReferenceError:\s*)?(?:document|window)\s+is not defined/i,
    severity: "warning",
    confidence: "high",
    title: "A test expects browser globals in a non-browser environment",
    message: "The supplied log contains a missing document or window global, which often means the test environment is still Node.",
    fix: "For Jest, configure jsdom and declare jest-environment-jsdom when required. For Vitest, configure jsdom or happy-dom and declare that package."
  },
  {
    code: "LOG_TEST_RUNNER_MISSING",
    pattern: /Cannot find (?:module|package)\s+['"](?:vitest|jest)(?:\/[^'"]*)?['"]/i,
    severity: "error",
    confidence: "high",
    title: "The test runner could not be resolved",
    message: "The supplied log reports that Jest or Vitest could not be loaded from the project.",
    fix: "Install the runner in the package that runs the tests, or check that the command is running from the intended workspace."
  },
  {
    code: "LOG_JEST_ENVIRONMENT_MISSING",
    pattern: /(?:Cannot find (?:module|package)\s+['"]jest-environment-jsdom|jest-environment-jsdom.*(?:not found|cannot be found|could not be resolved))/i,
    severity: "error",
    confidence: "high",
    title: "Jest could not load jest-environment-jsdom",
    message: "The supplied log reports that the Jest jsdom environment package is missing.",
    fix: "Add a Jest-version-compatible jest-environment-jsdom development dependency."
  },
  {
    code: "LOG_MODULE_FORMAT",
    pattern: /Cannot use import statement outside a module|require\(\) of ES Module|ERR_REQUIRE_ESM|must use import to load ES Module/i,
    severity: "warning",
    confidence: "medium",
    title: "The test log suggests an ESM/CommonJS mismatch",
    message: "The supplied log contains a module-format error while loading test code or configuration.",
    fix: "Check the package type, file extensions, transform settings, and the test runner's ESM configuration."
  },
  {
    code: "LOG_IMPORT_RESOLUTION",
    pattern: /Failed to resolve import|Cannot find module ['"][^'"]+['"]|Cannot find package ['"][^'"]+['"]/i,
    severity: "warning",
    confidence: "medium",
    title: "An import could not be resolved",
    message: "The supplied log reports a missing package or unresolved import.",
    fix: "Check that the dependency is installed in the active workspace and that any TypeScript aliases are mapped by the test runner."
  },
  {
    code: "LOG_MOCK_STATE",
    pattern: /(?:mock|spy).*(?:not restored|not reset|leaked|pollut)|(?:not restored|not reset|leaked|pollut).*(?:mock|spy)/i,
    severity: "warning",
    confidence: "low",
    title: "The test log may involve mock state leaking between tests",
    message: "The log mentions mock or spy state that was not reset or restored.",
    fix: "Check the runner's clearMocks, resetMocks, restoreMocks, or afterEach cleanup behavior."
  }
];

export function analyzeLog(logPath, rootDir) {
  const absolute = path.resolve(rootDir, logPath);
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    throw new Error("Cannot read log file " + logPath + ".");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Log path is not a regular file: " + logPath);
  if (stat.size > MAX_LOG_BYTES) {
    throw new Error("Log file is larger than the 2 MiB limit: " + logPath);
  }

  let text;
  try {
    text = fs.readFileSync(absolute, "utf8");
  } catch {
    throw new Error("Cannot read log file " + logPath + ".");
  }

  const file = absolute;
  return LOG_RULES.flatMap(rule => {
    const line = lineFor(text, rule.pattern);
    if (line === null) return [];
    return [{
      ...rule,
      file,
      line
    }];
  });
}
