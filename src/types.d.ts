// WorkflowEntrypoint, WorkflowEvent, WorkflowStep are globally available in the
// Cloudflare Workers runtime (like DurableObject). Only NonRetryableError is
// actually exported from the cloudflare:workflows module at runtime, so we
// declare these as global ambient types instead of augmenting the module.

declare type WorkflowEvent<T> = {
  payload: Readonly<T>;
  timestamp: Date;
  instanceId: string;
};

declare type WorkflowStepConfig = {
  retries?: {
    limit: number;
    delay?: string | number;
    backoff?: "constant" | "linear" | "exponential";
  };
  timeout?: string | number;
};

declare abstract class WorkflowStep {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  do<T>(name: string, config: WorkflowStepConfig, callback: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: string | number): Promise<void>;
}

declare abstract class WorkflowEntrypoint<Env = unknown, T = unknown> {
  protected readonly env: Env;
  protected readonly ctx: ExecutionContext;
  abstract run(event: WorkflowEvent<T>, step: WorkflowStep): Promise<unknown>;
}
