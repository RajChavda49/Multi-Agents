import { config } from "../config.js";

export async function chatJson(system, user, mockPayload) {
  if (config.mockLlm) {
    return mockPayload;
  }

  const payload = {
    model: config.reasoningModel,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    stream: false,
    format: "json",
  };

  try {
    const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      throw new Error(`Ollama error: ${response.status}`);
    }

    const data = await response.json();
    return JSON.parse(data.message.content);
  } catch {
    return mockPayload;
  }
}
