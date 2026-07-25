export async function resolveFileList(pointer: {
  type: "fileList";
}): Promise<{ shape: "fileList"; body: string[] }> {
  const repoRoot = "/workspace/git/compose/fc-ms02fq5s-7as8za/development-vessel";
  const files = await Array.fromAsync(
    new Bun.Glob("**").scan({
      cwd: repoRoot,
      absolute: true,
      onlyFiles: true,
    }),
  );
  return {
    shape: "fileList",
    body: files.map((f) => f.slice(repoRoot.length + 1)),
  };
}
