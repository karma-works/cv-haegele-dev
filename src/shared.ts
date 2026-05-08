// Shared types, constants, and utility functions

export interface Env {
  DB: D1Database;
  AI: Ai;
  CV_AGENT: DurableObjectNamespace;
  CV_WORKFLOW: Workflow;
  APP_ORIGIN: string;
  MODEL_NAME: string;
  KB_MAX_BYTES: string;
  DAILY_TOKEN_BUDGET: string;
}

export type SourceType = "upload" | "github" | "linkedin" | "xing" | "x" | "company" | "clarification";

export interface KnowledgeFile {
  id: string;
  filename: string;
  content: string;
  source_type: SourceType;
  source_url: string | null;
  content_bytes: number;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

export type AiRaw = Record<string, unknown>;

export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export const KB_TTL_MS = 1000 * 60 * 60 * 24 * 30;
export const FETCH_MAX_CHARS = 180_000;
export const GITHUB_MAX_REPOS = 12;
export const GITHUB_MAX_READMES = 5;
export const encoder = new TextEncoder();
export const allowedProfileHosts = new Set([
  "github.com", "www.github.com",
  "linkedin.com", "www.linkedin.com",
  "xing.com", "www.xing.com",
  "x.com", "www.x.com",
]);

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...init.headers },
  });
}

export function html(content: string, init: ResponseInit = {}): Response {
  return new Response(content, {
    ...init,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...init.headers },
  });
}

export function markdown(content: string, filename: string): Response {
  return new Response(content, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${filename.replace(/[^a-z0-9._-]/gi, "-")}"`,
      "cache-control": "no-store",
    },
  });
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw json({ error: "invalid_json" }, { status: 400 });
  }
}

export function randomId(prefix: string): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return `${prefix}_${btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
}

export function bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function cleanText(raw: string, maxChars = FETCH_MAX_CHARS): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ").trim().slice(0, maxChars);
}

export function sanitizeUserText(raw: string, maxChars = 80_000): string {
  return raw
    .slice(0, maxChars)
    .replace(/<(system|instructions?|prompt|context|human|assistant)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/\[\s*INST\s*\][\s\S]*?\[\s*\/INST\s*\]/gi, "")
    .replace(/ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/gi, "ignore unsupported claims");
}

export function safeUrl(raw: string, allowProfilesOnly: boolean): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw json({ error: "invalid_url" }, { status: 400 }); }
  if (url.protocol !== "https:") throw json({ error: "https_required" }, { status: 400 });
  const host = url.hostname.toLowerCase();
  if (allowProfilesOnly && !allowedProfileHosts.has(host)) throw json({ error: "unsupported_profile_host" }, { status: 400 });
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0)/i.test(host) || host === "::1") {
    throw json({ error: "blocked_host" }, { status: 400 });
  }
  return url;
}

export async function boundedFetchText(url: URL): Promise<string> {
  const response = await fetch(url.toString(), {
    redirect: "follow",
    headers: {
      accept: "text/html, text/plain, application/json;q=0.8, */*;q=0.2",
      "user-agent": "cv-haegele-dev/0.1 (+https://cv.haegele.dev)",
    },
  });
  if (!response.ok) throw new Error(`fetch_failed:${response.status}`);
  const text = await response.text();
  return text.slice(0, FETCH_MAX_CHARS);
}

export async function githubProfileMarkdown(username: string): Promise<string> {
  const userRes = await fetch(`https://api.github.com/users/${encodeURIComponent(username)}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "cv-haegele-dev" },
  });
  if (!userRes.ok) throw new Error(`github_profile_failed:${userRes.status}`);
  const user = (await userRes.json()) as Record<string, unknown>;
  const reposRes = await fetch(
    `https://api.github.com/users/${encodeURIComponent(username)}/repos?sort=updated&per_page=${GITHUB_MAX_REPOS}`,
    { headers: { accept: "application/vnd.github+json", "user-agent": "cv-haegele-dev" } },
  );
  const repos = reposRes.ok ? ((await reposRes.json()) as Array<Record<string, unknown>>) : [];
  const lines = [
    `# GitHub profile: ${username}`, "",
    `URL: https://github.com/${username}`,
    `Name: ${String(user.name || "")}`, `Bio: ${String(user.bio || "")}`,
    `Company: ${String(user.company || "")}`, `Location: ${String(user.location || "")}`,
    `Public repos: ${String(user.public_repos || "")}`, "", "## Repository highlights",
  ];
  let readmes = 0;
  for (const repo of repos) {
    const name = String(repo.name || "");
    const fullName = String(repo.full_name || "");
    lines.push("", `### ${name}`, `URL: ${String(repo.html_url || "")}`,
      `Description: ${String(repo.description || "")}`, `Language: ${String(repo.language || "")}`,
      `Stars: ${String(repo.stargazers_count || 0)}`);
    if (readmes < GITHUB_MAX_READMES && fullName) {
      const readmeRes = await fetch(`https://api.github.com/repos/${fullName}/readme`, {
        headers: { accept: "application/vnd.github.raw", "user-agent": "cv-haegele-dev" },
      });
      if (readmeRes.ok) {
        lines.push("", "README excerpt:", (await readmeRes.text()).replace(/\r\n/g, "\n").slice(0, 2500));
        readmes++;
      }
    }
  }
  return lines.join("\n").trim();
}

