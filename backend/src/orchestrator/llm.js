import { config } from "../config.js";
import { getPipeline } from "../storage/pipelines.js";
import {
  assertPipelineActive,
  getRunAbortSignal,
  isPipelineCancelledError,
  PipelineCancelledError,
} from "../services/pipeline-run-control.js";

export class LlmCallError extends Error {
  constructor(message, { agent = null, model = null, hint = null } = {}) {
    super(message);
    this.name = "LlmCallError";
    this.agent = agent;
    this.model = model;
    this.hint = hint;
  }
}

function timeoutMs() {
  return Number(process.env.OLLAMA_TIMEOUT_MS) || 600_000;
}

function planningTimeoutMs() {
  return Number(process.env.OLLAMA_PLANNING_TIMEOUT_MS) || 600_000;
}

function hintForMessage(message) {
  if (/401|unauthorized/i.test(message)) {
    return "Ollama cloud auth failed. Set OLLAMA_API_KEY in backend/.env (https://ollama.com/settings/keys) or run: ollama signin";
  }
  if (/subscription|upgrade for access/i.test(message)) {
    return "This cloud model needs an Ollama subscription (https://ollama.com/upgrade) or use a free cloud model (e.g. gpt-oss:20b-cloud).";
  }
  if (/timeout|aborted/i.test(message)) {
    return "LLM timed out on CPU. Increase OLLAMA_PLANNING_TIMEOUT_MS or set GOOGLE_API_KEY + LLM_PROVIDER=gemini.";
  }
  if (/invalid JSON|truncated|malformed JSON/i.test(message)) {
    return "Model returned truncated JSON — retrying with smaller output or higher token limit.";
  }
  if (/fetch failed|ECONNREFUSED/i.test(message)) {
    return "Cannot reach Ollama. Run: ollama serve";
  }
  return "Check backend logs. For speed: GOOGLE_API_KEY + LLM_PROVIDER=gemini";
}

function ollamaRequestHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (config.ollamaApiKey) {
    headers.Authorization = `Bearer ${config.ollamaApiKey}`;
  }
  return headers;
}

function parseJsonFromLlm(content) {
  const text = String(content || "").trim();
  if (!text) throw new Error("empty response");

  try {
    return JSON.parse(text);
  } catch {
    /* fall through */
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* fall through */
    }
  }

  const startObj = text.indexOf("{");
  const startArr = text.indexOf("[");
  const start =
    startObj >= 0 && (startArr < 0 || startObj < startArr) ? startObj : startArr;
  if (start < 0) throw new Error("no JSON object found");

  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }

  throw new Error("truncated or malformed JSON");
}

function isThinkingOllamaModel(model) {
  const name = String(model || "").toLowerCase();
  return name.includes("gpt-oss") || name.includes("thinking");
}

function ollamaOptions(meta = {}) {
  const opts = {
    num_ctx: meta.num_ctx ?? (Number(process.env.OLLAMA_NUM_CTX) || 4096),
    num_predict: meta.num_predict ?? (Number(process.env.OLLAMA_NUM_PREDICT) || 2048),
    temperature: 0.2,
  };
  const threads = Number(process.env.OLLAMA_NUM_THREAD);
  if (Number.isFinite(threads) && threads > 0) opts.num_thread = threads;
  return opts;
}

let ollamaChains = new Map();

function withOllamaQueue(model, fn) {
  const key = model || "default";
  const prev = ollamaChains.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  ollamaChains.set(key, run.catch(() => {}));
  return run;
}

