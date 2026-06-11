// Engram — WorkingMemoryManager
// Structured working memory for agent tasks.
// Tracks task progress across turns, detects goal drift, generates summaries.
// Standalone — no hook system dependency. Integrates via ActiveMemoryPlugin.
// Ported from holo-desktop WorkingMemoryManager.ts — hook deps removed.

import type { EngramLogger } from "../types/memory";

// ══════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════

export interface WorkingMemory {
  id: string;
  currentGoal: string;
  subGoals: SubGoal[];
  completedSteps: CompletedStep[];
  keyFindings: Finding[];
  constraints: string[];
  progress: number;
  createdAt: number;
  updatedAt: number;
}

export interface SubGoal {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
}

export interface CompletedStep {
  turnIndex: number;
  summary: string;
  toolsUsed: string[];
  outcome: "success" | "partial" | "error";
  timestamp: number;
}

export interface Finding {
  type: "lead_info" | "customer_insight" | "constraint" | "decision" | "risk" | "general";
  content: string;
  timestamp: number;
  turnIndex: number;
}

export interface DriftCheckResult {
  drifting: boolean;
  severity: number;
  description: string;
  correction: string;
}

/** Options for WorkingMemoryManager */
export interface WorkingMemoryOptions {
  /** Drift threshold (0-1), default: 0.6 */
  driftThreshold?: number;
  /** Max completed steps to keep, default: 50 */
  maxCompletedSteps?: number;
  /** Max findings to keep, default: 30 */
  maxFindings?: number;
  /** Custom logger */
  logger?: EngramLogger;
}

// ══════════════════════════════════════════════════════════════
// WorkingMemoryManager
// ══════════════════════════════════════════════════════════════

export class WorkingMemoryManager {
  private memories = new Map<string, WorkingMemory>();
  private options: Required<WorkingMemoryOptions>;
  private logger: EngramLogger;

  constructor(options: WorkingMemoryOptions = {}) {
    this.options = {
      driftThreshold: options.driftThreshold ?? 0.6,
      maxCompletedSteps: options.maxCompletedSteps ?? 50,
      maxFindings: options.maxFindings ?? 30,
      logger: options.logger ?? {
        info: (msg) => console.log(`[engram:working] ${msg}`),
        warn: (msg) => console.warn(`[engram:working] ${msg}`),
        error: (msg) => console.error(`[engram:working] ${msg}`),
        debug: (msg) => { /* noop */ },
      },
    };
    this.logger = this.options.logger;
  }

