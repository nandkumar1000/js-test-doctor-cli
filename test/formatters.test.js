import assert from "node:assert/strict";
import test from "node:test";
import { formatGitHub, formatMarkdown, formatSarif, formatText } from "../src/formatters.js";

function report(overrides = {}) {
  return {
    projectCount: 1,
    version: "0.1.0",
    diagnostics: [{
      code: "MOCK_ISSUE",
      severity: "warning",
      confidence: "high",
      title: "Mock setup issue",
      message: "Check this setup.",
      file: "vitest.config.js",
      line: 4,
      fix: "Add the setup file."
    }],
    ...overrides
  };
}

test("GitHub annotations escape metadata and keep untrusted newlines in one command", () => {
  const output = formatGitHub(report({
    diagnostics: [{
      code: "BAD:,CODE",
      severity: "error",
      confidence: "high",
      title: "Ignore this title\n::warning::injected",
      message: "Unsafe path\n::error::injected %0A",
      file: "config.js\n::error file=pwned",
      line: 8,
      fix: "Review, then fix."
    }]
  }));

  assert.equal(output.split("\n").length, 1);
  assert.match(output, /^::error file=config\.js %3A%3Aerror file=pwned,line=8,title=BAD%3A%2CCODE \(high confidence\)::/);
  assert.doesNotMatch(output, /\n::(?:error|warning|notice)/);
  assert.match(output, /Unsafe path ::error::injected %250A/);
  assert.match(output, /Review, then fix\./);
});

test("SARIF output includes rules, safe relative URIs, levels, and source lines", () => {
  const output = JSON.parse(formatSarif(report({
    diagnostics: [{
      code: "MOCK_ISSUE",
      severity: "warning",
      confidence: "medium",
      title: "Mock setup issue",
      message: "A mock setup issue was detected.",
      file: "src/my test.ts",
      line: 12,
      fix: "Review the mock setup."
    }]
  })));

  assert.equal(output.version, "2.1.0");
  assert.equal(output.runs[0].tool.driver.rules[0].id, "MOCK_ISSUE");
  assert.equal(output.runs[0].results[0].level, "warning");
  assert.equal(
    output.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri,
    "src/my%20test.ts"
  );
  assert.equal(output.runs[0].results[0].locations[0].physicalLocation.region.startLine, 12);
});

test("text and Markdown output flatten control characters from finding content", () => {
  const unsafeReport = report({
    diagnostics: [{
      code: "UNSAFE",
      severity: "warning",
      confidence: "medium",
      title: "Bad\n\u001b[31mheading",
      message: "Message\r\ncontinued",
      file: "src/test.js\nnext-file",
      line: 3,
      fix: "Use <safe> & valid config."
    }]
  });

  const text = formatText(unsafeReport);
  const markdown = formatMarkdown(unsafeReport);
  assert.doesNotMatch(text, /\u001b|\nnext-file|\ncontinued/);
  assert.doesNotMatch(markdown, /\u001b|<safe>/);
  assert.match(markdown, /&lt;safe&gt; &amp; valid config/);
});
