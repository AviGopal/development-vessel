import { describe, test, expect, mock, afterEach, beforeEach } from "bun:test";

// Mock dependencies before they are imported by the module under test.
const mockFs = {
  existsSync: (path: string) => false,
  readFileSync: (path: string | Buffer | URL, options?: any) => "",
  writeFileSync: (path: string, data: string) => {},
  renameSync: (oldPath: string, newPath: string) => {},
};
mock.module("node:fs", () => mockFs);

const mockPath = {
  join: (...args: string[]) => args.join('/'),
  dirname: (path: string) => {
    const i = path.lastIndexOf('/');
    if (i === -1) return '.';
    if (i === 0) return '/';
    return path.substring(0, i);
  },
};
mock.module("node:path", () => mockPath);

const mockSubstrateGap = {
  gapStoreIsLocal: () => false,
  gapStoreFilePath: () => "/workspace/gaps/gaps.json",
  holdGapForwardDrains: () => () => {},
  forwardToGapStore: async (params: any) => ({
    shape: "substrateGapMerge_write",
    body: {
      verified: true,
      counts: {
        source_rows: params.rows.length,
        added: new Set(params.rows.map((r: any) => r.id)).size,
        identical: 0,
        holder_won: 0,
        source_won: 0,
        holder_before: 100,
        after: 100 + new Set(params.rows.map((r: any) => r.id)).size,
      },
    },
  }),
};
mock.module("../../src/resolvers/substrate-gap.js", () => mockSubstrateGap);

// Import SUT after mocks
import * as mod from "../../src/resolvers/gap-store-merge-migration.js";
import type { GapStoreMergeMigrationResult } from "../../src/resolvers/gap-store-merge-migration.js";

describe("runGapStoreMergeMigration on a forwarding node", () => {
  let originalGapStoreEndpoint: string | undefined;

  beforeEach(() => {
    originalGapStoreEndpoint = process.env.GAP_STORE_ENDPOINT;
    process.env.GAP_STORE_ENDPOINT = "http://some-remote-holder.example.com";
  });

  afterEach(() => {
    process.env.GAP_STORE_ENDPOINT = originalGapStoreEndpoint;
  });

  test("reads and merges a stale local copy instead of refusing, violating law 8", async () => {
    const GAPS_PATH = "/workspace/gaps/gaps.json";
    const MARKER_DIR = "/workspace/gaps";

    // @ts-ignore
    mockFs.existsSync = (path: string) => {
      if (path === GAPS_PATH) return true; // A stale local file exists
      if (path.startsWith(MARKER_DIR) && path.endsWith('.done.json')) return false; // Migration has not run yet
      return false;
    };
    
    // @ts-ignore
    mockFs.readFileSync = (path: string | Buffer | URL) => {
      if (path === GAPS_PATH) {
        return JSON.stringify([{ id: "gap:1", value: "stale" }]);
      }
      return "";
    };

    const result = await mod.runGapStoreMergeMigration();

    // Per REALIGNMENT §2.4 and law 8, a reader must not act on a stale copy. The migration
    // on a forwarding node should refuse to run if a stale local file exists, as the
    // single source of truth is the remote holder.
    // This assertion fails because the function proceeds to merge the file, returning
    // a 'merged' status instead of a 'skipped' one indicating refusal.
    const expected: GapStoreMergeMigrationResult = {
      status: "skipped",
      reason: "local_copy_on_forwarding_node_is_stale_and_must_be_retired",
    };
    
    expect(result).toEqual(expected);
  });
});
