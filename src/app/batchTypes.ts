export interface BatchTool {
  schema: { parse: (value: unknown) => unknown };
  invoke: (args: unknown, context: unknown) => Promise<unknown>;
}
export interface BatchStep {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  select?: string[];
}