function warmupTimeoutMs() {
  const ms = Number(process.env.OLLAMA_WARMUP_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : 10_000;
}

function warmupEnabled() {
  return (process.env.OLLAMA_WARMUP ?? "true").toLowerCase() !== "false";
}

let warmupPromise = null;
let cachedOllamaModels = null;

export function ensureOllamaReady() {
  return warmupPromise ?? Promise.resolve();
}

function resolveProvider() {
  return resolveProviderMode(config.llmProvider);
}

function resolveCodingProvider() {
  return resolveProviderMode(config.codingLlmProvider);
}

function resolveProviderMode(mode) {
  if (mode === "gemini") return config.googleApiKey ? "gemini" : "ollama";
  if (mode === "ollama") return "ollama";
  return config.googleApiKey ? "gemini" : "ollama";
}

async function listOllamaModels() {
  if (cachedOllamaModels) return cachedOllamaModels;
  try {
    const response = await fetch(`${config.ollamaBaseUrl}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return [];
    const data = await response.json();
    cachedOllamaModels = (data.models || []).map((m) => m.name);
    return cachedOllamaModels;
  } catch {
    return [];
  }
}

function hasModel(models, name) {
  return models.some((m) => m === name || m.startsWith(`${name}:`));
}

function isOllamaCloudModel(model) {
  const name = String(model || "");
  return name.includes(":cloud") || name.endsWith("-cloud");
}

export async function resolvePlanningModel() {
  const configured = config.planningModel;
  const models = await listOllamaModels();

  if (configured && (isOllamaCloudModel(configured) || hasModel(models, configured))) {
    return configured;
  }

  const candidates = [
    configured,
    "qwen2.5:3b",
    "llama3.2:3b",
    "llama3",
    config.reasoningModel,
  ];
  for (const name of candidates) {
    if (name && hasModel(models, name)) return name;
  }
  return configured || config.reasoningModel;
}

async function ollamaChat(system, user, model, meta = {}) {
  return withOllamaQueue(model, () => ollamaChatInner(system, user, model, meta));
}

function resolveRequestSignal(meta) {
  const timeout = meta.timeout ?? timeoutMs();
  const signals = [AbortSignal.timeout(timeout)];
  if (meta.pipeline_id) {
    assertPipelineActive(meta.pipeline_id);
    const runSignal = getRunAbortSignal(meta.pipeline_id);
    if (runSignal) signals.push(runSignal);
  }
  return AbortSignal.any(signals);
}

function throwIfPipelineCancelled(err, meta) {
  if (isPipelineCancelledError(err)) throw err;
  if (
    meta.pipeline_id &&
    (!getPipeline(meta.pipeline_id) || err?.name === "AbortError")
  ) {
    throw new PipelineCancelledError(meta.pipeline_id);
  }
}

async function ollamaChatInner(system, user, model, meta = {}) {
  const maxJsonRetries = meta.coding ? 3 : 2;
  let attemptUser = user;
  let numPredict =
    meta.num_predict ?? (Number(process.env.OLLAMA_NUM_PREDICT) || 2048);

  for (let jsonAttempt = 1; jsonAttempt <= maxJsonRetries; jsonAttempt++) {
    try {
      return await ollamaChatOnce(system, attemptUser, model, {
        ...meta,
        num_predict: numPredict,
      });
    } catch (err) {
      throwIfPipelineCancelled(err, meta);
      const message = err?.message || String(err);
      const retryable = /invalid JSON|truncated|malformed JSON|empty response/i.test(message);
      if (!retryable || jsonAttempt >= maxJsonRetries) {
        if (err instanceof LlmCallError) throw err;
        throw new LlmCallError(message, {
          agent: meta.agent,
          model,
          hint: hintForMessage(message),
        });
      }

      numPredict = Math.min(Math.max(numPredict * 2, 8192), 16384);
      attemptUser = `${user}

[JSON RETRY ${jsonAttempt}/${maxJsonRetries - 1}] Previous response was truncated or invalid JSON.
Return COMPLETE valid JSON only. If generating code, use one files[] entry with compact code.`;
      console.warn(
        `[LLM] ${meta.agent || model} JSON retry ${jsonAttempt} (num_predict→${numPredict})`,
      );
    }
  }

  throw new LlmCallError(`Ollama JSON failed after ${maxJsonRetries} attempts`, {
    agent: meta.agent,
    model,
  });
}

async function ollamaChatOnce(system, user, model, meta = {}) {
  const started = Date.now();
  if (meta.agent) {
    console.log(`[LLM] ${meta.agent} → ${model} (prompt ~${user.length} chars)`);
  }

  const body = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    stream: false,
    keep_alive: process.env.OLLAMA_KEEP_ALIVE || "30m",
    options: ollamaOptions(meta),
  };
  // gpt-oss/thinking cloud models often ignore format:json and return prose instead
  if (!isThinkingOllamaModel(model)) {
    body.format = "json";
  }

  const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
    method: "POST",
    headers: ollamaRequestHeaders(),
    body: JSON.stringify(body),
    signal: resolveRequestSignal(meta),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Ollama HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }

  const data = await response.json();
  const content = data?.message?.content;
  if (!content) {
    throw new Error("Ollama returned an empty response");
  }

  if (meta.agent) {
    const loadSec = ((data.load_duration || 0) / 1e9).toFixed(1);
    const totalSec = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`[LLM] ${meta.agent} done in ${totalSec}s (model load ${loadSec}s)`);
  }

  try {
    return parseJsonFromLlm(content);
  } catch {
    const preview = content.replace(/\s+/g, " ").slice(0, 120);
    throw new Error(
      `Ollama returned invalid JSON from model ${model}${preview ? `: ${preview}` : ""}`,
    );
  }
}

async function geminiChatJson(system, user, meta = {}) {
  const model = meta.model || config.geminiModel;
  const started = Date.now();
  const images = meta.images || [];
  if (meta.agent) {
    console.log(
      `[LLM] ${meta.agent} → gemini:${model} (prompt ~${user.length} chars${images.length ? `, ${images.length} image(s)` : ""})`,
    );
  }

  if (!config.googleApiKey) {
    throw new LlmCallError("GOOGLE_API_KEY is not set", {
      agent: meta.agent,
      model: `gemini:${model}`,
      hint: "Get a free key at https://aistudio.google.com/apikey",
    });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.googleApiKey}`;

  const userParts = [{ text: user }];
  for (const image of images) {
    if (image?.base64 && image?.mime_type) {
      userParts.push({
        inlineData: {
          mimeType: image.mime_type,
          data: image.base64,
        },
      });
    }
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: `${system}\nRespond ONLY with valid JSON.` }] },
        contents: [{ role: "user", parts: userParts }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: meta.num_predict ?? 1024,
          responseMimeType: "application/json",
        },
      }),
      signal: resolveRequestSignal(meta),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const err = new LlmCallError(`Gemini HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`, {
        agent: meta.agent,
        model: `gemini:${model}`,
        hint: geminiHintForStatus(response.status, text),
      });
      err.status = response.status;
      throw err;
    }

    const data = await response.json();
    const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) {
      throw new LlmCallError("Gemini returned an empty response", {
        agent: meta.agent,
        model: `gemini:${model}`,
      });
    }

    if (meta.agent) {
      console.log(`[LLM] ${meta.agent} done in ${((Date.now() - started) / 1000).toFixed(1)}s (Gemini)`);
    }

    try {
      return parseJsonFromLlm(content);
    } catch {
      throw new LlmCallError(`Gemini returned invalid JSON`, {
        agent: meta.agent,
        model: `gemini:${model}`,
      });
    }
  } catch (err) {
    throwIfPipelineCancelled(err, meta);
    throw err;
  }
}

