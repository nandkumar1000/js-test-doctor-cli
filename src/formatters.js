function location(finding) {
  if (!finding.file) return "";
  return finding.line ? finding.file + ":" + finding.line : finding.file;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

export function sanitizeText(value) {
  return String(value ?? "")
    .replace(CONTROL_CHARACTERS, character => character === "\n" || character === "\r" || character === "\t" ? " " : "�")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeMarkdown(value) {
  return sanitizeText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_{}\[\]()#+.!|>~-]/g, "\\$&");
}

function escapeGitHubProperty(value) {
  return sanitizeText(value)
    .replace(/%/g, "%25")
    .replace(/:/g, "%3A")
    .replace(/,/g, "%2C");
}

function escapeGitHubData(value) {
  return sanitizeText(value).replace(/%/g, "%25");
}

export function formatJson(report) {
  return JSON.stringify({
    tool: "js-test-doctor-cli",
    version: report.version,
    root: ".",
    projectCount: report.projectCount,
    projects: report.projects,
    findings: report.diagnostics
  }, null, 2);
}

export function formatText(report) {
  const lines = [
    "JS Test Doctor",
    "Scanned " + report.projectCount + " package" + (report.projectCount === 1 ? "" : "s") + ".",
    ""
  ];

  if (report.diagnostics.length === 0) {
    lines.push("No issues were detected by the available checks.");
    return lines.join("\n");
  }

  for (const item of report.diagnostics) {
    const label = "[" + sanitizeText(item.severity).toUpperCase() + ", " + sanitizeText(item.confidence) + " confidence]";
    const place = sanitizeText(location(item));
    lines.push(label + " " + sanitizeText(item.code) + ": " + sanitizeText(item.title));
    if (place) lines.push("  " + place);
    lines.push("  " + sanitizeText(item.message));
    lines.push("  Next: " + sanitizeText(item.fix));
    lines.push("");
  }

  const highErrors = report.diagnostics.filter(item =>
    item.severity === "error" && item.confidence === "high"
  ).length;
  lines.push(report.diagnostics.length + " finding(s); " + highErrors + " high-confidence error(s).");
  return lines.join("\n").trimEnd();
}

export function formatMarkdown(report) {
  const lines = [
    "# JS Test Doctor report",
    "",
    "Scanned " + report.projectCount + " package(s).",
    ""
  ];
  if (report.diagnostics.length === 0) {
    lines.push("No issues were detected by the available checks.");
    return lines.join("\n");
  }
  for (const item of report.diagnostics) {
    lines.push("## " + escapeMarkdown(item.title));
    lines.push("");
    lines.push("- Code: " + escapeMarkdown(item.code));
    lines.push("- Severity: " + escapeMarkdown(item.severity));
    lines.push("- Confidence: " + escapeMarkdown(item.confidence));
    if (item.file) {
      lines.push("- Location: " + escapeMarkdown(location(item)));
    }
    lines.push("- Finding: " + escapeMarkdown(item.message));
    lines.push("- Suggested next step: " + escapeMarkdown(item.fix));
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function formatGitHub(report) {
  return report.diagnostics.map(item => {
    const command = item.severity === "error" ? "error" : item.severity === "warning" ? "warning" : "notice";
    const properties = [];
    if (item.file) properties.push("file=" + escapeGitHubProperty(item.file));
    if (Number.isInteger(item.line) && item.line > 0) properties.push("line=" + item.line);
    properties.push("title=" + escapeGitHubProperty(item.code + " (" + item.confidence + " confidence)"));
    const metadata = properties.length ? " " + properties.join(",") : "";
    const message = item.message + (item.fix ? " Suggested fix: " + item.fix : "");
    return "::" + command + metadata + "::" + escapeGitHubData(message);
  }).join("\n");
}

function sarifLevel(severity) {
  if (severity === "error") return "error";
  if (severity === "warning") return "warning";
  return "note";
}

function sarifUri(file) {
  return String(file).replace(/\\/g, "/")
    .split("/")
    .map(segment => encodeURIComponent(segment))
    .join("/");
}

export function formatSarif(report) {
  const ruleMap = new Map();
  for (const item of report.diagnostics) {
    if (ruleMap.has(item.code)) continue;
    ruleMap.set(item.code, {
      id: item.code,
      name: item.code,
      shortDescription: { text: sanitizeText(item.title) },
      fullDescription: { text: sanitizeText(item.message) },
      defaultConfiguration: { level: sarifLevel(item.severity) },
      help: { text: sanitizeText(item.fix) }
    });
  }

  const results = report.diagnostics.map(item => {
    const result = {
      ruleId: item.code,
      level: sarifLevel(item.severity),
      message: {
        text: sanitizeText(item.message + (item.fix ? " Suggested fix: " + item.fix : ""))
      },
      properties: { confidence: item.confidence }
    };
    if (item.file) {
      const physicalLocation = {
        artifactLocation: { uri: sarifUri(item.file) }
      };
      if (Number.isInteger(item.line) && item.line > 0) {
        physicalLocation.region = { startLine: item.line };
      }
      result.locations = [{ physicalLocation }];
    }
    return result;
  });

  return JSON.stringify({
    "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: {
        driver: {
          name: "JS Test Doctor",
          semanticVersion: report.version ?? "0.1.0",
          rules: [...ruleMap.values()]
        }
      },
      results
    }]
  }, null, 2);
}

export function formatReport(report, format) {
  if (format === "json") return formatJson(report);
  if (format === "markdown") return formatMarkdown(report);
  if (format === "github") return formatGitHub(report);
  if (format === "sarif") return formatSarif(report);
  return formatText(report);
}
