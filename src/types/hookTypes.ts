// Engram — Hook Types
// Standardized lifecycle events for the Active Memory plugin.
// Framework adapters map host framework events to these hooks.

export type HookName = "before_step" | "after_step" | "after_run" | "on_error";

export type HookExecutionMode = "sequential" | "parallel";

export interface HookMeta {
  name: HookName;
  mode: HookExecutionMode;
  description: string;
}

export const HOOK_META: Record<HookName, HookMeta> = {
  before_step: {
    name: "before_step",
    mode: "sequential",
    description: "Before each agent reasoning step — inject relevant memories into context",
  },
  after_step: {
    name: "after_step",
    mode: "parallel",
    description: "After each agent step — per-step analytics and logging",
  },
  after_run: {
    name: "after_run",
    mode: "parallel",
    description: "Agent run completed — extract memories, save session bridges, consolidate",
  },
  on_error: {
    name: "on_error",
    mode: "sequential",
    description: "Agent run errored — persist error context, trigger recovery",
  },
};
