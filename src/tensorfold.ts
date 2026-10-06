import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createInflate, createGunzip } from "node:zlib";
import { buildQuestions, classifierDecision } from "./decision.ts";
import type { DecisionInput } from "./decision.ts";

export interface DecisionUsage {
  input: number;
  output: number;
  totalTokens: number;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_TENSORFOLD_RESULT");
  return value as Record<string, unknown>;
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export async function tensorFoldDecision(input: DecisionInput, options: {
  baseUrl: string;
  model: string;
  apiKey?: string;
  headers?: Record<string, string | null>;
  signal: AbortSignal;
}) {
  options.signal.throwIfAborted();
  let endpoint: URL;
  try {
    endpoint = new URL(options.baseUrl);
    endpoint.pathname = endpoint.pathname.replace(/\/+$/, "");
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || !endpoint.pathname.endsWith("/v1")) throw new Error();
    endpoint.pathname += "/decisions";
  } catch { throw new Error("INVALID_DECISION_ENDPOINT"); }
  const headers = new Headers();
  if (options.apiKey) headers.set("Authorization", `Bearer ${options.apiKey}`);
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  headers.set("Content-Type", "application/json");
  const { state, questions } = buildQuestions(input);
  const body = JSON.stringify({ model: options.model, input: state, prompt_format_version: 1,
    questions: Object.entries(questions).map(([id, question]) => ({
      id, type: "yes_no", question: question.instructions,
      yes: question.criteria.true, no: question.criteria.false,
    })) });
  let responseBody: Buffer;
  try {
    // Native requests neither follow redirects nor replay POST on HTTP 421.
    responseBody = await new Promise<Buffer>((resolve, reject) => {
      const request = (endpoint.protocol === "https:" ? httpsRequest : httpRequest)(endpoint, {
        method: "POST", headers: Object.fromEntries(headers), signal: options.signal, agent: false,
      }, async (response) => {
        try {
          const status = response.statusCode ?? 0;
          if (status >= 300 && status < 400) throw new Error("DECISION_NETWORK_FAILED");
          if (status < 200 || status >= 300) throw new Error("DECISION_HTTP_FAILED");
          const encoding = response.headers["content-encoding"];
          const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate() :
            encoding === "br" ? createBrotliDecompress() : new PassThrough();
          const decoded = await pipeline(response, async function* (source) {
            let bytes = 0;
            for await (const chunk of source) {
              bytes += chunk.byteLength;
              if (bytes > 1024 * 1024) throw new Error("DECISION_RESPONSE_TOO_LARGE");
              yield chunk;
            }
          }, decoder, async (source) => {
            const chunks: Buffer[] = [];
            let bytes = 0;
            for await (const chunk of source) {
              bytes += chunk.byteLength;
              if (bytes > 1024 * 1024) throw new Error("DECISION_RESPONSE_TOO_LARGE");
              chunks.push(chunk);
            }
            return Buffer.concat(chunks);
          }, { signal: options.signal });
          resolve(decoded);
        } catch (error) {
          response.destroy();
          reject(error);
        }
      });
      request.on("error", reject);
      request.end(body);
    });
  } catch (error) {
    options.signal.throwIfAborted();
    if (error instanceof Error && ["DECISION_HTTP_FAILED", "DECISION_RESPONSE_TOO_LARGE"].includes(error.message)) throw error;
    throw new Error("DECISION_NETWORK_FAILED");
  }
  options.signal.throwIfAborted();
  let raw: unknown;
  try { raw = JSON.parse(responseBody.toString("utf8")); }
  catch { throw new Error("INVALID_TENSORFOLD_JSON"); }
  const result = object(raw);
  if (result.object !== "decisions" || result.prompt_format_version !== 1 ||
    typeof result.model !== "string" || !result.model.trim()) throw new Error("INVALID_TENSORFOLD_RESULT");
  const answers = object(result.answers);
  const expected = Object.keys(questions);
  if (Object.keys(answers).length !== expected.length ||
    Object.keys(answers).some((id) => !expected.includes(id))) throw new Error("INVALID_TENSORFOLD_RESULT");
  const normalized: Record<string, unknown> = {};
  for (const id of expected) {
    const answer = object(answers[id]);
    const probabilities = object(answer.probabilities);
    if (answer.type !== "yes_no" || !probability(answer.label_mass) ||
      Object.keys(probabilities).length !== 2 || !probability(probabilities.yes) || !probability(probabilities.no) ||
      Math.abs(probabilities.yes + probabilities.no - 1) > 1e-6) throw new Error("INVALID_TENSORFOLD_RESULT");
    normalized[id] = { type: "bool", probability: probabilities.yes };
  }
  let usage: DecisionUsage | undefined;
  if (result.usage !== undefined) {
    const reported = object(result.usage);
    if (![reported.prompt_tokens, reported.completion_tokens, reported.total_tokens].every((value) =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
      reported.completion_tokens !== 0 || reported.total_tokens !== reported.prompt_tokens) {
      throw new Error("INVALID_TENSORFOLD_RESULT");
    }
    usage = { input: reported.prompt_tokens as number, output: 0, totalTokens: reported.total_tokens as number };
  }
  return { decision: classifierDecision(input, normalized), model: result.model, usage };
}
