import { config } from "../config.js";

export async function chatJson(system, user, mockPayload, model = config.reasoningModel) {
  if (config.mockLlm) {
    return mockPayload;
  }

  const payload = {
    model,
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
      signal: AbortSignal.timeout(180_000),
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

export async function chatJsonCoding(system, user, mockPayload) {
  return chatJson(system, user, mockPayload, config.codingModel);
}
