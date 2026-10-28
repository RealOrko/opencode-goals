import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { GoalStore, type Goal } from "../src/store.js";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string, timeout = 20_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    try { const value = await read(); if (ready(value)) return value; last = value; } catch (error) { last = error; }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

test("real OpenCode 1.19.4 plugin lifecycle with a local deterministic provider", { timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "opencode-goals-live-"));
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  const requests: any[] = [];
  let slowRequests = 0;
  function stream(res: ServerResponse, text?: string, call?: { name: string; arguments: Record<string, unknown> }, largeUsage = false) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const chunk = (delta: unknown, finish_reason: string | null = null, usage?: unknown) => res.write(`data: ${JSON.stringify({
      id: `chatcmpl-fixture-${requests.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "goal-test",
      choices: [{ index: 0, delta, finish_reason }], ...usage ? { usage } : {},
    })}\n\n`);
    chunk({ role: "assistant" });
    if (call) chunk({ tool_calls: [{ index: 0, id: `call_fixture_${requests.length}`, type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] });
    else chunk({ content: text ?? "acknowledged" });
    chunk({}, call ? "tool_calls" : "stop", { prompt_tokens: largeUsage ? 2000 : 10, completion_tokens: 5, total_tokens: largeUsage ? 2005 : 15 });
    res.end("data: [DONE]\n\n");
  }
  const provider = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      if (!body.tools?.some((tool: any) => tool.function?.name === "update_goal")) { stream(res, "Fixture title"); return; }
      const lastUserIndex = body.messages.findLastIndex((m: any) => m.role === "user");
      const lastUser = JSON.stringify(body.messages[lastUserIndex]?.content ?? "");
      const sinceUser = body.messages.slice(lastUserIndex + 1);
      const lastTool = sinceUser.filter((m: any) => m.role === "tool").at(-1);
      if (lastUser.includes("control command has already been executed")) { stream(res, "Goal control acknowledged."); return; }
      if (lastUser.includes("INTERRUPT_TEST")) {
        slowRequests++;
        setTimeout(() => { if (!res.destroyed) stream(res, "Interrupted fixture finished."); }, 5000).unref();
        return;
      }
      if (lastUser.includes("STALL_TEST") || lastUser.includes("PAUSE_TEST")) { stream(res, "Checkpoint; more work remains."); return; }
      if (lastUser.includes("BUDGET_TEST")) { stream(res, "Budget test checkpoint.", undefined, true); return; }
      const automatic = lastUser.includes("Continue working toward the active session goal");
      if (!lastTool) {
        stream(res, undefined, { name: "bash", arguments: {
          command: automatic ? "test -f goal-proof.txt && printf 'verified\\n' >> goal-proof.txt" : "printf 'checkpoint\\n' > goal-proof.txt",
          description: automatic ? "Verify the goal artifact" : "Create the goal artifact",
        } });
      } else if (automatic && !String(lastTool.content).includes("Status: complete")) {
        stream(res, undefined, { name: "update_goal", arguments: {
          status: "complete", evidence: "Created goal-proof.txt and verified it with test -f; the verifier appended verified.",
        } });
      } else stream(res, automatic ? "Verified complete." : "First checkpoint complete; verification remains.");
    } catch (error) {
      res.writeHead(500); res.end(String(error));
    }
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address(); assert.ok(address && typeof address !== "string");
  const config = {
    "$schema": "https://opencode.ai/config.json",
    plugin: [[process.env.OPENCODE_GOALS_TEST_PLUGIN_SPEC ?? pathToFileURL(repository).href, { continuationDelayMs: 700 }]],
    model: "goal-fixture/goal-test", small_model: "goal-fixture/goal-test",
    provider: { "goal-fixture": { npm: "@ai-sdk/openai-compatible", name: "Local fixture",
      options: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-fixture" },
      models: { "goal-test": { name: "goal-test", limit: { context: 32768, output: 4096 } } } } },
    permission: { "*": "allow" }, snapshot: false, share: "disabled", autoupdate: false,
    compaction: { auto: false, prune: false },
  };
  await writeFile(join(project, "opencode.json"), JSON.stringify(config));
  const stateRoot = join(root, "goals");
  const store = new GoalStore(project, stateRoot);
  let output = "";
  let child: ChildProcess | undefined;
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([new Promise<void>(resolve => child!.once("exit", () => resolve())), delay(3000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  };
  const start = async () => {
    child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], {
      cwd: project, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env,
        XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
        XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
        OPENCODE_CONFIG_DIR: join(root, "config/opencode"), OPENCODE_GOALS_STATE_DIR: stateRoot,
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_MODELS_FETCH: "true",
        HERDR_PANE_ID: "", HERDR_SOCKET_PATH: "", OPENCODE_SERVER_PASSWORD: "",
      },
    });
    let currentOutput = "";
    for (const pipe of [child.stdout!, child.stderr!]) pipe.on("data", chunk => { currentOutput += chunk.toString(); output += chunk.toString(); });
    return eventually(async () => {
      if (child!.exitCode !== null) throw new Error(`OpenCode exited: ${currentOutput.slice(-4000)}`);
      return /opencode server listening on (http:\/\/[^\s]+)/.exec(currentOutput)?.[1];
    }, Boolean, "server start", 30_000) as Promise<string>;
  };
  try {
    let url = await start();
    const api = async (path: string, body?: unknown): Promise<any> => {
      const response = await fetch(`${url}${path}`, { method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", "x-opencode-directory": project },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
      const text = await response.text();
      if (!response.ok) throw new Error(`${path} ${response.status}: ${text}`);
      return text ? JSON.parse(text) : undefined;
    };
    const command = (id: string, args: string) => api(`/session/${id}/command`, { command: "goal", arguments: args, agent: "build", model: "goal-fixture/goal-test" });
    const created = await api("/session", {});
    const id: string = created.id;
    await t.test("loads a real plugin and registers /goal and its tools", async () => {
      assert.ok((await api("/command")).some((c: any) => c.name === "goal"));
      const tools = await api("/experimental/tool/ids");
      for (const name of ["create_goal", "get_goal", "update_goal"]) assert.ok(tools.includes(name), `missing ${name}`);
    });
    await t.test("continues after a real idle event and completes with observed tool evidence", async () => {
      await command(id, "LIVE_TEST Create goal-proof.txt, then verify it in the next turn");
      const completed = await eventually(() => store.get(id), g => g?.status === "complete", "completed goal");
      assert.equal(completed!.continuations, 1);
      assert.ok(completed!.tokensUsed > 0);
      assert.match(await readFile(join(project, "goal-proof.txt"), "utf8"), /checkpoint.*verified/s);
      const messages = await api(`/session/${id}/message`);
      assert.equal(messages.filter((m: any) => m.info.role === "user").length, 2);
    });
    await t.test("durable goal survives restarting the actual OpenCode server", async () => {
      await stop(); url = await start();
      const status = await command(id, "status");
      assert.equal((await store.get(id))!.status, "complete");
      assert.ok(status.info);
    });
    await t.test("a no-tool automatic turn pauses instead of looping", async () => {
      const session = await api("/session", {});
      await command(session.id, "STALL_TEST Verify an unavailable artifact");
      const goal = await eventually(() => store.get(session.id), g => g?.status === "paused", "no progress pause");
      assert.equal(goal!.continuations, 1);
      assert.match(goal!.reason!, /no tool calls/);
    });
    await t.test("token budget exhaustion is a separate stopped state", async () => {
      const session = await api("/session", {});
      await command(session.id, "--tokens 100 BUDGET_TEST Verify the artifact");
      const goal = await eventually(() => store.get(session.id), g => g?.status === "budget_limited", "budget stop");
      assert.ok(goal!.tokensUsed >= 100); assert.equal(goal!.continuations, 0);
    });
    await t.test("/goal pause deterministically stops a pending continuation", async () => {
      const session = await api("/session", {});
      await command(session.id, "PAUSE_TEST Work toward the artifact");
      await command(session.id, "pause");
      await delay(1000);
      const goal = await store.get(session.id);
      assert.equal(goal!.status, "paused"); assert.equal(goal!.continuations, 0);
      await command(session.id, "clear"); assert.equal(await store.get(session.id), undefined);
    });
    await t.test("aborting a real running turn pauses the goal", async () => {
      const session = await api("/session", {});
      const before = slowRequests;
      const work = command(session.id, "INTERRUPT_TEST Work until stopped");
      await eventually(async () => slowRequests, n => n > before, "running model request");
      await api(`/session/${session.id}/abort`, {});
      await work;
      const goal = await eventually(() => store.get(session.id), g => g?.status === "paused", "interruption pause");
      assert.equal(goal!.continuations, 0);
    });
  } catch (error) {
    process.stderr.write(`\nOpenCode log tail:\n${output.slice(-12_000)}\nLocal provider requests: ${requests.length}\n`);
    throw error;
  } finally {
    await stop();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
