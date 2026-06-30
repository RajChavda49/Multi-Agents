/**
 * Structured deliverables from Jira — used by A1–A4 so multi-part tasks (header + footer) are not dropped.
 */

export function parseTaskDeliverables(jiraTask) {
  const summary = jiraTask?.summary || "";
  const description = jiraTask?.description || "";
  const text = `${summary}\n${description}`;
  const lower = text.toLowerCase();

  const wantsHeader =
    /\b(header|navbar|navigation|nav\s*bar|site\s*header|top\s*bar|menu\s*bar)\b/.test(lower) &&
    !/\bcart\s*header\b/.test(lower);
  const wantsFooter = /\b(footer|site\s*footer|page\s*footer|bottom\s*bar)\b/.test(lower);
  const wantsHomepage = /\b(home\s*page|homepage|landing\s*page|ecommerce\s*home|store\s*front)\b/.test(
    lower,
  );
  const wantsHero = /\b(hero|banner\s*section)\b/.test(lower);
  const wantsProducts =
    /\b(products?|featured|catalog|collection)\b/.test(lower) && wantsHomepage;

  const deliverables = [];

  if (wantsHeader) {
    deliverables.push({
      id: "header",
      label: "Site header / navigation",
      area: "site_header",
      path_hints: ["NewHeader", "Header", "global-header", "Navbar"],
      suggested_new_paths: [
        "src/components/Common/NewHeader/index.js",
        "src/components/global-header/index.js",
      ],
    });
  }

  if (wantsFooter) {
    deliverables.push({
      id: "footer",
      label: "Site footer",
      area: "site_footer",
      path_hints: ["Footer", "FooterLinks", "NewFooter", "global-footer"],
      suggested_new_paths: [
        "src/components/Common/NewFooter/index.js",
        "src/components/Common/FooterLinks/index.js",
        "src/components/global-footer/index.js",
      ],
    });
  }

  if (wantsHomepage) {
    deliverables.push({
      id: "homepage",
      label: "Homepage / landing page",
      area: "page_content",
      path_hints: ["Homepage", "pages/index", "app/page"],
      suggested_new_paths: [
        "src/components/Homepage/Homepage.js",
        "src/components/Homepage/index.js",
      ],
    });
  }

  if (wantsHero) {
    deliverables.push({
      id: "hero",
      label: "Hero section",
      area: "page_content",
      path_hints: ["Hero", "Banner"],
      suggested_new_paths: ["src/components/Homepage/HeroSection.js"],
    });
  }

  if (wantsProducts) {
    deliverables.push({
      id: "products",
      label: "Featured products section",
      area: "page_content",
      path_hints: ["FeaturedProducts", "ProductGrid"],
      suggested_new_paths: ["src/components/Homepage/FeaturedProducts.js"],
    });
  }

  // Acceptance criteria bullets that name UI areas
  const acBullets = [
    ...text.matchAll(/\[ \]\s*(.+)/g),
    ...text.matchAll(/^[-*]\s*(.+)/gm),
  ].map((m) => m[1].trim().toLowerCase());

  for (const bullet of acBullets) {
    if (/\bfooter\b/.test(bullet) && !deliverables.some((d) => d.id === "footer")) {
      deliverables.push({
        id: "footer",
        label: "Site footer (from acceptance criteria)",
        area: "site_footer",
        path_hints: ["Footer", "FooterLinks", "global-footer"],
        suggested_new_paths: [
          "src/components/Common/NewFooter/index.js",
          "src/components/global-footer/index.js",
        ],
      });
    }
    if (
      /\b(header|navbar|navigation)\b/.test(bullet) &&
      !deliverables.some((d) => d.id === "header")
    ) {
      deliverables.push({
        id: "header",
        label: "Site header (from acceptance criteria)",
        area: "site_header",
        path_hints: ["Header", "NewHeader", "global-header"],
        suggested_new_paths: ["src/components/Common/NewHeader/index.js"],
      });
    }
  }

  return {
    deliverables,
    wantsHeader: deliverables.some((d) => d.id === "header"),
    wantsFooter: deliverables.some((d) => d.id === "footer"),
    wantsHomepage: deliverables.some((d) => d.id === "homepage"),
    summary:
      deliverables.length > 0
        ? deliverables.map((d) => d.label).join(" + ")
        : "General implementation per Jira description",
  };
}

export function deliverablePaths(deliverables = []) {
  const paths = new Set();
  for (const d of deliverables) {
    for (const p of d.suggested_new_paths || []) paths.add(p);
  }
  return [...paths];
}

export function checkDeliverablesCoverage(deliverables, outputFiles = []) {
  if (!deliverables?.length) return { complete: true, missing: [] };

  const paths = outputFiles.map((f) => (f.path || "").toLowerCase());
  const allContent = outputFiles.map((f) => f.content || "").join("\n").toLowerCase();
  const missing = [];

  for (const d of deliverables) {
    const pathHit = paths.some(
      (p) =>
        d.path_hints.some((h) => p.includes(h.toLowerCase())) ||
        p.includes(d.id) ||
        p.includes(d.area.replace("site_", "")),
    );
    const contentHit =
      allContent.includes(d.id) ||
      (d.id === "header" && /\b(header|navbar|navigation)\b/.test(allContent)) ||
      (d.id === "footer" && /\bfooter\b/.test(allContent));

    if (!pathHit && !contentHit) {
      missing.push(d);
    }
  }

  return { complete: missing.length === 0, missing };
}

export function formatDeliverablesForPrompt(deliverables) {
  if (!deliverables?.length) return "No specific UI areas parsed — read Jira description carefully.";
  return deliverables
    .map(
      (d, i) =>
        `${i + 1}. ${d.label} (${d.id}) — suggested: ${(d.suggested_new_paths || []).slice(0, 2).join(" or ")}`,
    )
    .join("\n");
}
