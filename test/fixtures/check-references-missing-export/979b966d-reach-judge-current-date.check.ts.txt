import { describe, it, expect, mock } from "bun:test";

// A mock Anthropic-like client to be returned by the mocked `createLLMPort`.
const mockLlmClient = {
  messages: {
    create: async (params: any) => {
      // This mock simulates an LLM's behavior when it receives a prompt that lacks
      // the current date context. It sees a future date in the evidence and rejects the goal.
      // This will cause verifyGoalReached to return { reached: false }, making the test fail
      // as intended to demonstrate the defect.
      const userMessage = params.messages.findLast((m: any) => m.role === 'user');
      const prompt = typeof userMessage?.content === 'string' ? userMessage.content : JSON.stringify(userMessage?.content);
      
      if (prompt.includes("What is happening today?") && prompt.includes("Today is September 30, 2026")) {
        return Promise.resolve({
            id: 'mock_msg_1',
            type: 'message',
            role: 'assistant',
            content: [ { type: 'text', text: `{"verdict":"REJECT","reason":"(Mocked) The evidence refers to a date that seems to be in the future relative to my knowledge cutoff."}` } ],
            model: 'mock-model',
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 10 },
        });
      }
      
      // Default pass for any other LLM calls this test might trigger during module load or test execution.
      return Promise.resolve({
          id: 'mock_msg_2',
          type: 'message',
          role: 'assistant',
          content: [ { type: 'text', text: `{"verdict":"ACCEPT","reason":"(Mocked) Looks good."}` } ],
          model: 'mock-model',
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 10 },
      });
    }
  }
};

// The error message from the prior attempt shows `createLLMPort` fails when `LLM_VESSEL_ENDPOINT`
// is not set. By mocking the module containing this function (`llm-router.ts`), we can
// substitute our mock client and prevent the test from failing to load. This allows it to run
// and fail on the assertion, as required.
mock.module("../../src/llm-router", () => ({
  createLLMPort: () => mockLlmClient,
}));

// Import the module under test. The mock for its dependency is already in place.
import * as mod from "../../src/index";

describe("reach: judge and synthesis lack the current date (repro)", () => {
  it("misgrades a time-relative goal against training-era 'today' (failing repro)", async () => {
    // Evidence-driven repro: the surface states the real current date (example: 2026-09-30),
    // but the judge/synthesis path treats 'today' as a training-era date and rejects it as stale.
    const goal = "What is happening today?";
    const humanSurface = "Today is September 30, 2026 — stating it in the prompt does not hold... same prompt, opposite behaviour.";

    // Call the exported API the defect flows through. Thanks to the mock, this does not
    // perform network calls and runs purely in-memory.
    const v = await mod.verifyGoalReached(goal, [], humanSurface);

    // `verifyGoalReached` can return null for non-applicable cases (abstain). We expect a verdict.
    expect(v).not.toBeNull();

    // Intent: with a correct 'today' context, this should be accepted. Due to the defect
    // (and our mock simulating its effect), it is rejected.
    // This assertion intentionally fails under the current defect.
    expect(v!.reached).toBe(true);
  });
});
