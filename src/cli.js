import path from "node:path";
import { analyzeProject } from "./analyzer.js";
import { formatReport, sanitizeText } from "./formatters.js";

const VERSION = "0.1.0";
const USAGE = [
  "Usage: js-test-doctor-cli [options]",
  "",
  "Options:",
  "  --root <path>       Project directory to scan (default: current directory)",
  "  --log <path>         Analyze a saved test log as well",
  "  --format <format>    text, json, markdown, github, or sarif (default: text)",
  "  --strict             Exit 1 when a high-confidence error is found",
  "  -h, --help           Show this help",
  "  -v, --version        Show the version"
].join("\n");

class UsageError extends Error {}

function parseArguments(args, cwd) {
  const options = {
    root: cwd,
    logPath: null,
    format: "text",
    strict: false,
    help: false,
    version: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--version" || arg === "-v") {
      options.version = true;
    } else if (arg === "--strict") {
      options.strict = true;
    } else if (arg === "--root" || arg === "--log" || arg === "--format") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) throw new UsageError("Option " + arg + " requires a value.");
      index += 1;
      if (arg === "--root") options.root = path.resolve(cwd, value);
      if (arg === "--log") options.logPath = value;
      if (arg === "--format") options.format = value;
    } else {
      throw new UsageError("Unknown option: " + arg);
    }
  }

  if (!["text", "json", "markdown", "github", "sarif"].includes(options.format)) {
    throw new UsageError("Unsupported output format: " + options.format);
  }
  return options;
}

function writeLine(stream, value) {
  stream.write(String(value) + "\n");
}

export function main(args = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const cwd = path.resolve(io.cwd ?? process.cwd());

  let options;
  try {
    options = parseArguments(args, cwd);
  } catch (error) {
    writeLine(stderr, "Error: " + sanitizeText(error.message));
    writeLine(stderr, "");
    writeLine(stderr, USAGE);
    return 2;
  }

  if (options.help) {
    writeLine(stdout, USAGE);
    return 0;
  }
  if (options.version) {
    writeLine(stdout, VERSION);
    return 0;
  }

  try {
    const report = analyzeProject(options.root, { logPath: options.logPath });
    report.version = VERSION;
    writeLine(stdout, formatReport(report, options.format));
    const hasStrictError = report.diagnostics.some(item =>
      item.severity === "error" && item.confidence === "high"
    );
    return options.strict && hasStrictError ? 1 : 0;
  } catch (error) {
    writeLine(stderr, "Error: " + sanitizeText(error.message));
    return 2;
  }
}
