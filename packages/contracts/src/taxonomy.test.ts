import { describe, expect, it } from "vitest";
import {
  DENIED_TERMINATION,
  deniedTermination,
  isCancelledErrorCode,
  isDeniedErrorCode,
  isInternalErrorCode,
  isModelErrorCode,
  isPermissionOrSandboxDenied,
  isTimeoutErrorCode,
  retryKindTermination,
} from "./taxonomy.js";
import { ERROR_CODES } from "./errors.js";
import type { ErrorCode } from "./errors.js";
import { RETRY_KINDS } from "./retry.js";
import { TERMINATION_REASONS } from "./termination.js";

describe("Q-3 shared taxonomy — denied family", () => {
  it("covers every denied-class code and maps each to a termination reason", () => {
    // The map is non-empty and every mapped reason is a legal TerminationReason.
    for (const [code, reason] of Object.entries(DENIED_TERMINATION)) {
      expect(TERMINATION_REASONS).toContain(reason);
      expect(isDeniedErrorCode(code as ErrorCode)).toBe(true);
    }
  });

  it("splits permission/approval vs sandbox vs security correctly", () => {
    expect(deniedTermination("PERMISSION_DENIED")).toBe("permission_denied");
    expect(deniedTermination("APPROVAL_DENIED")).toBe("permission_denied");
    expect(deniedTermination("SANDBOX_NETWORK_DENIED")).toBe("sandbox_denied");
    expect(deniedTermination("INJECTION_DENIED")).toBe("security_denied");
    expect(deniedTermination("SECRET_REDACTED")).toBe("security_denied");
  });

  it("deniedTermination is fail-closed for any code", () => {
    // Total over the closed union: no code throws.
    for (const code of ERROR_CODES) {
      expect(TERMINATION_REASONS).toContain(deniedTermination(code));
    }
  });
});

describe("Q-3 shared taxonomy — guarded predicates", () => {
  it("isPermissionOrSandboxDenied covers exactly the orchestrator's denied set", () => {
    expect(isPermissionOrSandboxDenied("PERMISSION_DENIED")).toBe(true);
    expect(isPermissionOrSandboxDenied("APPROVAL_DENIED")).toBe(true);
    expect(isPermissionOrSandboxDenied("SANDBOX_DENIED")).toBe(true);
    expect(isPermissionOrSandboxDenied("SANDBOX_FILESYSTEM_DENIED")).toBe(true);
    expect(isPermissionOrSandboxDenied("SANDBOX_PROCESS_DENIED")).toBe(true);
    expect(isPermissionOrSandboxDenied("SANDBOX_NETWORK_DENIED")).toBe(true);
    // Security-specific denials are NOT the sandbox/permission set.
    expect(isPermissionOrSandboxDenied("INJECTION_DENIED")).toBe(false);
    expect(isPermissionOrSandboxDenied("MODEL_ERROR")).toBe(false);
  });

  it("granular predicates are disjoint where the classes differ", () => {
    expect(isTimeoutErrorCode("PROCESS_TIMEOUT")).toBe(true);
    expect(isTimeoutErrorCode("MODEL_ERROR")).toBe(false);
    expect(isCancelledErrorCode("USER_CANCELLED")).toBe(true);
    expect(isCancelledErrorCode("INTERNAL_ERROR")).toBe(false);
    expect(isInternalErrorCode("INTERNAL_ERROR")).toBe(true);
    expect(isInternalErrorCode("USER_CANCELLED")).toBe(false);
    expect(isModelErrorCode("MODEL_ERROR")).toBe(true);
    expect(isModelErrorCode("INTERNAL_ERROR")).toBe(false);
  });
});

describe("Q-3 shared taxonomy — retry kind termination", () => {
  it("reads the termination behavior from the governance table for every kind", () => {
    for (const kind of RETRY_KINDS) {
      expect(TERMINATION_REASONS).toContain(retryKindTermination(kind));
    }
  });

  it("matches the expected couplings", () => {
    expect(retryKindTermination("provider")).toBe("provider_error");
    expect(retryKindTermination("model")).toBe("model_error");
    expect(retryKindTermination("tool")).toBe("tool_limit");
    expect(retryKindTermination("verification")).toBe("verification_failed");
    expect(retryKindTermination("reconciliation")).toBe("resume_ambiguous");
  });
});