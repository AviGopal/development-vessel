import { readdir } from "node:fs/promises";
import { join } from "node:path";

export type FileListOptions = {
  dir?: string;
  recursive?: boolean;
};

export async function resolveFileList(opts: FileListOptions = {}): Promise<{ shape: "file-list"; body: string[] }> {
  const { dir = process.cwd(), recursive = false } = opts;
  const entries = await readdir(dir, { withFileTypes: true, recursive });
  const files = entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => join(dir, entry.name));
  return { shape: "file-list", body: files };
}