  /** Initialize working memory for a run */
  init(runId: string, goal: string, subGoals: string[] = [], constraints: string[] = []): WorkingMemory {
    const wm: WorkingMemory = {
      id: runId,
      currentGoal: goal,
      subGoals: subGoals.map((s, i) => ({
        id: `sg-${i}`,
        description: s,
        status: "pending" as const,
      })),
      completedSteps: [],
      keyFindings: [],
      constraints,
      progress: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.memories.set(runId, wm);
    this.logger.info(`initialized | runId=${runId} goal="${goal.slice(0, 60)}"`);
    return wm;
  }

  /** Get working memory for a run */
  get(runId: string): WorkingMemory | undefined {
    return this.memories.get(runId);
  }

  /** Record a completed step */
  recordStep(
    runId: string,
    turnIndex: number,
    summary: string,
    toolsUsed: string[],
    outcome: CompletedStep["outcome"] = "success",
  ): void {
    const wm = this.memories.get(runId);
    if (!wm) return;

    wm.completedSteps.push({
      turnIndex,
      summary,
      toolsUsed,
      outcome,
      timestamp: Date.now(),
    });

    if (wm.completedSteps.length > this.options.maxCompletedSteps) {
      wm.completedSteps = wm.completedSteps.slice(-this.options.maxCompletedSteps);
    }

    this.updateProgress(wm);
    wm.updatedAt = Date.now();
  }

  /** Add a key finding */
  addFinding(runId: string, type: Finding["type"], content: string, turnIndex: number): void {
    const wm = this.memories.get(runId);
    if (!wm) return;

    if (wm.keyFindings.some((f) => f.content === content)) return;

    wm.keyFindings.push({ type, content, timestamp: Date.now(), turnIndex });
    if (wm.keyFindings.length > this.options.maxFindings) {
      wm.keyFindings = wm.keyFindings.slice(-this.options.maxFindings);
    }
    wm.updatedAt = Date.now();
  }

  /** Mark a sub-goal status */
  updateSubGoal(runId: string, subGoalId: string, status: SubGoal["status"]): void {
    const wm = this.memories.get(runId);
    if (!wm) return;

    const sg = wm.subGoals.find((s) => s.id === subGoalId);
    if (sg) {
      sg.status = status;
      this.updateProgress(wm);
      wm.updatedAt = Date.now();
    }
  }

  /** Generate a context injection string for the agent prompt */
  generateSummary(runId: string): string | null {
    const wm = this.memories.get(runId);
    if (!wm) return null;

    const parts: string[] = [];
    parts.push(`[Working Memory] Goal: ${wm.currentGoal}`);

    if (wm.subGoals.length > 0) {
      const lines = wm.subGoals.map((sg) => {
        const icon = sg.status === "completed" ? "[done]"
          : sg.status === "in_progress" ? "[>>]"
          : sg.status === "blocked" ? "[!!]" : "[ ]";
        return `  ${icon} ${sg.description}`;
      });
      parts.push(`Sub-goals:\n${lines.join("\n")}`);
    }

    if (wm.completedSteps.length > 0) {
      const recent = wm.completedSteps.slice(-5);
      const lines = recent.map((s) => `  Step ${s.turnIndex}: ${s.summary} [${s.outcome}]`);
      parts.push(`Recent steps:\n${lines.join("\n")}`);
    }

    if (wm.keyFindings.length > 0) {
      const recent = wm.keyFindings.slice(-3);
      const lines = recent.map((f) => `  [${f.type}] ${f.content}`);
      parts.push(`Key findings:\n${lines.join("\n")}`);
    }

    if (wm.constraints.length > 0) {
      parts.push(`Constraints: ${wm.constraints.join("; ")}`);
    }

    parts.push(`Progress: ${wm.progress}%`);

    return parts.join("\n\n");
  }

  /** Check if the agent is drifting from the goal (heuristic-based) */
  checkDrift(
    runId: string,
    _currentStepText?: string,
    _currentToolCalls?: Array<{ name: string }>,
  ): DriftCheckResult {
    const wm = this.memories.get(runId);
    if (!wm) {
      return { drifting: false, severity: 0, description: "", correction: "" };
    }

    const stepsSinceProgress = wm.completedSteps.length > 0
      ? wm.completedSteps.filter((s) => s.outcome === "success").length === 0
      : false;

    const lastThree = wm.completedSteps.slice(-3);
    const consecutiveErrors = lastThree.length >= 3 &&
      lastThree.every((s) => s.outcome === "error");

    const lastTools = wm.completedSteps.slice(-5).flatMap((s) => s.toolsUsed);
    const toolCounts = new Map<string, number>();
    for (const t of lastTools) {
      toolCounts.set(t, (toolCounts.get(t) ?? 0) + 1);
    }
    const maxRepeated = Math.max(0, ...toolCounts.values());
    const repeatedToolLoop = maxRepeated >= 4;

    let severity = 0;
    let description = "";
    let correction = "";

    if (consecutiveErrors) {
      severity = 0.9;
      description = "3+ consecutive tool errors — agent may be stuck in an error loop";
      correction = "Review the last 3 errors and try a different approach. Consider asking the user for clarification.";
    } else if (repeatedToolLoop) {
      severity = 0.7;
      description = `Same tool called ${maxRepeated} times in recent steps — possible loop`;
      correction = "Avoid calling the same tool repeatedly. Is there a different tool or approach that could break this loop?";
    } else if (stepsSinceProgress && wm.completedSteps.length > 10) {
      severity = 0.5;
      description = `${wm.completedSteps.length} steps without successful completion — may have lost track of goal`;
      correction = `Re-evaluate progress against the main goal: "${wm.currentGoal}". What needs to happen next?`;
    }

    if (severity >= this.options.driftThreshold) {
      this.logger.warn(`drift detected | runId=${runId} severity=${severity} desc="${description}"`);
    }

    return {
      drifting: severity >= this.options.driftThreshold,
      severity,
      description,
      correction,
    };
  }

  /** Clean up memory for a run */
  dispose(runId: string): void {
    this.memories.delete(runId);
  }

  /** Clear all working memories */
  disposeAll(): void {
    this.memories.clear();
  }

  // ── Private ──

  private updateProgress(wm: WorkingMemory): void {
    if (wm.subGoals.length > 0) {
      const completed = wm.subGoals.filter((s) => s.status === "completed").length;
      wm.progress = Math.round((completed / wm.subGoals.length) * 100);
    } else {
      wm.progress = Math.min(95, wm.completedSteps.length * 5);
    }
  }
}
