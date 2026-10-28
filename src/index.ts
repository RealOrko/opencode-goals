import { type Plugin, tool } from "@opencode-ai/plugin";
import type { TextPart } from "@opencode-ai/sdk";
import { GoalEngine, type Host } from "./engine.js";
import { latestTurn, summary } from "./goal.js";
import { GoalStore } from "./store.js";

const GoalPlugin: Plugin = async ({ client, directory }, options = {}) => {
  const stateDirectory = typeof options.stateDirectory === "string" ? options.stateDirectory : undefined;
  const delayMs = typeof options.continuationDelayMs === "number" ? options.continuationDelayMs : 350;
  if (!Number.isFinite(delayMs) || delayMs < 50) throw new Error("continuationDelayMs must be at least 50.");
  const query = { directory };
  const host: Host = {
    async messages(sessionID) {
      const response = await client.session.messages({ path: { id: sessionID }, query, throwOnError: true });
      return response.data ?? [];
    },
    async status(sessionID) {
      const response = await client.session.status({ query, throwOnError: true });
      return response.data?.[sessionID]?.type ?? "idle";
    },
    async dispatch(sessionID, goal, leaseID) {
      await client.session.promptAsync({
        path: { id: sessionID }, query, throwOnError: true,
        body: {
          agent: goal.agent, model: goal.model,
          // Preserve the selected reasoning variant on OpenCode versions which expose it.
          ...goal.variant ? { variant: goal.variant } : {},
          parts: [{
            type: "text", synthetic: true,
            text: "Continue working toward the active session goal. Check the current evidence and take the next useful action. " +
              "If the whole objective is verified, call update_goal to mark it complete with evidence. " +
              "Do not ask the user to say keep going.\n\n" + summary(goal),
            metadata: { opencodeGoals: { kind: "continue", goalID: goal.id, leaseID } },
          }],
        },
      });
    },
    async abort(sessionID) {
      await client.session.abort({ path: { id: sessionID }, query, throwOnError: true });
    },
    async notice(_sessionID, message, warning) {
      await client.tui.showToast({ body: { title: "Session goal", message, variant: warning ? "warning" : "info" } });
    },
    async log(error) {
      await client.app.log({ body: { service: "opencode-session-goals", level: "error",
        message: error instanceof Error ? error.message : String(error) } }).catch(() => {});
    },
  };
  const engine = new GoalEngine(new GoalStore(directory, stateDirectory), host, delayMs);
  const s = tool.schema;
  return {
    async config(config) {
      config.command ??= {};
      if (config.command.goal) throw new Error("Another plugin or config already owns /goal. Remove that command first.");
      config.command.goal = {
        description: "Persistent session goal: <objective>, status, pause, resume, clear, budget N/off",
        template: "Manage the persistent session goal: $ARGUMENTS",
      };
    },
    tool: {
      create_goal: tool({
        description: "Create a persistent objective for this session ONLY when the user explicitly asks for a goal. " +
          "Continues across turns until verified complete or stopped. Never invent a token budget.",
        args: {
          objective: s.string().min(1).describe("The user's explicit objective and success conditions"),
          token_budget: s.number().int().positive().optional().describe("Only when the user explicitly specifies a token budget"),
        },
        async execute(args, context) {
          if (context.agent === "plan") throw new Error("Switch from plan mode to a working agent before starting a goal.");
          const messages = await host.messages(context.sessionID);
          const currentUser = latestTurn(messages).user?.info.id;
          const goal = await engine.create(context.sessionID, args.objective, { tokenBudget: args.token_budget }, currentUser);
          return summary(goal);
        },
      }),
      get_goal: tool({
        description: "Read this session's goal, status, token usage, limits and completion evidence.",
        args: {},
        async execute(_args, context) { return summary(await engine.get(context.sessionID)); },
      }),
      update_goal: tool({
        description: "Mark the active goal complete ONLY after verifying every requirement with concrete evidence. " +
          "Or report the same external blocker across three consecutive turns to stop as blocked. " +
          "The model cannot pause, resume, clear, replace a live goal or change its budget.",
        args: {
          status: s.enum(["complete", "blocked"]),
          evidence: s.string().min(1).describe("Specific verified outputs, tests, files, or the exact recurring external blocker"),
        },
        async execute(args, context) { return summary(await engine.update(context.sessionID, args)); },
      }),
    },
    async "command.execute.before"(input, output) {
      if (input.command !== "goal") return;
      let result: { text: string; work: boolean };
      try {
        result = await engine.command(input.sessionID, input.arguments);
      } catch (error) {
        result = { text: error instanceof Error ? error.message : String(error), work: false };
      }
      // OpenCode v1 always submits a turn after this hook. Mutate the existing
      // array in place: replacing output.parts does not replace the host's array.
      const part = output.parts.find((p): p is TextPart => p.type === "text");
      const text = result.work ? `${result.text}\n\nWork toward the active goal now.` :
        `${result.text}\n\nThis goal control command has already been executed by the plugin. ` +
        "Briefly report the result above. Do not call tools, change goal state, or start substantive goal work this turn.";
      if (part) {
        part.text = text;
        part.metadata = { ...part.metadata, opencodeGoals: { kind: "control", work: result.work } };
        output.parts.splice(0, output.parts.length, part);
      } else {
        // The hook's runtime parts are prompt inputs; OpenCode assigns IDs later.
        output.parts.push({ type: "text", text,
          metadata: { opencodeGoals: { kind: "control", work: result.work } } } as unknown as TextPart);
      }
    },
    async "chat.message"(input, output) {
      await engine.onUser(output.message, output.parts, input.variant);
    },
    async "tool.execute.before"(input) {
      await engine.beforeTool(input.sessionID, input.tool);
    },
    async "experimental.chat.system.transform"(input, output) {
      if (!input.sessionID) return;
      const context = await engine.context(input.sessionID);
      if (context) output.system.push(context);
    },
    async "experimental.session.compacting"(input, output) {
      const context = await engine.context(input.sessionID);
      if (context) output.context.push(context);
    },
    async "experimental.compaction.autocontinue"(input, output) {
      const goal = await engine.store.get(input.sessionID);
      if (goal && goal.status !== "active") output.enabled = false;
    },
    async event({ event }) {
      // The v1 SDK's event union omits permission.asked/question.* events that
      // 1.19.4 actually delivers. Interpret those runtime events explicitly.
      const { type, properties: p } = event as unknown as { type: string; properties: Record<string, any> };
      try {
        if (type === "message.updated" && p.info) await engine.onMessage(p.info);
        else if (type === "session.status" && p.status?.type !== "idle") engine.busy(p.sessionID);
        else if (type === "session.idle") engine.idle(p.sessionID);
        else if (type === "session.error" && p.sessionID) await engine.pause(p.sessionID, `Session error: ${p.error?.name ?? "unknown"}`);
        else if (type === "session.deleted") await engine.remove(p.info.id);
        else if (["permission.asked", "permission.updated", "question.asked"].includes(type)) {
          engine.waitForUser(p.sessionID, p.id ?? p.requestID ?? p.permissionID);
        } else if (["permission.replied", "question.replied", "question.rejected"].includes(type)) {
          engine.answered(p.sessionID, p.requestID ?? p.permissionID ?? p.id);
          if (type === "question.rejected" || ["reject", "deny"].includes(p.reply ?? p.response)) {
            await engine.pause(p.sessionID, "User declined an input or permission request.");
          }
        }
      } catch (error) {
        await host.log(error);
      }
    },
    async dispose() { await engine.dispose(); },
  };
};

export default GoalPlugin;
