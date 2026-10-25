import { expect, it } from "vitest";
import { parseManagedCommandEnvironment } from "./managed-command-host.js";
import { lifecycleOf } from "./config-layers.js";
it("omission and explicit zero preserve the default configuration identity", () => {
  expect(parseManagedCommandEnvironment(undefined, undefined)).toBeUndefined();
  expect(parseManagedCommandEnvironment("0", "invalid")).toBeUndefined();
});
it("only an explicit valid opt-in supplies a finite immutable host budget", () => {
  expect(parseManagedCommandEnvironment("1", undefined)).toEqual({
    managedCommands: { enabled: true },
    limits: { maxDurationMs: 600000 },
  });
  expect(
    parseManagedCommandEnvironment("1", "1234")?.limits.maxDurationMs,
  ).toBe(1234);
  expect(lifecycleOf("managedCommands.enabled")).toBe("session_frozen");
});
it.each(["0", "-1", "Infinity", "NaN", "1.1", "3600001", "9007199254740992"])(
  "rejects invalid managed owner budget %s",
  (value) => {
    expect(() => parseManagedCommandEnvironment("1", value)).toThrow(
      "HARNESS_MANAGED_TURN_MS",
    );
  },
);
