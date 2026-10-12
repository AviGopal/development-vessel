// THE DRAFTER MODULE'S TYPES (open; type-only, erased at runtime).
//
// These mirror the closed schema in src/resolvers/feature-compose.ts (the drafter-split section), which is the
// authority: the closed core validates every DrafterContext it receives against its own copy of these keys and
// refuses anything else, so changing a type here changes nothing the core accepts.

/** A gap's lesson record, as the store holds it (structure is read defensively). */
export type LessonRecord = Readonly<Record<string, unknown>>;

/** Everything the closed core gathered for one compose. Deep-frozen; the module reads it and returns a context. */
export type DrafterFacts = Readonly<{
  spec: string;
  gapSummary: string;
  directed: boolean;
  /** The hydrated, store-merged classification_metadata (the floor reads the same object). */
  gapMeta: Readonly<Record<string, unknown>>;
  regionHint: string;
  lineHint: Readonly<{ file: string; start: number; end: number }> | null;
  targets: Readonly<{
    /** The closed target set (edit_site, relocation hint, spec paths, the check's imports admitted as targets). */
    files: readonly string[];
    ownCheckAdded: readonly string[];
    ownCheckReadonly: ReadonlyArray<Readonly<{ path: string; why: string }>>;
    /** Targets with no content on disk: each needs a create_file. */
    netNew: readonly string[];
  }>;
  verifyVessels: readonly string[];
  /** vessel ("repos/<v>") -> the files the closed listing found, in the floor's order (targets of any extension appended). */
  listing: Readonly<Record<string, readonly string[]>>;
  /** "repos/<v>/<file>" -> text: ONLY what the closed core read. */
  contents: Readonly<Record<string, string>>;
  ownCheck: Readonly<{
    vessel: string;
    test_file: string;
    only_tests: readonly string[];
    source: string;
    /** Each read-only imported module's text as the core read it (null: unreadable). */
    readonlyModules: Readonly<Record<string, string | null>>;
  }> | null;
  /** Display copy of the source/parent row's failure_lessons (the enforcement set is closed and separate). */
  lineageLessons: ReadonlyArray<LessonRecord>;
  /** Ancestor rows' failure lessons, filled only when planDrafterReads asks (ancestorDepth), to a closed depth. */
  ancestors: ReadonlyArray<Readonly<{ gap_id: string; depth: number; failure_lessons: ReadonlyArray<LessonRecord>; omitted: number }>>;
  parentCheck: Readonly<{ gap_id: string; check: Readonly<Record<string, unknown>>; failing: ReadonlyArray<Readonly<{ name: string; error?: string; expected?: string; received?: string; diff?: string }>> }> | null;
  /** Which source the closed lesson recall used: "concept-db" (lessonHits[0] are its rows), "jsonl" or "none". */
  lessonSource: "concept-db" | "jsonl" | "none";
  /** Concept-db lesson rows by query: the closed recall's first, then any queries planDrafterReads asked for. */
  lessonHits: ReadonlyArray<Readonly<{ query: string; rows: readonly string[] }>>;
  /** The compose-lesson JSONL lines the closed recall read (its last 400 raw lines, or its last 60 non-blank). */
  lessonJsonlTail: readonly string[];
  /** The per-file lesson JSONL lines the closed reader read (its last 80 non-blank). */
  fileLessonsTail: readonly string[];
  /** Text the closed core rendered from its own reads, exactly as the floor appends it. */
  principles: string;
  contracts: string;
  existingSymbols: string;
  symbolDecls: string;
  safeAnchors: string;
  /** The op-budget ceiling C = pointer.max_ops ?? 24 (closed), and whether max_ops was given. */
  opCeiling: number;
  opCeilingDeclared: boolean;
}>;

export type ReadRequest = { path: string; maxBytes: number };
export type LessonQuery = { query: string; limit: number };
export type DrafterReadPlan = { reads: ReadRequest[]; lessonQueries: LessonQuery[]; ancestorDepth: number };

/** What the module returns. The core validates every key; any other key is refused. */
export type DrafterContext = {
  /** GROUND TRUTH plus the appended blocks, as the decompose prompt consumes it. */
  grounding: string;
  /** path -> exactly the raw slice of that target file shown in `grounding` (checked by the core). */
  targetWindows: Record<string, string>;
  priorFeedback: string;
  /** The decompose prompt's principles slot is principles + composeLessons; the refine prompt reads composeLessons. */
  principles: string;
  composeLessons: string;
  /** Must equal facts.targets.netNew as a set. */
  netNewTargets: string[];
  opBudgetHint: number;
  journal: string[];
  version: string;
};
