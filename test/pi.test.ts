import assert from "node:assert/strict";
import fsPromises, { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:http";

type PiSession = Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"];
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import {
  createAgentSessionFromServices, createAgentSessionServices, createSyntheticSourceInfo, ModelRuntime,
  parseArgs, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import skillDecision from "../src/pi.ts";

async function runPi(options: {
  output?: string;
  cliArgs?: string[];
  unreadable?: boolean;
  oversized?: boolean;
  manualOnly?: boolean;
  turns?: number;
  catalogDescription?: string;
  decideModel?: string;
  mainVirtual?: boolean;
  virtualTarget?: "decision" | "bedrock";
  classifier?: { api: string; incomplete?: boolean };
  emptyCatalog?: boolean;
  hangDecision?: boolean;
  mainTool?: boolean;
  toolOnSecondMain?: boolean;
  outputForTask?: (task: string) => string;
  decisionError?: boolean;
  decisionThrow?: boolean;
  mainErrorOnce?: boolean;
  noUI?: boolean;
  run?: (session: PiSession, fixture: {
    decisionStarted: Promise<void>; toolStarted: Promise<void>; releaseTool: () => void;
  }) => Promise<void>;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "skill-decision-"));
  const skillPath = join(directory, "SKILL.md");
  const skillContent = options.oversized ? "x".repeat(65537) :
    "---\nname: pdf\ndescription: Process PDF documents\n---\n# PDF\nVerify every extracted obligation.\n";
  await writeFile(skillPath, skillContent);
  const requests: Record<string, any>[] = [];
  const notifications: string[] = [];
  const decisionOptions: unknown[] = [];
  const routes = { decision: 0, main: 0 };
  let classifierCalls = 0;
  let classifierState: unknown;
  let startDecision!: () => void;
  const decisionStarted = new Promise<void>((resolve) => { startDecision = resolve; });
  let startTool!: () => void;
  const toolStarted = new Promise<void>((resolve) => { startTool = resolve; });
  let releaseTool!: () => void;
  const toolGate = new Promise<void>((resolve) => { releaseTool = resolve; });
  let mainCalls = 0;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    const isDecision = payload.messages[0]?.content?.includes("resource selector");
    if (isDecision) startDecision();
    if (isDecision && options.hangDecision) return;
    if (isDecision && options.decisionError) {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "fixture-private-provider-error" } }));
      return;
    }
    const useTool = !isDecision && ((options.mainTool && mainCalls === 0) || (options.toolOnSecondMain && mainCalls === 1));
    if (!isDecision) mainCalls++;
    if (!isDecision && options.mainErrorOnce && mainCalls === 1) {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "fixture main temporary error" } }));
      return;
    }
    const text = isDecision ? (options.outputForTask?.(JSON.parse(payload.messages.at(-1).content).task) ??
      options.output ?? '{"skills":["pdf"],"tools":["read"]}') : "Main agent answer";
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", model: payload.model,
      choices: [{ index: 0, delta: useTool ? {
        role: "assistant", tool_calls: [{ index: 0, id: "read-fixture", type: "function",
          function: { name: "read", arguments: JSON.stringify({ path: skillPath }) } }],
      } : { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", model: payload.model,
      choices: [{ index: 0, delta: {}, finish_reason: useTool ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  let session: PiSession | undefined;
  try {
    const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"),
      modelsPath: null, modelsStorePath: join(directory, "models-store.json"), refreshOnCreate: false });
    runtime.registerProvider("fixture", {
      api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "fixture-not-a-secret",
      models: [{ id: "decision", name: "Decision", reasoning: false, input: ["text"],
        cost: { input: 2, output: 4, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 2000 },
        { id: "bedrock", name: "Bedrock", api: "bedrock-converse-stream", reasoning: false, input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 2000 }],
    });
    runtime.registerVirtualModel({ provider: "fixture", id: "virtual", name: "Virtual selector",
      route: (request) => {
        routes[request.reason === "direct" ? "decision" : "main"]++;
        return { model: runtime.getModel("fixture", options.virtualTarget ?? "decision")!, thinkingLevel: "off" };
      } });
    const originalStream = runtime.streamSimple.bind(runtime);
    runtime.streamSimple = (model, context, callOptions) => {
      if (context.systemPrompt?.includes("resource selector")) {
        decisionOptions.push(callOptions);
        // Never let a regression invoke the real AWS transport in this fixture.
        if (options.decisionThrow || model.api === "bedrock-converse-stream") throw new Error("PRIVATE_PROVIDER_SECRET");
      }
      return originalStream(model, context, callOptions);
    };
    if (options.classifier) runtime.registerProvider("classify-fixture", {
      apiKey: "fixture-not-a-secret", models: [{ type: "classifier", id: "selector", name: "Selector",
        api: options.classifier.api, baseUrl: "http://127.0.0.1", input: ["text"], contextWindow: 32000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      classifiers: { [options.classifier.api]: { classify: async (model, context, callOptions) => {
        classifierCalls++;
        classifierState = context;
        assert.equal(callOptions?.maxRetries, 0);
        return { api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
          answers: options.classifier?.incomplete ? {} : Object.fromEntries(Object.keys(context.questions).map((id) =>
            [id, { type: "bool", probability: id === "skill_0" || id === "tool_0" ? 0.9 : 0.1 }])) };
      } } },
    });
    const settings = SettingsManager.inMemory({ compaction: { enabled: false },
      retry: { enabled: options.mainErrorOnce ?? false, maxRetries: 1, baseDelayMs: 1, provider: { maxRetries: 0 } } });
    const parsed = parseArgs([...(options.cliArgs ?? []),
      ...(options.decideModel ? ["--decide-model", options.decideModel] : [])]);
    assert.deepEqual(parsed.diagnostics, []);
    const services = await createAgentSessionServices({ cwd: directory, agentDir: directory,
      modelRuntime: runtime, settingsManager: settings, extensionFlagValues: parsed.unknownFlags,
      resourceLoaderOptions: {
        noContextFiles: true, noPromptTemplates: true, noThemes: true,
        extensionFactories: [skillDecision, (pi) => {
          pi.on("message_end", (event) => { if (event.message.role === "user") event.message.timestamp = 123; });
          pi.on("tool_call", async () => {
            if (options.mainTool) { startTool(); await toolGate; }
          });
        }],
        skillsOverride: () => ({ skills: [{ name: "pdf", description: options.catalogDescription ?? "Process PDF documents",
          filePath: options.unreadable ? join(directory, "missing.md") : skillPath,
          baseDir: directory, disableModelInvocation: options.manualOnly ?? false,
          sourceInfo: createSyntheticSourceInfo(skillPath, { source: "sdk" }) }].filter(() => !options.emptyCatalog), diagnostics: [] }),
      },
    });
    assert.deepEqual(services.diagnostics, []);
    const created = await createAgentSessionFromServices({ services,
      model: runtime.getModel("fixture", options.mainVirtual ? "virtual" : "decision")!, thinkingLevel: "off",
      sessionManager: SessionManager.inMemory(directory), tools: options.emptyCatalog ? [] : ["read", "bash"] });
    session = created.session;
    await session.bindExtensions(options.noUI ? {} : { uiContext: {
      notify: (message: string) => { notifications.push(message); }, setStatus: () => {},
    } as unknown as ExtensionUIContext });
    const toolsBefore = session.getActiveToolNames();
    if (options.run) await options.run(session, { decisionStarted, toolStarted, releaseTool });
    else {
      for (let turn = 0; turn < (options.turns ?? 1); turn++) {
        await session.prompt(turn ? "Do the same for another PDF" : "Extract obligations from the PDF");
      }
      assert.equal(session.getLastAssistantText(), "Main agent answer");
    }
    if (options.noUI) {
      const output = mock.method(console, "log", (message: string) => { notifications.push(message); });
      try { await session.prompt("/decide stats"); }
      finally { output.mock.restore(); }
    } else await session.prompt("/decide stats");
    assert.deepEqual(session.getActiveToolNames(), toolsBefore);
    assert.equal(await readFile(skillPath, "utf8"), skillContent);
    return { requests, entries: session.sessionManager.getBranch(), classifierCalls, classifierState, decisionOptions, notifications, routes };
  } finally {
    session?.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

test("actual session.abort cancels a hung selector before the main provider is called", async () => {
  const { requests, entries } = await runPi({ hangDecision: true, run: async (session, { decisionStarted }) => {
    const pending = session.prompt("Extract obligations from the PDF");
    await decisionStarted;
    let completed = false;
    const stopped = session.abort().then(async () => { await pending; completed = true; });
    await Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, 200))]);
    assert.equal(completed, true, "session.abort must stop the selector, not wait for its 15-second timeout");
    await stopped;
  } });
  assert.equal(requests.length, 1, "aborting selection must never call the main provider");
  const audits = entries.filter((entry) => entry.type === "custom" && entry.customType === "skill-decision");
  assert.equal(audits.length, 1);
  assert.equal((audits[0] as any).data.reason, "ABORTED");
});

test("Pi makes one isolated decision, loads selected skill and preserves its tools", async () => {
  const { requests, entries } = await runPi();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].tools, undefined);
  assert.match(JSON.stringify(requests[1].messages), /Verify every extracted obligation/);
  assert(!JSON.stringify(requests[1].messages).includes("name: pdf\\ndescription:"));
  assert(entries.some((entry) => entry.type === "custom" && entry.customType === "skill-decision"));
});

test("/decide stats reports separate branch usage with the physical decision model", async () => {
  const { entries, notifications } = await runPi({ turns: 2, decideModel: "fixture/decision" });
  const stats = JSON.parse(notifications.at(-1)!);
  assert.equal(stats.decisions, 2);
  assert.equal(stats.selected, 2);
  assert.equal(stats.fallback, 0);
  assert.equal(stats.unknownUsage, 0);
  const { cost, ...tokens } = stats.usage;
  assert.deepEqual(tokens, { input: 40, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 60 });
  assert(Math.abs(cost.input - 0.00008) < 1e-12);
  assert(Math.abs(cost.output - 0.00008) < 1e-12);
  assert(Math.abs(cost.total - 0.00016) < 1e-12);
  assert.equal(cost.cacheRead, 0);
  assert.equal(cost.cacheWrite, 0);
  assert.equal(stats.footerIncludesDecisionCost, false);
  const audits = entries.filter((entry) => entry.type === "custom" && entry.customType === "skill-decision");
  for (const entry of audits) {
    assert.equal((entry as any).data.provider, "fixture");
    assert.equal((entry as any).data.model, "decision");
  }
  assert(!entries.some((entry) => entry.type === "usage"));
});

test("/decide stats counts missing usage instead of treating failed requests as free", async () => {
  for (const options of [{ decisionError: true }, {
    decideModel: "classify-fixture/selector", classifier: { api: "fixture-classify" },
  }]) {
    const { notifications } = await runPi(options);
    const stats = JSON.parse(notifications.at(-1)!);
    assert.equal(stats.decisions, 1);
    assert.equal(stats.unknownUsage, 1);
    assert.equal(stats.usage.totalTokens, 0);
  }
});

test("the decision deadline covers stalled file loading without late audit writes", async () => {
  const { entries, requests } = await runPi({ run: async (session) => {
    const openFile = fsPromises.open;
    let loading!: () => void;
    const started = new Promise<void>((resolve) => { loading = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const openMock = mock.method(fsPromises, "open", async (...args: Parameters<typeof openFile>) => {
      const handle = await openFile(...args);
      if (String(args[0]).endsWith("SKILL.md")) {
        const stat = handle.stat.bind(handle);
        handle.stat = (async () => { loading(); await gate; return stat(); }) as typeof handle.stat;
      }
      return handle;
    });
    syncBuiltinESMExports();
    const setTimer = globalThis.setTimeout;
    const timerMock = mock.method(globalThis, "setTimeout", (callback: (...args: any[]) => void, delay?: number, ...args: any[]) =>
      setTimer(callback, delay === 15000 ? 100 : delay, ...args));
    try {
      let completed = false;
      const pending = session.prompt("Extract obligations from the PDF").then(() => { completed = true; });
      await started;
      await Promise.race([pending, new Promise((resolve) => setTimer(resolve, 300))]);
      assert.equal(completed, true, "file loading must not outlive the decision deadline");
      const before = session.sessionManager.getBranch().length;
      release();
      await new Promise((resolve) => setTimer(resolve, 30));
      assert.equal(session.sessionManager.getBranch().length, before, "late file work cannot append or inject anything");
      await pending;
    } finally {
      release();
      timerMock.mock.restore();
      openMock.mock.restore();
      syncBuiltinESMExports();
    }
  } });
  assert.equal(requests.length, 2);
  assert(!JSON.stringify(requests[1].messages).includes("Verify every extracted obligation"));
  const audits = entries.filter((entry) => entry.type === "custom" && entry.customType === "skill-decision");
  assert.equal(audits.length, 1);
  assert.equal((audits[0] as any).data.reason, "DECISION_TIMEOUT");
});

test("skill loading reads the full file rather than accepting a short single read", async () => {
  let fullReads = 0;
  let closes = 0;
  const { requests } = await runPi({ run: async (session) => {
    const openFile = fsPromises.open;
    const openMock = mock.method(fsPromises, "open", async (...args: Parameters<typeof openFile>) => {
      const handle = await openFile(...args);
      if (String(args[0]).endsWith("SKILL.md")) {
        const read = handle.read.bind(handle);
        handle.read = ((buffer: Buffer, offset: number, length: number, position: number) =>
          read(buffer, offset, Math.min(length, 16), position)) as typeof handle.read;
        const readAll = handle.readFile.bind(handle);
        handle.readFile = (async (...args: any[]) => { fullReads++; return readAll(...args); }) as typeof handle.readFile;
        const close = handle.close.bind(handle);
        handle.close = async () => { closes++; await close(); };
      }
      return handle;
    });
    syncBuiltinESMExports();
    try { await session.prompt("Extract obligations from the PDF"); }
    finally { openMock.mock.restore(); syncBuiltinESMExports(); }
  } });
  assert.match(JSON.stringify(requests[1].messages), /Verify every extracted obligation/);
  assert.equal(fullReads, 1);
  assert.equal(closes, 1);
});

test("skill byte and regular-file limits apply before and after the full read", async () => {
  for (const kind of ["not-file", "too-large-stat", "grew", "at-limit"] as const) {
    let reads = 0;
    let closes = 0;
    const { entries, requests } = await runPi({ run: async (session) => {
      const openFile = fsPromises.open;
      const openMock = mock.method(fsPromises, "open", async (...args: Parameters<typeof openFile>) => {
        const handle = await openFile(...args);
        if (String(args[0]).endsWith("SKILL.md")) {
          const stat = handle.stat.bind(handle);
          handle.stat = (async () => {
            const value = await stat();
            if (kind === "not-file") value.isFile = () => false;
            value.size = kind === "too-large-stat" ? 65537 : kind === "at-limit" ? 65536 : value.size;
            return value;
          }) as typeof handle.stat;
          handle.readFile = (async () => { reads++; return Buffer.alloc(kind === "grew" ? 65537 : 65536, "x"); }) as typeof handle.readFile;
          const close = handle.close.bind(handle);
          handle.close = async () => { closes++; await close(); };
        }
        return handle;
      });
      syncBuiltinESMExports();
      try { await session.prompt("Extract obligations from the PDF"); }
      finally { openMock.mock.restore(); syncBuiltinESMExports(); }
    } });
    assert.equal(closes, 1);
    assert.equal(reads, kind === "not-file" || kind === "too-large-stat" ? 0 : 1);
    const audit = entries.find((entry) => entry.type === "custom" && entry.customType === "skill-decision");
    assert.equal((audit as any).data.status, kind === "at-limit" ? "selected" : "fallback");
    if (kind !== "at-limit") assert(!JSON.stringify(requests[1].messages).includes("Resources selected for the current task"));
  }
});

test("session.abort during stalled file loading finishes once and closes the late handle", async () => {
  let closes = 0;
  const { entries, requests } = await runPi({ run: async (session) => {
    const openFile = fsPromises.open;
    let loading!: () => void;
    const started = new Promise<void>((resolve) => { loading = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const openMock = mock.method(fsPromises, "open", async (...args: Parameters<typeof openFile>) => {
      const handle = await openFile(...args);
      if (String(args[0]).endsWith("SKILL.md")) {
        const stat = handle.stat.bind(handle);
        handle.stat = (async () => { loading(); await gate; return stat(); }) as typeof handle.stat;
        const close = handle.close.bind(handle);
        handle.close = async () => { closes++; await close(); };
      }
      return handle;
    });
    syncBuiltinESMExports();
    try {
      const pending = session.prompt("Extract obligations from the PDF");
      await started;
      await session.abort();
      await pending;
      const before = session.sessionManager.getBranch().length;
      release();
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(session.sessionManager.getBranch().length, before);
    } finally { release(); openMock.mock.restore(); syncBuiltinESMExports(); }
  } });
  assert.equal(requests.length, 1);
  assert.equal(closes, 1);
  const audits = entries.filter((entry) => entry.type === "custom" && entry.customType === "skill-decision");
  assert.equal(audits.length, 1);
  assert.equal((audits[0] as any).data.reason, "ABORTED");
});

test("unexpected provider exceptions use a named fallback without copying secret error text", async () => {
  const { entries, requests } = await runPi({ decisionThrow: true });
  assert.equal(requests.length, 1);
  const audit = entries.find((entry) => entry.type === "custom" && entry.customType === "skill-decision");
  assert.equal((audit as any).data.reason, "DECISION_FAILED");
  assert(!JSON.stringify(entries).includes("PRIVATE_PROVIDER_SECRET"));
});

test("/decide stats emits JSON when Pi runs without a UI", async () => {
  const { notifications } = await runPi({ noUI: true });
  assert.equal(notifications.length, 1);
  assert.equal(JSON.parse(notifications[0]).decisions, 1);
});

test("decision transport is SSE with zero retries even when the provider fails", async () => {
  const { requests, entries, decisionOptions } = await runPi({ decisionError: true });
  assert.equal(requests.length, 2, "one failed decision request plus one main request");
  assert.equal(decisionOptions.length, 1);
  assert.equal((decisionOptions[0] as any).transport, "sse");
  assert.equal((decisionOptions[0] as any).maxRetries, 0);
  const audit = entries.find((entry) => entry.type === "custom" && entry.customType === "skill-decision");
  assert.equal((audit as any).data.reason, "DECISION_MODEL_FAILED");
  assert(!JSON.stringify(entries).includes("fixture-private-provider-error"));
});

test("Bedrock decisions fall back before invoking a transport that ignores zero retries", async () => {
  const { requests, entries, decisionOptions } = await runPi({ decideModel: "fixture/bedrock" });
  assert.equal(decisionOptions.length, 0, "unsupported transport must not be invoked");
  assert.equal(requests.length, 1, "the main model must still run");
  const audits = entries.filter((entry) => entry.type === "custom" && entry.customType === "skill-decision");
  assert.equal(audits.length, 1);
  assert.equal((audits[0] as any).data.reason, "DECISION_TRANSPORT_UNSUPPORTED");
  assert(!JSON.stringify(requests[0].messages).includes("Resources selected for the current task"));
});

test("virtual decision models fall back before routing while the main virtual model still routes", async () => {
  for (const options of [
    { decideModel: "fixture/virtual", virtualTarget: "decision" },
    { decideModel: "fixture/virtual", virtualTarget: "bedrock" },
    { mainVirtual: true },
  ] as const) {
    const { requests, entries, decisionOptions, routes } = await runPi(options);
    assert.equal(routes.decision, 0, "isolated decisions must not invoke the router");
    assert.equal(routes.main, options.mainVirtual ? 1 : 0);
    assert.equal(decisionOptions.length, 0);
    assert.equal(requests.length, 1, "only the main model may call its provider");
    const audits = entries.filter((entry) => entry.type === "custom" && entry.customType === "skill-decision");
    assert.equal(audits.length, 1);
    assert.equal((audits[0] as any).data.reason, "VIRTUAL_DECISION_MODEL_UNSUPPORTED");
    assert(!JSON.stringify(requests[0].messages).includes("Resources selected for the current task"));
  }
});

test("tool follow-ups reuse one persisted decision and leave raw user messages unchanged", async () => {
  const { requests, entries } = await runPi({ mainTool: true, run: async (session, { toolStarted, releaseTool }) => {
    const pending = session.prompt("Extract obligations from the PDF");
    await toolStarted;
    releaseTool();
    await pending;
  } });
  const selections = requests.filter((request) => request.messages[0].content.includes("resource selector"));
  const main = requests.filter((request) => !request.messages[0].content.includes("resource selector"));
  assert.equal(selections.length, 1, "tool continuation must not select again");
  assert.equal(main.length, 2);
  for (const request of main) {
    assert.equal(request.messages.filter((message: any) => JSON.stringify(message.content).includes("Resources selected for the current task")).length, 1);
    assert.match(request.messages[0].content, /available_skills/);
    assert.deepEqual(request.tools.map((tool: any) => tool.function.name), ["read", "bash"]);
  }
  const users = entries.filter((entry) => entry.type === "message" && entry.message.role === "user");
  const audits = entries.filter((entry) => entry.type === "custom" && entry.customType === "skill-decision");
  assert.equal(users.length, 1);
  assert.equal(audits.length, 1);
  assert.equal((audits[0] as any).data.targetId, users[0].id);
  assert.match((audits[0] as any).data.enrichment, /Verify every extracted obligation/);
  assert.deepEqual((users[0] as any).message.content, [{ type: "text", text: "Extract obligations from the PDF" }]);
  assert(!entries.some((entry) => entry.type === "custom_message" && entry.customType === "skill-decision-context"));
});

test("compaction without a projected user restores the current enrichment without selecting again", async () => {
  for (const retain of ["assistant", "none", "tool"] as const) {
    const { requests, entries } = await runPi({ mainTool: true,
      outputForTask: (task) => task.startsWith("Extract") ? '{"skills":["pdf"],"tools":["read"]}' : '{"skills":[],"tools":[]}',
      run: async (session, { toolStarted, releaseTool }) => {
        const pending = session.prompt("Extract obligations from the PDF");
        await toolStarted;
        const assistant = session.sessionManager.getBranch().findLast((entry) =>
          entry.type === "message" && entry.message.role === "assistant")!;
        if (retain !== "tool") {
          session.sessionManager.appendCompaction("Continue extracting PDF obligations", retain === "none" ? null : assistant.id, 0);
        } else {
          const unsubscribe = session.subscribe((event) => {
            if (event.type !== "turn_end" || !event.toolResults.length) return;
            const tool = session.sessionManager.getBranch().findLast((entry) =>
              entry.type === "message" && entry.message.role === "toolResult")!;
            session.sessionManager.appendCompaction("Continue extracting PDF obligations", tool.id, 0);
          });
          releaseTool();
          await pending;
          unsubscribe();
        }
        releaseTool();
        await pending;
        await session.prompt("Now write a plain greeting");
      },
    });
    const selections = requests.filter((request) => request.messages[0].content.includes("resource selector"));
    assert.deepEqual(selections.map((request) => JSON.parse(request.messages.at(-1).content).task),
      ["Extract obligations from the PDF", "Now write a plain greeting"]);
    const main = requests.filter((request) => !request.messages[0].content.includes("resource selector"));
    assert.equal(main.length, 3, `${retain}-first compaction must preserve the tool continuation`);
    const enrichments = main.slice(0, 2).map((request) => request.messages.filter((message: any) =>
      JSON.stringify(message.content).includes("Resources selected for the current task")));
    assert.equal(enrichments[1].length, 1, `${retain}-first compaction must restore current enrichment`);
    assert.deepEqual(enrichments[1], enrichments[0], "continuation must reuse exactly the same enrichment");
    const nextEnrichments = main[2].messages.filter((message: any) =>
      JSON.stringify(message.content).includes("Resources selected for the current task"));
    assert.equal(nextEnrichments.length, 1);
    assert(!JSON.stringify(nextEnrichments).includes("Verify every extracted obligation"), "new task must not inherit old enrichment");
    assert.equal(entries.filter((entry) => entry.type === "custom" && entry.customType === "skill-decision").length, 2);
  }
});

test("context omissions never revive a previous task's enrichment", async () => {
  for (const omit of ["assistant", "user", "compacted-user"] as const) {
    const { requests } = await runPi({
      outputForTask: (task) => task.startsWith("Extract") ? '{"skills":["pdf"],"tools":["read"]}' : '{"skills":[],"tools":[]}',
      run: async (session) => {
        await session.prompt("Extract obligations from the PDF");
        if (omit === "assistant") {
          const assistant = session.sessionManager.getBranch().findLast((entry) =>
            entry.type === "message" && entry.message.role === "assistant")!;
          session.sessionManager.appendContextEdit(assistant.id, null);
        }
        await session.prompt("Now write a plain greeting");
        if (omit !== "assistant") {
          const user = session.sessionManager.getBranch().findLast((entry) =>
            entry.type === "message" && entry.message.role === "user")!;
          session.sessionManager.appendContextEdit(user.id, null);
          if (omit === "compacted-user") session.sessionManager.appendCompaction("Continue the greeting", null, 0);
          await session.sendCustomMessage({ customType: "continue-test", content: "Continue", display: false }, { triggerTurn: true });
        }
      },
    });
    const main = requests.filter((request) => !request.messages[0].content.includes("resource selector"));
    for (const request of main.slice(1)) {
      const enrichments = request.messages.filter((message: any) =>
        JSON.stringify(message.content).includes("Resources selected for the current task"));
      assert(!JSON.stringify(enrichments).includes("Verify every extracted obligation"), "an omitted boundary must not revive the PDF task");
    }
    assert.equal(requests.filter((request) => request.messages[0].content.includes("resource selector")).length, 2);
    if (omit !== "assistant") {
      assert(!JSON.stringify(main.at(-1)!.messages).includes("Resources selected for the current task"), "an explicitly omitted user must not restore its audit");
    }
  }
});

test("queued steering and followUp each get one decision by source id, not timestamp", async () => {
  const { requests, entries } = await runPi({ mainTool: true,
    outputForTask: (task) => task.startsWith("Extract") ? '{"skills":["pdf"],"tools":["read"]}' : '{"skills":[],"tools":[]}',
    run: async (session, { toolStarted, releaseTool }) => {
      session.setSteeringMode("all");
      const pending = session.prompt("Extract obligations from the PDF");
      await toolStarted;
      assert.equal(await session.steer("Queued steering"), "queued");
      assert.equal(await session.steer("Queued steering"), "queued");
      assert.equal(await session.followUp("Queued follow-up"), "queued");
      releaseTool();
      await pending;
    },
  });
  const selections = requests.filter((request) => request.messages[0].content.includes("resource selector"));
  assert.deepEqual(selections.map((request) => JSON.parse(request.messages.at(-1).content).task),
    ["Extract obligations from the PDF", "Queued steering", "Queued steering", "Queued follow-up"]);
  const users = entries.filter((entry) => entry.type === "message" && entry.message.role === "user");
  assert.equal(new Set(users.map((entry) => (entry as any).message.timestamp)).size, 1);
  const audits = entries.filter((entry) => entry.type === "custom" && entry.customType === "skill-decision");
  assert.deepEqual(audits.map((entry) => (entry as any).data.targetId), users.map((entry) => entry.id));
  for (const request of requests.filter((request) => !request.messages[0].content.includes("resource selector")).slice(1)) {
    const enrichments = request.messages.filter((message: any) => JSON.stringify(message.content).includes("Resources selected for the current task"));
    assert(enrichments.length > 0);
    assert(!JSON.stringify(enrichments).includes("Verify every extracted obligation"), "old enrichment must not leak into queued turns");
  }
});

test("a queued user batch keeps every current decision through compaction and tool continuation", async () => {
  const { requests, entries } = await runPi({ mainTool: true, toolOnSecondMain: true,
    outputForTask: (task) => task.startsWith("Extract") ? '{"skills":["pdf"],"tools":["read"]}' : '{"skills":[],"tools":[]}',
    run: async (session, { toolStarted, releaseTool }) => {
      let toolTurns = 0;
      const unsubscribe = session.subscribe((event) => {
        if (event.type !== "turn_end" || !event.toolResults.length || ++toolTurns !== 2) return;
        const assistant = session.sessionManager.getBranch().findLast((entry) =>
          entry.type === "message" && entry.message.role === "assistant")!;
        session.sessionManager.appendCompaction("Continue the queued steering batch", assistant.id, 0);
      });
      session.setSteeringMode("all");
      const pending = session.prompt("Extract obligations from the PDF");
      await toolStarted;
      await session.steer("First steering");
      await session.steer("Second steering");
      releaseTool();
      await pending;
      unsubscribe();
    },
  });
  const main = requests.filter((request) => !request.messages[0].content.includes("resource selector"));
  assert.equal(main.length, 3);
  for (const request of main.slice(1)) {
    const enrichments = request.messages.filter((message: any) => JSON.stringify(message.content).includes("Resources selected for the current task"));
    assert.equal(enrichments.length, 2);
    assert(!JSON.stringify(enrichments).includes("Verify every extracted obligation"));
  }
  const audits = entries.filter((entry) => entry.type === "custom" && entry.customType === "skill-decision");
  const users = entries.filter((entry) => entry.type === "message" && entry.message.role === "user");
  assert.deepEqual(audits.map((entry) => (entry as any).data.targetId), users.map((entry) => entry.id));
  assert.equal(requests.length, 6);
});

test("main retry reuses the branch audit without selecting or injecting twice", async () => {
  const { entries, requests } = await runPi({ mainErrorOnce: true });
  assert.equal(requests.length, 3);
  for (const request of requests.slice(1)) {
    assert.equal(request.messages.filter((message: any) => JSON.stringify(message.content).includes("Resources selected for the current task")).length, 1);
  }
  assert.equal(entries.filter((entry) => entry.type === "custom" && entry.customType === "skill-decision").length, 1);
});

test("resume reloads decision enrichment from the active branch without another selector call", async () => {
  const { requests, entries } = await runPi({ run: async (session) => {
    await session.prompt("Extract obligations from the PDF");
    await session.resourceLoader.reload();
    await session.bindExtensions({});
    await session.sendCustomMessage({ customType: "resume-test", content: "Continue the same task", display: false }, { triggerTurn: true });
  } });
  assert.equal(requests.length, 3);
  assert.match(JSON.stringify(requests[2].messages), /Verify every extracted obligation/);
  assert.equal(entries.filter((entry) => entry.type === "custom" && entry.customType === "skill-decision").length, 1);
});

test("/decide stats aggregates only the active branch, not abandoned decisions", async () => {
  await runPi({ run: async (session) => {
    await session.prompt("Extract obligations from the PDF");
    const firstLeaf = session.sessionManager.getLeafId()!;
    await session.prompt("Another PDF");
    session.sessionManager.branch(firstLeaf);
    await session.prompt("/decide stats");
    // The final fixture stats call observes the same active leaf.
  } }).then(({ notifications }) => {
    const stats = JSON.parse(notifications.at(-1)!);
    assert.equal(stats.decisions, 1);
    assert.equal(stats.usage.totalTokens, 30);
  });
});

test("malformed or invented selections fall back without retry or enrichment", async () => {
  for (const output of ["not JSON", '{"skills":["made-up"],"tools":[]}', '{"skills":[],"tools":["deploy"]}']) {
    const { requests, entries } = await runPi({ output });
    assert.equal(requests.length, 2);
    assert(!JSON.stringify(requests[1].messages).includes("Verify every extracted obligation"));
    assert(!entries.some((entry) => entry.type === "custom_message" && entry.customType === "skill-decision-context"));
    const audit = entries.find((entry) => entry.type === "custom" && entry.customType === "skill-decision");
    assert(audit && audit.type === "custom");
    assert.equal((audit.data as { status: string }).status, "fallback");
  }
});

test("unreadable and oversized skills fall back before injecting partial context", async () => {
  for (const options of [{ unreadable: true }, { oversized: true }]) {
    const { requests, entries } = await runPi(options);
    assert.equal(requests.length, 2);
    assert(!entries.some((entry) => entry.type === "custom_message" && entry.customType === "skill-decision-context"));
  }
});

test("CLI --decide-disabled prevents selection even after /decide on", async () => {
  const { requests, entries, decisionOptions, notifications } = await runPi({
    cliArgs: ["--decide-disabled"], run: async (session) => {
      await session.prompt("/decide status");
      await session.prompt("Answer without resource selection");
      await session.prompt("/decide on");
      await session.prompt("/decide status");
      await session.prompt("Extract obligations from the PDF");
      assert.equal(session.getLastAssistantText(), "Main agent answer");
    },
  });
  assert.equal(decisionOptions.length, 0, "CLI disabling must prevent selection even after /decide on");
  assert.equal(requests.length, 2, "only the two main requests may reach the provider");
  assert(requests.every((request) => !JSON.stringify(request.messages).includes("Resources selected for the current task")));
  assert(!entries.some((entry) => entry.type === "custom" && entry.customType === "skill-decision"));
  assert.deepEqual(notifications.slice(0, 3), Array(3).fill("decide: off; model=auto"));
});

test("/decide on, off and status control only the isolated selector", async () => {
  const { requests, entries, notifications } = await runPi({ run: async (session) => {
    await session.prompt("/decide status");
    await session.prompt("/decide off");
    await session.prompt("/decide status");
    await session.prompt("Answer without resource selection");
    await session.prompt("/decide on");
    await session.prompt("/decide status");
    await session.prompt("Extract obligations from the PDF");
  } });
  assert.deepEqual(notifications.slice(0, 5), ["on", "off", "off", "on", "on"].map((state) => `decide: ${state}; model=auto`));
  assert.equal(requests.length, 3, "two main requests and one isolated decision");
  assert(!JSON.stringify(requests[0].messages).includes("Resources selected for the current task"));
  assert.match(JSON.stringify(requests[2].messages), /Verify every extracted obligation/);
  assert.equal(entries.filter((entry) => entry.type === "custom" && entry.customType === "skill-decision").length, 1);
});

test("manual-only skills never reach the automatic selector", async () => {
  const { requests } = await runPi({ manualOnly: true, output: '{"skills":[],"tools":["read"]}' });
  const input = JSON.parse(requests[0].messages.at(-1).content);
  assert.deepEqual(input.skills, []);
});

test("each user turn makes one decision and includes recent conversation", async () => {
  const { requests } = await runPi({ turns: 2 });
  assert.equal(requests.length, 4);
  const input = JSON.parse(requests[2].messages.at(-1).content);
  assert(input.context.some((item: { text: string }) => item.text.includes("Extract obligations")));
  assert(input.context.some((item: { text: string }) => item.text === "Main agent answer"));
});

test("selector context distinguishes retained-none compaction and branch summaries for the same task", async () => {
  for (const kind of ["compaction", "branch"] as const) {
    const contexts = [];
    for (const resource of ["PDF", "XLSX"]) {
      const { requests, entries } = await runPi({ run: async (session) => {
        session.sessionManager.appendMessage({ role: "user", content: "Old task outside the projected context", timestamp: 1 });
        const summary = `${resource}: the referenced document contains obligations. ${"detail ".repeat(400)}`;
        if (kind === "compaction") session.sessionManager.appendCompaction(summary, null, 0);
        else session.sessionManager.branchWithSummary(null, summary);
        await session.prompt("Extract obligations from it");
      } });
      const selections = requests.filter((request) => request.messages[0].content.includes("resource selector"));
      assert.equal(selections.length, 1, "summaries must not create extra tasks");
      const input = JSON.parse(selections[0].messages.at(-1).content);
      assert.equal(input.task, "Extract obligations from it");
      assert.equal(input.context.length, 2);
      assert.equal(input.context[0].role, "assistant");
      assert.match(input.context[0].text, new RegExp(`^\\[${kind === "compaction" ? "Compaction" : "Branch"} summary\\]\\n${resource}:`));
      assert(input.context.every((item: { text: string }) => item.text.length <= 2000));
      assert(!JSON.stringify(input.context).includes("Old task outside the projected context"));
      assert.equal(entries.filter((entry) => entry.type === "custom" && entry.customType === "skill-decision").length, 1);
      contexts.push(input.context);
    }
    assert.notDeepEqual(contexts[0], contexts[1], "PDF and XLSX histories must reach the selector as different context");
  }
});

test("an explicit classifier makes one classify call without a chat decision", async () => {
  const { requests, entries, classifierCalls, classifierState } = await runPi({
    decideModel: "classify-fixture/selector", classifier: { api: "fixture-classify" },
  });
  assert.equal(classifierCalls, 1);
  assert.equal(requests.length, 1);
  assert.match(JSON.stringify(requests[0].messages), /Verify every extracted obligation/);
  assert.match(JSON.stringify(classifierState), /Extract obligations/);
  assert(!entries.some((entry) => entry.type === "custom_message" && entry.customType === "skill-decision-context"));
});

test("an incomplete classifier result falls back without a second model call", async () => {
  const { requests, entries, classifierCalls } = await runPi({
    decideModel: "classify-fixture/selector", classifier: { api: "fixture-classify", incomplete: true },
  });
  assert.equal(classifierCalls, 1);
  assert.equal(requests.length, 1);
  assert(!entries.some((entry) => entry.type === "custom_message" && entry.customType === "skill-decision-context"));
});

test("llama.cpp classifier fanout is rejected before making a decision call", async () => {
  const { requests, entries, classifierCalls } = await runPi({
    decideModel: "classify-fixture/selector", classifier: { api: "llama-cpp-classify" },
  });
  assert.equal(classifierCalls, 0);
  assert.equal(requests.length, 1);
  const audit = entries.find((entry) => entry.type === "custom" && entry.customType === "skill-decision");
  assert(audit && audit.type === "custom");
  assert.equal((audit.data as { reason: string }).reason, "CLASSIFIER_FANOUT_UNSUPPORTED");
});

test("unknown or malformed model configuration falls back without guessing a provider", async () => {
  for (const decideModel of ["missing/selector", "not-an-address", "provider/"]) {
    const { requests } = await runPi({ decideModel });
    assert.equal(requests.length, 1);
  }
});

test("an empty catalog skips the selector", async () => {
  const { requests, entries } = await runPi({ emptyCatalog: true });
  assert.equal(requests.length, 1);
  assert(!entries.some((entry) => entry.type === "custom" && entry.customType === "skill-decision"));
});

test("an over-budget catalog falls back without calling the decision model", async () => {
  const { requests, entries } = await runPi({ catalogDescription: "x".repeat(131073) });
  assert.equal(requests.length, 1);
  const audit = entries.find((entry) => entry.type === "custom" && entry.customType === "skill-decision");
  assert(audit && audit.type === "custom");
  assert.equal((audit.data as { reason: string }).reason, "CATALOG_TOO_LARGE");
});
