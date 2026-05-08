import {
  Env, AiMessage, KnowledgeFile,
  getKnowledge, kbPrompt, checkTokenBudget, recordTokenUsage,
  ensureWorkspace, sanitizeUserText, extractText, extractTokens,
  randomId,
} from "./shared";
import {
  fetchJdTool, analyzeGapsTool, searchCompanyTool, importProfileTool,
  ANTHROPIC_GUIDELINE_SUMMARY,
} from "./tools";
import type { WorkflowTool } from "./workflow";

// ── Display message types sent over WebSocket to the browser ──────────────
type WsEvent =
  | { type: "history"; messages: DisplayMessage[] }
  | { type: "agent"; text: string }
  | { type: "agent_stream"; text: string }
  | { type: "tool_start"; tool: string; summary: string }
  | { type: "tool_end"; tool: string; summary: string }
  | { type: "choices"; options: string[] }
  | { type: "guideline"; source: "company" | "default"; name: string }
  | { type: "preview"; content_type: "cv" | "cover_letter" | "plan"; content: string }
  | { type: "budget"; remaining: number; total: number }
  | { type: "error"; message: string };

export interface DisplayMessage {
  role: "user" | "agent" | "tool";
  text?: string;
  tool?: string;
  toolStatus?: "start" | "done";
  summary?: string;
  choices?: string[];
}

interface AgentState {
  workspaceId: string;
  jdText: string;
  tailoringPlan: string;
  companySummary: string;
  aiGuideline: string;
  aiGuidelineSource: "company" | "default";
  aiGuidelineName: string;
  pendingWorkflowId: string;
}

const SYSTEM_PROMPT_TEMPLATE = `You are a professional CV tailoring assistant. Guide the user through:
1. Building their knowledge base (CV, profiles, notes)
2. Providing a job description (upload or URL)
3. Researching the company and their AI usage policy
4. Analysing skill gaps
5. Creating a tailoring plan, generating the CV, and optionally a cover letter

To call a tool, output a fenced code block with language "tool" containing JSON — exactly one per response:
\`\`\`tool
{"name": "fetch_jd", "url": "https://..."}
\`\`\`
\`\`\`tool
{"name": "analyze_gaps"}
\`\`\`
\`\`\`tool
{"name": "search_company", "query": "company name or URL"}
\`\`\`
\`\`\`tool
{"name": "import_profile", "url": "https://github.com/username"}
\`\`\`
\`\`\`tool
{"name": "start_generation", "type": "create_tailoring_plan"}
\`\`\`
\`\`\`tool
{"name": "start_generation", "type": "generate_cv"}
\`\`\`
\`\`\`tool
{"name": "start_generation", "type": "generate_cover_letter", "tone": "direct and concise"}
\`\`\`

After a tool call you will receive the result and should continue.

To offer the user clickable choices at the end of your message, output a fenced code block with language "choices":
\`\`\`choices
["Option A", "Option B", "Option C"]
\`\`\`

Rules:
- The tool and choices code blocks are machine-read — output them literally, never translate or paraphrase them.
- Infer CV language from the JD language (German JD → German CV, English JD → English CV)
- When KB is empty, prompt for uploads or profile URLs
- After receiving a JD, proactively offer to search the company
- Keep responses concise and professional
- Never invent facts not in the knowledge base

{{AI_GUIDELINE}}

Current knowledge base:
{{KB_CONTENT}}`;

const GREETING = `Hello! I'm your CV tailoring assistant.

To get started:
1. Upload your CV or profile notes using the sidebar on the left
2. Or share your GitHub, LinkedIn, or Xing profile URL

Once your knowledge base is ready, I'll help you tailor your CV for any job.

\`\`\`choices
["Upload files now", "Share a profile URL", "I already have files — let's proceed"]
\`\`\``;

const GREETING_WITH_KB = (count: number) =>
  `Hello! I can see you have ${count} file${count !== 1 ? "s" : ""} in your knowledge base.

Please provide the job description you'd like to tailor your CV for.

\`\`\`choices
["Upload JD document", "Provide JD URL", "Paste the JD as text"]
\`\`\``;

