import { main } from "../src/cli.js";

const root = process.env.INPUT_ROOT ?? ".";
const logPath = process.env.INPUT_LOG ?? "";
const strict = String(process.env.INPUT_STRICT ?? "false").trim().toLowerCase();

if (strict !== "true" && strict !== "false") {
  process.stderr.write("Error: The action input strict must be 'true' or 'false'.\n");
  process.exitCode = 2;
} else {
  const args = ["--root", root, "--format", "github"];
  if (logPath !== "") args.push("--log", logPath);
  if (strict === "true") args.push("--strict");
  process.exitCode = main(args);
}