export function extractText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const r = result as AiRaw;
  if (typeof r.response === "string") return r.response;
  if (r.response && typeof r.response === "object") {
    const n = r.response as AiRaw;
    if (typeof n.content === "string") return n.content;
    if (typeof n.text === "string") return n.text;
  }
  if (Array.isArray(r.choices) && r.choices.length > 0) {
    const c = r.choices[0] as AiRaw;
    if (c.message && typeof c.message === "object") {
      const m = c.message as AiRaw;
      if (typeof m.content === "string") return m.content;
    }
    if (typeof c.text === "string") return c.text;
  }
  return "";
}

export function extractTokens(result: AiRaw): number {
  const u = result.usage as { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number } | undefined;
  return u?.total_tokens || (u?.prompt_tokens || 0) + (u?.completion_tokens || 0);
}

export async function checkTokenBudget(env: Env): Promise<{ ok: boolean; used: number; budget: number; remaining: number }> {
  const budget = Number(env.DAILY_TOKEN_BUDGET || 500_000);
  const day = utcDay();
  const row = await env.DB.prepare("SELECT tokens FROM cv_daily_tokens WHERE day = ?").bind(day).first<{ tokens: number }>();
  const used = row?.tokens || 0;
  return { ok: used < budget, used, budget, remaining: Math.max(0, budget - used) };
}

export async function recordTokenUsage(env: Env, tokens: number): Promise<void> {
  if (tokens <= 0) return;
  const day = utcDay();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO cv_daily_tokens (day, tokens, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET tokens = tokens + ?, updated_at = ?`
  ).bind(day, tokens, now, tokens, now).run();
}

export async function ensureWorkspace(env: Env, workspaceId: string): Promise<void> {
  if (!/^ws_[A-Za-z0-9_-]{16,80}$/.test(workspaceId)) {
    throw json({ error: "invalid_workspace_id" }, { status: 400 });
  }
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO cv_workspaces (id, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`
  ).bind(workspaceId, now, now, now + KB_TTL_MS).run();
}

export async function cleanupExpired(env: Env): Promise<void> {
  const now = Date.now();
  const weekAgo = utcDay(now - 7 * 24 * 60 * 60 * 1000);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM cv_knowledge_files WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM cv_company_sources WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM cv_workspaces WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM cv_daily_tokens WHERE day < ?").bind(weekAgo),
  ]);
}

