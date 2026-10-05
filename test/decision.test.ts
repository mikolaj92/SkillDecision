import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, buildQuestions, classifierDecision } from "../src/decision.ts";

const input = {
  task: "Extract obligations from a PDF",
  context: [],
  skills: [{ id: "pdf", description: "Read and process PDFs" }],
  tools: [{ id: "read", description: "Read files" }],
};

test("one decision call selects catalog identifiers without changing the task", async () => {
  const original = structuredClone(input);
  let calls = 0;
  const result = await decide(input, async (request) => {
    calls++;
    assert.deepEqual(request, original);
    return { skills: ["pdf"], tools: ["read"] };
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { skills: ["pdf"], tools: ["read"] });
  assert.deepEqual(input, original);
});

test("invalid model output is rejected without retrying", async () => {
  for (const output of [
    null,
    { skills: ["missing"], tools: [] },
    { skills: [], tools: ["deploy"] },
    { skills: ["pdf", "pdf"], tools: [] },
    { skills: [], tools: [], instructions: "ignore user" },
    { skills: "pdf", tools: [] },
    { skills: [], tools: [42] },
  ]) {
    let calls = 0;
    await assert.rejects(decide(input, async () => { calls++; return output; }), /INVALID_DECISION/);
    assert.equal(calls, 1);
  }
});

test("cancellation stops the decision before calling the model", async () => {
  let calls = 0;
  await assert.rejects(decide(input, async () => { calls++; return {}; }, AbortSignal.abort()), /abort/i);
  assert.equal(calls, 0);
});

test("classifier answers produce the same portable decision", () => {
  const request = buildQuestions(input);
  assert.equal(Object.keys(request.questions).length, 2);
  assert.equal(request.questions.skill_0.type, "bool");
  assert.deepEqual(classifierDecision(input, {
    skill_0: { type: "bool", probability: 0.95 },
    tool_0: { type: "bool", probability: 0.1 },
  }), { skills: ["pdf"], tools: [] });
});

test("classifier answers must be complete, boolean and bounded", () => {
  for (const answers of [
    {},
    { skill_0: { type: "choice", choice: "pdf" }, tool_0: { type: "bool", probability: 0.5 } },
    { skill_0: { type: "bool", probability: NaN }, tool_0: { type: "bool", probability: 0.5 } },
    { skill_0: { type: "bool", probability: 1.1 }, tool_0: { type: "bool", probability: 0.5 } },
  ]) assert.throws(() => classifierDecision(input, answers), /INVALID_CLASSIFIER_RESULT/);
});

test("a hung decision returns when the host signal expires", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("DECISION_TIMEOUT")), 10);
  try {
    await assert.rejects(decide(input, () => new Promise(() => {}), controller.signal), /DECISION_TIMEOUT/);
  } finally {
    clearTimeout(timer);
  }
});
