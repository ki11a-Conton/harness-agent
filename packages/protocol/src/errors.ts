/** P29-7 — bounded-queue protocol errors. */
export type ProtocolErrorCode =
  | "NOT_INITIALIZED"
  | "ALREADY_INITIALIZED"
  | "SERVER_OVERLOADED"
  | "INVALID_REQUEST"
  | "METHOD_NOT_FOUND"
  | "NOT_IMPLEMENTED"
  | "INTERNAL_ERROR";

export interface ProtocolErrorInfo {
  code: ProtocolErrorCode;
  message: string;
  /** True when the client may retry the identical request (e.g. overload). */
  retryable: boolean;
  data?: unknown;
}

/** Typed protocol error (P29-7): a retryable typed error indicates the server
 *  rejected the request without consuming work — the client may retry. */
export class ProtocolError extends Error {
  readonly info: ProtocolErrorInfo;
  constructor(info: ProtocolErrorInfo) {
    super(info.message);
    this.name = "ProtocolError";
    this.info = info;
  }

  static notInitialized(): ProtocolError {
    return new ProtocolError({
      code: "NOT_INITIALIZED",
      message: "server is not initialized; call initialize first",
      retryable: false,
    });
  }

  static alreadyInitialized(): ProtocolError {
    return new ProtocolError({
      code: "ALREADY_INITIALIZED",
      message: "server is already initialized",
      retryable: false,
    });
  }

  static overloaded(detail?: string): ProtocolError {
    return new ProtocolError({
      code: "SERVER_OVERLOADED",
      message: detail ?? "server is saturated; retry later",
      retryable: true,
    });
  }

  static invalid(message: string): ProtocolError {
    return new ProtocolError({ code: "INVALID_REQUEST", message, retryable: false });
  }
}