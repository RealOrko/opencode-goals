import { randomUUID } from "node:crypto";
import type { Message, Part } from "@opencode-ai/sdk";
import type { Goal } from "./store.js";

export type SessionMessage = { info: Message; parts: Part[] };
export type Limits = { tokenBudget?: number; maxContinuations?: number };

export function tokenCount(message: Message): number {
  if (message.role !== "assistant") return 0;
  const t = message.tokens;
  // OpenCode reports uncached input, output, reasoning and cache input separately.
  return [t.input, t.output, t.reasoning, t.cache.read, t.cache.write]
    .reduce((sum, n) => sum + (Number.isFinite(n) && n > 0 ? n : 0), 0);
}

export function newGoal(sessionID: string, objective: string, limits: Limits, baseline: SessionMessage[]): Goal {
  if (!objective.trim()) throw new Error("A goal needs an objective.");
  for (const value of [limits.tokenBudget, limits.maxContinuations]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error("Goal limits must be positive integers.");
    }
  }
  return {
    version: 1, id: randomUUID(), sessionID, objective: objective.trim(),
    status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    ...limits, tokensUsed: 0, continuations: 0, automaticTurn: false, trackedTurns: [],
    usage: Object.fromEntries(baseline.filter(m => m.info.role === "assistant").map(m => [m.info.id, tokenCount(m.info)])),
  };
}

export function account(goal: Goal, messages: SessionMessage[]) {
  for (const { info } of messages) {
    if (info.role !== "assistant") continue;
    const previous = goal.usage[info.id];
    if (!goal.trackedTurns.includes(info.parentID)) continue;
    const current = tokenCount(info);
    goal.tokensUsed += Math.max(0, current - (previous ?? 0));
    goal.usage[info.id] = Math.max(previous ?? 0, current);
  }
  if (goal.status === "active" && goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget) {
    goal.status = "budget_limited";
    goal.reason = `Token budget reached (${goal.tokensUsed}/${goal.tokenBudget}).`;
    delete goal.pending;
  }
}

export function latestTurn(messages: SessionMessage[]) {
  // The server returns chronological messages. Use its order, not local clock comparisons.
  const users = messages.filter(m => m.info.role === "user");
  const user = users.at(-1);
  const assistants = user ? messages.filter(m => m.info.role === "assistant" && m.info.parentID === user.info.id) : [];
  return { user, assistants, last: assistants.at(-1) };
}

export function madeProgress(messages: SessionMessage[]): boolean {
  return messages.some(m => m.parts.some(p => p.type === "tool" && !isGoalTool(p.tool) &&
    p.tool !== "question" && p.state.status === "completed"));
}

export function isGoalTool(name: string) {
  return ["create_goal", "get_goal", "update_goal"].includes(name);
}

export function usedWorkTool(messages: SessionMessage[]): boolean {
  return messages.some(m => m.parts.some(p => p.type === "tool" && !isGoalTool(p.tool) &&
    p.tool !== "question" && ["completed", "error"].includes(p.state.status)));
}

export function summary(goal?: Goal): string {
  if (!goal) return "No goal is set for this session. Start one with /goal <objective>.";
  return [
    `Goal: ${goal.objective}`, `Status: ${goal.status}`,
    `Tokens used: ${goal.tokensUsed}${goal.tokenBudget === undefined ? " (no budget set)" : ` / ${goal.tokenBudget}`}`,
    goal.tokenBudget === undefined ? "" : `Tokens remaining: ${Math.max(0, goal.tokenBudget - goal.tokensUsed)}`,
    `Automatic continuations: ${goal.continuations}${goal.maxContinuations === undefined ? "" : ` / ${goal.maxContinuations}`}`,
    goal.reason ? `Reason: ${goal.reason}` : "", goal.evidence ? `Evidence: ${goal.evidence}` : "",
  ].filter(Boolean).join("\n");
}

export function instructions(goal: Goal) {
  return `<opencode-session-goal>\n${summary(goal)}\n` +
    (goal.status === "active" ?
      "Work toward this persistent objective. Follow user steering in this session while preserving the objective. " +
      "Verify the actual outcome with files, tool results, tests or other concrete evidence. " +
      "Call update_goal with status complete and specific evidence only when every requirement is satisfied. " +
      "A progress report, a passed subset of checks, or reaching a budget is not completion. " +
      "Do not stop just because a turn ends. The plugin will continue at the next idle boundary. " +
      "If the same external blocker prevents useful work, report it with update_goal status blocked; " +
      "three distinct consecutive turns are required before the goal stops as blocked. " +
      "Only create a goal on an explicit user request. Never invent a budget. " +
      "Pause/resume/clear and budget changes belong to the user via /goal controls. " +
      "Ask any necessary questions directly in ordinary session chat.\n" :
      "Do not automatically pursue this goal. Follow the user's current request. " +
      "Only the user can resume it with /goal resume.\n") + "</opencode-session-goal>";
}

export type GoalCommand = { action: "show" | "pause" | "resume" | "clear" } |
  { action: "start"; objective: string; limits: Limits } |
  { action: "budget"; tokenBudget?: number };

export function parseCommand(raw: string): GoalCommand {
  const text = raw.trim();
  if (!text || text === "status") return { action: "show" };
  if (["pause", "resume", "clear"].includes(text)) return { action: text as "pause" | "resume" | "clear" };
  const budget = /^budget\s+(off|\d+)$/.exec(text);
  if (budget) {
    const tokenBudget = budget[1] === "off" ? undefined : Number(budget[1]);
    if (tokenBudget !== undefined && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)) throw new Error("Budget must be positive or off.");
    return { action: "budget", tokenBudget };
  }
  let objective = text;
  const limits: Limits = {};
  while (objective.startsWith("--")) {
    if (objective.startsWith("-- ")) { objective = objective.slice(3); break; }
    const flag = /^--(tokens|turns)\s+(\d+)\s+/.exec(objective);
    if (!flag) throw new Error("Usage: /goal [--tokens N] [--turns N] <objective>");
    const number = Number(flag[2]);
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error("Limits must be positive integers.");
    if (flag[1] === "tokens") limits.tokenBudget = number;
    else limits.maxContinuations = number;
    objective = objective.slice(flag[0].length);
  }
  if (!objective.trim()) throw new Error("A goal needs an objective.");
  return { action: "start", objective: objective.trim(), limits };
}