export class CvAgent implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/workflow-done") {
      return this.handleWorkflowDone(request);
    }

    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocket(request);
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleWebSocket(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Extract workspaceId from path: /agents/cv-agent/{workspaceId}
    const parts = url.pathname.split("/").filter(Boolean);
    const workspaceId = parts[parts.length - 1] || "";

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.state.acceptWebSocket(server);

    // Store workspaceId if not already set
    const stored = await this.state.storage.get<string>("workspace_id");
    if (!stored && workspaceId) {
      await this.state.storage.put("workspace_id", workspaceId);
      try { await ensureWorkspace(this.env, workspaceId); } catch { /* ignore */ }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleWorkflowDone(request: Request): Promise<Response> {
    try {
      const body = await request.json() as { tool: WorkflowTool; result: string };
      const contentType = body.tool === "generate_cv" ? "cv"
        : body.tool === "generate_cover_letter" ? "cover_letter" : "plan";

      // Save plan to state if it's a tailoring plan
      if (body.tool === "create_tailoring_plan") {
        await this.state.storage.put("tailoring_plan", body.result);
      }

      await this.state.storage.put("pending_workflow_id", "");

      const preview: WsEvent = { type: "preview", content_type: contentType, content: body.result };
      const toolEnd: WsEvent = { type: "tool_end", tool: body.tool, summary: "Generation complete" };

      // Add agent message about completion
      const label = body.tool === "generate_cv" ? "CV" : body.tool === "generate_cover_letter" ? "cover letter" : "tailoring plan";
      const agentMsg: WsEvent = {
        type: "agent",
        text: `Your ${label} is ready! You can preview and download it above.\n\nWould you like anything else?`,
      };
      const choices: WsEvent = { type: "choices", options: ["Generate cover letter", "Refine the tailoring plan", "Start over"] };

      // Store completion message in display history
      const history = await this.getDisplayHistory();
      history.push({ role: "tool", tool: body.tool, toolStatus: "done", summary: "Generation complete" });
      history.push({ role: "agent", text: agentMsg.text, choices: (choices as { type: string; options: string[] }).options });
      await this.setDisplayHistory(history);

      for (const ws of this.state.getWebSockets()) {
        ws.send(JSON.stringify(toolEnd));
        ws.send(JSON.stringify(preview));
        ws.send(JSON.stringify(agentMsg));
        ws.send(JSON.stringify(choices));
        ws.send(JSON.stringify(await this.budgetEvent()));
      }
      return new Response("ok");
    } catch (err) {
      return new Response(String(err), { status: 500 });
    }
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const message = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    let data: Record<string, unknown>;
    try { data = JSON.parse(message) as Record<string, unknown>; } catch { return; }

    const type = String(data.type || "chat");

    try {
      if (type === "connect") {
        await this.handleConnect(ws);
      } else if (type === "reset") {
        await this.handleReset(ws);
      } else if (type === "chat") {
        await this.handleChat(ws, String(data.text || ""));
      } else if (type === "jd_upload") {
        await this.handleJdUpload(ws, String(data.text || ""), String(data.filename || "job.md"));
      } else if (type === "jd_url") {
        await this.handleChat(ws, `Please fetch the job description from this URL: ${data.url}`);
      }
    } catch (err) {
      this.send(ws, { type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  async webSocketClose(): Promise<void> { /* hibernation handles cleanup */ }
  async webSocketError(): Promise<void> { /* hibernation handles cleanup */ }

  private async handleConnect(ws: WebSocket): Promise<void> {
    const history = await this.getDisplayHistory();
    this.send(ws, { type: "history", messages: history });
    this.send(ws, await this.budgetEvent());

    if (history.length === 0) {
      await this.sendGreeting(ws);
    }
  }

  private async handleReset(ws: WebSocket): Promise<void> {
    await this.state.storage.put("display_history", "[]");
    await this.state.storage.put("ai_messages", "[]");
    await this.state.storage.put("jd_text", "");
    await this.state.storage.put("tailoring_plan", "");
    await this.state.storage.put("company_summary", "");
    await this.state.storage.put("pending_workflow_id", "");
    // Keep workspace_id, ai_guideline settings
    this.send(ws, { type: "history", messages: [] });
    await this.sendGreeting(ws);
  }

  private async sendGreeting(ws: WebSocket): Promise<void> {
    const workspaceId = await this.state.storage.get<string>("workspace_id") || "";
    let kbCount = 0;
    if (workspaceId) {
      try {
        const files = await getKnowledge(this.env, workspaceId);
        kbCount = files.length;
      } catch { /* ignore */ }
    }

    const greetingText = kbCount > 0 ? GREETING_WITH_KB(kbCount) : GREETING;
    const choices = this.parseChoices(greetingText);
    const text = this.stripMeta(greetingText);

    const display: DisplayMessage = { role: "agent", text, choices: choices || undefined };
    const history = [display];
    await this.setDisplayHistory(history);

    this.send(ws, { type: "agent", text });
    if (choices) this.send(ws, { type: "choices", options: choices });
  }

  private async handleJdUpload(ws: WebSocket, text: string, filename: string): Promise<void> {
    await this.state.storage.put("jd_text", text.slice(0, 80_000));
    const userMsg = `[Uploaded JD: ${filename}]\n\n${text.slice(0, 500)}…`;
    await this.handleChat(ws, userMsg, text);
  }

  private async handleChat(ws: WebSocket, userText: string, jdOverride?: string): Promise<void> {
    if (!userText.trim()) return;

    const budget = await checkTokenBudget(this.env);
    if (!budget.ok) {
      this.send(ws, { type: "error", message: "Daily token budget exceeded. Try again tomorrow." });
      return;
    }

    // Add user message to history
    const history = await this.getDisplayHistory();
    history.push({ role: "user", text: userText });
    await this.setDisplayHistory(history);

    // Add to AI messages
    const aiMessages = await this.getAiMessages();
    aiMessages.push({ role: "user", content: userText });

    // Run agentic loop (max 5 tool calls)
    await this.agenticLoop(ws, aiMessages, history);
  }

  private async agenticLoop(ws: WebSocket, aiMessages: AiMessage[], history: DisplayMessage[]): Promise<void> {
    for (let step = 0; step < 5; step++) {
      const workspaceId = await this.state.storage.get<string>("workspace_id") || "";
      const aiGuideline = await this.state.storage.get<string>("ai_guideline") || ANTHROPIC_GUIDELINE_SUMMARY;

      // Build KB content
      let kbContent = "[No knowledge base files uploaded yet]";
      if (workspaceId) {
        try {
          const files = await getKnowledge(this.env, workspaceId);
          kbContent = kbPrompt(files);
        } catch { /* ignore */ }
      }

      const systemPrompt = SYSTEM_PROMPT_TEMPLATE
        .replace("{{AI_GUIDELINE}}", aiGuideline ? `Active AI guideline:\n${aiGuideline}` : "")
        .replace("{{KB_CONTENT}}", kbContent.slice(0, 80_000));

      const messages = [{ role: "system" as const, content: systemPrompt }, ...aiMessages];

      // Call AI
      const result = (await this.env.AI.run(
        this.env.MODEL_NAME || "@cf/moonshotai/kimi-k2.6",
        { messages }
      )) as Record<string, unknown>;
      const usage = (result.usage as { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number }) || {};
      const tokens = usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
      if (tokens) await recordTokenUsage(this.env, tokens);

      const responseText = extractText(result).trim();

      // Parse for tool call
      const toolCall = this.parseToolCall(responseText);

      if (toolCall) {
        // Add assistant message (everything before the tool call) to AI history
        const textBeforeTool = this.stripToolCall(responseText).trim();
        if (textBeforeTool) {
          aiMessages.push({ role: "assistant", content: textBeforeTool });
          const cleanText = this.stripMeta(textBeforeTool);
          if (cleanText) {
            history.push({ role: "agent", text: cleanText });
            const wsMsg: WsEvent = { type: "agent", text: cleanText };
            for (const ws2 of this.state.getWebSockets()) this.send(ws2, wsMsg);
          }
        }

        // Execute the tool
        const toolResult = await this.executeTool(ws, toolCall.tool, toolCall.args, history);
        aiMessages.push({ role: "user", content: `Tool result for ${toolCall.tool}:\n${toolResult}` });
        await this.setAiMessages(aiMessages);
        continue;
      }

      // Final response — no tool call
      aiMessages.push({ role: "assistant", content: responseText });
      await this.setAiMessages(aiMessages);

      const choices = this.parseChoices(responseText);
      const cleanResponse = this.stripMeta(responseText);

      const displayMsg: DisplayMessage = { role: "agent", text: cleanResponse, choices: choices || undefined };
      history.push(displayMsg);
      await this.setDisplayHistory(history);

      for (const ws2 of this.state.getWebSockets()) {
        this.send(ws2, { type: "agent", text: cleanResponse } as WsEvent);
        if (choices) this.send(ws2, { type: "choices", options: choices } as WsEvent);
        this.send(ws2, await this.budgetEvent());
      }
      return;
    }

    // Max steps reached — send a fallback
    const fallback = "I've completed the available steps. What would you like to do next?";
    history.push({ role: "agent", text: fallback });
    await this.setDisplayHistory(history);
    for (const ws2 of this.state.getWebSockets()) {
      this.send(ws2, { type: "agent", text: fallback } as WsEvent);
    }
  }

  private async executeTool(
    ws: WebSocket,
    tool: string,
    args: Record<string, string>,
    history: DisplayMessage[]
  ): Promise<string> {
    const workspaceId = await this.state.storage.get<string>("workspace_id") || "";

    const startMsg: WsEvent = { type: "tool_start", tool, summary: `Running ${tool}…` };
    history.push({ role: "tool", tool, toolStatus: "start", summary: `Running ${tool}…` });
    for (const ws2 of this.state.getWebSockets()) this.send(ws2, startMsg);

    let result: string;
    try {
      if (tool === "fetch_jd") {
        const text = await fetchJdTool(args.url || "");
        await this.state.storage.put("jd_text", text);
        result = `Job description fetched (${text.length} chars). First 300 chars:\n${text.slice(0, 300)}`;

      } else if (tool === "analyze_gaps") {
        const jdText = await this.state.storage.get<string>("jd_text") || args.jdText || "";
        const files = workspaceId ? await getKnowledge(this.env, workspaceId) : [];
        const kbText = kbPrompt(files);
        result = await analyzeGapsTool(this.env, kbText, jdText);

      } else if (tool === "search_company") {
        const research = await searchCompanyTool(this.env, args.query || "");
        await this.state.storage.put("company_summary", research.companySummary);
        await this.state.storage.put("ai_guideline", research.aiGuideline);
        await this.state.storage.put("ai_guideline_source", research.aiGuidelineSource);
        await this.state.storage.put("ai_guideline_name", research.aiGuidelineName);

        const guidelineEvent: WsEvent = {
          type: "guideline",
          source: research.aiGuidelineSource,
          name: research.aiGuidelineName,
        };
        for (const ws2 of this.state.getWebSockets()) this.send(ws2, guidelineEvent);
        result = `Company research complete.\n\nSummary:\n${research.companySummary}\n\nAI guideline: ${research.aiGuidelineName} (${research.aiGuidelineSource})`;

      } else if (tool === "import_profile") {
        result = await importProfileTool(this.env, workspaceId, args.url || "");

      } else if (tool === "start_generation") {
        result = await this.startGeneration(args.type as WorkflowTool, args, history);

      } else {
        result = `Unknown tool: ${tool}`;
      }

      const endMsg: WsEvent = { type: "tool_end", tool, summary: result.split("\n")[0].slice(0, 80) };
      history.push({ role: "tool", tool, toolStatus: "done", summary: endMsg.summary });
      for (const ws2 of this.state.getWebSockets()) this.send(ws2, endMsg);
      return result;

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const endMsg: WsEvent = { type: "tool_end", tool, summary: `Error: ${errMsg}` };
      history.push({ role: "tool", tool, toolStatus: "done", summary: `Error: ${errMsg}` });
      for (const ws2 of this.state.getWebSockets()) this.send(ws2, endMsg);
      return `Error executing ${tool}: ${errMsg}`;
    }
  }

  private async startGeneration(toolType: WorkflowTool, args: Record<string, string>, history: DisplayMessage[]): Promise<string> {
    const workspaceId = await this.state.storage.get<string>("workspace_id") || "";
    const jdText = await this.state.storage.get<string>("jd_text") || "";
    const aiGuideline = await this.state.storage.get<string>("ai_guideline") || "";
    const companySummary = await this.state.storage.get<string>("company_summary") || "";
    const tailoringPlan = await this.state.storage.get<string>("tailoring_plan") || args.tailoringPlan || "";
    const doId = this.state.id.toString();
    const workflowId = randomId("wf");

    const instance = await this.env.CV_WORKFLOW.create({
      id: workflowId,
      params: {
        tool: toolType,
        workspaceId,
        doId,
        jdText,
        tailoringPlan,
        tone: args.tone || "direct and concise",
        aiGuideline,
        companySummary,
      },
    });

    await this.state.storage.put("pending_workflow_id", instance.id);
    return `Generation started (workflow ID: ${instance.id}). You'll receive the result shortly.`;
  }

  private send(ws: WebSocket, event: WsEvent): void {
    try { ws.send(JSON.stringify(event)); } catch { /* client disconnected */ }
  }

  private parseToolCall(text: string): { tool: string; args: Record<string, string> } | null {
    const m = text.match(/```tool\s*\n([\s\S]*?)\n```/);
    if (!m) return null;
    try {
      const obj = JSON.parse(m[1].trim()) as Record<string, string>;
      const tool = obj.name;
      if (!tool) return null;
      const { name: _name, ...args } = obj;
      return { tool, args };
    } catch { return null; }
  }

  private stripToolCall(text: string): string {
    return text.replace(/```tool\s*\n[\s\S]*?\n```/g, "").trim();
  }

  private parseChoices(text: string): string[] | null {
    const m = text.match(/```choices\s*\n([\s\S]*?)\n```/);
    if (!m) return null;
    try { return JSON.parse(m[1].trim()) as string[]; } catch { return null; }
  }

  private stripMeta(text: string): string {
    return text
      .replace(/```tool\s*\n[\s\S]*?\n```/g, "")
      .replace(/```choices\s*\n[\s\S]*?\n```/g, "")
      .trim();
  }

  private async getDisplayHistory(): Promise<DisplayMessage[]> {
    const raw = await this.state.storage.get<string>("display_history");
    if (!raw) return [];
    try { return JSON.parse(raw) as DisplayMessage[]; } catch { return []; }
  }

  private async setDisplayHistory(history: DisplayMessage[]): Promise<void> {
    // Trim to last 100 messages to stay under storage limits
    const trimmed = history.slice(-100);
    await this.state.storage.put("display_history", JSON.stringify(trimmed));
  }

  private async getAiMessages(): Promise<AiMessage[]> {
    const raw = await this.state.storage.get<string>("ai_messages");
    if (!raw) return [];
    try { return JSON.parse(raw) as AiMessage[]; } catch { return []; }
  }

  private async setAiMessages(messages: AiMessage[]): Promise<void> {
    // Keep last 40 messages for AI context (to avoid prompt overflow)
    const trimmed = messages.slice(-40);
    await this.state.storage.put("ai_messages", JSON.stringify(trimmed));
  }

  private async budgetEvent(): Promise<WsEvent> {
    const b = await checkTokenBudget(this.env);
    return { type: "budget", remaining: b.remaining, total: b.budget };
  }
}
