/**
 * changePlan shape's ordering primitive: deterministically orders multi-component
 * planned changes so dependent edits land in sequence. Pure module, no I/O.
 */
export interface PlannedChange {
  id: string;
  file: string;
  dependsOn: string[];
}

export function orderChangePlan(changes: PlannedChange[]): { ordered: PlannedChange[]; cycles: string[][] } {
  const byId = new Map(changes.map((c) => [c.id, c]));
  const visited = new Map<string, 0 | 1 | 2>();
  const ordered: PlannedChange[] = [];
  const cycles: string[][] = [];
  const sortedIds = [...changes].sort((a, b) => a.id.localeCompare(b.id)).map((c) => c.id);

  const visit = (id: string, stack: string[]): void => {
    const state = visited.get(id);
    if (state === 2) return;
    if (state === 1) {
      const cycle = stack.slice(stack.indexOf(id));
      cycle.push(id);
      cycles.push(cycle);
      return;
    }
    visited.set(id, 1);
    const change = byId.get(id);
    if (change) {
      for (const dep of [...change.dependsOn].sort()) {
        if (byId.has(dep)) visit(dep, [...stack, id]);
      }
      ordered.push(change);
    }
    visited.set(id, 2);
  };

  for (const id of sortedIds) visit(id, []);
  return { ordered, cycles };
}
