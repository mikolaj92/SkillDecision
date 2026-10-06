import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { tensorFoldDecision } from "../src/tensorfold.ts";

const input = {
  task: "Extract obligations from a PDF", context: [],
  skills: [{ id: "pdf", description: "Process PDF documents" }],
  tools: [{ id: "read", description: "Read files" }],
};

function scored() {
  return {
    object: "decisions", model: "served-model", prompt_format_version: 1,
    answers: {
      skill_0: { type: "yes_no", probabilities: { yes: 0.9, no: 0.1 }, label_mass: 0.8 },
      tool_0: { type: "yes_no", probabilities: { yes: 0.1, no: 0.9 }, label_mass: 0.7 },
    },
    usage: { prompt_tokens: 45, completion_tokens: 0, total_tokens: 45 },
  };
}

async function withResponse(body: unknown, run: (baseUrl: string) => Promise<void>, status = 200, raw = false) {
  let calls = 0;
  const server = createServer((request, response) => {
    calls++;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/decisions");
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(raw ? String(body) : JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  try { await run(`http://127.0.0.1:${address.port}/v1`); }
  finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.equal(calls, 1, "exactly one POST, including on invalid output");
  }
}

test("TensorFold normalizes a fixture produced by its real build_response function", async () => {
  // TensorFold 609ca419abecebdc5a059498a613680bd3aa847f, server/decisions.py::build_response.
  // PreparedQuestion prompt IDs and logits are synthetic; this is not a live-weight test.
  const fixture = JSON.parse(await readFile(new URL("./fixtures/tensorfold-decisions.v1.json", import.meta.url), "utf8"));
  const original = structuredClone(input);
  await withResponse(fixture, async (baseUrl) => {
    const result = await tensorFoldDecision(input, {
      baseUrl: `${baseUrl}/`, model: "requested-model", signal: new AbortController().signal,
    });
    assert.deepEqual(result, { decision: { skills: ["pdf"], tools: [] }, model: "tensorfold-fixture",
      usage: { input: 7, output: 0, totalTokens: 7 } });
    assert.deepEqual(input, original);
  });
});

test("TensorFold HTTP errors have a named reason and never retry", async () => {
  for (const status of [400, 401, 429, 503]) await withResponse({ error: "PRIVATE_ERROR" }, async (baseUrl) => {
    await assert.rejects(tensorFoldDecision(input, {
      baseUrl, model: "requested-model", signal: new AbortController().signal,
    }), { message: "DECISION_HTTP_FAILED" });
  }, status);
});

test("TensorFold HTTP 421 sends exactly one POST, even with a replayable JSON body", async () => {
  let calls = 0;
  const server = createServer((request, response) => {
    calls++;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/decisions");
    response.writeHead(421, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "misdirected request" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    const result = await tensorFoldDecision(input, {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "requested-model", signal: new AbortController().signal,
    }).catch((error: unknown) => error);
    // Allow a secretly replayed request to reach the server before counting.
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls, 1, "HTTP 421 must never replay a POST");
    assert(result instanceof Error);
    assert.equal(result.message, "DECISION_HTTP_FAILED");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("TensorFold does not follow redirects to a second inference endpoint", async () => {
  let calls = 0;
  const server = createServer((_request, response) => {
    calls++;
    response.writeHead(307, { Location: "/v1/other" });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    await assert.rejects(tensorFoldDecision(input, {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "requested-model", signal: new AbortController().signal,
    }), { message: "DECISION_NETWORK_FAILED" });
    assert.equal(calls, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("TensorFold honors Pi headers including case-insensitive bearer overrides", async () => {
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer host-header");
    assert.equal(request.headers["x-trace"], "host-trace");
    assert.equal(request.headers["x-removed"], undefined);
    assert.equal(request.headers["content-type"], "application/json");
    response.end(JSON.stringify(scored()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    await tensorFoldDecision(input, {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "requested-model", apiKey: "host-key",
      headers: { authorization: "Bearer host-header", "X-Trace": "host-trace", "X-Removed": null },
      signal: new AbortController().signal,
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("TensorFold sends apiKey as exactly one bearer token, never a comma list", async () => {
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer one,two");
    response.end(JSON.stringify(scored()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    await tensorFoldDecision(input, {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "requested-model", apiKey: "one,two",
      signal: new AbortController().signal,
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("TensorFold decodes compressed responses when Pi headers request compression", async () => {
  for (const [encoding, compress] of [
    ["gzip", gzipSync], ["deflate", deflateSync], ["br", brotliCompressSync],
  ] as const) {
    let calls = 0;
    const server = createServer((request, response) => {
      calls++;
      assert.equal(request.headers["accept-encoding"], encoding);
      response.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": encoding });
      response.end(compress(JSON.stringify(scored())));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address === "object");
    try {
      const result = await tensorFoldDecision(input, {
        baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "requested-model",
        headers: { "Accept-Encoding": encoding }, signal: new AbortController().signal,
      });
      assert.deepEqual(result.decision, { skills: ["pdf"], tools: [] });
      assert.equal(calls, 1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

test("TensorFold bounds response bytes before parsing JSON", async () => {
  await withResponse(" ".repeat(1024 * 1024 + 1), async (baseUrl) => {
    await assert.rejects(tensorFoldDecision(input, {
      baseUrl, model: "requested-model", signal: new AbortController().signal,
    }), { message: "DECISION_RESPONSE_TOO_LARGE" });
  }, 200, true);
});

test("TensorFold bounds both encoded and decoded response bytes to 1 MiB", async () => {
  for (const body of [
    Buffer.concat([gzipSync(JSON.stringify(scored())), Buffer.alloc(1024 * 1024)]),
    gzipSync(" ".repeat(1024 * 1024 + 1)),
  ]) {
    let calls = 0;
    const server = createServer((_request, response) => {
      calls++;
      response.writeHead(200, { "Content-Encoding": "gzip" });
      response.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address === "object");
    try {
      await assert.rejects(tensorFoldDecision(input, {
        baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "requested-model",
        signal: new AbortController().signal,
      }), { message: "DECISION_RESPONSE_TOO_LARGE" });
      assert.equal(calls, 1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

test("TensorFold rejects unsafe or non-v1 base URLs before making any request", async () => {
  for (const baseUrl of ["not a URL", "file:///v1", "ftp://example.com/v1", "https://user:pass@example.com/v1",
    "https://example.com", "https://example.com/v1?key=secret", "https://example.com/v1#fragment"]) {
    await assert.rejects(tensorFoldDecision(input, {
      baseUrl, model: "requested-model", signal: new AbortController().signal,
    }), { message: "INVALID_DECISION_ENDPOINT" });
  }
});

test("TensorFold malformed JSON has a named error without leaking the body", async () => {
  await withResponse("PRIVATE_RESPONSE", async (baseUrl) => {
    await assert.rejects(tensorFoldDecision(input, {
      baseUrl, model: "requested-model", signal: new AbortController().signal,
    }), { message: "INVALID_TENSORFOLD_JSON" });
  }, 200, true);
});

test("TensorFold validates the complete yes/no wire result, not only its yes probability", async () => {
  for (const mutate of [
    (body: any) => { body.object = "chat.completion"; },
    (body: any) => { body.prompt_format_version = 2; },
    (body: any) => { body.model = ""; },
    (body: any) => { delete body.answers.tool_0; },
    (body: any) => { body.answers = []; },
    (body: any) => { body.answers.skill_0.type = "choice"; },
    (body: any) => { delete body.answers.skill_0.probabilities.no; },
    (body: any) => { body.answers.skill_0.probabilities.no = -0.1; },
    (body: any) => { body.answers.skill_0.probabilities.yes = "0.9"; },
    (body: any) => { body.answers.skill_0.probabilities.no = 0.9; },
    (body: any) => { body.answers.skill_0.probabilities.other = 0; },
    (body: any) => { body.answers.skill_0.label_mass = 2; },
    (body: any) => { delete body.answers.skill_0.label_mass; },
    (body: any) => { body.usage.prompt_tokens = -1; },
    (body: any) => { body.usage.prompt_tokens = 1.5; },
    (body: any) => { body.usage.total_tokens = 44; },
    (body: any) => { body.usage.completion_tokens = 1; },
    (body: any) => { body.usage = null; },
  ]) {
    const body = scored();
    mutate(body);
    await withResponse(body, async (baseUrl) => {
      await assert.rejects(tensorFoldDecision(input, {
        baseUrl, model: "requested-model", signal: new AbortController().signal,
      }), /INVALID_TENSORFOLD_RESULT/);
    });
  }
});

test("TensorFold rejects unknown answer IDs before producing a decision", async () => {
  const body = scored();
  Object.assign(body.answers, { invented: body.answers.skill_0 });
  await withResponse(body, async (baseUrl) => {
    await assert.rejects(tensorFoldDecision(input, {
      baseUrl, model: "requested-model", signal: new AbortController().signal,
    }), /INVALID_TENSORFOLD_RESULT/);
  });
});
