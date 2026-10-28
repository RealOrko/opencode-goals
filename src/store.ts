import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";

export type GoalStatus = "active" | "paused" | "blocked" | "complete" | "budget_limited";
export interface Goal {
  version: 1;
  id: string;
  sessionID: string;
  objective: string;
  status: GoalStatus;
  reason?: string;
  createdAt: number;
  updatedAt: number;
  tokenBudget?: number;
  maxContinuations?: number;
  tokensUsed: number;
  continuations: number;
  usage: Record<string, number>;
  lastUserID?: string;
  automaticTurn: boolean;
  trackedTurns: string[];
  lastDispatchedTurn?: string;
  pending?: { id: string; parentID: string; expiresAt: number };
  model?: { providerID: string; modelID: string };
  agent?: string;
  variant?: string;
  evidence?: string;
  blocker?: { description: string; turns: string[] };
}

export class GoalStore {
  readonly directory: string;
  constructor(projectDirectory: string, root = process.env.OPENCODE_GOALS_STATE_DIR ??
    join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "opencode-goals")) {
    this.directory = join(root, createHash("sha256").update(resolve(projectDirectory)).digest("hex").slice(0, 24));
  }

  path(sessionID: string) {
    if (!/^ses_[a-zA-Z0-9_-]+$/.test(sessionID)) throw new Error("Invalid OpenCode session ID");
    return join(this.directory, `${sessionID}.json`);
  }

  async get(sessionID: string): Promise<Goal | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path(sessionID), "utf8"));
      const g = value as Partial<Goal> | null;
      if (!g || typeof g !== "object" || g.version !== 1 || g.sessionID !== sessionID ||
        typeof g.id !== "string" || typeof g.objective !== "string" ||
        !["active", "paused", "blocked", "complete", "budget_limited"].includes(g.status ?? "") ||
        !Number.isFinite(g.createdAt) || !Number.isFinite(g.updatedAt) ||
        !Number.isFinite(g.tokensUsed) || !Number.isSafeInteger(g.continuations) ||
        typeof g.automaticTurn !== "boolean" ||
        !Array.isArray(g.trackedTurns) || !g.trackedTurns.every(t => typeof t === "string") ||
        !g.usage || typeof g.usage !== "object" || !Object.values(g.usage).every(n => Number.isFinite(n) && n >= 0)) {
        throw new Error(`Invalid goal state: ${this.path(sessionID)}. State was left intact.`);
      }
      return value as Goal;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async change<T>(sessionID: string, update: (goal: Goal | undefined) => { goal?: Goal; result: T }): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(sessionID);
    const release = await lockfile.lock(path, {
      realpath: false, stale: 30_000, retries: { retries: 50, minTimeout: 10, maxTimeout: 100 },
    });
    try {
      const { goal, result } = update(await this.get(sessionID));
      if (!goal) {
        await rm(path, { force: true });
      } else {
        goal.updatedAt = Date.now();
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(goal, null, 2) + "\n", { mode: 0o600, flag: "wx" });
          await rename(temporary, path);
        } finally {
          await rm(temporary, { force: true });
        }
      }
      return result;
    } finally {
      await release();
    }
  }
}
