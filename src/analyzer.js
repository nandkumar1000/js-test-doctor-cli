import fs from "node:fs";
import path from "node:path";
import { analyzeLog } from "./log-analyzer.js";

const CONFIG_NAMES = [
  ["jest", "jest.config.js"],
  ["jest", "jest.config.cjs"],
  ["jest", "jest.config.mjs"],
  ["jest", "jest.config.ts"],
  ["jest", "jest.config.cts"],
  ["jest", "jest.config.mts"],
  ["jest", "jest.config.json"],
  ["vitest", "vitest.config.js"],
  ["vitest", "vitest.config.cjs"],
  ["vitest", "vitest.config.mjs"],
  ["vitest", "vitest.config.ts"],
  ["vitest", "vitest.config.cts"],
  ["vitest", "vitest.config.mts"],
  ["vitest", "vite.config.js"],
  ["vitest", "vite.config.cjs"],
  ["vitest", "vite.config.mjs"],
  ["vitest", "vite.config.ts"],
  ["vitest", "vite.config.cts"],
  ["vitest", "vite.config.mts"]
];
const TS_CONFIG_NAMES = ["tsconfig.json", "tsconfig.base.json"];
const LOCKFILE_MANAGERS = new Map([
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"]
]);
const SKIP_WORKSPACE_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", ".yarn", ".pnpm", "dist",
  "build", "coverage", ".next", ".turbo"
]);
const MAX_CONFIG_BYTES = 512 * 1024;

function posixPath(value) {
  return value.split(path.sep).join("/");
}

function relativeFile(root, file) {
  const relative = path.relative(root, file);
  return relative ? posixPath(relative) : ".";
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function lineAt(text, pattern) {
  const match = pattern.exec(text);
  if (!match) return null;
  return text.slice(0, match.index).split(/\r?\n/).length;
}

function finding(root, details) {
  return {
    code: details.code,
    severity: details.severity,
    confidence: details.confidence,
    title: details.title,
    message: details.message,
    file: details.file ? relativeFile(root, details.file) : null,
    line: details.line ?? null,
    fix: details.fix
  };
}

function parseJsonc(text) {
  let result = "";
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        result += char;
      } else {
        result += " ";
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        result += "  ";
        i += 1;
        blockComment = false;
      } else {
        result += char === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (quote) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      result += char;
    } else if (char === "/" && next === "/") {
      result += "  ";
      i += 1;
      lineComment = true;
    } else if (char === "/" && next === "*") {
      result += "  ";
      i += 1;
      blockComment = true;
    } else {
      result += char;
    }
  }

  return result.replace(/,\s*([}\]])/g, "$1");
}

function readText(file, maxBytes = MAX_CONFIG_BYTES) {
  try {
    // Avoid following links while scanning the selected project tree.
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readManifest(projectDir, root, diagnostics) {
  const file = path.join(projectDir, "package.json");
  const text = readText(file);
  if (text === null) {
    diagnostics.push(finding(root, {
      code: "PACKAGE_JSON_NOT_FOUND",
      severity: "error",
      confidence: "high",
      title: "No package.json found",
      message: "The selected project directory does not contain a readable package.json.",
      file,
      fix: "Run the scan from a JavaScript package directory or use --root to select one."
    }));
    return { manifest: null, text: null };
  }
  try {
    return { manifest: JSON.parse(text), text };
  } catch (error) {
    diagnostics.push(finding(root, {
      code: "PACKAGE_JSON_INVALID",
      severity: "error",
      confidence: "high",
      title: "package.json is not valid JSON",
      message: error.message,
      file,
      line: lineAt(text, /[^\s]/),
      fix: "Fix the JSON syntax, then run the scan again."
    }));
    return { manifest: null, text };
  }
}

function workspacePatterns(manifest) {
  const workspaces = manifest?.workspaces;
  if (Array.isArray(workspaces)) return workspaces.filter(value => typeof value === "string");
  if (Array.isArray(workspaces?.packages)) {
    return workspaces.packages.filter(value => typeof value === "string");
  }
  return [];
}

function segmentRegex(segment) {
  const escaped = segment.split("*")
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp("^" + escaped + "$");
}

function directoriesAt(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !SKIP_WORKSPACE_DIRS.has(entry.name))
      .map(entry => path.join(directory, entry.name));
  } catch {
    return [];
  }
}

