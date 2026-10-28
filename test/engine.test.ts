import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { AssistantMessage, Part, TextPart, UserMessage } from "@opencode-ai/sdk";
import { GoalEngine, type Host } from "../src/engine.js";
import { account, newGoal, parseCommand, type SessionMessage } from "../src/goal.js";
import { GoalStore, type Goal } from "../src/store.js";

const sessionID = "ses_test";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(f => f())); });

function user(id: string): UserMessage {
  return { id, sessionID, role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: Date.now() } };
}
function assistant(parentID: string, id: string, count = 10, progress = true): SessionMessage {
  const info: AssistantMessage = { id, parentID, sessionID, role: "assistant", time: { created: Date.now(), completed: Date.now() },
    modelID: "test", providerID: "fixture", mode: "build", path: { cwd: "/test", root: "/test" }, cost: 0,
    tokens: { input: count, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop" };
  const parts = progress ? [{ id: `prt_${id}`, messageID: id, sessionID, type: "tool", callID: `call_${id}`,
    tool: "bash", state: { status: "completed", input: { command: "test -f result" }, output: "passed", title: "check",
      metadata: {}, time: { start: Date.now(), end: Date.now() } } }] as Part[] : [];
  return { info, parts };
}
function text(metadata: Record<string, unknown>): TextPart {
  return { id: "prt_marker", messageID: "msg_marker", sessionID, type: "text", text: "continue", metadata };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "opencode-goals-unit-"));
  const store = new GoalStore("/test-project", root);
  let messages: SessionMessage[] = [];
  let status = "idle";
  let aborts = 0;
  const dispatches: { goal: Goal; leaseID: string }[] = [];
  const host: Host = {
    async messages() { return structuredClone(messages); },
    async status() { return status; },
    async dispatch(_id, goal, leaseID) { dispatches.push({ goal, leaseID }); },
    async abort() { aborts++; }, async notice() {}, async log(error) { throw error; },
  };
  const engine = new GoalEngine(store, host, 50);
  cleanup.push(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });
  async function turn(id: string, { automatic = false, progress = true, count = 10, error = undefined as AssistantMessage["error"] } = {}) {
    const input = user(id);
    const marker = dispatches.at(-1);
    const parts = automatic ? [text({ opencodeGoals: { kind: "continue", goalID: marker!.goal.id, leaseID: marker!.leaseID } })] : [];
    await engine.onUser(input, parts);
    const reply = assistant(id, `msg_reply_${id}`, count, progress);
    if (error) (reply.info as AssistantMessage).error = error;
    messages.push({ info: input, parts }, reply);
    await engine.onMessage(reply.info);
  }
  return { root, store, host, engine, dispatches, turn,
    get messages() { return messages; }, set status(next: string) { status = next; }, get aborts() { return aborts; } };
}

test("idle continuation is deduplicated across duplicate events and plugin instances", async () => {
  const f = await fixture();
  await f.engine.create(sessionID, "Produce and verify the result");
  await f.turn("msg_first");
  const second = new GoalEngine(new GoalStore("/test-project", f.root), f.host, 50);
  cleanup.push(() => second.dispose());
  await Promise.all([f.engine.continue(sessionID), f.engine.continue(sessionID), second.continue(sessionID)]);
  assert.equal(f.dispatches.length, 1);
  await f.turn("msg_auto", { automatic: true });
  await f.engine.continue(sessionID);
  assert.equal(f.dispatches.length, 2);
  assert.equal((await f.store.get(sessionID))?.continuations, 1);
});

test("pause invalidates an already dispatched synthetic prompt", async () => {
  const f = await fixture();
  await f.engine.create(sessionID, "Finish"); await f.turn("msg_first");
  await f.engine.continue(sessionID);
  const dispatched = f.dispatches[0]!;
  await f.engine.command(sessionID, "pause");
  await assert.rejects(f.engine.onUser(user("msg_late"), [text({ opencodeGoals: {
    kind: "continue", goalID: dispatched.goal.id, leaseID: dispatched.leaseID,
  } })]), /cancelled/);
  assert.equal((await f.store.get(sessionID))?.status, "paused");
  await f.engine.continue(sessionID); assert.equal(f.dispatches.length, 1);
});

