// Augment cloudflare:workflows to re-export Workflow classes
// (they exist in the CloudflareWorkersModule global namespace and are importable at runtime
// but the workers-types package only declares NonRetryableError in this module)
declare module "cloudflare:workflows" {
  export type WorkflowEvent<T> = {
    payload: Readonly<T>;
    timestamp: Date;
    instanceId: string;
  };
  export type WorkflowStepConfig = {
    retries?: {
      limit: number;
      delay?: string | number;
      backoff?: "constant" | "linear" | "exponential";
    };
    timeout?: string | number;
  };
  export abstract class WorkflowStep {
    do<T>(name: string, callback: () => Promise<T>): Promise<T>;
    do<T>(name: string, config: WorkflowStepConfig, callback: () => Promise<T>): Promise<T>;
    sleep(name: string, duration: string | number): Promise<void>;
  }
  export abstract class WorkflowEntrypoint<Env = unknown, T = unknown> {
    protected readonly env: Env;
    protected readonly ctx: ExecutionContext;
    abstract run(event: WorkflowEvent<T>, step: WorkflowStep): Promise<unknown>;
  }
}
