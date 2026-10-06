import { open } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import { decide, validateDecision } from "./decision.ts";
import { tensorFoldDecision } from "./tensorfold.ts";
import type { DecisionUsage } from "./tensorfold.ts";
import type { DecisionInput } from "./decision.ts";

const MAX_SKILL_BYTES = 64 * 1024;
const MAX_CONTEXT_CHARS = 128 * 1024;
const TIMEOUT_MS = 30_000;
const FALLBACK_REASONS = new Set([
  "CATALOG_TOO_LARGE", "DECISION_HTTP_FAILED", "DECISION_NETWORK_FAILED",
  "INVALID_TENSORFOLD_JSON", "INVALID_TENSORFOLD_RESULT", "INVALID_DECISION_ENDPOINT", "DECISION_RESPONSE_TOO_LARGE",
  "DECISION_NOT_CONFIGURED", "INVALID_MODEL_ADDRESS",
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

export default function skillDecision(pi: ExtensionAPI) {
  let enabled = true;
  let catalog: Skill[] = [];
  pi.registerFlag("decide-url", {
    type: "string", default: "",
    description: "Exact HTTP(S) TensorFold base URL ending in /v1; default TENSORFOLD_BASE_URL.",
  });
  pi.registerFlag("decide-model", {
    type: "string", default: "",
    description: "Exact served TensorFold model ID; default TENSORFOLD_MODEL. Calls POST /v1/decisions only.",
  });
  pi.registerFlag("decide-disabled", { type: "boolean", default: false, description: "Disable resource selection." });
  pi.registerCommand("decide", {
    description: "Resource selector: /decide on | off | status | stats (separate cost; excluded from Pi footer)",
    handler: async (args, ctx) => {
      if (args.trim() === "stats") {
        const stats = {
          decisions: 0, selected: 0, fallback: 0, unknownUsage: 0,
          unknownCost: 0, usage: { input: 0, output: 0, totalTokens: 0 },
          footerIncludesDecisionCost: false,
        };
        for (const entry of ctx.sessionManager.getBranch()) {
          if (entry.type !== "custom" || entry.customType !== "skill-decision") continue;
          const audit = entry.data as { status: string; usage?: DecisionUsage };
          stats.decisions++;
          if (audit.status === "selected") stats.selected++;
          else stats.fallback++;
          stats.unknownCost++;
          if (!audit.usage) { stats.unknownUsage++; continue; }
          for (const key of ["input", "output", "totalTokens"] as const) stats.usage[key] += audit.usage[key];
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
      const configuredUrl = String(pi.getFlag("decide-url") || process.env.TENSORFOLD_BASE_URL || "");
      const configuredModel = String(pi.getFlag("decide-model") || process.env.TENSORFOLD_MODEL || "");
      if (ctx.hasUI) ctx.ui.notify(`decide: ${enabled && !disabled ? "on" : "off"}; ` +
        `url=${configuredUrl || "not configured"}; model=${configuredModel || "not configured"}`, "info");
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
      let usage: DecisionUsage | undefined;
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
            // Direct TensorFold config only: Pi's registry, login state, and command
            // headers are never consulted. Values are re-read for every decision.
            const baseUrl = String(pi.getFlag("decide-url") || process.env.TENSORFOLD_BASE_URL || "");
            const model = String(pi.getFlag("decide-model") || process.env.TENSORFOLD_MODEL || "");
            if (!baseUrl.trim() || !model.trim()) throw new Error("DECISION_NOT_CONFIGURED");
            if (model === "auto") throw new Error("INVALID_MODEL_ADDRESS");
            signal.throwIfAborted();
            const result = await tensorFoldDecision(request, {
              baseUrl, model, apiKey: process.env.TENSORFOLD_API_KEY || undefined, signal,
            });
            usage = result.usage;
            modelName = result.model;
            return result.decision;
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
          targetId: target.id, status: "selected", backend: "tensorfold", provider: "tensorfold", model: modelName, decision: selection,
          enrichment, durationMs: Date.now() - started, usage,
        });
        if (ctx.hasUI) ctx.ui.setStatus("skill-decision", `decide: ${selection.skills.length} skills / ${selection.tools.length} tools`);
        return inject(enrichment);
      } catch (error) {
        const reason = signal.aborted ? (ctx.signal?.aborted ? "ABORTED" : "DECISION_TIMEOUT") :
          error instanceof Error && FALLBACK_REASONS.has(error.message) ? error.message : "DECISION_FAILED";
        pi.appendEntry("skill-decision", {
          targetId: target.id, status: "fallback", reason, backend: "tensorfold", provider: "tensorfold", model: modelName, durationMs: Date.now() - started, usage,
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
