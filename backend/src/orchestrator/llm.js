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
  return Number(process.env.OLLAMA_PLANNING_TIMEOUT_MS) || 300_000;
}

function hintForMessage(message) {
  if (/timeout|aborted/i.test(message)) {
    return "LLM timed out on CPU. Increase OLLAMA_PLANNING_TIMEOUT_MS or set GOOGLE_API_KEY + LLM_PROVIDER=gemini.";
  }
  if (/invalid JSON/i.test(message)) {
    return "The model returned text that was not valid JSON. Retry or switch models.";
  }
  if (/fetch failed|ECONNREFUSED/i.test(message)) {
    return "Cannot reach Ollama. Run: ollama serve";
  }
  return "Check backend logs. For speed: GOOGLE_API_KEY + LLM_PROVIDER=gemini";
}

function ollamaOptions(meta = {}) {
  return {
    num_ctx: meta.num_ctx ?? (Number(process.env.OLLAMA_NUM_CTX) || 4096),
    num_predict: meta.num_predict ?? (Number(process.env.OLLAMA_NUM_PREDICT) || 2048),
    temperature: 0.2,
  };
}

let ollamaChain = Promise.resolve();

function withOllamaQueue(fn) {
  const run = ollamaChain.then(fn, fn);
  ollamaChain = run.catch(() => {});
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

export async function resolvePlanningModel() {
  const models = await listOllamaModels();
  const candidates = [
    config.planningModel,
    "qwen2.5:3b",
    "llama3.2:3b",
    "llama3",
    config.reasoningModel,
  ];
  for (const name of candidates) {
    if (name && hasModel(models, name)) return name;
  }
  return config.reasoningModel;
}

async function ollamaChat(system, user, model, meta = {}) {
  return withOllamaQueue(() => ollamaChatInner(system, user, model, meta));
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
  const started = Date.now();
  if (meta.agent) {
    console.log(`[LLM] ${meta.agent} → ${model} (prompt ~${user.length} chars)`);
  }

  try {
    const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        stream: false,
        format: "json",
        keep_alive: process.env.OLLAMA_KEEP_ALIVE || "30m",
        options: ollamaOptions(meta),
      }),
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
      return JSON.parse(content);
    } catch {
      throw new Error(`Ollama returned invalid JSON from model ${model}`);
    }
  } catch (err) {
    throwIfPipelineCancelled(err, meta);
    const message = err.message || String(err);
    throw new LlmCallError(message, {
      agent: meta.agent,
      model,
      hint: hintForMessage(message),
    });
  }
}

async function geminiChatJson(system, user, meta = {}) {
  const model = meta.model || config.geminiModel;
  const started = Date.now();
  if (meta.agent) {
    console.log(`[LLM] ${meta.agent} → gemini:${model} (prompt ~${user.length} chars)`);
  }

  if (!config.googleApiKey) {
    throw new LlmCallError("GOOGLE_API_KEY is not set", {
      agent: meta.agent,
      model: `gemini:${model}`,
      hint: "Get a free key at https://aistudio.google.com/apikey",
    });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.googleApiKey}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: `${system}\nRespond ONLY with valid JSON.` }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
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
      return JSON.parse(content);
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

/** Fast path for A1–A3: smaller model, smaller context, shorter output, optional Gemini. */
export async function chatJsonPlanning(system, user, options = {}) {
  return chatJsonInner(system, user, {
    ...options,
    planning: true,
    num_ctx: options.num_ctx ?? 2048,
    num_predict: options.num_predict ?? 512,
    timeout: options.timeout ?? planningTimeoutMs(),
  });
}

export async function chatJsonCoding(system, user, agentOrOptions = {}) {
  const options =
    typeof agentOrOptions === "string" ? { agent: agentOrOptions } : agentOrOptions;
  const agent = options.agent || "A4";
  const provider = resolveCodingProvider();
  const num_predict = Number(process.env.GEMINI_CODING_MAX_TOKENS) ||
    Number(process.env.OLLAMA_CODING_NUM_PREDICT) ||
    8192;
  const meta = {
    agent,
    pipeline_id: options.pipeline_id,
    num_predict,
    timeout: Number(process.env.GEMINI_TIMEOUT_MS) || 120_000,
    model: config.geminiCodingModel,
  };

  if (provider === "gemini") {
    return geminiChatJson(system, user, meta);
  }

  return ollamaChat(system, user, config.codingModel, {
    agent,
    pipeline_id: options.pipeline_id,
    num_predict: Number(process.env.OLLAMA_CODING_NUM_PREDICT) || 4096,
    num_ctx: Number(process.env.OLLAMA_NUM_CTX) || 8192,
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
      headers: { "Content-Type": "application/json" },
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