function expandWorkspacePattern(root, pattern) {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (!normalized || path.isAbsolute(normalized) || normalized.split("/").includes("..")) return [];
  const segments = normalized.split("/").filter(Boolean);
  const found = [];

  function visit(directory, index, depth) {
    if (found.length >= 500 || depth > 8) return;
    if (index >= segments.length) {
      if (fs.existsSync(path.join(directory, "package.json"))) found.push(directory);
      return;
    }
    const segment = segments[index];
    if (segment === "**") {
      visit(directory, index + 1, depth);
      for (const child of directoriesAt(directory)) visit(child, index, depth + 1);
      return;
    }
    if (!segment.includes("*")) {
      const next = path.resolve(directory, segment);
      if (isWithin(root, next)) {
        try {
          const stat = fs.lstatSync(next);
          if (stat.isDirectory() && !stat.isSymbolicLink()) visit(next, index + 1, depth + 1);
        } catch {
          // An absent or inaccessible workspace directory is skipped.
        }
      }
      return;
    }
    const matcher = segmentRegex(segment);
    for (const child of directoriesAt(directory)) {
      if (matcher.test(path.basename(child))) visit(child, index + 1, depth + 1);
    }
  }

  visit(root, 0, 0);
  return found;
}

function discoverWorkspaces(root, manifest) {
  const matches = new Set();
  for (const pattern of workspacePatterns(manifest)) {
    if (pattern.startsWith("!")) continue;
    for (const directory of expandWorkspacePattern(root, pattern)) matches.add(path.resolve(directory));
  }
  for (const pattern of workspacePatterns(manifest).filter(value => value.startsWith("!"))) {
    for (const directory of expandWorkspacePattern(root, pattern.slice(1))) matches.delete(path.resolve(directory));
  }
  return [...matches].sort();
}

function discoverLockfiles(projectDir, rootDir) {
  const directories = projectDir === rootDir ? [rootDir] : [projectDir, rootDir];
  const files = [];
  for (const directory of directories) {
    for (const name of LOCKFILE_MANAGERS.keys()) {
      const file = path.join(directory, name);
      try {
        if (fs.lstatSync(file).isFile()) files.push(file);
      } catch {
        // A missing or inaccessible lockfile is not a scan failure.
      }
    }
  }
  return [...new Set(files)];
}

function packageManagerName(value) {
  if (typeof value !== "string") return null;
  const name = value.split("@")[0];
  if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") return name;
  return null;
}

function analyzeLockfiles(projectDir, rootDir, manifest, rootManifest, diagnostics) {
  const files = discoverLockfiles(projectDir, rootDir);
  if (files.length === 0) return;
  const managers = new Set(files.map(file => LOCKFILE_MANAGERS.get(path.basename(file))));
  if (managers.size > 1) {
    diagnostics.push(finding(rootDir, {
      code: "MULTIPLE_LOCKFILES",
      severity: "warning",
      confidence: "high",
      title: "More than one package-manager lockfile is present",
      message: "The project has lockfiles for " + [...managers].sort().join(", ") + ", so installs may resolve different dependency trees.",
      file: files[0],
      fix: "Choose one package manager for this project and remove stale lockfiles after confirming the intended dependency tree."
    }));
  }

  const declaredManager = packageManagerName(manifest?.packageManager) ??
    packageManagerName(rootManifest?.packageManager);
  if (declaredManager && !managers.has(declaredManager)) {
    diagnostics.push(finding(rootDir, {
      code: "PACKAGE_MANAGER_LOCKFILE_MISMATCH",
      severity: "warning",
      confidence: "high",
      title: "The packageManager field does not match the detected lockfile",
      message: "The packageManager field declares " + declaredManager + ", but the available lockfile(s) indicate " + [...managers].sort().join(", ") + ".",
      file: path.join(projectDir, "package.json"),
      line: lineAt(readText(path.join(projectDir, "package.json")) ?? "", /"packageManager"\s*:/),
      fix: "Use the declared package manager to regenerate the matching lockfile, or update packageManager to the intended tool and version."
    }));
  }
}

