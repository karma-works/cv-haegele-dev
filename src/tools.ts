// Light tool executors — run inline inside the CvAgent Durable Object

import {
  Env, SourceType,
  safeUrl, boundedFetchText, githubProfileMarkdown,
  cleanText, sanitizeUserText, summarizeWithAi, callAiJson, callAiMarkdown, kbPrompt,
  saveKnowledgeFile, listKnowledge, getKnowledge, allowedProfileHosts,
} from "./shared";

export const ANTHROPIC_GUIDELINE_URL = "https://www.anthropic.com/candidate-ai-guidance";

// Anthropic's candidate AI guidance — used as default when no company guideline found
export const ANTHROPIC_GUIDELINE_SUMMARY = `Anthropic's candidate AI guidance (default):
- Application materials: create initial drafts yourself; use AI to refine and polish communication.
- Take-home assessments: complete without AI unless explicitly permitted.
- Interview preparation: AI is encouraged for research and practice.
- Live interviews: no AI assistance — demonstrate real-time problem-solving.
- Core principles: use AI as a collaboration tool, remain authentic, follow any explicit guidelines.
Source: ${ANTHROPIC_GUIDELINE_URL}`;

export async function fetchJdTool(url: string): Promise<string> {
  let parsedUrl: URL;
  try { parsedUrl = new URL(url); } catch { throw new Error("Invalid URL"); }
  if (parsedUrl.protocol !== "https:") throw new Error("HTTPS required");
  const host = parsedUrl.hostname.toLowerCase();
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0)/i.test(host)) {
    throw new Error("Blocked host");
  }
  const raw = await boundedFetchText(parsedUrl);
  const text = cleanText(raw);
  if (!text) throw new Error("No readable text found at URL");
  return text.slice(0, 60_000);
}

export async function analyzeGapsTool(env: Env, kbText: string, jdText: string): Promise<string> {
  const result = await callAiJson(
    env,
    `You analyze gaps between a candidate's knowledge base and a job description.
Return JSON only: {"questions":[{"id":"q1","question":"...","why":"..."}],"ready":true,"gaps":["..."]}
Ask at most 5 high-impact questions. If no critical gaps, questions must be [].
Only flag genuine gaps — skills the candidate clearly lacks or hasn't mentioned.`,
    `Job description:\n${sanitizeUserText(jdText, 40_000)}\n\nKnowledge base:\n${sanitizeUserText(kbText, 80_000)}`
  );
  return JSON.stringify(result, null, 2);
}

export interface CompanyResearch {
  companySummary: string;
  aiGuideline: string;
  aiGuidelineSource: "company" | "default";
  aiGuidelineName: string;
}

export async function searchCompanyTool(env: Env, query: string): Promise<CompanyResearch> {
  // Determine if query is a URL or a company name
  let targetUrl: URL | null = null;
  try { targetUrl = new URL(query); } catch { /* not a URL */ }

  let companyText = "";
  let companyName = query;

  if (targetUrl) {
    try {
      const raw = await boundedFetchText(targetUrl);
      companyText = cleanText(raw, 40_000);
      companyName = targetUrl.hostname.replace(/^www\./, "");
    } catch { companyText = ""; }
  } else {
    // Can't web-search without a URL — use name only for guideline search
    companyText = `Company: ${query}`;
  }

  // Summarise company content
  const companySummary = companyText
    ? await summarizeWithAi(env,
        "Extract hiring signals, company values, tech stack, and anything useful for a CV or cover letter. Return Markdown bullets.",
        companyText)
    : `Company: ${companyName} (no page content available)`;

  // Search for AI usage guideline in the company page text
  const guidelineKeywords = ["ai", "artificial intelligence", "candidate guidance", "llm", "machine learning tools"];
  const hasGuidelineContent = guidelineKeywords.some(k => companyText.toLowerCase().includes(k));

  let aiGuideline: string;
  let aiGuidelineSource: "company" | "default";
  let aiGuidelineName: string;

  if (hasGuidelineContent) {
    // Try to extract AI guideline from the company page
    const extracted = await summarizeWithAi(env,
      "Extract any AI usage policy or candidate guidance about using AI tools during the hiring process. If found, return it. If not found, respond with 'NOT_FOUND'.",
      companyText
    );
    if (extracted && !extracted.includes("NOT_FOUND") && extracted.length > 50) {
      aiGuideline = `${companyName} AI candidate policy:\n${extracted}\nSource: ${targetUrl?.toString() || query}`;
      aiGuidelineSource = "company";
      aiGuidelineName = `${companyName} AI Policy`;
    } else {
      aiGuideline = ANTHROPIC_GUIDELINE_SUMMARY;
      aiGuidelineSource = "default";
      aiGuidelineName = "Anthropic Candidate AI Guidance (default)";
    }
  } else {
    // Try the Anthropic guideline as default
    aiGuideline = ANTHROPIC_GUIDELINE_SUMMARY;
    aiGuidelineSource = "default";
    aiGuidelineName = "Anthropic Candidate AI Guidance (default)";

    // Try to fetch company's /ai-policy or /candidate-guide page
    if (targetUrl) {
      try {
        const guideUrl = new URL("/candidate-ai-guidance", targetUrl.origin);
        const raw = await boundedFetchText(guideUrl);
        const text = cleanText(raw, 20_000);
        if (text.length > 200) {
          const extracted = await summarizeWithAi(env,
            "Extract the AI usage policy or candidate guidance about using AI during the hiring process.",
            text
          );
          if (extracted && extracted.length > 50) {
            aiGuideline = `${companyName} AI candidate policy:\n${extracted}\nSource: ${guideUrl.toString()}`;
            aiGuidelineSource = "company";
            aiGuidelineName = `${companyName} AI Policy`;
          }
        }
      } catch { /* not found */ }
    }
  }

  return { companySummary, aiGuideline, aiGuidelineSource, aiGuidelineName };
}

