import { Env, getKnowledge, kbPrompt, recordTokenUsage } from "./shared";
import { generateTailoringPlan, generateCv, generateCoverLetter } from "./tools";

export type WorkflowTool = "create_tailoring_plan" | "generate_cv" | "generate_cover_letter";

export interface CvWorkflowParams {
  tool: WorkflowTool;
  workspaceId: string;
  doId: string;
  jdText: string;
  tailoringPlan?: string;
  tone?: string;
  aiGuideline?: string;
  companySummary?: string;
}

export class CvWorkflow extends WorkflowEntrypoint<Env, CvWorkflowParams> {
  async run(event: WorkflowEvent<CvWorkflowParams>, step: WorkflowStep): Promise<void> {
    const p = event.payload;

    const kbText = await step.do("load-context", async () => {
      const files = await getKnowledge(this.env, p.workspaceId);
      return kbPrompt(files);
    });

    const result = await step.do("ai-generate", { retries: { limit: 2, delay: "5 seconds" }, timeout: "4 minutes" }, async () => {
      const guideline = p.aiGuideline || "";
      if (p.tool === "create_tailoring_plan") {
        return generateTailoringPlan(this.env, kbText, p.jdText, guideline);
      }
      if (p.tool === "generate_cv") {
        return generateCv(this.env, kbText, p.jdText, p.tailoringPlan || "", guideline);
      }
      if (p.tool === "generate_cover_letter") {
        return generateCoverLetter(this.env, kbText, p.jdText, p.companySummary || "", p.tone || "direct and concise", guideline);
      }
      throw new Error(`Unknown tool: ${p.tool}`);
    });

    // Callback to the Durable Object via its fetch handler
    await step.do("notify-agent", { retries: { limit: 3, delay: "2 seconds" } }, async () => {
      const stub = this.env.CV_AGENT.get(this.env.CV_AGENT.idFromString(p.doId));
      const resp = await stub.fetch("https://internal/workflow-done", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: p.tool, result }),
      });
      if (!resp.ok) throw new Error(`Callback failed: ${resp.status}`);
    });
  }
}
