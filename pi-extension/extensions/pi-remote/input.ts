import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProtocolError } from "./protocol.ts";

/** Short-lived session-local bridge across retry/compaction gaps, never an offline event queue. */
export class RemoteInput {
  private pending: string[] = [];
  private pendingBytes = 0;

  constructor(
    private readonly pi: Pick<ExtensionAPI, "sendUserMessage">,
    private readonly isStreaming: () => boolean,
    private readonly onError: (error: ProtocolError) => void,
  ) {}

  receive(text: string, busy: boolean): void {
    // Between agent_end and agent_settled, Pi can be recovering/compacting rather than
    // streaming. Its user-message API cannot queue during compaction: defer to the
    // next actual stream or settlement instead of interrupting recovery or losing input.
    if ((busy && !this.isStreaming()) || this.pending.length > 0) {
      if (this.pending.length >= 32 || this.pendingBytes + Buffer.byteLength(text) > 1024 * 1024) {
        this.onError({ code: "injection_failed", message: "Remote follow-up queue is full." });
        return;
      }
      this.pending.push(text);
      this.pendingBytes += Buffer.byteLength(text);
      return;
    }
    this.deliver(text);
  }

  agentStarted(): void {
    if (!this.isStreaming()) return;
    for (const text of this.pending.splice(0)) this.deliver(text);
    this.pendingBytes = 0;
  }

  agentSettled(): void {
    // Submit one normal user turn; agentStarted queues the rest with Pi's followUp API.
    const text = this.pending.shift();
    if (text !== undefined) {
      this.pendingBytes -= Buffer.byteLength(text);
      this.deliver(text);
    }
  }

  clear(): void { this.pending = []; this.pendingBytes = 0; }

  private deliver(text: string): void {
    try {
      // Safe even when idle: Pi starts a normal turn. Also covers local-input races.
      this.pi.sendUserMessage(text, { deliverAs: "followUp", expandPromptTemplates: false });
    } catch {
      this.onError({ code: "injection_failed", message: "Pi could not accept the user message." });
    }
  }
}
