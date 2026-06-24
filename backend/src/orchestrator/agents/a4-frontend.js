import { chatJsonCoding } from "../llm.js";
import { getRepoPromptContext } from "../../integrations/local-repo.js";

const SYSTEM = `You are A4 Frontend Coding Agent. Generate React/Next.js frontend code from the technical spec.
Respond ONLY with valid JSON: { "files": [{ "path": "relative/path", "content": "source code" }] }`;

export async function runA4Frontend(state) {
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
        path: `src/pages/${slug}/index.js`,
        content: `import { useState } from "react";

export default function ${toPascal(slug)}Page() {
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/${slug}", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) throw new Error("Request failed");
      setTitle("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="p-6 max-w-lg mx-auto">
      <h1 className="text-2xl font-semibold mb-4">${spec?.title || task.summary}</h1>
      <form onSubmit={handleSubmit} className="space-y-3">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title"
          required
          className="w-full border rounded px-3 py-2"
        />
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <button disabled={loading} className="bg-blue-600 text-white px-4 py-2 rounded">
          {loading ? "Saving…" : "Save"}
        </button>
      </form>
    </main>
  );
}
`,
      },
      {
        path: `src/components/${toPascal(slug)}Form.js`,
        content: `export function ${toPascal(slug)}Form({ value, onChange, error }) {
  return (
    <label className="block">
      <span className="text-sm text-slate-600">Title</span>
      <input value={value} onChange={onChange} className="mt-1 w-full border rounded px-3 py-2" />
      {error && <span className="text-red-600 text-xs">{error}</span>}
    </label>
  );
}
`,
      },
    ],
  };

  const user = `Jira: ${task.key}
${getRepoPromptContext(state.knowledge_context)}

Spec:
${JSON.stringify(spec, null, 2)}

Generate files using the SAME folder conventions as the connected local project.`;

  const result = await chatJsonCoding(SYSTEM, user, mockPayload);

  return {
    frontend_code: result,
    agent_logs: [
      {
        agent: "A4",
        name: "Frontend Coding Agent",
        status: "completed",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        output_summary: `${(result.files || []).length} frontend files generated`,
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