export async function importProfileTool(env: Env, workspaceId: string, profileUrl: string): Promise<string> {
  const url = safeUrl(profileUrl, true);
  let content: string;
  let sourceType: SourceType;

  if (url.hostname.endsWith("github.com")) {
    const username = url.pathname.split("/").filter(Boolean)[0];
    if (!username) throw new Error("Missing GitHub username in URL");
    content = await githubProfileMarkdown(username);
    sourceType = "github";
  } else {
    const fetched = await boundedFetchText(url);
    content = `# Public profile import\n\nSource: ${url.toString()}\n\n${cleanText(fetched)}`;
    sourceType = url.hostname.includes("linkedin") ? "linkedin"
      : url.hostname.includes("xing") ? "xing" : "x";
  }

  await saveKnowledgeFile(env, workspaceId, `${sourceType}-profile-${Date.now()}.md`, content, sourceType, url.toString());
  const files = await listKnowledge(env, workspaceId);
  return `Profile imported successfully. KB now has ${files.length} file(s).`;
}

export async function generateTailoringPlan(env: Env, kbText: string, jdText: string, aiGuideline: string): Promise<string> {
  return callAiMarkdown(
    env,
    `You are a professional CV tailoring expert. Create a concise tailoring plan.
Sections: ## Emphasize, ## Reduce, ## Omit, ## Risk checks.
Do not write the CV yet — only the plan.
Use only facts from the knowledge base.
${aiGuideline ? `\nActive AI guideline:\n${aiGuideline}` : ""}`,
    `Job description:\n${sanitizeUserText(jdText, 40_000)}\n\nKnowledge base:\n${sanitizeUserText(kbText, 80_000)}`
  );
}

export async function generateCv(env: Env, kbText: string, jdText: string, tailoringPlan: string, aiGuideline: string): Promise<string> {
  // Detect language from JD
  const langHint = /\b(der|die|das|und|ist|für|mit|wir|Sie|Ihr)\b/.test(jdText)
    ? "Use German CV conventions (Lebenslauf format, German language, dd.mm.yyyy dates)."
    : "Use English/American resume conventions (concise, action verbs, reverse-chronological).";
  return callAiMarkdown(
    env,
    `You write factual, professional CVs. ${langHint}
Include public project links where relevant. No placeholders. No AI disclosure.
Use only facts from the knowledge base.
${aiGuideline ? `\nActive AI guideline:\n${aiGuideline}` : ""}`,
    `Approved tailoring plan:\n${sanitizeUserText(tailoringPlan, 15_000)}\n\nJob description:\n${sanitizeUserText(jdText, 30_000)}\n\nKnowledge base:\n${sanitizeUserText(kbText, 80_000)}`
  );
}

export async function generateCoverLetter(env: Env, kbText: string, jdText: string, companySummary: string, tone: string, aiGuideline: string): Promise<string> {
  return callAiMarkdown(
    env,
    `You write factual, professional cover letters. Style: ${tone || "direct and concise"}.
No placeholders, no AI disclosure. Use only facts from the knowledge base.
${aiGuideline ? `\nActive AI guideline:\n${aiGuideline}` : ""}`,
    `Job description:\n${sanitizeUserText(jdText, 30_000)}\n\nCompany notes:\n${companySummary || "[none]"}\n\nKnowledge base:\n${sanitizeUserText(kbText, 80_000)}`
  );
}
