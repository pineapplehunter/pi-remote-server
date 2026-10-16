// Test-only types for browser mocks; the gateway validates protocol in Go.
export type AgentMessage = { version: 1; session_id: string } & (
  | { type: "message.delta"; delta: string }
  | { type: "message.completed"; role: "user" | "assistant"; content: string }
  | { type: "activity.started"; activity: { kind: "tool"; tool_call_id: string; tool: string; args: any; args_omitted?: true } }
  | { type: "activity.completed"; activity: { kind: "tool"; tool_call_id: string; tool: string; is_error: boolean } }
  | { type: "error"; code: string; message: string }
  | { type: "session.updated"; reset?: boolean }
);
export interface Session {
  registration_id: string; session_id: string; host_id: string; cwd: string; name: string | null;
  pid: number; status: "idle" | "working" | null; connected_at: number; last_seen: number;
}
