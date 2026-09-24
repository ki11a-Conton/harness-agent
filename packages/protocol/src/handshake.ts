/**
 * P29-2 — initialize handshake state machine.
 *
 * The server must be initialized exactly once per connection:
 *   - any mutating request before `initialize` → NOT_INITIALIZED;
 *   - a repeated `initialize` → ALREADY_INITIALIZED.
 *
 * This type is the pure decision authority; the transport wraps it with the
 * actual request dispatch.
 */
import { ProtocolError } from "./errors.js";
import { PROTOCOL_VERSION, type InitializeServer, type ProtocolClientInfo, type ProtocolServerInfo } from "./types.js";

export type HandshakeState = "new" | "initialized";

export interface InitializeInput {
  clientInfo: ProtocolClientInfo;
  capabilities?: {
    streamingItems?: boolean;
    approvalForms?: boolean;
  };
}

export class InitializeGate {
  private state: HandshakeState = "new";

  /** Process an `initialize` call. Throws ALREADY_INITIALIZED on retry. */
  initialize(input: InitializeInput, serverInfo: ProtocolServerInfo): InitializeServer {
    if (this.state === "initialized") throw ProtocolError.alreadyInitialized();
    this.state = "initialized";
    return {
      protocolVersion: PROTOCOL_VERSION,
      serverInfo,
      capabilities: {
        streamingItems: input.capabilities?.streamingItems ?? false,
        approvalForms: input.capabilities?.approvalForms ?? false,
      },
    };
  }

  /** Enforce initialization before every non-initialize mutating request. */
  requireInitialized(): void {
    if (this.state !== "initialized") throw ProtocolError.notInitialized();
  }

  isInitialized(): boolean {
    return this.state === "initialized";
  }
}