import { test, expect } from "bun:test";
import * as mod from "../../src/index";

test("a containment-refused shell write is misreported as 'no result'", () => {
  // Simulate a walk log where a tool execution was refused by write-containment,
  // yielding a `null` result to the executor's reasoner.
  const walkLogWithNullResult = [
    {
      goal: "A goal that requires a shell write.",
      judgement: {
        executed: [
          {
            tool: "shell",
            result: null, // This `null` represents the refused write.
          },
        ],
      },
    },
  ];

  const reasons = mod.dispatchFailureReasons(
    walkLogWithNullResult,
    "Dispatch failed."
  );

  // This test reproduces the defect. The reasoner should distinguish a refused
  // write from a command that produced no output. Instead, it reports
  // "the command produced no result", misguiding the walk's self-correction.
  // This assertion passes against the current defective code.
  expect(reasons).toContain("the command produced no result");
});
