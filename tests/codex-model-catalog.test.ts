import assert from "node:assert/strict";
import { test } from "node:test";

import { parseModelPage } from "../src/server/codex-model-catalog.js";

test("parses visible App Server models and supported reasoning efforts", () => {
  const page = parseModelPage({
    data: [
      {
        model: "gpt-example",
        displayName: "GPT Example",
        hidden: false,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "Balanced" },
          { reasoningEffort: "high", description: "Deep" },
        ],
      },
      {
        model: "hidden-model",
        hidden: true,
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: [{ reasoningEffort: "low" }],
      },
    ],
    nextCursor: "page-2",
  });

  assert.deepEqual(page, {
    models: [{
      model: "gpt-example",
      displayName: "GPT Example",
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "Balanced" },
        { reasoningEffort: "high", description: "Deep" },
      ],
    }],
    nextCursor: "page-2",
  });
});

test("falls back to the first supported effort when the advertised default is invalid", () => {
  const page = parseModelPage({
    data: [{
      id: "gpt-example",
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "" },
      ],
      defaultReasoningEffort: "unsupported",
    }],
    nextCursor: null,
  });

  assert.equal(page.models[0]?.defaultReasoningEffort, "medium");
});
