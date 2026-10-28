import { randomUUID } from "node:crypto";
import type { Message, Part, TextPart, UserMessage } from "@opencode-ai/sdk";
import { account, instructions, latestTurn, madeProgress, newGoal, parseCommand, summary, usedWorkTool } from "./goal.js";
import type { Limits, SessionMessage } from "./goal.js";
import { GoalStore } from "./store.js";
import type { Goal } from "./store.js";

export interface Host {
  messages(sessionID: string): Promise<SessionMessage[]>;
  status(sessionID: string): Promise<string>;
  dispatch(sessionID: string, goal: Goal, leaseID: string): Promise<void>;
  abort(sessionID: string): Promise<void>;
  notice(sessionID: string, message: string, warning?: boolean): Promise<void>;
  log(error: unknown): Promise<void>;
}

export interface ContinuationMarker { kind: "continue"; goalID: string; leaseID: string }

export class GoalEngine {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private tasks = new Map<string, Promise<unknown>>();
  private waiting = new Map<string, Set<string>>();
  private controls = new Set<string>();
  private disposed = false;

  constructor(readonly store: GoalStore, readonly host: Host, readonly delayMs = 350) {}

  private queue<T>(sessionID: string, run: () => Promise<T>): Promise<T> {
    const task = (this.tasks.get(sessionID) ?? Promise.resolve()).catch(() => {}).then(run);
    this.tasks.set(sessionID, task);
    void task.finally(() => {
      if (this.tasks.get(sessionID) === task) this.tasks.delete(sessionID);
    }).catch(() => {});
    return task;
  }