test("user steering invalidates an outstanding continuation and retains the objective", async () => {
  const f = await fixture();
  await f.engine.create(sessionID, "Original objective"); await f.turn("msg_first");
  await f.engine.continue(sessionID);
  await f.engine.onUser(user("msg_steering"), []);
  const g = await f.store.get(sessionID);
  assert.equal(g?.objective, "Original objective"); assert.equal(g?.pending, undefined);
  await assert.rejects(f.turn("msg_late", { automatic: true }), /cancelled/);
});

test("token usage is incremental, includes cached and reasoning tokens, and survives reload", async () => {
  const f = await fixture();
  const old = assistant("msg_old", "msg_old_reply", 1000);
  f.messages.push({ info: user("msg_old"), parts: [] }, old);
  await f.engine.create(sessionID, "Finish", { tokenBudget: 100 }); await f.turn("msg_first", { count: 20 });
  const info = f.messages.at(-1)!.info as AssistantMessage;
  info.tokens = { input: 20, output: 10, reasoning: 5, cache: { read: 30, write: 5 } };
  await f.engine.onMessage(info); await f.engine.onMessage(info);
  assert.equal((await new GoalStore("/test-project", f.root).get(sessionID))?.tokensUsed, 70);
  info.tokens.input = 60;
  await f.engine.onMessage(info);
  assert.equal((await f.store.get(sessionID))?.tokensUsed, 110);
  assert.equal((await f.store.get(sessionID))?.status, "budget_limited");
  assert.equal(f.aborts, 1);
  await assert.rejects(f.engine.command(sessionID, "resume"), /exhausted/);
  await f.engine.command(sessionID, "budget 200");
  assert.equal((await f.store.get(sessionID))?.status, "budget_limited");
  await f.engine.command(sessionID, "resume");
  assert.equal((await f.store.get(sessionID))?.status, "active");
});

test("paused conversations are not charged to a goal", async () => {
  const f = await fixture();
  await f.engine.create(sessionID, "Finish"); await f.turn("msg_work", { count: 10 });
  await f.engine.command(sessionID, "pause"); await f.turn("msg_unrelated", { count: 999 });
  assert.equal((await f.engine.get(sessionID))?.tokensUsed, 10);
  await f.engine.command(sessionID, "resume"); await f.turn("msg_resumed", { count: 20 });
  assert.equal((await f.engine.get(sessionID))?.tokensUsed, 30);
});

test("an automatic turn without successful work stops instead of spinning", async () => {
  const f = await fixture();
  await f.engine.create(sessionID, "Finish"); await f.turn("msg_initial", { progress: false });
  await f.engine.continue(sessionID); assert.equal(f.dispatches.length, 1);
  await f.turn("msg_auto", { automatic: true, progress: false });
  await f.engine.continue(sessionID);
  assert.equal(f.dispatches.length, 1);
  assert.equal((await f.store.get(sessionID))?.status, "paused");
  assert.match((await f.store.get(sessionID))?.reason ?? "", /no tool calls/);
});

test("busy, pending input and plan mode prevent automatic work", async () => {
  const f = await fixture();
  await f.engine.create(sessionID, "Finish"); await f.turn("msg_initial");
  f.status = "busy"; await f.engine.continue(sessionID); assert.equal(f.dispatches.length, 0);
  f.status = "idle"; f.engine.waitForUser(sessionID, "request_1");
  await f.engine.continue(sessionID); assert.equal(f.dispatches.length, 0);
  f.engine.answered(sessionID, "request_1");
  await f.engine.onUser({ ...user("msg_plan"), agent: "plan" }, []);
  assert.equal((await f.store.get(sessionID))?.status, "paused");
});

test("interruption pauses a goal and does not restart it at idle", async () => {
  const f = await fixture();
  await f.engine.create(sessionID, "Finish");
  await f.turn("msg_interrupt", { error: { name: "MessageAbortedError", data: { message: "aborted" } } });
  await f.engine.continue(sessionID);
  assert.equal(f.dispatches.length, 0);
  assert.equal((await f.store.get(sessionID))?.status, "paused");
});

test("a configured continuation cap stops without claiming completion", async () => {
  const f = await fixture();
  await f.engine.create(sessionID, "Finish", { maxContinuations: 1 }); await f.turn("msg_first");
  await f.engine.continue(sessionID); await f.turn("msg_auto", { automatic: true });
  await f.engine.continue(sessionID);
  assert.equal(f.dispatches.length, 1); assert.equal((await f.store.get(sessionID))?.status, "budget_limited");
});

