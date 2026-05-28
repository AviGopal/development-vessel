import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * try-direct-answer — the minimum activity loop mechanism.
 *
 * Per operator directive 2026-05-28:
 * "It needs to be able to learn how it can learn how to answer by trying to
 * answer the question. This is the simplest activity loop mechanism."
 *
 * When the substrate receives a goal it has no specific template for, instead
 * of refusing or cascading through slot-binding it should **try**. The trying
 * itself is the learning signal: a trace exists, Thompson posteriors accumulate,
 * the LLM's self-assessment of confidence and `learning_needs` feed downstream
 * concept-extraction / template-authoring.
 *
 * Why this template gets selected for out-of-domain goals:
 * - `input_shapes: []` → matches anything → `shape_compatible: true` → +3 boost
 * - `tags: ["fallback.universal", "intent:try-anything"]` → low tag-match
 *   quality on most goals but non-zero
 * - Combined with Thompson exploration, it surfaces in the exploration pool
 *   whenever existing templates have zero domain match
 *
 * The output is NOT claimed to be authoritative. It's an *attempt* with the
 * LLM's own confidence + learning_needs. Downstream consumers (concept-db
 * extractor, draft-gap-closing-activity) can use the learning_needs field to
 * grow the substrate's competence: each `learning_needs` entry is a candidate
 * concept to write to concept-db, or a candidate shape to author a producer
 * template for.
 */
export const TRY_DIRECT_ANSWER_TEMPLATE: ActivityTemplate = {
  id: "try-direct-answer",
  name: "try-direct-answer",
  description:
    "Universal fallback: attempt to answer any goal directly via LLM. Emits an " +
    "attemptedAnswer impulse with answer text, confidence (0-1), and learning_needs " +
    "(list of concepts/shapes the substrate would need to learn to answer better). " +
    "The substrate's simplest activity-loop mechanism — trying IS the learning signal. " +
    "Out-of-domain goals select this template via shape_compatible=true (input_shapes=[]) " +
    "instead of cascading through slot-binding on a wrongly-selected high-α template.",
  outputShapes: ["attemptedAnswer"],
  tags: ["fallback.universal", "intent.try-anything", "lifecycle.attempt"],
  variables: [
    {
      name: "goal",
      type: "string",
      required: true,
      description: "The user-provided goal text to attempt to answer.",
    },
  ],
  tasks: [
    {
      id: "attempt_answer",
      description:
        "Ask the LLM to attempt the goal directly, then self-rate confidence and " +
        "identify learning needs. The attemptedAnswer impulse this emits is the " +
        "trace signal for Thompson learning + downstream concept extraction.",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        prompt: {
          template:
            "You are an AI assistant attempting to answer a goal. The substrate that asked you may have " +
            "zero domain expertise for this — that's expected. Your job is to TRY, then honestly report " +
            "your confidence and what the substrate would need to learn to answer better next time.\n\n" +
            "GOAL: {{goal}}\n\n" +
            "Provide your attempt in this exact JSON format (no markdown, no prose outside JSON):\n" +
            "{\n" +
            '  "answer": "<your best-effort answer, 1-5 sentences>",\n' +
            '  "confidence": <number 0.0-1.0; 0.0 = totally guessing, 1.0 = certain>,\n' +
            '  "learning_needs": [\n' +
            '    "<a concept the substrate would need to know to answer better>",\n' +
            '    "<another concept or shape that would help>",\n' +
            '    "<up to 5 entries; empty array if you answered confidently>"\n' +
            "  ],\n" +
            '  "answer_shape": "<a short hypothetical shape name the substrate could' +
            ' produce to answer this kind of goal authoritatively, e.g. ' +
            '\\"investmentRecommendation\\" or \\"collectibleValuation\\"; or null if the goal is too vague>"\n' +
            "}\n",
        },
      },
      outputShapes: ["attemptedAnswer"],
    },
  ],
};