function geminiHintForStatus(status, body = "") {
  if (status === 429) {
    return "Free-tier quota/rate limit hit. Wait and retry, or set LLM_PROVIDER=ollama.";
  }
  if (status === 403) {
    return "Project access denied for this model. Use GEMINI_MODEL=gemini-2.0-flash or create a new key at https://aistudio.google.com/apikey";
  }
  if (status === 400) {
    return "Invalid API key — use a key from https://aistudio.google.com/apikey (usually starts with AIza…)";
  }
  return "Check GOOGLE_API_KEY and GEMINI_MODEL in .env";
}

async function chatJsonInner(system, user, options = {}) {
  const provider = options.provider ?? resolveProvider();
  const meta = {
    agent: options.agent,
    pipeline_id: options.pipeline_id,
    num_predict: options.num_predict,
    num_ctx: options.num_ctx,
    timeout: options.timeout,
    model: options.model,
    planning: options.planning,
    images: options.images,
  };

  if (provider === "gemini") {
    return geminiChatJson(system, user, meta);
  }

  const model = options.model || (options.planning ? await resolvePlanningModel() : config.reasoningModel);
  return ollamaChat(system, user, model, meta);
}

export async function chatJson(system, user, options = {}) {
  return chatJsonInner(system, user, options);
}

function planningNumCtx() {
  const n = Number(process.env.OLLAMA_PLANNING_NUM_CTX);
  return Number.isFinite(n) && n > 0 ? n : 4096;
}

function planningNumPredict(model) {
  const fromEnv = Number(process.env.OLLAMA_PLANNING_NUM_PREDICT);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  if (model && isOllamaCloudModel(model)) return 4096;
  return 2048;
}

/** Planning path for A1–A3. Limits only apply when set in .env — agents are not hard-capped in code. */
export async function chatJsonPlanning(system, user, options = {}) {
  const model = options.model || (await resolvePlanningModel());
  return chatJsonInner(system, user, {
    ...options,
    model,
    planning: true,
    num_ctx: options.num_ctx ?? planningNumCtx(),
    num_predict: options.num_predict ?? planningNumPredict(model),
    timeout: options.timeout ?? planningTimeoutMs(),
  });
}

function codingNumPredict(model) {
  const fromEnv = Number(process.env.OLLAMA_CODING_NUM_PREDICT);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  if (isOllamaCloudModel(model) || isThinkingOllamaModel(model)) return 16384;
  return 8192;
}