  private cancelTimer(sessionID: string) {
    const timer = this.timers.get(sessionID);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionID);
  }

  async create(sessionID: string, objective: string, limits: Limits = {}, currentTurnID?: string): Promise<Goal> {
    return this.queue(sessionID, async () => {
      const baseline = await this.host.messages(sessionID);
      const goal = newGoal(sessionID, objective, limits, baseline);
      if (currentTurnID) {
        goal.lastUserID = currentTurnID;
        goal.trackedTurns.push(currentTurnID);
        const user = baseline.find(m => m.info.id === currentTurnID)?.info;
        if (user?.role === "user") {
          goal.agent = user.agent;
          goal.model = user.model;
        }
      }
      return this.store.change(sessionID, previous => {
        if (previous && previous.status !== "complete") {
          throw new Error("⚠️ This session already has a goal. Use /goal clear before replacing it.");
        }
        return { goal, result: goal };
      });
    });
  }

  async get(sessionID: string): Promise<Goal | undefined> {
    return this.queue(sessionID, async () => {
      const goal = await this.store.get(sessionID);
      if (!goal) return undefined;
      const messages = await this.host.messages(sessionID);
      return this.store.change(sessionID, current => {
        if (current) account(current, messages);
        return { goal: current, result: current };
      });
    });
  }

  async command(sessionID: string, raw: string): Promise<{ text: string; work: boolean }> {
    this.cancelTimer(sessionID);
    const command = parseCommand(raw);
    if (command.action === "start") {
      const goal = await this.create(sessionID, command.objective, command.limits);
      return { text: summary(goal), work: true };
    }
    return this.queue(sessionID, async () => {
      const messages = await this.host.messages(sessionID);
      return this.store.change(sessionID, goal => {
        if (goal) account(goal, messages);
        if (command.action === "clear") return { result: { text: "🧹 Goal cleared for this session.", work: false } };
        if (!goal) {
          if (command.action !== "show") throw new Error("⚠️ No goal is set for this session.");
          return { result: { text: summary(), work: false } };
        }
        // Any explicit control command cancels an outstanding automatic prompt.
        delete goal.pending;
        if (command.action === "pause") {
          if (goal.status !== "complete") {
            goal.status = "paused";
            goal.reason = "⏸️ Paused by user.";
          }
        } else if (command.action === "resume") {
          if (goal.status === "complete") throw new Error("⚠️ This goal is already complete.");
          if (goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget) {
            throw new Error("⚠️ Token budget is exhausted. Change it with /goal budget N or /goal budget off, then resume.");
          }
          if (goal.maxContinuations !== undefined && goal.continuations >= goal.maxContinuations) {
            throw new Error("⚠️ Continuation limit reached. Clear and create a new goal with a larger --turns limit.");
          }
          goal.status = "active";
          delete goal.reason;
          delete goal.blocker;
          delete goal.lastDispatchedTurn;
          goal.automaticTurn = false;
        } else if (command.action === "budget") {
          goal.tokenBudget = command.tokenBudget;
          account(goal, []);
        }
        return { goal, result: { text: summary(goal), work: command.action === "resume" } };
      });
    });
  }

  async onUser(message: UserMessage, parts: Part[], variant?: string) {
    this.cancelTimer(message.sessionID);
    return this.queue(message.sessionID, async () => {
      const marker = parts.find((p): p is TextPart => p.type === "text" && !!p.metadata?.opencodeGoals)?.metadata?.opencodeGoals as
        ContinuationMarker | { kind: "control"; work: boolean } | undefined;
      if (marker?.kind === "control" && !marker.work) this.controls.add(message.sessionID);
      else this.controls.delete(message.sessionID);
      await this.store.change(message.sessionID, goal => {
        if (marker?.kind === "continue") {
          if (!goal || goal.id !== marker.goalID || goal.status !== "active" ||
            goal.pending?.id !== marker.leaseID || goal.pending.expiresAt < Date.now()) {
            throw new Error("⚠️ Goal continuation cancelled: session or goal state changed.");
          }
          goal.automaticTurn = true;
          goal.continuations++;
          delete goal.pending;
        } else if (goal) {
          delete goal.pending;
          goal.automaticTurn = false;
        }
        if (goal) {
          goal.lastUserID = message.id;
          goal.agent = message.agent;
          goal.model = message.model;
          goal.variant = variant;
          if (goal.status === "active" && message.agent === "plan") {
            goal.status = "paused";
            goal.reason = "📝 Plan mode does not run goals. Switch to a working agent and use /goal resume.";
          }
          const controlOnly = marker?.kind === "control" && !marker.work;
          if (goal.status === "active" && !controlOnly) goal.trackedTurns.push(message.id);
          // /goal status and budget controls must not start goal work as a side effect.
          if (controlOnly) goal.lastDispatchedTurn = message.id;
        }
        return { goal, result: undefined };
      });
    });
  }

  async update(sessionID: string, update: { status: "complete" | "blocked"; evidence: string }): Promise<Goal> {
    return this.queue(sessionID, async () => {
      if (!update.evidence.trim()) throw new Error("⚠️ Specific completion or blocker evidence is required.");
      const messages = await this.host.messages(sessionID);
      return this.store.change(sessionID, goal => {
        if (!goal) throw new Error("⚠️ No goal is set for this session.");
        account(goal, messages);
        if (goal.status !== "active") throw new Error(`⚠️ Goal is ${goal.status}; only the user can resume it.`);
        if (update.status === "complete") {
          const observed = messages.filter(m => m.info.role === "assistant" && goal.trackedTurns.includes(m.info.parentID));
          if (!madeProgress(observed)) throw new Error("⚠️ Completion needs a successful non-goal tool call in this goal's work. Verify the outcome first.");
          goal.status = "complete";
          goal.evidence = update.evidence.trim();
          delete goal.reason;
          delete goal.pending;
        } else {
          const turn = goal.lastUserID;
          if (!turn) throw new Error("⚠️ A blocker must be reported from an active turn.");
          const description = update.evidence.trim();
          const previous = goal.blocker;
          const priorTurn = latestTurn(messages.filter(m => m.info.id !== turn &&
            !(m.info.role === "assistant" && m.info.parentID === turn))).user?.info.id;
          const consecutive = previous?.description === description &&
            (previous.turns.includes(turn) || previous.turns.at(-1) === priorTurn);
          goal.blocker = consecutive ? previous! : { description, turns: [] };
          if (!goal.blocker.turns.includes(turn)) goal.blocker.turns.push(turn);
          if (goal.blocker.turns.length >= 3) {
            goal.status = "blocked";
            goal.reason = description;
            delete goal.pending;
          }
        }
        return { goal, result: goal };
      });
    });
  }

  async onMessage(info: Message) {
    if (info.role !== "assistant") return;
    return this.queue(info.sessionID, async () => {
      const stop = await this.store.change(info.sessionID, goal => {
        if (!goal) return { result: false };
        const wasActive = goal.status === "active";
        account(goal, [{ info, parts: [] }]);
        if (goal.status === "active" && info.error) {
          goal.status = "paused";
          goal.reason = info.error.name === "MessageAbortedError" ? "⏸️ Interrupted by user." : `❌ Session error: ${info.error.name}`;
          delete goal.pending;
        }
        return { goal, result: wasActive && goal.status === "budget_limited" };
      });
      if (stop) {
        this.cancelTimer(info.sessionID);
        await this.host.abort(info.sessionID);
        await this.host.notice(info.sessionID, "🛑 Goal token budget reached. Automatic work stopped.", true);
      }
    });
  }

  async pause(sessionID: string, reason: string) {
    this.cancelTimer(sessionID);
    return this.queue(sessionID, () => this.store.change(sessionID, goal => {
      if (goal?.status === "active") {
        goal.status = "paused";
        goal.reason = reason;
        delete goal.pending;
      }
      return { goal, result: undefined };
    }));
  }

  waitForUser(sessionID: string, requestID: string) {
    this.cancelTimer(sessionID);
    const requests = this.waiting.get(sessionID) ?? new Set<string>();
    requests.add(requestID);
    this.waiting.set(sessionID, requests);
  }

  answered(sessionID: string, requestID: string) {
    this.waiting.get(sessionID)?.delete(requestID);
  }

  busy(sessionID: string) { this.cancelTimer(sessionID); }

  idle(sessionID: string) {
    if (this.disposed || this.timers.has(sessionID)) return;
    const timer = setTimeout(() => {
      this.timers.delete(sessionID);
      void this.continue(sessionID).catch(error => this.host.log(error));
    }, this.delayMs);
    timer.unref();
    this.timers.set(sessionID, timer);
  }

  async continue(sessionID: string) {
    if (this.disposed || this.waiting.get(sessionID)?.size) return;
    // Serialize admission and dispatch in this instance. The durable lease also
    // prevents two OpenCode instances from dispatching the same turn.
    return this.queue(sessionID, async () => {
      if (this.disposed || await this.host.status(sessionID) !== "idle") return;
      const messages = await this.host.messages(sessionID);
      const turn = latestTurn(messages);
      const last = turn.last?.info;
      const decision = await this.store.change(sessionID, goal => {
        if (!goal) return { result: undefined as { goal: Goal; leaseID: string } | undefined };
        account(goal, messages);
        if (goal.status !== "active" || !turn.user || !last || last.role !== "assistant" || !last.time.completed ||
          goal.lastUserID !== turn.user.info.id || goal.lastDispatchedTurn === turn.user.info.id ||
          (goal.pending && goal.pending.expiresAt > Date.now())) return { goal, result: undefined };
        if (last.error || goal.agent === "plan") {
          goal.status = "paused";
          goal.reason = last.error ? `🛑 Session stopped: ${last.error.name}` : "📝 Plan mode does not run goals.";
        } else if (goal.automaticTurn && !usedWorkTool(turn.assistants) && !goal.blocker?.turns.includes(turn.user.info.id)) {
          goal.status = "paused";
          goal.reason = "⏸️ Automatic turn made no tool calls that performed work. Use /goal resume to continue.";
        } else if (goal.maxContinuations !== undefined && goal.continuations >= goal.maxContinuations) {
          goal.status = "budget_limited";
          goal.reason = "🛑 Automatic continuation limit reached.";
        }
        if (goal.status !== "active") {
          delete goal.pending;
          return { goal, result: undefined };
        }
        const leaseID = randomUUID();
        goal.pending = { id: leaseID, parentID: turn.user.info.id, expiresAt: Date.now() + 30_000 };
        goal.lastDispatchedTurn = turn.user.info.id;
        return { goal, result: { goal, leaseID } };
      });
      if (!decision || this.disposed || this.waiting.get(sessionID)?.size) return;
      // Do not await the resulting model turn: promptAsync only admits a prompt.
      // onUser validates the lease again before OpenCode persists that prompt.
      try {
        await this.host.dispatch(sessionID, decision.goal, decision.leaseID);
      } catch (error) {
        await this.store.change(sessionID, goal => {
          if (goal?.pending?.id === decision.leaseID) {
            goal.status = "paused";
            goal.reason = `⚠️ Could not dispatch continuation: ${error instanceof Error ? error.message : String(error)}`;
            delete goal.pending;
          }
          return { goal, result: undefined };
        });
        throw error;
      }
    });
  }

  async context(sessionID: string) {
    const goal = await this.store.get(sessionID);
    return goal ? instructions(goal) : undefined;
  }

  async beforeTool(sessionID: string, tool: string) {
    if (this.controls.has(sessionID) && tool !== "get_goal") {
      throw new Error("⚠️ This goal control turn is acknowledgement only. Do not call tools or change goal state.");
    }
    const goal = await this.store.get(sessionID);
    if (goal && goal.status !== "active" && goal.status !== "complete" &&
      goal.lastUserID && goal.trackedTurns.includes(goal.lastUserID)) {
      throw new Error(`⚠️ Goal work stopped (${goal.status}). Report the status and wait for user input.`);
    }
  }

  async remove(sessionID: string) {
    this.cancelTimer(sessionID);
    this.waiting.delete(sessionID);
    this.controls.delete(sessionID);
    return this.queue(sessionID, () => this.store.change(sessionID, () => ({ result: undefined })));
  }

  async dispose() {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled(this.tasks.values());
  }
}
