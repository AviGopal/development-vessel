import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ResolverResult } from "./types.js";

const DEFAULT_QUEUE_PATH = join(
  process.env["HOME"] ?? "/root",
  ".minibob",
  "boredom-queue.json",
);

interface BoredomTask {
  id: string;
  templateId?: string;
  goal?: string;
  priority: "critical" | "high" | "medium" | "low";
  variables: Record<string, unknown>;
  reason?: string;
  createdAt: number;
  status: "pending";
}

interface LocalBoredomQueue {
  tasks: BoredomTask[];
  lastUpdated: number;
}

export interface BoredomEnqueuePointer {
  type: "boredom_enqueue";
  template_id?: string;
  goal?: string;
  priority?: "critical" | "high" | "medium" | "low";
  variables?: Record<string, unknown>;
  reason?: string;
  queue_path?: string;
}

export async function resolveBoredomEnqueue(pointer: BoredomEnqueuePointer): Promise<ResolverResult> {
  if (!pointer.template_id && !pointer.goal) {
    return {
      shape: "structuredError",
      body: { resolver: "boredom_enqueue", detail: "one of template_id or goal is required" },
    };
  }

  const queuePath = pointer.queue_path ?? DEFAULT_QUEUE_PATH;
  const dir = dirname(queuePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let queue: LocalBoredomQueue;
  if (existsSync(queuePath)) {
    try {
      queue = JSON.parse(readFileSync(queuePath, "utf-8")) as LocalBoredomQueue;
    } catch {
      queue = { tasks: [], lastUpdated: Date.now() };
    }
  } else {
    queue = { tasks: [], lastUpdated: Date.now() };
  }

  const task: BoredomTask = {
    id: `dev-vessel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ...(pointer.template_id ? { templateId: pointer.template_id } : {}),
    ...(pointer.goal ? { goal: pointer.goal } : {}),
    priority: pointer.priority ?? "medium",
    variables: pointer.variables ?? {},
    reason: pointer.reason ?? "enqueued by development-vessel probe",
    createdAt: Date.now(),
    status: "pending",
  };

  queue.tasks.push(task);
  queue.lastUpdated = Date.now();
  writeFileSync(queuePath, JSON.stringify(queue, null, 2));

  return {
    shape: "boredomEnqueueResult",
    body: {
      enqueued: true,
      task_id: task.id,
      template_id: pointer.template_id ?? null,
      goal: pointer.goal ?? null,
      priority: task.priority,
      queue_path: queuePath,
    },
  };
}
