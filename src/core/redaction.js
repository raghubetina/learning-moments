// @ts-check
import { createHash } from "node:crypto";

/**
 * @typedef {Object} RedactionFinding
 * @property {string} type
 * @property {string} hash
 * @property {number} length
 *
 * @typedef {Object} RedactionResult
 * @property {string} text
 * @property {RedactionFinding[]} findings
 */

/** @type {ReadonlyArray<{type: string, pattern: RegExp}>} */
const rules = [
  {
    type: "PEM_PRIVATE_KEY",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g
  },
  {
    type: "ANTHROPIC_KEY",
    pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g
  },
  {
    type: "OPENAI_KEY",
    pattern: /sk-[A-Za-z0-9]{32,}/g
  },
  {
    type: "GITHUB_TOKEN",
    pattern: /gh[pousr]_[A-Za-z0-9_]{20,}/g
  },
  {
    type: "STRIPE_KEY",
    pattern: /(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g
  },
  {
    type: "BEARER_TOKEN",
    pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi
  },
  {
    type: "ENV_SECRET",
    pattern: /\b[A-Z0-9_]*(?:SECRET|TOKEN|API_KEY|PASSWORD|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*['"]?(?!\[REDACTED_)[^'"\s]{8,}/g
  },
  {
    type: "AWS_ACCESS_KEY",
    pattern: /AKIA[0-9A-Z]{16}/g
  },
  {
    type: "AZURE_SAS",
    pattern: /sig=[A-Za-z0-9%+/]{20,}/g
  }
];

/** @param {string} value */
function hashValue(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/**
 * @param {string} input
 * @returns {RedactionResult}
 */
export function redactSecrets(input) {
  /** @type {RedactionFinding[]} */
  const findings = [];
  let text = input;

  for (const rule of rules) {
    text = text.replace(rule.pattern, (match) => {
      const finding = {
        type: rule.type,
        hash: hashValue(match),
        length: match.length
      };
      findings.push(finding);
      return `[REDACTED_${finding.type} hash=${finding.hash} len=${finding.length}]`;
    });
  }

  return { text, findings };
}