function dependencyMap(manifest) {
  const result = new Map();
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const dependencies = manifest?.[field];
    if (dependencies && typeof dependencies === "object" && !Array.isArray(dependencies)) {
      for (const [name, version] of Object.entries(dependencies)) {
        result.set(name, String(version));
      }
    }
  }
  return result;
}

function mergeDependencies(manifests) {
  const result = new Map();
  for (const manifest of manifests) {
    for (const [name, version] of dependencyMap(manifest)) result.set(name, version);
  }
  return result;
}

function runnersFromScript(script) {
  const value = String(script ?? "");
  const runners = new Set();
  if (/\bjest(?:\s|$|:)/i.test(value)) runners.add("jest");
  if (/\bvitest(?:\s|$|:)/i.test(value)) runners.add("vitest");
  return runners;
}

function detectRunners(manifest, dependencies) {
  const runners = new Set();
  for (const name of dependencies.keys()) {
    if (name === "jest" || name.startsWith("@jest/")) runners.add("jest");
    if (name === "vitest" || name.startsWith("@vitest/")) runners.add("vitest");
  }
  for (const script of Object.values(manifest?.scripts ?? {})) {
    for (const runner of runnersFromScript(script)) runners.add(runner);
  }
  return runners;
}

function parseConfigJson(text) {
  try {
    return JSON.parse(parseJsonc(text));
  } catch {
    return null;
  }
}

function discoverConfigs(projectDir, rootDir, manifest, rootManifest) {
  const configs = [];
  const searchDirs = projectDir === rootDir ? [projectDir] : [projectDir, rootDir];
  for (const directory of searchDirs) {
    for (const [runner, name] of CONFIG_NAMES) {
      const file = path.join(directory, name);
      if (!fs.existsSync(file)) continue;
      const raw = readText(file);
      if (raw !== null) {
        const parsed = name.endsWith(".json") ? parseConfigJson(raw) : null;
        configs.push({ runner, file, raw, parsed, literal: false });
      }
    }
  }
  if (manifest?.jest && typeof manifest.jest === "object") {
    const manifestPath = path.join(projectDir, "package.json");
    const raw = readText(manifestPath) ?? "";
    configs.push({ runner: "jest", file: manifestPath, raw, parsed: manifest.jest, literal: true });
  }
  if (projectDir !== rootDir && rootManifest?.jest && typeof rootManifest.jest === "object") {
    const manifestPath = path.join(rootDir, "package.json");
    const raw = readText(manifestPath) ?? "";
    configs.push({ runner: "jest", file: manifestPath, raw, parsed: rootManifest.jest, literal: true });
  }
  return configs;
}

function valueFor(config, key) {
  if (config.parsed && Object.hasOwn(config.parsed, key)) {
    return { value: config.parsed[key], line: lineAt(config.raw, new RegExp("\"" + key + "\"\\s*:")) ?? 1 };
  }
  if (config.literal) return { value: undefined, line: null };
  const match = new RegExp("\\b" + key + "\\s*:\\s*(['\"])([^'\"]+)\\1").exec(config.raw);
  if (!match) return { value: undefined, line: null };
  return { value: match[2], line: lineAt(config.raw, new RegExp("\\b" + key + "\\s*:")) };
}

