import { chatJsonCoding } from "../llm.js";
import { getRepoPromptContext } from "../../integrations/local-repo.js";

const SYSTEM = `You are A6 Test Coding Agent. Generate Playwright E2E tests from the test plan and technical spec.
Respond ONLY with valid JSON: { "files": [{ "path": "relative/path", "content": "source code" }] }`;

export async function runA6TestCoding(state) {
  const spec = state.technical_spec;
  const testCases = state.test_cases || [];
  const task = state.jira_task;
  const startedAt = new Date().toISOString();
  const slug = (spec?.title || task.summary || "feature")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

  const mockPayload = {
    files: [
      {
        path: `tests/e2e/${slug}.spec.js`,
        content: `import { test, expect } from "@playwright/test";

test.describe("${spec?.title || task.summary}", () => {
  test("happy path — create record", async ({ page }) => {
    await page.goto("/${slug}");
    await page.getByPlaceholder("Title").fill("E2E test record");
    await page.getByRole("button", { name: /save/i }).click();
    await expect(page.getByText(/success|saved/i)).toBeVisible();
  });

  test("validation — required fields", async ({ page }) => {
    await page.goto("/${slug}");
    await page.getByRole("button", { name: /save/i }).click();
    await expect(page.locator("input:invalid")).toHaveCount(1);
  });
});
`,
      },
      {
        path: `tests/api/${slug}.api.spec.js`,
        content: `import { test, expect } from "@playwright/test";

test("GET /api/${slug} returns 200", async ({ request }) => {
  const res = await request.get("/api/${slug}");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toHaveProperty("items");
});
`,
      },
    ],
    mapped_cases: testCases.map((tc) => tc.id),
  };

  const user = `Jira: ${task.key}
${getRepoPromptContext(state.knowledge_context)}

Test cases:
${JSON.stringify(testCases, null, 2)}
Spec:
${JSON.stringify(spec, null, 2)}

Place tests in the same test folder pattern as the local project (e.g. tests/e2e).`;

  const result = await chatJsonCoding(SYSTEM, user, mockPayload);

  return {
    test_code: result,
    agent_logs: [
      {
        agent: "A6",
        name: "Test Coding Agent",
        status: "completed",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        output_summary: `${(result.files || []).length} test files for ${(result.mapped_cases || []).length} cases`,
      },
    ],
  };
}
