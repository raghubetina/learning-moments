import { createHash } from "node:crypto";

export interface RedactionFinding {
  type: string;
  hash: string;
  length: number;
}

export interface RedactionResult {
  text: string;
  findings: RedactionFinding[];
}

interface RedactionRule {
  type: string;
  pattern: RegExp;
}

const rules: RedactionRule[] = [
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

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

export function redactSecrets(input: string): RedactionResult {
  const findings: RedactionFinding[] = [];
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