export async function chatJsonCoding(system, user, agentOrOptions = {}) {
  const options =
    typeof agentOrOptions === "string" ? { agent: agentOrOptions } : agentOrOptions;
  const agent = options.agent || "A4";
  const provider = resolveCodingProvider();
  const codingModel = config.codingModel;
  const num_predict = Number(process.env.GEMINI_CODING_MAX_TOKENS) || codingNumPredict(codingModel);
  const meta = {
    agent,
    pipeline_id: options.pipeline_id,
    num_predict,
    timeout: Number(process.env.GEMINI_TIMEOUT_MS) || timeoutMs(),
    model: config.geminiCodingModel,
    images: options.images,
    coding: true,
  };

  if (provider === "gemini") {
    return geminiChatJson(system, user, meta);
  }

  return ollamaChat(system, user, codingModel, {
    agent,
    pipeline_id: options.pipeline_id,
    num_predict: codingNumPredict(codingModel),
    num_ctx: Number(process.env.OLLAMA_NUM_CTX) || 8192,
    coding: true,
  });
}

export async function checkGeminiConnection() {
  if (!config.googleApiKey) {
    return { configured: false, connected: false, error: "GOOGLE_API_KEY not set" };
  }

  try {
    const model = config.geminiModel;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.googleApiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: 'Reply JSON: {"ok":true}' }] }],
        generationConfig: {
          maxOutputTokens: 16,
          responseMimeType: "application/json",
        },
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        configured: true,
        connected: false,
        model,
        error: `HTTP ${response.status}: ${text.slice(0, 200)}`,
        hint: geminiHintForStatus(response.status, text),
      };
    }

    return {
      configured: true,
      connected: true,
      model,
      coding_model: config.geminiCodingModel,
      planning_provider: resolveProvider(),
      coding_provider: resolveCodingProvider(),
    };
  } catch (err) {
    return { configured: true, connected: false, error: err.message };
  }
}

async function isModelLoaded(model) {
  try {
    const response = await fetch(`${config.ollamaBaseUrl}/api/ps`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return false;
    const data = await response.json();
    return (data.models || []).some(
      (m) => m.name === model || m.name.startsWith(`${model}:`),
    );
  } catch {
    return false;
  }
}

export function warmupOllama() {
  if (!warmupPromise) {
    warmupPromise = withOllamaQueue(() => warmupOllamaInner());
  }
  return warmupPromise;
}

async function warmupOllamaInner() {
  if (!warmupEnabled()) {
    console.log("Ollama warmup disabled (OLLAMA_WARMUP=false)");
    return;
  }

  if (resolveProvider() === "gemini") {
    console.log("LLM provider: Gemini (planning) — skipping Ollama warmup");
    return;
  }

  const model = await resolvePlanningModel();
  if (isOllamaCloudModel(model)) {
    if (config.ollamaApiKey) {
      console.log(`Ollama planning: ${model} (cloud — OLLAMA_API_KEY configured)`);
    } else {
      console.log(
        `Ollama planning: ${model} (cloud — set OLLAMA_API_KEY in .env or run: ollama signin)`,
      );
    }
    return;
  }
  if (await isModelLoaded(model)) {
    console.log(`Ollama ready: ${model} already in memory`);
    return;
  }

  const capSec = (warmupTimeoutMs() / 1000).toFixed(0);
  console.log(`Ollama warmup: trying ${model} (max ${capSec}s — cold load on CPU often needs longer)`);
  const t0 = Date.now();

  try {
    const response = await fetch(`${config.ollamaBaseUrl}/api/generate`, {
      method: "POST",
      headers: ollamaRequestHeaders(),
      body: JSON.stringify({
        model,
        prompt: "ok",
        stream: false,
        keep_alive: process.env.OLLAMA_KEEP_ALIVE || "30m",
        options: { num_predict: 1, num_ctx: 256 },
      }),
      signal: AbortSignal.timeout(warmupTimeoutMs()),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 120)}` : ""}`);
    }
    console.log(`Ollama warmup complete (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (err) {
    if (await isModelLoaded(model)) {
      console.log(`Ollama ready: ${model} loaded (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      return;
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `Ollama warmup deferred after ${elapsed}s — ${model} will load on first A1 call (normal on CPU)`,
    );
  }
}

export async function checkOllamaConnection() {
  try {
    cachedOllamaModels = null;
    const response = await fetch(`${config.ollamaBaseUrl}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return { connected: false, error: `HTTP ${response.status}` };
    const data = await response.json();
    const models = (data.models || []).map((m) => m.name);
    cachedOllamaModels = models;
    const hasModel = (name) => models.some((m) => m === name || m.startsWith(`${name}:`));
    const planning = await resolvePlanningModel();
    return {
      connected: true,
      models,
      planning_model: planning,
      reasoning_model: hasModel(config.reasoningModel) ? config.reasoningModel : null,
      coding_model: hasModel(config.codingModel) ? config.codingModel : null,
      llm_provider: resolveProvider(),
      coding_llm_provider: resolveCodingProvider(),
      timeout_ms: timeoutMs(),
      planning_timeout_ms: planningTimeoutMs(),
    };
  } catch (err) {
    return { connected: false, error: err.message };
  }
}