function stringsFor(config, key) {
  if (config.parsed && Object.hasOwn(config.parsed, key)) {
    const value = config.parsed[key];
    const values = Array.isArray(value) ? value : [value];
    return {
      values: values.filter(item => typeof item === "string"),
      line: lineAt(config.raw, new RegExp("\"" + key + "\"\\s*:")) ?? 1,
      confidence: "high"
    };
  }
  if (config.literal) return { values: [], line: null, confidence: "high" };
  const match = new RegExp("\\b" + key + "\\s*:\\s*\\[([\\s\\S]*?)\\]").exec(config.raw);
  if (!match) return { values: [], line: null, confidence: "medium" };
  const values = [...match[1].matchAll(/(['"])(.*?)\1/g)].map(entry => entry[2]);
  return {
    values,
    line: lineAt(config.raw, new RegExp("\\b" + key + "\\s*:")),
    confidence: "medium"
  };
}

function configHas(config, key) {
  if (config.parsed) return Object.hasOwn(config.parsed, key);
  return new RegExp("\\b" + key + "\\s*:").test(config.raw);
}

function configLine(config, key) {
  if (config.parsed) {
    return lineAt(config.raw, new RegExp("\"" + key + "\"\\s*:")) ?? 1;
  }
  return lineAt(config.raw, new RegExp("\\b" + key + "\\s*:"));
}

function resolveSetupFile(config, rootDir, value) {
  let clean = value.replace(/^<rootDir>[\\/]/, "");
  if (!clean || clean.includes("$" + "{") || clean.includes("<rootDir>")) return null;
  const configDir = path.dirname(config.file);
  const absolute = path.isAbsolute(clean) ? path.resolve(clean) : path.resolve(configDir, clean);
  if (!isWithin(rootDir, absolute)) return null;
  return absolute;
}

function parseMajor(version) {
  const match = String(version ?? "").match(/(?:^|[^\d])(\d+)(?:\.\d+)?/);
  return match ? Number(match[1]) : null;
}

function tsConfigPaths(projectDir, rootDir) {
  for (const directory of projectDir === rootDir ? [projectDir] : [projectDir, rootDir]) {
    for (const name of TS_CONFIG_NAMES) {
      const file = path.join(directory, name);
      const raw = readText(file);
      if (raw === null) continue;
      const parsed = parseConfigJson(raw);
      if (!parsed) continue;
      const paths = parsed.compilerOptions?.paths;
      if (paths && Object.keys(paths).length > 0) return { file, raw, parsed };
    }
  }
  return null;
}

function hasTsPathPlugin(dependencies) {
  return dependencies.has("vite-tsconfig-paths");
}

function analyzePackage(projectDir, rootDir, manifest, rootManifest, diagnostics) {
  const packageFile = path.join(projectDir, "package.json");
  const dependencies = mergeDependencies(projectDir === rootDir ? [manifest] : [rootManifest, manifest]);
  const runners = detectRunners(manifest, dependencies);
  const scripts = manifest?.scripts ?? {};

  const packageText = readText(packageFile) ?? "";
  for (const [scriptName, script] of Object.entries(scripts)) {
    if (scriptName !== "test" && !scriptName.startsWith("test:") && !scriptName.startsWith("test-")) continue;
    for (const runner of runnersFromScript(script)) {
      if (!dependencies.has(runner)) {
        diagnostics.push(finding(rootDir, {
          code: "TEST_RUNNER_NOT_DECLARED",
          severity: "error",
          confidence: "high",
          title: runner + " is used by the " + scriptName + " script but is not declared",
          message: "The " + scriptName + " script in " + relativeFile(rootDir, packageFile) + " invokes " + runner + ", but the package manifests do not declare it.",
          file: packageFile,
          line: lineAt(packageText, new RegExp("\"" + scriptName + "\"\\s*:")),
          fix: "Add " + runner + " to this package's devDependencies or correct the " + scriptName + " script."
        }));
      }
    }
  }

  analyzeLockfiles(projectDir, rootDir, manifest, rootManifest, diagnostics);
  const configs = discoverConfigs(projectDir, rootDir, manifest, rootManifest);
  for (const config of configs) {
    const packageType = manifest?.type ?? rootManifest?.type;
    if (config.runner === "jest" && packageType === "module" && config.file.endsWith("jest.config.js") &&
        /\bmodule\.exports\b|\brequire\s*\(/.test(config.raw)) {
      diagnostics.push(finding(rootDir, {
        code: "JEST_CONFIG_MODULE_FORMAT",
        severity: "error",
        confidence: "high",
        title: "Jest config uses CommonJS syntax in an ESM package",
        message: "This package declares type module, while " + path.basename(config.file) + " uses module.exports or require().",
        file: config.file,
        line: lineAt(config.raw, /\bmodule\.exports\b|\brequire\s*\(/),
        fix: "Rename the config to jest.config.cjs or convert it to ESM syntax."
      }));
    }

    if (config.runner === "jest") {
      const environment = valueFor(config, "testEnvironment");
      if (environment.value === "jsdom") {
        const jestMajor = parseMajor(dependencies.get("jest"));
        if (!dependencies.has("jest-environment-jsdom") && (jestMajor === null || jestMajor >= 28)) {
          diagnostics.push(finding(rootDir, {
            code: "JEST_JSDOM_NOT_DECLARED",
            severity: "error",
            confidence: jestMajor === null ? "medium" : "high",
            title: "Jest requests jsdom but does not declare its environment package",
            message: "The Jest config selects jsdom, but jest-environment-jsdom is not declared in the package manifests.",
            file: config.file,
            line: environment.line,
            fix: "Install jest-environment-jsdom as a development dependency compatible with the project's Jest version."
          }));
        }
      }
      for (const key of ["setupFiles", "setupFilesAfterEnv"]) {
        const setup = stringsFor(config, key);
        for (const value of setup.values) {
          const setupFile = resolveSetupFile(config, rootDir, value);
          if (setupFile && !fs.existsSync(setupFile)) {
            diagnostics.push(finding(rootDir, {
              code: "JEST_SETUP_FILE_MISSING",
              severity: "warning",
              confidence: setup.confidence,
              title: "A configured Jest setup file was not found",
              message: key + " points to " + value + ", but that file does not exist under this package.",
              file: config.file,
              line: setup.line,
              fix: "Create the setup file or update the " + key + " path."
            }));
          }
        }
      }
    }

    if (config.runner === "vitest") {
      const environment = valueFor(config, "environment");
      if (environment.value === "jsdom" && !dependencies.has("jsdom")) {
        diagnostics.push(finding(rootDir, {
          code: "VITEST_JSDOM_NOT_DECLARED",
          severity: "error",
          confidence: "high",
          title: "Vitest requests jsdom but does not declare it",
          message: "The Vitest config selects jsdom, but jsdom is not declared in the package manifests.",
          file: config.file,
          line: environment.line,
          fix: "Add jsdom as a development dependency."
        }));
      } else if (environment.value === "happy-dom" && !dependencies.has("happy-dom")) {
        diagnostics.push(finding(rootDir, {
          code: "VITEST_HAPPY_DOM_NOT_DECLARED",
          severity: "error",
          confidence: "high",
          title: "Vitest requests happy-dom but does not declare it",
          message: "The Vitest config selects happy-dom, but happy-dom is not declared in the package manifests.",
          file: config.file,
          line: environment.line,
          fix: "Add happy-dom as a development dependency."
        }));
      }
      const setup = stringsFor(config, "setupFiles");
      for (const value of setup.values) {
        const setupFile = resolveSetupFile(config, rootDir, value);
        if (setupFile && !fs.existsSync(setupFile)) {
          diagnostics.push(finding(rootDir, {
            code: "VITEST_SETUP_FILE_MISSING",
            severity: "warning",
            confidence: setup.confidence,
            title: "A configured Vitest setup file was not found",
            message: "setupFiles points to " + value + ", but that file does not exist under this package.",
            file: config.file,
            line: setup.line,
            fix: "Create the setup file or update the setupFiles path."
          }));
        }
      }
    }
  }

  const tsPaths = tsConfigPaths(projectDir, rootDir);
  if (tsPaths) {
    const runnerConfigs = configs.filter(config => config.runner === "jest" || config.runner === "vitest");
    for (const runner of runners) {
      const runnerConfig = runnerConfigs.find(config => config.runner === runner);
      if (!runnerConfig) continue;
      if (runner === "jest" && !configHas(runnerConfig, "moduleNameMapper")) {
        diagnostics.push(finding(rootDir, {
          code: "JEST_TYPESCRIPT_PATHS_UNMAPPED",
          severity: "warning",
          confidence: "medium",
          title: "TypeScript path aliases may not resolve in Jest",
          message: "The TypeScript config declares path aliases, but the detected Jest config has no moduleNameMapper entry.",
          file: runnerConfig.file,
          line: configLine(runnerConfig, "moduleNameMapper"),
          fix: "Map the TypeScript aliases in moduleNameMapper, for example with pathsToModuleNameMapper from ts-jest."
        }));
      } else if (runner === "vitest" && !hasTsPathPlugin(dependencies) &&
          !/\bresolve\s*:\s*\{[\s\S]*?\balias\s*:/.test(runnerConfig.raw)) {
        diagnostics.push(finding(rootDir, {
          code: "VITEST_TYPESCRIPT_PATHS_UNMAPPED",
          severity: "warning",
          confidence: "medium",
          title: "TypeScript path aliases may not resolve in Vitest",
          message: "The TypeScript config declares path aliases, but no vite-tsconfig-paths dependency or literal Vite resolve.alias was found.",
          file: tsPaths.file,
          line: lineAt(tsPaths.raw, /"paths"\s*:/),
          fix: "Verify that the Vite/Vitest config maps these aliases; vite-tsconfig-paths is one option."
        }));
      }
    }
  }

  return { path: relativeFile(rootDir, projectDir), name: manifest?.name ?? null, runners: [...runners].sort() };
}

export function analyzeProject(rootPath, options = {}) {
  const rootDir = path.resolve(rootPath);
  const diagnostics = [];
  const rootResult = readManifest(rootDir, rootDir, diagnostics);
  const rootManifest = rootResult.manifest;
  if (!rootManifest) {
    return {
      root: rootDir,
      projectCount: 0,
      projects: [],
      diagnostics: sortDiagnostics(diagnostics)
    };
  }

  const projectDirs = [rootDir, ...discoverWorkspaces(rootDir, rootManifest)];
  const projects = [];
  for (const projectDir of projectDirs) {
    const result = projectDir === rootDir ? rootResult : readManifest(projectDir, rootDir, diagnostics);
    if (!result.manifest) continue;
    projects.push(analyzePackage(projectDir, rootDir, result.manifest, rootManifest, diagnostics));
  }

  if (projects.every(project => project.runners.length === 0)) {
    diagnostics.push(finding(rootDir, {
      code: "NO_SUPPORTED_RUNNER",
      severity: "info",
      confidence: "high",
      title: "No Jest or Vitest setup was detected",
      message: "This first version diagnoses Jest and Vitest projects only.",
      file: path.join(rootDir, "package.json"),
      fix: "No action is needed unless this project uses Jest or Vitest."
    }));
  }

  if (options.logPath) {
    const logFindings = analyzeLog(options.logPath, rootDir);
    for (const item of logFindings) diagnostics.push(finding(rootDir, item));
  }

  return {
    root: rootDir,
    projectCount: projects.length,
    projects,
    diagnostics: sortDiagnostics(diagnostics)
  };
}

function sortDiagnostics(diagnostics) {
  const seen = new Set();
  return diagnostics
    .filter(item => {
      const key = [item.code, item.file, item.line, item.message].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) =>
      String(left.file ?? "").localeCompare(String(right.file ?? "")) ||
      String(left.code).localeCompare(String(right.code)) ||
      (left.line ?? 0) - (right.line ?? 0)
    );
}
