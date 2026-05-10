export interface ClassifierInput {
  files: string[];
  diff: string;
}

export interface ClassifierOutput {
  eligible: boolean;
  timing: "ask_now" | "ask_later";
  delivery: "active" | "silent_log_only" | "discard";
  moment_type: "predict" | "test" | "recall";
  learning_value: number;
  flow_cost: number;
  question: string;
  expected_answer_outline: string;
  reason: string;
  recall: {
    schedule: boolean;
    prompt_seed: string;
    delay: "next_session";
  };
  storage: {
    summary: string;
    tags: string[];
  };
}

export function classifyCandidate(input: ClassifierInput): ClassifierOutput {
  const files = input.files.slice(0, 3);
  if (files.length === 0 || input.diff.trim().length === 0) {
    return {
      eligible: false,
      timing: "ask_later",
      delivery: "discard",
      moment_type: "recall",
      learning_value: 0,
      flow_cost: 0,
      question: "",
      expected_answer_outline: "",
      reason: "No substantive changed files were available.",
      recall: {
        schedule: false,
        prompt_seed: "",
        delay: "next_session"
      },
      storage: {
        summary: "No candidate change.",
        tags: []
      }
    };
  }

  const fileList = files.map((file) => `\`${file}\``).join(", ");
  return {
    eligible: true,
    timing: "ask_now",
    delivery: "active",
    moment_type: "predict",
    learning_value: 3,
    flow_cost: 2,
    question: `Before we move on, what behavior or claim changed in ${fileList}, and what would you check to verify you understand it?`,
    expected_answer_outline:
      "A strong answer should identify the changed behavior or claim, name the affected file or area, and propose a concrete verification such as a test, manual check, or failure mode.",
    reason: "A recent AI-authored project change is available for an understanding check.",
    recall: {
      schedule: true,
      prompt_seed: `What changed in ${files[0]}, and how would you verify it?`,
      delay: "next_session"
    },
    storage: {
      summary: `Candidate change touching ${files.join(", ")}`,
      tags: ["predict", "test-design"]
    }
  };
}
