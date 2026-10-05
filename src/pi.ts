import { open, readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { buildQuestions, classifierDecision, decide, validateDecision } from "./decision.ts";
import type { DecisionInput } from "./decision.ts";

const MAX_SKILL_BYTES = 64 * 1024;
const MAX_CONTEXT_CHARS = 128 * 1024;
const TIMEOUT_MS = 15_000;
const FALLBACK_REASONS = new Set([
  "CATALOG_TOO_LARGE", "CLASSIFIER_FANOUT_UNSUPPORTED", "CLASSIFIER_FAILED", "INVALID_CLASSIFIER_RESULT",
  "INVALID_MODEL_ADDRESS", "MODEL_UNAVAILABLE", "DECISION_TRANSPORT_UNSUPPORTED", "VIRTUAL_DECISION_MODEL_UNSUPPORTED",
  "DECISION_MODEL_FAILED", "INVALID_DECISION_JSON",
  "INVALID_DECISION", "SKILL_TOO_LARGE", "ENRICHMENT_TOO_LARGE",
]);

function recentContext(ctx: ExtensionContext): DecisionInput["context"] {
  return ctx.sessionManager.buildSessionProjection().messages
    .filter((message) => message.role === "user" || message.role === "assistant" ||
      message.role === "compactionSummary" || message.role === "branchSummary")
    .slice(-4)
    .map((message) => {
      if (message.role === "compactionSummary" || message.role === "branchSummary") {
        const label = message.role === "compactionSummary" ? "Compaction" : "Branch";
        return { role: "assistant" as const, text: `[${label} summary]\n${message.summary}`.slice(0, 2000) };
      }
      return {
        role: message.role as "user" | "assistant",
        text: typeof message.content === "string" ? message.content.slice(-2000) :
          message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n").slice(-2000),
      };
    });
}

async function loadSkill(skill: Skill, signal: AbortSignal) {
  signal.throwIfAborted();
  const file = await open(skill.filePath, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) throw new Error("SKILL_TOO_LARGE");
    signal.throwIfAborted();
    const buffer = await file.readFile({ signal });
    if (buffer.byteLength > MAX_SKILL_BYTES) throw new Error("SKILL_TOO_LARGE");
    signal.throwIfAborted();
    const instructions = buffer.toString("utf8")
      .replace(/^\uFEFF/, "").replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
    return { id: skill.name, path: skill.filePath, baseDir: skill.baseDir, instructions };
  } finally {
    await file.close();
  }
}

function modelAddress(value: string): [string, string] {
  const slash = value.indexOf("/");
  if (slash < 1 || slash === value.length - 1) throw new Error("INVALID_MODEL_ADDRESS");
  return [value.slice(0, slash), value.slice(slash + 1)];
}

