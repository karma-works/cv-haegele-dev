interface AiBinding {
  run(model: string, input: unknown): Promise<unknown>;
}
