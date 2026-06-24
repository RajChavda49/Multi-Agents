import { chatJsonCoding } from "../llm.js";
import { getRepoPromptContext } from "../../integrations/local-repo.js";

const SYSTEM = `You are A5 Backend Coding Agent. Generate Node.js/Express API code from the technical spec.
Respond ONLY with valid JSON: { "files": [{ "path": "relative/path", "content": "source code" }] }`;

export async function runA5Backend(state) {
  const spec = state.technical_spec;
  const task = state.jira_task;
  const startedAt = new Date().toISOString();
  const slug = (spec?.title || task.summary || "feature")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

  const mockPayload = {
    files: [
      {
        path: `src/api/routes/${slug}.js`,
        content: `import { Router } from "express";
import { z } from "zod";

const router = Router();
const store = [];

const CreateSchema = z.object({
  title: z.string().min(1),
});

router.get("/${slug}", (_req, res) => {
  res.json({ items: store });
});

router.post("/${slug}", (req, res) => {
  try {
    const body = CreateSchema.parse(req.body);
    const item = { id: crypto.randomUUID(), ...body, createdAt: new Date().toISOString() };
    store.push(item);
    res.status(201).json({ item });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
`,
      },
      {
        path: `src/services/${slug}-service.js`,
        content: `export function list${toPascal(slug)}Records(store) {
  return store;
}

export function create${toPascal(slug)}Record(store, data) {
  const item = { id: crypto.randomUUID(), ...data, createdAt: new Date().toISOString() };
  store.push(item);
  return item;
}
`,
      },
    ],
  };

  const user = `Jira: ${task.key}
${getRepoPromptContext(state.knowledge_context)}

Spec:
${JSON.stringify(spec, null, 2)}

Generate files matching the connected local project's API layout.`;

  const result = await chatJsonCoding(SYSTEM, user, mockPayload);

  return {
    backend_code: result,
    agent_logs: [
      {
        agent: "A5",
        name: "Backend Coding Agent",
        status: "completed",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        output_summary: `${(result.files || []).length} backend files generated`,
      },
    ],
  };
}

function toPascal(slug) {
  return slug
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}