export async function kbTotalBytes(env: Env, workspaceId: string, excludingFileId?: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(content_bytes), 0) AS total FROM cv_knowledge_files
     WHERE workspace_id = ? AND expires_at > ? AND (? IS NULL OR id != ?)`
  ).bind(workspaceId, Date.now(), excludingFileId || null, excludingFileId || null).first<{ total: number }>();
  return row?.total || 0;
}

export async function listKnowledge(env: Env, workspaceId: string): Promise<Omit<KnowledgeFile, "content">[]> {
  await cleanupExpired(env);
  const result = await env.DB.prepare(
    `SELECT id, filename, source_type, source_url, content_bytes, created_at, updated_at, expires_at
     FROM cv_knowledge_files WHERE workspace_id = ? AND expires_at > ? ORDER BY created_at DESC`
  ).bind(workspaceId, Date.now()).all<Omit<KnowledgeFile, "content">>();
  return result.results || [];
}

export async function getKnowledge(env: Env, workspaceId: string): Promise<KnowledgeFile[]> {
  await cleanupExpired(env);
  const result = await env.DB.prepare(
    `SELECT id, filename, content, source_type, source_url, content_bytes, created_at, updated_at, expires_at
     FROM cv_knowledge_files WHERE workspace_id = ? AND expires_at > ? ORDER BY created_at ASC`
  ).bind(workspaceId, Date.now()).all<KnowledgeFile>();
  return result.results || [];
}

export async function saveKnowledgeFile(
  env: Env, workspaceId: string, filename: string, content: string,
  sourceType: SourceType, sourceUrl?: string
): Promise<{ id: string; filename: string; sourceType: SourceType; sourceUrl: string | null; contentBytes: number; expiresAt: number }> {
  const clean = content.replace(/\r\n/g, "\n").trim();
  if (!clean) throw json({ error: "empty_content" }, { status: 400 });
  const contentBytes = bytes(clean);
  const max = Number(env.KB_MAX_BYTES || 1048576);
  const total = await kbTotalBytes(env, workspaceId);
  if (total + contentBytes > max) {
    throw json({ error: "knowledge_base_too_large", maxBytes: max, currentBytes: total, newBytes: contentBytes }, { status: 413 });
  }
  const now = Date.now();
  const expiresAt = now + KB_TTL_MS;
  const id = randomId("kb");
  await env.DB.prepare(
    `INSERT INTO cv_knowledge_files
     (id, workspace_id, filename, content, source_type, source_url, content_bytes, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, workspaceId, filename.slice(0, 160), clean, sourceType, sourceUrl || null, contentBytes, now, now, expiresAt).run();
  return { id, filename, sourceType, sourceUrl: sourceUrl || null, contentBytes, expiresAt };
}

export function kbPrompt(files: KnowledgeFile[]): string {
  if (!files.length) return "[No knowledge base files uploaded yet]";
  return files.map(f =>
    `## Source: ${f.filename} (${f.source_type}${f.source_url ? `, ${f.source_url}` : ""})\n\n${f.content}`
  ).join("\n\n---\n\n");
}

export async function callAiJson(env: Env, system: string, user: string): Promise<unknown> {
  const result = (await env.AI.run(env.MODEL_NAME || "@cf/moonshotai/kimi-k2.6", {
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  })) as AiRaw;
  await recordTokenUsage(env, extractTokens(result));
  const raw = extractText(result);
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { raw };
  try { return JSON.parse(m[0]) as unknown; } catch { return { raw }; }
}

export async function callAiMarkdown(env: Env, system: string, user: string): Promise<string> {
  const result = (await env.AI.run(env.MODEL_NAME || "@cf/moonshotai/kimi-k2.6", {
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  })) as AiRaw;
  await recordTokenUsage(env, extractTokens(result));
  return extractText(result).trim();
}

export async function summarizeWithAi(env: Env, instruction: string, content: string): Promise<string> {
  const result = (await env.AI.run(env.MODEL_NAME || "@cf/moonshotai/kimi-k2.6", {
    messages: [
      { role: "system", content: "You summarize fetched public material. Be factual and concise." },
      { role: "user", content: `${instruction}\n\n${content.slice(0, 24_000)}` },
    ],
  })) as AiRaw;
  await recordTokenUsage(env, extractTokens(result));
  return extractText(result).trim() || content.slice(0, 1200);
}