test("completion requires evidence and observed work; completed goals never continue", async () => {
  const f = await fixture();
  await f.engine.create(sessionID, "Verify result"); await f.turn("msg_initial", { progress: false });
  await assert.rejects(f.engine.update(sessionID, { status: "complete", evidence: "" }), /evidence/);
  await assert.rejects(f.engine.update(sessionID, { status: "complete", evidence: "Probably fine" }), /Verify the outcome/);
  await f.turn("msg_verified");
  await f.engine.update(sessionID, { status: "complete", evidence: "test -f result passed" });
  await f.engine.continue(sessionID); assert.equal(f.dispatches.length, 0);
  assert.equal((await f.store.get(sessionID))?.status, "complete");
});

test("repeated blocker calls in one turn do not satisfy the three turn rule", async () => {
  const f = await fixture();
  await f.engine.create(sessionID, "Finish"); await f.turn("msg_one");
  for (let i = 0; i < 4; i++) await f.engine.update(sessionID, { status: "blocked", evidence: "Missing credential" });
  assert.equal((await f.store.get(sessionID))?.status, "active");
  await f.engine.continue(sessionID); await f.turn("msg_two", { automatic: true });
  await f.engine.update(sessionID, { status: "blocked", evidence: "Missing credential" });
  await f.engine.continue(sessionID); await f.turn("msg_three", { automatic: true });
  await f.engine.update(sessionID, { status: "blocked", evidence: "Missing credential" });
  assert.equal((await f.store.get(sessionID))?.status, "blocked");
  await f.engine.command(sessionID, "resume");
  assert.equal((await f.store.get(sessionID))?.blocker, undefined);
});

test("goals are session scoped and cannot replace an unfinished goal", async () => {
  const f = await fixture();
  await f.engine.create(sessionID, "One");
  await assert.rejects(f.engine.create(sessionID, "Two"), /already has a goal/);
  await f.engine.create("ses_other", "Other");
  await f.engine.command(sessionID, "clear");
  assert.equal(await f.store.get(sessionID), undefined);
  assert.equal((await f.store.get("ses_other"))?.objective, "Other");
});

test("status command does not dispatch goal work", async () => {
  const f = await fixture();
  await f.engine.create(sessionID, "Finish");
  await f.engine.command(sessionID, "status");
  const input = user("msg_status");
  const parts = [text({ opencodeGoals: { kind: "control", work: false } })];
  await f.engine.onUser(input, parts);
  await assert.rejects(f.engine.beforeTool(sessionID, "bash"), /acknowledgement only/);
  await assert.rejects(f.engine.beforeTool(sessionID, "update_goal"), /acknowledgement only/);
  await f.engine.beforeTool(sessionID, "get_goal");
  f.messages.push({ info: input, parts }, assistant(input.id, "msg_status_reply", 10, false));
  await f.engine.continue(sessionID); assert.equal(f.dispatches.length, 0);
});

test("state corruption is surfaced and preserved, and session path traversal is rejected", async () => {
  const f = await fixture();
  await f.engine.create(sessionID, "Finish");
  await writeFile(f.store.path(sessionID), "{broken");
  await assert.rejects(f.store.get(sessionID));
  assert.equal(await readFile(f.store.path(sessionID), "utf8"), "{broken");
  assert.throws(() => f.store.path("../../escape"), /Invalid/);
});

test("failed work tools still allow another attempt instead of triggering the no-tool guard", async () => {
  const f = await fixture();
  await f.engine.create(sessionID, "Fix the failing command"); await f.turn("msg_first");
  await f.engine.continue(sessionID); await f.turn("msg_retry", { automatic: true });
  const part = f.messages.at(-1)!.parts[0]!;
  if (part.type === "tool") part.state = { status: "error", input: {}, error: "command failed", time: { start: 1, end: 2 } };
  await f.engine.continue(sessionID);
  assert.equal(f.dispatches.length, 2);
});

test("goal command parsing keeps objective text literal and validates limits", () => {
  assert.deepEqual(parseCommand("--tokens 5000 --turns 3 Fix the test\nKeep the API"), {
    action: "start", objective: "Fix the test\nKeep the API", limits: { tokenBudget: 5000, maxContinuations: 3 },
  });
  assert.deepEqual(parseCommand("-- pause"), { action: "start", objective: "pause", limits: {} });
  assert.deepEqual(parseCommand("budget off"), { action: "budget", tokenBudget: undefined });
  assert.throws(() => parseCommand("--tokens 0 Fix"), /positive/);
  assert.throws(() => parseCommand("budget 0"), /positive/);
});
