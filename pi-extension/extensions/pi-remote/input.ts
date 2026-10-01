import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DeliveryMode, ProtocolError } from "./protocol.ts";

/** Short-lived session-local bridge across retry/compaction gaps, never an offline event queue. */
export class RemoteInput {
  private pending: { text: string; delivery: DeliveryMode }[] = [];
  private pendingBytes = 0;

  constructor(
    private readonly pi: Pick<ExtensionAPI, "sendUserMessage">,
    private readonly isStreaming: () => boolean,
    private readonly onError: (error: ProtocolError) => void,
  ) {}

  receive(text: string, busy: boolean, delivery: DeliveryMode = "followUp"): void {
    // Between agent_end and agent_settled, Pi can be recovering/compacting rather than
    // streaming. Its user-message API cannot queue during compaction: defer to the
    // next actual stream or settlement instead of interrupting recovery or losing input.
    if ((busy && !this.isStreaming()) || this.pending.length > 0) {
      if (this.pending.length >= 32 || this.pendingBytes + Buffer.byteLength(text) > 1024 * 1024) {
        this.onError({ code: "injection_failed", message: "Remote input queue is full." });
        return;
      }
      this.pending.push({ text, delivery });
      this.pendingBytes += Buffer.byteLength(text);
      return;
    }
    this.deliver(text, delivery);
  }

  agentStarted(): void {
    if (!this.isStreaming()) return;
    for (const item of this.pending.splice(0)) this.deliver(item.text, item.delivery);
    this.pendingBytes = 0;
  }

  agentSettled(): void {
    // Submit one normal user turn; agentStarted queues the rest with their selected modes.
    const item = this.pending.shift();
    if (item !== undefined) {
      this.pendingBytes -= Buffer.byteLength(item.text);
      this.deliver(item.text, item.delivery);
    }
  }

  clear(): void { this.pending = []; this.pendingBytes = 0; }

  private deliver(text: string, delivery: DeliveryMode): void {
    try {
      // Safe even when idle: Pi starts a normal turn. Also covers local-input races.
      this.pi.sendUserMessage(text, { deliverAs: delivery, expandPromptTemplates: false });
    } catch {
      this.onError({ code: "injection_failed", message: "Pi could not accept the user message." });
    }
  }
}
