export const GRANT_BOUNDS = [
    "one_call",
    "one_tool",
    "session",
];
/** A grant that is still alive at `now` (not past its hard expiry). */
export function isGrantExpired(grant, now) {
    return now >= grant.expiresAt;
}
/** Milliseconds until the hard expiry; 0 once expired. */
export function grantRemainingMs(grant, now) {
    return Math.max(0, grant.expiresAt - now);
}
/**
 * Consume one usage of a bounded grant and return the updated grant, or
 * `undefined` when the grant is already exhausted/expired. Pure: it does NOT
 * mutate the input, the caller persists the returned value.
 *
 * A grant with `remainingUses === undefined` (session bound) is not usage
 * capped — it is returned unchanged until `expiresAt`.
 */
export function consumePermissionGrantUsage(grant, now) {
    if (isGrantExpired(grant, now))
        return undefined;
    if (grant.remainingUses === undefined)
        return grant;
    const remaining = grant.remainingUses - 1;
    if (remaining <= 0)
        return undefined;
    return { ...grant, remainingUses: remaining };
}
//# sourceMappingURL=permission-expiry.js.map