export default function skillDecision(pi: ExtensionAPI) {
  let enabled = true;
  let catalog: Skill[] = [];
  pi.registerFlag("decide-model", {
    type: "string", default: "auto",
    description: "Decision model as provider/id; auto uses the current chat model in an isolated call.",
  });
  pi.registerFlag("decide-disabled", { type: "boolean", default: false, description: "Disable resource selection." });
  pi.registerCommand("decide", {
    description: "Resource selector: /decide on | off | status | stats (separate cost; excluded from Pi footer)",
    handler: async (args, ctx) => {
      if (args.trim() === "stats") {
        const stats = {
          decisions: 0, selected: 0, fallback: 0, unknownUsage: 0,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          footerIncludesDecisionCost: false,
        };
        for (const entry of ctx.sessionManager.getBranch()) {
          if (entry.type !== "custom" || entry.customType !== "skill-decision") continue;
          const audit = entry.data as { status: string; usage?: Usage };
          stats.decisions++;
          if (audit.status === "selected") stats.selected++;
          else stats.fallback++;
          if (!audit.usage) { stats.unknownUsage++; continue; }
          for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
            stats.usage[key] += audit.usage[key];
          }
          for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
            stats.usage.cost[key] += audit.usage.cost[key];
          }
        }
        if (ctx.hasUI) ctx.ui.notify(JSON.stringify(stats), "info");
        else console.log(JSON.stringify(stats));
        return;
      }
      if (args.trim() === "on") enabled = true;
      else if (args.trim() === "off") enabled = false;
      else if (args.trim() && args.trim() !== "status") {
        if (ctx.hasUI) ctx.ui.notify("Usage: /decide on | off | status | stats", "warning");
        return;
      }
      const disabled = pi.getFlag("decide-disabled") === true;
      if (ctx.hasUI) ctx.ui.notify(`decide: ${enabled && !disabled ? "on" : "off"}; model=${pi.getFlag("decide-model")}`, "info");
    },
  });

  pi.on("before_agent_start", (event) => {
    catalog = event.systemPromptOptions.skills.filter((skill) => !skill.disableModelInvocation).map((skill) => ({ ...skill }));
  });

  pi.on("context", async (event, ctx) => {
    if (!enabled || pi.getFlag("decide-disabled") === true || !ctx.signal) return;
    const projection = ctx.sessionManager.buildSessionProjection();
    const projected = new Map(projection.entries.map((entry) => [entry.sourceEntry.id, entry]));
    const branch = ctx.sessionManager.getBranch();
    const edits = new Map(branch.filter((entry) => entry.type === "context_edit")
      .map((entry) => [entry.targetId, entry]));
    // Raw source identities and batch boundaries survive compaction and context edits.
    const history = branch.filter((entry) => entry.type === "message" &&
      (entry.message.role === "user" || entry.message.role === "assistant"));
    const lastUser = history.findLastIndex((entry) => entry.type === "message" && entry.message.role === "user");
    if (lastUser < 0) return;
    // The current user batch begins after the assistant preceding its newest user.
    // Later assistant/tool messages do not end that batch; a new user does.
    const precedingAssistant = history.slice(0, lastUser)
      .findLastIndex((entry) => entry.type === "message" && entry.message.role === "assistant");
    const targets = history.slice(precedingAssistant + 1)
      .filter((entry) => entry.type === "message" && entry.message.role === "user" &&
        (projected.has(entry.id) ? projected.get(entry.id)!.messages.some((message) => message.role === "user") :
          edits.get(entry.id)?.replacement !== null));
    const select = async (target: typeof targets[number]) => {
      const inject = (enrichment: string) => ({
        role: "custom" as const, customType: "skill-decision-context", content: enrichment,
        display: false, details: { targetId: target.id }, timestamp: Date.now(),
      });
      const previous = branch.find((entry) => entry.type === "custom" &&
        entry.customType === "skill-decision" && (entry.data as { targetId?: string })?.targetId === target.id);
      if (previous?.type === "custom") {
        const enrichment = (previous.data as { enrichment?: string }).enrichment;
        return enrichment ? inject(enrichment) : undefined;
      }
      // Summarized raw tasks are identities only, never inputs to a new decision.
      const user = projected.get(target.id)?.messages.find((message) => message.role === "user");
      if (!user || user.role !== "user") return;
      const task = typeof user.content === "string" ? user.content :
        user.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("DECISION_TIMEOUT")), TIMEOUT_MS);
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
      let usage: Usage | undefined;
      const requestedModel = String(pi.getFlag("decide-model") ?? "auto");
      let provider: string | undefined;
      let modelName: string | undefined;
      try {
        const skills = catalog;
        const active = new Set(pi.getActiveTools());
        const tools = pi.getAllTools().filter((tool) => tool.exposure !== "hidden" &&
          (active.has(tool.name) || tool.exposure === "deferred" || tool.exposure === "codemode"));
        if (!task.trim() || (!skills.length && !tools.length)) return;
        const input: DecisionInput = {
          task,
          context: recentContext(ctx),
          skills: skills.map((skill) => ({ id: skill.name, description: skill.description })),
          tools: tools.map((tool) => ({ id: tool.name, description: tool.description })),
        };
        if (JSON.stringify(input).length > MAX_CONTEXT_CHARS) throw new Error("CATALOG_TOO_LARGE");
        let enrichment = "";
        // decide races the whole operation, including prompt and selected-skill loading.
        // Only the settled path below can change Pi state.
        const selection = await decide(input, async (request) => {
          const choose = async () => {
            const address = requestedModel === "auto" ? undefined : modelAddress(requestedModel);
            const classifier = address ? ctx.modelRegistry.findOfType("classifier", ...address) : undefined;
            if (classifier) {
              // llama.cpp classifies one question per backend call. Never silently fan out.
              if (classifier.api === "llama-cpp-classify") throw new Error("CLASSIFIER_FANOUT_UNSUPPORTED");
              const result = await ctx.modelRegistry.classify(classifier, buildQuestions(request), {
                signal, timeoutMs: TIMEOUT_MS, maxRetries: 0,
              });
              usage = result.usage;
              provider = result.provider;
              modelName = result.model;
              if (result.stopReason !== "stop") throw new Error("CLASSIFIER_FAILED");
              return classifierDecision(request, result.answers);
            }
            const model = address ? ctx.modelRegistry.find(...address) : ctx.model;
            if (!model) throw new Error("MODEL_UNAVAILABLE");
            // Reject before routing: the public registry cannot resolve a virtual model safely here.
            if (model.api === "pi-virtual") throw new Error("VIRTUAL_DECISION_MODEL_UNSUPPORTED");
            // Bedrock's AWS client ignores maxRetries and can retry the isolated decision.
            if (model.api === "bedrock-converse-stream") throw new Error("DECISION_TRANSPORT_UNSUPPORTED");
            const instructions = await readFile(new URL("../prompts/decide.md", import.meta.url), { encoding: "utf8", signal });
            const result = await ctx.modelRegistry.streamSimple(model, {
              systemPrompt: instructions,
              messages: [{ role: "user", content: JSON.stringify(request), timestamp: Date.now() }],
            }, { signal, timeoutMs: TIMEOUT_MS, transport: "sse", maxRetries: 0, maxTokens: 1024 }).result();
            // Chat APIs initialize usage to zero even when no usage was reported.
            usage = result.usage.totalTokens > 0 ? result.usage : undefined;
            provider = result.provider;
            modelName = result.model;
            if (result.stopReason !== "stop" || result.content.some((block) => block.type === "toolCall")) {
              throw new Error("DECISION_MODEL_FAILED");
            }
            const text = result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
            try { return JSON.parse(text); } catch { throw new Error("INVALID_DECISION_JSON"); }
          };
          const decision = validateDecision(await choose(), request);
          signal.throwIfAborted();
          const loaded = [];
          for (const id of decision.skills) {
            loaded.push(await loadSkill(skills.find((skill) => skill.name === id)!, signal));
          }
          enrichment = "Resources selected for the current task. Use these skill instructions when applicable; " +
            "resolve their relative paths from baseDir. Tool selections are recommendations, not permissions. " +
            "Other Pi resources remain available.\n" + JSON.stringify({
              decision, skills: loaded,
              tools: tools.filter((tool) => decision.tools.includes(tool.name))
                .map((tool) => ({ id: tool.name, description: tool.description })),
            });
          if (enrichment.length > MAX_CONTEXT_CHARS) throw new Error("ENRICHMENT_TOO_LARGE");
          signal.throwIfAborted();
          return decision;
        }, signal);
        signal.throwIfAborted();
        pi.appendEntry("skill-decision", {
          targetId: target.id, status: "selected", provider, model: modelName, decision: selection,
          enrichment, durationMs: Date.now() - started, usage,
        });
        if (ctx.hasUI) ctx.ui.setStatus("skill-decision", `decide: ${selection.skills.length} skills / ${selection.tools.length} tools`);
        return inject(enrichment);
      } catch (error) {
        const reason = signal.aborted ? (ctx.signal?.aborted ? "ABORTED" : "DECISION_TIMEOUT") :
          error instanceof Error && FALLBACK_REASONS.has(error.message) ? error.message : "DECISION_FAILED";
        pi.appendEntry("skill-decision", {
          targetId: target.id, status: "fallback", reason, provider, model: modelName, durationMs: Date.now() - started, usage,
        });
        if (ctx.hasUI) ctx.ui.setStatus("skill-decision", `decide: fallback (${reason})`);
      } finally {
        clearTimeout(timer);
      }
    };
    const enrichments = [];
    for (const target of targets) {
      const message = await select(target);
      if (message) enrichments.push(message);
      if (ctx.signal.aborted) break;
    }
    return { messages: [...event.messages, ...enrichments] };
  });
}
