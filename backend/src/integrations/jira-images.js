import fs from "fs";
import path from "path";
import { config } from "../config.js";

const IMAGE_MIME = /^image\//i;
const MAX_IMAGE_BYTES = Number(process.env.JIRA_IMAGE_MAX_BYTES) || 5 * 1024 * 1024;
const MAX_IMAGES = Number(process.env.JIRA_IMAGE_MAX_COUNT) || 6;

function jiraAuthHeader() {
  const token = Buffer.from(`${config.jira.email}:${config.jira.apiToken}`).toString("base64");
  return `Basic ${token}`;
}

function jiraSiteUrl() {
  return (config.jira.baseUrl || "")
    .replace(/\/$/, "")
    .replace(/\/rest\/api\/\d+(\/.*)?$/i, "");
}

async function jiraFetchBinary(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "*/*",
      Authorization: jiraAuthHeader(),
    },
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new Error(`Jira binary fetch ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function isImageFile(filename, mimeType) {
  if (IMAGE_MIME.test(mimeType || "")) return true;
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(filename || "");
}

function safeFilename(name) {
  return (name || "image").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function imagesDir(issueKey) {
  return path.join(config.dataDir, "jira-images", issueKey.toUpperCase());
}

export function extractAdfMediaRefs(description) {
  const refs = [];
  if (!description || typeof description !== "object") return refs;

  function walk(nodes) {
    for (const node of nodes || []) {
      if (node.type === "media" && node.attrs?.id) {
        refs.push({
          id: String(node.attrs.id),
          alt: node.attrs.alt || null,
          collection: node.attrs.collection || null,
        });
      }
      if (node.type === "mediaGroup" && node.content) walk(node.content);
      if (node.type === "mediaSingle" && node.content) walk(node.content);
      if (node.content) walk(node.content);
    }
  }

  if (description.type === "doc" && Array.isArray(description.content)) {
    walk(description.content);
  }

  return refs;
}

function uniqueByKey(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function saveImageBuffer(issueKey, filename, mimeType, buffer, meta = {}) {
  if (!buffer?.length || buffer.length > MAX_IMAGE_BYTES) return null;

  const dir = imagesDir(issueKey);
  fs.mkdirSync(dir, { recursive: true });
  const storedName = safeFilename(filename);
  const localPath = path.join(dir, storedName);
  fs.writeFileSync(localPath, buffer);

  return {
    id: meta.id || null,
    filename: filename || storedName,
    mime_type: mimeType || "image/png",
    size: buffer.length,
    local_path: localPath,
    url: `/api/jira/images/${encodeURIComponent(issueKey.toUpperCase())}/${encodeURIComponent(storedName)}`,
    alt_text: meta.alt || null,
    source: meta.source || "attachment",
  };
}

async function downloadAttachmentImage(issueKey, attachment) {
  if (!isImageFile(attachment.filename, attachment.mimeType)) return null;
  if (!attachment.content) return null;

  try {
    const buffer = await jiraFetchBinary(attachment.content);
    return saveImageBuffer(issueKey, attachment.filename, attachment.mimeType, buffer, {
      id: String(attachment.id),
      source: "attachment",
    });
  } catch (err) {
    console.warn(`[jira-images] attachment ${attachment.filename}: ${err.message}`);
    return null;
  }
}

async function downloadMediaById(issueKey, mediaId, alt = null) {
  const base = jiraSiteUrl();
  const candidates = [
    `${base}/rest/api/3/attachment/content/${mediaId}`,
    `${base}/rest/api/3/attachment/thumbnail/${mediaId}`,
  ];

  for (const url of candidates) {
    try {
      const buffer = await jiraFetchBinary(url);
      const mimeType = guessMimeFromBuffer(buffer) || "image/png";
      return saveImageBuffer(issueKey, `${mediaId}.png`, mimeType, buffer, {
        id: mediaId,
        alt,
        source: "description_media",
      });
    } catch {
      // try next URL
    }
  }

  return null;
}

function guessMimeFromBuffer(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return "image/gif";
  if (buffer.slice(0, 4).toString("ascii") === "RIFF") return "image/webp";
  return null;
}

export async function describeImageWithGemini(image) {
  if (!config.googleApiKey || !image?.local_path) return null;

  const buffer = fs.readFileSync(image.local_path);
  const base64 = buffer.toString("base64");
  const model = config.geminiModel;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.googleApiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: 'Describe this screenshot from a Jira software task. Focus on visible UI text, layout, components, colors, and what change the ticket likely requires. Respond ONLY with JSON: {"description":"..."}',
            },
            {
              inlineData: {
                mimeType: image.mime_type || "image/png",
                data: base64,
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 256,
        responseMimeType: "application/json",
      },
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!response.ok) {
    throw new Error(`Gemini vision HTTP ${response.status}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    return typeof parsed.description === "string" ? parsed.description.trim() : null;
  } catch {
    return text.trim().slice(0, 500);
  }
}

export async function enrichImagesWithDescriptions(images) {
  if (!images.length || !config.googleApiKey) return images;

  const enriched = [];
  for (const image of images) {
    try {
      const description = await describeImageWithGemini(image);
      enriched.push(description ? { ...image, description } : image);
      if (description) {
        console.log(`[jira-images] described ${image.filename}: ${description.slice(0, 80)}…`);
      }
    } catch (err) {
      console.warn(`[jira-images] vision describe failed for ${image.filename}: ${err.message}`);
      enriched.push(image);
    }
  }
  return enriched;
}

export async function fetchIssueDescriptionImages(issueKey, { attachments = [], rawDescription = null } = {}) {
  const key = issueKey.toUpperCase();
  const candidates = [];

  for (const att of attachments || []) {
    candidates.push({ type: "attachment", attachment: att });
  }

  for (const media of extractAdfMediaRefs(rawDescription)) {
    candidates.push({ type: "media", media });
  }

  const images = [];

  for (const item of candidates) {
    if (images.length >= MAX_IMAGES) break;

    if (item.type === "attachment") {
      const saved = await downloadAttachmentImage(key, item.attachment);
      if (saved) images.push(saved);
      continue;
    }

    const already = images.some((img) => img.id === item.media.id);
    if (already) continue;

    const saved = await downloadMediaById(key, item.media.id, item.media.alt);
    if (saved) images.push(saved);
  }

  const unique = uniqueByKey(images, (img) => img.local_path).slice(0, MAX_IMAGES);
  if (!unique.length) return [];

  return enrichImagesWithDescriptions(unique);
}

export function readImageBase64(image) {
  if (!image?.local_path || !fs.existsSync(image.local_path)) return null;
  return fs.readFileSync(image.local_path).toString("base64");
}

export function imagePartsForLlm(images = []) {
  return (images || [])
    .map((image) => {
      const base64 = readImageBase64(image);
      if (!base64) return null;
      return {
        mime_type: image.mime_type || "image/png",
        base64,
      };
    })
    .filter(Boolean);
}

export function resolveImageFile(issueKey, filename) {
  const dir = imagesDir(issueKey);
  const resolved = path.resolve(dir, filename);
  if (!resolved.startsWith(path.resolve(dir) + path.sep) && resolved !== path.resolve(dir)) {
    return null;
  }
  if (!fs.existsSync(resolved)) return null;
  return resolved;
}
