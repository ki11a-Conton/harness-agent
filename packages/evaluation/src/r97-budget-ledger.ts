/**
 * E4-R97 — the campaign-wide model-call budget ledger.
 *
 * Plan §R97 怎么做 (line 216-217) requires the global budget to be shared
 * "跨两臂、跨进程、跨恢复" (across both arms, across processes, across recovery):
 * reserved BEFORE the call, consumed recorded after it, and consumption plus
 * unknown reservations preserved after a crash — never re-granted 320 calls to
 * each subprocess. Logical model calls and physical transport retries are
 * recorded separately, and the unknown bill is named rather than assumed to be
 * zero.
 *
 * This module is the ledger. It is deliberately file-backed with an exclusive
 * lock rather than in-memory, because an in-process counter cannot be shared by
 * the two arm subprocesses that plan §R97 line 216 describes.
 */

import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

export const R97_LEDGER_SCHEMA = "e4-r97-budget-ledger-v1";

/**
 * The separator used by `campaignIdOf`. A character that cannot appear in a hex
 * plan digest or in a decimal integer, so no two different `(digest, grant)`
 * pairs can be made to hash the same string by shifting a boundary.
 */
const CAMPAIGN_ID_SEPARATOR = "\u0000";


/**
 * Named failure codes. Plan §R98 怎么做 requires a resumed campaign whose durable
 * state is missing/corrupt/foreign to FAIL CLOSED rather than silently re-grant
 * the allowance, so the reason is a stable code a caller can assert on.
 */
export const R97_BUDGET_STATE_MISSING = "BUDGET_STATE_MISSING";
export const R97_BUDGET_STATE_CORRUPT = "BUDGET_STATE_CORRUPT";
export const R97_BUDGET_STATE_MISMATCH = "BUDGET_STATE_MISMATCH";
export const R97_LOCK_HELD = "BUDGET_LOCK_HELD";

/**
 * Plan §A2 怎么验收: "claims 文件损坏/不可读/写入失败均拒绝执行，且错误可诊断."
 *
 * These are deliberately NOT folded into "the anchor is absent". An anchor that
 * exists but cannot be read is not evidence that the authorization is
 * unclaimed — reading it that way is exactly how a damaged anchor becomes a
 * licence to mint a second full allowance. Only ENOENT means "never claimed".
 */
export const R97_CAMPAIGN_CLAIM_CORRUPT = "CAMPAIGN_CLAIM_CORRUPT";
export const R97_CAMPAIGN_CLAIM_UNREADABLE = "CAMPAIGN_CLAIM_UNREADABLE";
export const R97_CAMPAIGN_CLAIM_WRITE_FAILED = "CAMPAIGN_CLAIM_WRITE_FAILED";

/**
 * The claim anchor's OWN lock could not be acquired, so its read-modify-write
 * was refused rather than performed unserialized.
 *
 * WHY THIS IS A REFUSAL AND NOT A WARNING: the anchor is what decides whether an
 * approval may establish a budget. Two processes that write it without
 * serialization can each observe "not yet established" and each mint a full
 * allowance for ONE approval — the double-spend this whole module exists to
 * prevent. An availability failure (a leftover lock file) must therefore never be
 * converted into a correctness failure.
 */
export const R97_CAMPAIGN_CLAIM_LOCK_HELD = "CAMPAIGN_CLAIM_LOCK_HELD";

/**
 * Plan §A2 / finding F2 — the approval ESTABLISHED a budget somewhere, and that
 * campaign is no longer readable. A deleted root is a LOSS of the consumed
 * record, never a fresh allowance.
 */
export const R97_CAMPAIGN_STATE_LOST = "CAMPAIGN_STATE_LOST";

/** The ledger file name inside the campaign output directory. */
export const R97_LEDGER_FILENAME = "budget-ledger.json";
/** The exclusive lock guarding one read-modify-write of the ledger. */
export const R97_LEDGER_LOCK_FILENAME = "budget-ledger.lock";

/**
 * Derive the PERSISTED campaign identity of one AUTHORIZATION.
 *
 * Plan §R98 怎么做 (line 121): "campaign 初始化与 resume 用明确模式或持久 header
 * 区分；命令行换 ledgerDir/outDir 不得静默启动同一授权的另一个空预算."
 *
 * MEASURED DEFECT this closes: the ledger used to be identified only by
 * `(directory, planDigest, campaignModelCalls)`. Since the directory was part of
 * the identity, pointing `--ledger`/`--out` at a fresh directory started a
 * brand-new EMPTY budget for the SAME approved plan — one authorization spent
 * twice, with nothing on disk recording it.
 *
 * The identity is therefore derived from the AUTHORIZATION ALONE and persisted
 * INSIDE the ledger file, so it travels with the budget instead of being implied
 * by where the file happens to sit.
 *
 * Inputs (deliberately exactly two, and both of them part of the grant):
 *   - `planDigest`         — WHICH plan is approved.
 *   - `campaignModelCalls` — HOW MANY logical calls that approval covers.
 * Both are included because a re-approval with a different cap is a different
 * authorization: adopting the old directory's spend against a new cap would
 * either over- or under-grant.
 *
 * The derivation is PURE and total: same inputs -> same id, in this process and
 * in any other (no clock, no randomness, no path, no hostname). That is what
 * makes it usable as a persisted comparison value.
 *
 * NOT a security primitive: this is a deterministic identifier, not a MAC. An
 * operator with full control of the filesystem can forge it — the plan's stated
 * guarantee is local recovery integrity, not defence against an operator who
 * deletes all evidence.
 */
export function campaignIdOf(planDigest: string, campaignModelCalls: number): string {
  return createHash("sha256")
    .update("e4-r97-campaign-id-v1")
    .update(CAMPAIGN_ID_SEPARATOR)
    .update(planDigest)
    .update(CAMPAIGN_ID_SEPARATOR)
    .update(String(campaignModelCalls))
    .digest("hex");
}

/**
 * Environment override for the directory holding the per-authorization CLAIM
 * records. Tests point it at a scratch directory so they never touch (or depend
 * on) machine-level state.
 */
export const R97_CAMPAIGN_CLAIMS_DIR_ENV = "R97_CAMPAIGN_CLAIMS_DIR";

/** One durable record of "this authorization was claimed for a campaign here". */
export interface R97CampaignClaim {
  campaignId: string;
  /** Absolute, normalised ledger directory that claimed the authorization. */
  dir: string;
  /** Every directory that has claimed it, oldest first. More than one entry is
   *  the double-spend signal this file exists to make DETECTABLE. */
  claimedDirs: string[];
  /**
   * The subset of `claimedDirs` that went on to CREATE a budget — i.e. that this
   * approval actually spent (or could spend) calls in.
   *
   * WHY THIS FIELD EXISTS (finding F2). `claimedDirs` alone cannot tell "this
   * directory was probed once and produced nothing" from "this directory ran the
   * campaign and was then deleted". The old rule treated BOTH as stale and let
   * the same approval start a second full budget — one `rm -rf` away from
   * double-spend. An entry here is a durable fact that the approval has been
   * ESTABLISHED, so the directory's later disappearance is a LOSS of the
   * consumption record rather than evidence that nothing was ever spent.
   *
   * A directory that is only in `claimedDirs` is still safely ignorable, which is
   * what keeps a failed first run from wedging the authorization forever.
   */
  establishedDirs: string[];
  firstClaimedAt: number;
}

/** Plan §R98 怎么做 (line 121): moving `--ledger`/`--out` must not SILENTLY start
 *  another empty budget for the same authorization. Reported (not thrown) when a
 *  NEW directory claims an authorization another directory already claimed. */
export const R97_DUPLICATE_CAMPAIGN_DIR = "BUDGET_CAMPAIGN_DIR_DUPLICATE";

/**
 * Where per-authorization claim records live.
 *
 * WHY THIS EXISTS — the honest limitation. The ledger itself is
 * directory-local: a fresh directory B has, by construction, no way to observe
 * a ledger sitting in A. A directory-local file therefore CANNOT, on its own,
 * notice that the same authorization is being re-run somewhere else. The plan
 * asks that this not happen SILENTLY, and Line 121 explicitly scopes the
 * guarantee to "本地恢复完整性" (local recovery integrity) rather than defence
 * against an operator who deletes all evidence.
 *
 * So instead of pretending a refusal is possible, every open RECORDS the claim
 * for its `campaignId` in a small anchor outside any single campaign directory.
 * A second directory claiming the same `campaignId` is then a durable,
 * inspectable fact — `readR97CampaignClaim` returns both directories — and
 * `first-run` reports it loudly (R97_DUPLICATE_CAMPAIGN_DIR) instead of
 * silently minting a second full allowance.
 *
 * The anchor is intentionally NOT authoritative and never blocks a legitimate
 * first run: it is advisory evidence, so a missing or unwritable anchor
 * degrades to "no evidence" rather than to a hard failure that could wedge CI.
 */
function campaignClaimsDir(): string {
  const override = process.env[R97_CAMPAIGN_CLAIMS_DIR_ENV];
  if (typeof override === "string" && override !== "") return override;
  return join(tmpdir(), "e4-r97-campaign-claims");
}

function claimPathFor(campaignId: string): string {
  // The id is a hex digest, so it is already filesystem-safe; the prefix keeps
  // the files recognisable to an operator browsing the anchor directory.
  return join(campaignClaimsDir(), `claim-${campaignId}.json`);
}

/** Read a claim record without creating one. `null` = never claimed here.
 *
 *  ABSENT and DAMAGED are deliberately different outcomes (plan §A2 怎么验收:
 *  "claims 文件损坏/不可读/写入失败均拒绝执行，且错误可诊断"). An anchor that exists
 *  but cannot be read is NOT evidence that the authorization is unclaimed —
 *  reading it that way is precisely how a damaged anchor becomes a licence to
 *  mint a second allowance. Only ENOENT degrades to `null`. */
export async function readR97CampaignClaim(campaignId: string): Promise<R97CampaignClaim | null> {
  let text: string;
  try {
    text = await readFile(claimPathFor(campaignId), "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw new Error(
      `E4-R97: ${R97_CAMPAIGN_CLAIM_UNREADABLE}: the claim anchor for campaign ${campaignId} exists but could not be read (${err instanceof Error ? err.message : String(err)}) — an unreadable anchor is not evidence that this approval is unclaimed`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(
      `E4-R97: ${R97_CAMPAIGN_CLAIM_CORRUPT}: the claim anchor for campaign ${campaignId} is not valid JSON — refusing to guess whether this approval was already claimed`,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`E4-R97: ${R97_CAMPAIGN_CLAIM_CORRUPT}: the claim anchor for campaign ${campaignId} is not a JSON object`);
  }
  const o = raw as Record<string, unknown>;
  const dir = o["dir"];
  const dirs = o["claimedDirs"];
  if (typeof dir !== "string" || dir === "") {
    throw new Error(`E4-R97: ${R97_CAMPAIGN_CLAIM_CORRUPT}: the claim anchor for campaign ${campaignId} names no directory`);
  }
  const claimedDirs = Array.isArray(dirs) ? dirs.filter((d): d is string => typeof d === "string") : [dir];
  if (claimedDirs.length === 0) claimedDirs.push(dir);
  const established = o["establishedDirs"];
  return {
    campaignId,
    dir,
    claimedDirs,
    // FAIL CLOSED ON A LEGACY ANCHOR. An anchor written before `establishedDirs`
    // existed carries no evidence either way; reading its directories as "never
    // established" would re-open the very hole this field closes, so an absent
    // list is read as "every claimed directory may have been established".
    establishedDirs: Array.isArray(established)
      ? established.filter((d): d is string => typeof d === "string")
      : [...claimedDirs],
    firstClaimedAt: typeof o["firstClaimedAt"] === "number" ? o["firstClaimedAt"] : 0,
  };
}

/**
 * Atomically replace the claim anchor: write a UNIQUE temp file in the SAME
 * directory, then `rename` it over the anchor path.
 *
 * FINDING F1 (plan §N1). The previous version called
 * `writeFile(claimPathFor(campaignId), …)`, which TRUNCATES the anchor in place
 * and then streams the new bytes into it. The anchor is read on PURPOSE outside
 * this lock — `openR97Campaign` consults it (§5) before any budget is opened, and
 * `readR97CampaignClaim` is a public inspection API — so a concurrent reader could
 * observe an EMPTY or HALF-WRITTEN file and be refused with
 * `CAMPAIGN_CLAIM_CORRUPT` even though the authorization was perfectly intact.
 * Measured on the unfixed source with a real reader/writer process pair: 345 of
 * 1053 reads came back CORRUPT. Rename is atomic (POSIX `rename(2)`; Windows
 * `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`), so a reader now sees either the
 * COMPLETE previous version or the COMPLETE new one and never a torn one. The temp
 * name is unique per call, so two writers cannot share it, and it lives in the SAME
 * directory, so the rename can never cross a filesystem boundary (where it would
 * degrade to a copy and lose atomicity).
 *
 * IN-PROGRESS VERSIONS DO NOT BECOME AUTHORITATIVE. A reader only ever opens
 * `claimPathFor(...)`; a temp file is invisible to it, so an interrupted write
 * leaves the PREVIOUS complete anchor in place — never half of the new one. Every
 * failure here is a NAMED refusal (`CAMPAIGN_CLAIM_WRITE_FAILED`), so a claim that
 * cannot be made durable never degrades into "this approval was free".
 *
 * DURABILITY BOUNDARY (matches `writeLedgerAtomic`): the rename makes a complete
 * version VISIBLE atomically, but is not followed by an `fsync` of the file or its
 * directory, so a host power loss can still lose the most recent rename. That is the
 * same boundary the ledger's own atomic write draws; stating it here keeps it
 * explicit rather than implied.
 */
async function writeClaimAtomic(campaignId: string, next: R97CampaignClaim): Promise<void> {
  const target = claimPathFor(campaignId);
  const tmp = `${target}.tmp-${process.pid}-${newLockToken()}`;
  try {
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(tmp, target);
  } catch (err) {
    // Clean up ONLY our own unique temp file. The committed anchor at `target` is
    // never touched on this path, so a failed write cannot destroy the last good
    // version — which is what keeps an interrupted write from becoming a loss.
    // A cleanup failure is REPORTED through the `[degraded]` channel rather than
    // swallowed: a leftover temp file is invisible to every reader (only
    // `claimPathFor(...)` is ever opened), but it is still a fact worth stating.
    try {
      await rm(tmp, { force: true });
    } catch (cleanupErr) {
      process.stderr.write(
        `[degraded] r97-budget-ledger.claim-tmp-cleanup: could not remove ${tmp}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}\n`,
      );
    }
    throw new Error(
      `E4-R97: ${R97_CAMPAIGN_CLAIM_WRITE_FAILED}: the claim anchor for campaign ${campaignId} could not be written (${err instanceof Error ? err.message : String(err)}) — refusing to start a budget whose single-use record cannot be made durable`,
    );
  }
}

/** Read + write the claim anchor under its own lock. `mutate` sees the record as
 *  it is on disk (or `null`) and returns the next one. */
async function withClaimLock<T>(
  campaignId: string,
  now: () => number,
  isAlive: (pid: number) => boolean,
  mutate: (previous: R97CampaignClaim | null) => Promise<{ next: R97CampaignClaim | null; result: T }> | { next: R97CampaignClaim | null; result: T },
): Promise<T> {
  let lockPath: string;
  try {
    await mkdir(campaignClaimsDir(), { recursive: true });
    lockPath = `${claimPathFor(campaignId)}.lock`;
  } catch (err) {
    throw new Error(
      `E4-R97: ${R97_CAMPAIGN_CLAIM_WRITE_FAILED}: the claim anchor directory for campaign ${campaignId} could not be created (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  // A lock that cannot be acquired is a REFUSAL, never a silent unlocked write:
  // proceeding here is what let two processes both observe "not established" and
  // each mint a full allowance for one approval.
  const { token } = await acquireClaimLock(lockPath, now, isAlive);
  try {
    const previous = await readR97CampaignClaim(campaignId);
    const { next, result } = await mutate(previous);
    if (next !== null) {
      // FINDING F1: this used to be an in-place `writeFile` over the anchor, which
      // truncates it before the new bytes land. See `writeClaimAtomic`.
      await writeClaimAtomic(campaignId, next);
    }
    return result;
  } finally {
    // Release ONLY a lock we still own. The previous version removed the path
    // unconditionally, so a process that had timed out (and was therefore writing
    // without the lock) deleted the REAL owner's lock on its way out — turning one
    // process's contention into another process's unserialized write.
    await releaseClaimLock(lockPath, token).catch((cleanupErr) => {
      // P14-6: best-effort cleanup failures must be OBSERVABLE, never swallowed.
      process.stderr.write(
        `[degraded] r97-budget-ledger.claim-lock-cleanup: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}\n`,
      );
    });
  }
}

/**
 * Record that `dir` claims `campaignId`, and report what was already recorded.
 *
 * Returns the claim as it was BEFORE this call, so a caller can tell a genuine
 * first claim from a duplicate one.
 *
 * This NO LONGER swallows I/O trouble (plan §A2 怎么验收: "写入失败均拒绝执行"). An
 * earlier version degraded to "no evidence" here, which made an unwritable anchor
 * indistinguishable from an unclaimed authorization — and a failure to RECORD a
 * claim is exactly the moment a second allowance would go unnoticed.
 */
async function recordCampaignClaim(campaignId: string, dir: string, now: () => number, isAlive: (pid: number) => boolean): Promise<R97CampaignClaim | null> {
  return withClaimLock(campaignId, now, isAlive, (previous) => {
    const claimedDirs = previous === null ? [] : [...previous.claimedDirs];
    if (!claimedDirs.includes(dir)) claimedDirs.push(dir);
    const next: R97CampaignClaim = {
      campaignId,
      dir,
      claimedDirs,
      establishedDirs: previous === null ? [] : [...previous.establishedDirs],
      firstClaimedAt: previous?.firstClaimedAt ?? now(),
    };
    return { next, result: previous };
  });
}

/**
 * Mark `dir` as having ESTABLISHED a budget for `campaignId` (finding F2).
 *
 * Called at the one moment a budget actually comes into existence, so the anchor
 * records "this approval has been spent from here" durably. Later, if that
 * directory is deleted, the anchor still says the approval was established — and
 * a missing root becomes a LOSS instead of a fresh allowance.
 */
export async function markR97CampaignClaimEstablished(
  campaignId: string,
  dir: string,
  now: () => number = () => Date.now(),
  isAlive: (pid: number) => boolean = defaultIsAlive,
): Promise<void> {
  await withClaimLock(campaignId, now, isAlive, (previous) => {
    if (previous === null) return { next: null, result: undefined };
    const claimedDirs = [...previous.claimedDirs];
    if (!claimedDirs.includes(dir)) claimedDirs.push(dir);
    const establishedDirs = [...previous.establishedDirs];
    if (!establishedDirs.includes(dir)) establishedDirs.push(dir);
    const next: R97CampaignClaim = {
      campaignId,
      dir: previous.dir,
      claimedDirs,
      establishedDirs,
      firstClaimedAt: previous.firstClaimedAt,
    };
    return { next, result: undefined };
  });
}

/**
 * The claim anchor's lock.
 *
 * ---- FINDING (independent verifier probe P16/P17, plan §A2 怎么验收 4) --------
 *
 * The previous version wrote a BARE TOKEN, had no staleness recovery, and — the
 * fatal part — returned `{token: ""}` when it timed out, after which
 * `withClaimLock` performed its read-modify-write ANYWAY and its `finally`
 * deleted a lock file it had never owned. A single leftover lock file from a
 * crashed process therefore disabled the anchor's mutual exclusion entirely:
 * two processes released by a real barrier each observed "not established" and
 * each minted a FULL budget for one approval.
 *
 * This now follows the SAME contract as the ledger's own lock (see
 * `acquireLock`): an owner record with a token and pid, takeover ONLY when the
 * owner is provably dead, and a NAMED REFUSAL on timeout instead of an unlocked
 * write. Plan §R98 怎么做: "锁采用 owner token + 进程存活判断；年龄只能作为检查线索。
 * 活 owner 超时返回占用错误，不能删锁."
 *
 * AGE IS USED FOR EXACTLY ONE CASE, and it is not a live owner: a lock whose
 * content cannot be parsed at all (the legacy bare-token form, or garbage) names
 * no owner to check, so an old one is treated as debris from a crashed writer and
 * taken over. A lock whose owner record IS parseable is never taken over on age —
 * only when its pid is provably gone.
 *
 * THE BOUND IS DELIBERATELY SHORTER THAN THE ACQUIRE DEADLINE. If debris were
 * only reclaimable after `DEFAULT_LOCK_TIMEOUT_MS`, the very first acquisition
 * would always give up before the takeover could happen, so a single leftover
 * file would refuse every attempt — converting a crash into a permanent outage.
 * Every writer of the CURRENT format leaves a parseable record, and the legacy
 * writer's critical section was a single write, so 5s is far longer than any
 * holder whose record we cannot read could legitimately need.
 */
const CLAIM_LOCK_STALE_MS = 5_000;

async function acquireClaimLock(lockPath: string, now: () => number, isAlive: (pid: number) => boolean): Promise<{ token: string }> {
  const deadline = now() + DEFAULT_LOCK_TIMEOUT_MS;
  for (;;) {
    const token = newLockToken();
    try {
      const fh = await open(lockPath, "wx");
      try {
        const record: R97LockRecord = { token, pid: process.pid, host: hostname(), acquiredAt: now() };
        await fh.writeFile(JSON.stringify(record), "utf8");
      } finally {
        await fh.close();
      }
      return { token };
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") throw err;
    }

    // The lock exists. Decide whether its owner is still alive.
    let holder: R97LockRecord | null = null;
    let age = 0;
    try {
      const [text, st] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]);
      holder = parseLockRecord(text);
      age = Math.max(0, now() - st.mtimeMs);
    } catch {
      // The holder released it between our open() and this read: retry at once.
      continue;
    }

    // A provably dead owner — the crash this exists to survive. Age is NOT
    // required: a fast crash must not deadlock the campaign.
    const ownerGone = holder !== null && holder.token !== "" && !isAlive(holder.pid);
    // An UNPARSEABLE lock names no owner, so there is no liveness to check. Only
    // an old one is debris; a fresh one is conservatively occupied, because
    // stealing a lock we cannot identify is the worse error.
    const unparseableDebris = holder === null && age >= CLAIM_LOCK_STALE_MS;

    if (ownerGone || unparseableDebris) {
      // THE TAKEOVER MUST BE ATOMIC, and `rm` is not.
      //
      // Two processes that both see the same stale lock would both `rm` it and
      // both then `open(…, "wx")` successfully — because the LOSER'S `rm` can
      // land AFTER the winner has already created its own lock, deleting the
      // winner's lock and letting the loser in too. That is exactly the
      // double-grant this lock exists to prevent, and it was measured: two
      // barrier-released processes produced winners=2.
      //
      // `rename` is atomic on both POSIX and Windows/NTFS: for a given source
      // path exactly ONE concurrent caller can succeed, and the others get
      // ENOENT. So the winner moves the debris to a PRIVATE name (so it can
      // never delete anyone else's live lock) and only then creates its own;
      // the losers simply see ENOENT and retry. `rm` of the private name is
      // best-effort cleanup of our own file, never someone else's.
      const graveyard = `${lockPath}.debris-${newLockToken()}`;
      try {
        await rename(lockPath, graveyard);
      } catch {
        // Another process won the takeover, or the owner released it. Either
        // way there is nothing for us to do but look again.
        continue;
      }
      // VERIFY WHAT WE ACTUALLY TOOK. Our "this is debris" decision was made from
      // an EARLIER read, so between that read and this rename the path may have
      // been replaced by a LIVE owner's lock. Renaming is atomic, but it is not a
      // compare-and-swap, so we must not destroy a lock we did not intend to
      // take: re-read what we moved, and if it names a living owner, put it back
      // and retry. Otherwise two processes could each end up believing they hold
      // the anchor — the exact double-grant this exists to prevent.
      let taken: R97LockRecord | null = null;
      try {
        taken = parseLockRecord(await readFile(graveyard, "utf8"));
      } catch {
        taken = null; // unreadable ⇒ genuine debris
      }
      const tookLiveLock = taken !== null && taken.token !== "" && isAlive(taken.pid);
      if (tookLiveLock) {
        // We raced a legitimate owner. Restore it and back off. If the path was
        // re-created in the meantime the restore fails, and that is still safe:
        // WE simply do not proceed without a lock we own.
        await rename(graveyard, lockPath).catch((restoreErr) => {
          // P14-6: a best-effort restore failure must be OBSERVABLE. Swallowing it
          // would hide the one case where a live owner's lock stays in our private
          // debris name instead of being put back — a state an operator needs to see.
          process.stderr.write(
            `[degraded] r97-budget-ledger.claim-lock-restore: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}\n`,
          );
        });
        continue;
      }
      await rm(graveyard, { force: true }).catch((cleanupErr) => {
        // P14-6: our OWN debris cleanup is still a filesystem failure; report it
        // rather than leaving an unexplained debris file behind.
        process.stderr.write(
          `[degraded] r97-budget-ledger.claim-lock-debris-cleanup: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}\n`,
        );
      });
      continue;
    }

    if (now() >= deadline) {
      const who = holder === null ? "an unreadable owner" : `pid ${holder.pid}`;
      throw new Error(
        `E4-R97: ${R97_CAMPAIGN_CLAIM_LOCK_HELD}: could not acquire the claim anchor lock within ${DEFAULT_LOCK_TIMEOUT_MS}ms (${lockPath}) — it is held by ${who} (age ${age}ms); refusing to write the claim anchor unserialized, because two unserialized writers can each grant one approval a full budget`,
      );
    }
    await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
  }
}

/** Release the claim lock ONLY if we still own it. */
async function releaseClaimLock(lockPath: string, token: string): Promise<void> {
  if (token === "") return;
  try {
    const text = await readFile(lockPath, "utf8");
    const holder = parseLockRecord(text);
    if (holder === null || holder.token !== token) return; // no longer ours
  } catch {
    return; // already gone
  }
  await rm(lockPath, { force: true });
}

/** A reservation whose owning process is gone and which has no terminal record.
 *  Its `reserved` amount stays counted: a dispatched attempt may have been
 *  billed, so the allowance is NOT returned. */
export type R97ReservationStatus = "reserved" | "committed" | "abandoned" | "unknown";

export interface R97LedgerEntry {
  reservationId: string;
  /** Which arm asked. Free-form so a rehearsal can use its own names. */
  arm: string;
  /** Owning process id, so a dead owner's reservations can be found. */
  pid: number;
  reservedAt: number;
  /** Logical calls this reservation reserved BEFORE the call was made. */
  reserved: number;
  status: R97ReservationStatus;
  /** Logical calls actually consumed. `null` while outstanding or unknown. */
  consumed: number | null;
  /** Physical transport retries observed. Recorded separately from `consumed`. */
  transportRetries: number;
}

export interface R97LedgerFile {
  schemaVersion: string;
  /** Binds the ledger to ONE authorization: a different plan cannot reuse it. */
  planDigest: string;
  /** The frozen grant. Never increased by a later process. */
  campaignModelCalls: number;
  /**
   * The PERSISTED campaign identity — see `campaignIdOf`. Optional in the TYPE
   * only so that a caller can CONSTRUCT a legacy/hostile file literal to test
   * the refusal; the reader never returns a ledger without one, because a file
   * missing it is rejected. Every file this module writes carries it.
   */
  campaignId?: string;
  entries: R97LedgerEntry[];
}

export interface R97LedgerView {
  granted: number;
  /** Logical calls from terminal records. */
  committed: number;
  /** Logical calls reserved but not yet terminal. */
  outstanding: number;
  /** Logical calls whose outcome is unknown. Counted as consumed. */
  unknown: number;
  /** Logical calls still grantable. */
  remaining: number;
  /** Physical transport retries across all terminal records. */
  transportRetries: number;
}

export interface R97ReserveResult {
  ok: boolean;
  reservationId: string | null;
  reason: string;
  view: R97LedgerView;
}

/** Why a reservation was refused. Named so a caller can report the cause. */
export const R97_BUDGET_EXHAUSTED = "BUDGET_EXHAUSTED";

/**
 * How an open is allowed to treat durable state. Plan §R98 怎么做 (line 121)
 * requires an EXPLICIT mode rather than a single ambiguous "open" that silently
 * does whichever is convenient.
 *
 *  - `"first-run"` — the caller is STARTING a campaign. It may CREATE the
 *    ledger. If a ledger already exists in the directory it is adopted ONLY when
 *    the campaign identity matches (same plan digest, same grant, same stored
 *    `campaignId`); otherwise the open is REFUSED with BUDGET_STATE_MISMATCH.
 *    It also RECORDS the claim (see `recordCampaignClaim`) so that a later
 *    first-run for the same authorization in a DIFFERENT directory is a loud,
 *    durably-recorded conflict instead of a silent second allowance.
 *
 *  - `"resume"` — the caller is RECOVERING a campaign. It may NOT create
 *    anything. A missing ledger is BUDGET_STATE_MISSING; a ledger whose
 *    persisted identity differs from the derived one (including a legacy file
 *    with no identity at all) is BUDGET_STATE_MISMATCH; a structurally invalid
 *    file is BUDGET_STATE_CORRUPT. A resume never records a new claim.
 *
 *  - `"auto"` (the DEFAULT) — FAILS CLOSED by choosing between the two on the
 *    basis of what is actually on disk: create only when NO ledger exists, and
 *    behave exactly like `"resume"` when one does. It exists so that a caller
 *    which has not been taught about modes still gets resume semantics for an
 *    established campaign — the old bug was precisely an implicit "always
 *    allowed to create". It never adopts a foreign identity: an existing file
 *    whose identity does not match is refused, never overwritten and never
 *    re-created. Because it cannot know whether a caller means "start" or
 *    "recover", it does NOT treat a fresh directory as an error (that would
 *    refuse the legitimate very first run), but it DOES record the claim.
 */
export type R97LedgerOpenMode = "first-run" | "resume" | "auto";

export interface R97LedgerOpenOptions {
  planDigest: string;
  campaignModelCalls: number;
  /** See `R97LedgerOpenMode`. Defaults to `"auto"`, which fails closed. */
  mode?: R97LedgerOpenMode;
  /** Lock acquisition budget in ms. Default 10s. */
  lockTimeoutMs?: number;
  /** Injectable clock, so tests are not wall-clock dependent. */
  now?: () => number;
  /** Injectable liveness probe, so tests can simulate a dead owner. */
  isAlive?: (pid: number) => boolean;
  /**
   * Injectable liveness probe for a cross-directory CLAIM, so a claim left by a
   * directory that no longer exists does not wedge a legitimate new run.
   * Defaults to `defaultIsLiveClaimDir` (that directory still holds a ledger
   * bound to this campaign id).
   */
  isLiveClaimDir?: (dir: string, campaignId: string) => Promise<boolean>;
}

/**
 * The DEFAULT liveness test for a cross-directory claim: the named directory
 * still holds a ledger that belongs to the SAME campaign.
 *
 * A directory that is gone, unreadable, or holds no/foreign ledger is a STALE
 * claim — the campaign it recorded no longer exists there, so it is not evidence
 * that this authorization is currently in use.
 */
async function defaultIsLiveClaimDir(dir: string, campaignId: string): Promise<boolean> {
  try {
    const file = await readR97LedgerFile(dir);
    return file !== null && file.campaignId === campaignId;
  } catch {
    // A damaged ledger is still SOMETHING: treat it as live rather than
    // silently ignoring a directory that may be in use.
    return true;
  }
}

export interface R97BudgetLedger {
  readonly dir: string;
  readonly planDigest: string;
  /** The persisted campaign identity this handle is bound to. */
  readonly campaignId: string;
  /** How this handle was opened — `"auto"` is resolved to `"first-run"` or
   *  `"resume"` by what was actually on disk, so a caller can see which
   *  semantics applied. */
  readonly mode: "first-run" | "resume";
  /** Non-empty when this authorization has ALSO been claimed by other
   *  directories (plan §R98 line 121). The ledger is still usable, but the
   *  caller must be able to report that the same approval looks spent twice. */
  readonly duplicateCampaignDirs: readonly string[];
  view(): Promise<R97LedgerView>;
  reserve(arm: string, count: number): Promise<R97ReserveResult>;
  commit(reservationId: string, consumed: number, transportRetries?: number): Promise<R97LedgerView>;
  /** Return a reservation made for an attempt that PROVABLY never dispatched.
   *  Only legal while the reservation is still outstanding. */
  abandon(reservationId: string): Promise<R97LedgerView>;
  /** Mark a DISPATCHED reservation whose outcome was never observed.
   *
   *  Plan T1 怎么验收: "已发送后进程终止的 reservation 保留 unknown 占用，不自动退款
   *  或重发." Unlike `abandon` — which is only legal for a provably-undispatched
   *  attempt — this is the settlement for a request that DID leave and whose
   *  result nobody saw. The allowance stays counted, because it may already have
   *  been billed. */
  markUnknown(reservationId: string): Promise<R97LedgerView>;
  /** Mark outstanding reservations whose owner is gone as `unknown`. Their
   *  allowance is NOT returned. Returns how many were reclassified. */
  recover(): Promise<{ unknown: number; view: R97LedgerView }>;
  read(): Promise<R97LedgerFile>;
}

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 5;

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is not ours — still alive.
    return (err as { code?: string }).code === "EPERM";
  }
}

/**
 * ---- E4-R98-B (T2): ONE CAMPAIGN LOCK, REUSED -----------------------------
 *
 * Plan §T2 怎么做 3 is explicit: "用同一已有 campaign lock/事务合同保护
 * read-modify-write。仅靠写临时文件再 rename 不能防两个 writer 互相覆盖；不要再造
 * 第三套锁实现."
 *
 * MEASURED DEFECT (reproduced by the Lead with a two-process file-barrier probe):
 * the execution-state store did its read-modify-write with NO lock at all, so
 *   - two processes calling `begin` on the SAME unit BOTH succeeded (one unit,
 *     two owners, two bills), and
 *   - two processes calling `begin` on DIFFERENT units lost one record entirely,
 *     because `writeStateAtomic`'s read-modify-write rewrote the whole `records`
 *     array from a stale snapshot (last-writer-wins).
 * `writeStateAtomic`'s temp-file-then-rename is atomic per WRITE but is not a
 * mutual-exclusion mechanism, which is exactly the distinction the plan draws.
 *
 * This exports the lock that already exists here — the same `acquireLock` /
 * `releaseLock` pair, the same lock file name, the same dead-owner takeover and
 * the same token discipline that stops a stale owner deleting a new owner's lock.
 * It is deliberately the ONLY lock in the R97 stack; the execution-state store
 * calls this rather than growing a second implementation.
 *
 * The callback runs with the lock held and the lock is released in a `finally`,
 * so an exception cannot leak it. Note the timeout default: a caller that holds
 * the lock across a long operation must still finish inside `timeoutMs`, or the
 * next acquirer takes over a lock it believes is dead.
 */
export async function withR97CampaignLock<T>(
  dir: string,
  fn: () => Promise<T>,
  opts: { lockTimeoutMs?: number; isAlive?: (pid: number) => boolean; now?: () => number } = {},
): Promise<T> {
  const lockTimeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const now = opts.now ?? (() => Date.now());
  const { lockPath, token } = await acquireLock(dir, lockTimeoutMs, isAlive, now);
  try {
    return await fn();
  } finally {
    await releaseLock(lockPath, token);
  }
}

/** Derive the view from the raw file. Pure, so it can be asserted directly.
 *
 *  `clamp` (default true) floors `remaining` at 0 for DISPLAY of a well-formed
 *  ledger. The parser calls it with `clamp: false` so an over-consumed file is
 *  DETECTED (remaining < 0) instead of being silently clamped into validity —
 *  plan §R98 怎么做: "任何计算结果违反 0 <= remaining <= granted 必须拒绝，不能靠
 *  clamp 掩盖错误." */
export function viewOfR97Ledger(file: R97LedgerFile, opts: { clamp?: boolean } = {}): R97LedgerView {
  let committed = 0;
  let outstanding = 0;
  let unknown = 0;
  let transportRetries = 0;
  for (const e of file.entries) {
    transportRetries += e.transportRetries;
    if (e.status === "committed") {
      // A committed record reports what was ACTUALLY consumed. A caller that
      // consumed less than it reserved returns the difference implicitly.
      committed += e.consumed ?? e.reserved;
    } else if (e.status === "unknown") {
      // Unknown counts as consumed at the RESERVED amount: the request may have
      // been sent, so the allowance must not silently reappear.
      unknown += e.reserved;
    } else if (e.status === "reserved") {
      outstanding += e.reserved;
    }
    // `abandoned` is the only status that returns allowance, and only because
    // the attempt provably never dispatched.
  }
  const raw = file.campaignModelCalls - committed - outstanding - unknown;
  const remaining = opts.clamp === false ? raw : Math.max(0, raw);
  return {
    granted: file.campaignModelCalls,
    committed,
    outstanding,
    unknown,
    remaining,
    transportRetries,
  };
}

function emptyLedger(planDigest: string, campaignModelCalls: number): R97LedgerFile {
  return {
    schemaVersion: R97_LEDGER_SCHEMA,
    planDigest,
    campaignModelCalls,
    campaignId: campaignIdOf(planDigest, campaignModelCalls),
    entries: [],
  };
}

/**
 * The SINGLE validation every locked read-modify-write must pass.
 *
 * Plan §R98 怎么做 (line 119): "每次锁内读改写都校验 schema、plan digest、grant 与
 * campaign identity，不只 open 时检查一次."
 *
 * Why ONE function: the bootstrap path and `withLedger` each used to hand-roll
 * their own checks, so the two could (and did) drift — the bootstrap compared
 * plan/grant while the identity and schema were only whatever
 * `readR97LedgerFile` happened to enforce. Both now call `assertR97LedgerMatches`
 * so they CANNOT diverge, and every disagreement is a NAMED code that says which
 * field disagreed and what was found vs expected.
 *
 * Codes:
 *   - schema version disagreement   -> BUDGET_STATE_CORRUPT (the file is not a
 *     ledger of this version at all; there is nothing to compare field by field)
 *   - plan digest / grant / identity -> BUDGET_STATE_MISMATCH
 *
 * The identity is the persisted `campaignId` compared against the value DERIVED
 * from this authorization. A ledger with NO `campaignId` (an old file written
 * before this change, or a hand-made one) is a MISMATCH, never an implicit pass:
 * see `campaignIdOf` for why "cannot prove it is mine" must not mean "assume it
 * is mine".
 */
function assertR97LedgerMatches(found: R97LedgerFile, opts: R97LedgerOpenOptions, dir: string): void {
  const expectedCampaignId = campaignIdOf(opts.planDigest, opts.campaignModelCalls);

  if (found.schemaVersion !== R97_LEDGER_SCHEMA) {
    throw new Error(
      `E4-R97: ${R97_BUDGET_STATE_CORRUPT}: the budget ledger in ${dir} has schemaVersion ${JSON.stringify(found.schemaVersion)} but this build only understands ${JSON.stringify(R97_LEDGER_SCHEMA)}`,
    );
  }
  if (found.planDigest !== opts.planDigest) {
    throw new Error(
      `E4-R97: ${R97_BUDGET_STATE_MISMATCH}: the budget ledger in ${dir} belongs to a different plan (found ${found.planDigest}, expected ${opts.planDigest})`,
    );
  }
  if (found.campaignModelCalls !== opts.campaignModelCalls) {
    throw new Error(
      `E4-R97: ${R97_BUDGET_STATE_MISMATCH}: the budget ledger in ${dir} grants ${found.campaignModelCalls} calls but this authorization declares ${opts.campaignModelCalls} — a process must never re-grant itself a different allowance`,
    );
  }
  // The identity is re-derived from the SAME authorization and compared, so it
  // is impossible for the two fields above to agree while the identity does not.
  if (found.campaignId === undefined || found.campaignId === "") {
    throw new Error(
      `E4-R97: ${R97_BUDGET_STATE_MISMATCH}: the budget ledger in ${dir} carries no campaignId (found none, expected ${expectedCampaignId}) — a file with no campaign identity cannot be proven to belong to this authorization, so it is refused rather than adopted; this is the shape of a ledger written before the campaign identity existed`,
    );
  }
  if (found.campaignId !== expectedCampaignId) {
    throw new Error(
      `E4-R97: ${R97_BUDGET_STATE_MISMATCH}: the budget ledger in ${dir} carries campaignId ${found.campaignId} but this authorization derives ${expectedCampaignId} — the budget belongs to a different campaign`,
    );
  }
}

/**
 * Parse a ledger file. Fails CLOSED: a corrupt or foreign ledger is refused
 * rather than treated as an empty one, because "I cannot read the budget" must
 * never become "the budget is full again".
 *
 * Plan §R98 怎么做 requires STRICT validation of every counter and of the
 * (status, consumed) combination, because the previous version accepted
 * `consumed: -100` and derived `remaining: 103` from a grant of 3 — a hostile
 * (or merely buggy) file could INCREASE the allowance. Every rejection names
 * the offending field.
 */
export function parseR97Ledger(raw: unknown): { ledger: R97LedgerFile | null; issue: string | null } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ledger: null, issue: "ledger is not a JSON object" };
  }
  const o = raw as Record<string, unknown>;
  if (o["schemaVersion"] !== R97_LEDGER_SCHEMA) {
    return { ledger: null, issue: `ledger schemaVersion must be ${R97_LEDGER_SCHEMA}` };
  }
  if (typeof o["planDigest"] !== "string" || o["planDigest"] === "") {
    return { ledger: null, issue: "ledger planDigest must be a non-empty string" };
  }
  const grant = o["campaignModelCalls"];
  if (typeof grant !== "number" || !Number.isSafeInteger(grant) || grant < 0) {
    return { ledger: null, issue: "ledger campaignModelCalls must be a non-negative safe integer" };
  }
  if (!Array.isArray(o["entries"])) return { ledger: null, issue: "ledger entries must be an array" };

  // The campaign identity. A MISSING field is tolerated by the PARSER (it is
  // carried through as `undefined` so the refusal happens in the single
  // identity-checking helper with the right named code and a useful message),
  // but a PRESENT field of the wrong shape is structural damage and is rejected
  // here like every other malformed field.
  const campaignIdRaw = o["campaignId"];
  if (campaignIdRaw !== undefined && (typeof campaignIdRaw !== "string" || campaignIdRaw === "")) {
    return { ledger: null, issue: "ledger campaignId must be a non-empty string when present" };
  }

  /** A counter must be a non-negative safe integer. */
  const counter = (value: unknown, field: string): string | null =>
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 0
      ? `ledger ${field} must be a non-negative safe integer (got ${String(value)})`
      : null;

  const entries: R97LedgerEntry[] = [];
  const seenIds = new Set<string>();
  for (const [i, e] of (o["entries"] as unknown[]).entries()) {
    if (typeof e !== "object" || e === null || Array.isArray(e)) {
      return { ledger: null, issue: `ledger entries[${i}] is not an object` };
    }
    const r = e as Record<string, unknown>;
    const where = `entries[${i}]`;

    if (typeof r["reservationId"] !== "string" || r["reservationId"] === "") {
      return { ledger: null, issue: `ledger ${where}.reservationId must be a non-empty string` };
    }
    // Duplicate ids would make commit/abandon ambiguous and let one reservation
    // be settled twice.
    if (seenIds.has(r["reservationId"])) {
      return { ledger: null, issue: `ledger ${where}.reservationId "${r["reservationId"]}" is duplicated` };
    }
    seenIds.add(r["reservationId"]);

    const reservedIssue = counter(r["reserved"], `${where}.reserved`);
    if (reservedIssue !== null) return { ledger: null, issue: reservedIssue };
    const reserved = r["reserved"] as number;

    if (typeof r["arm"] !== "string") {
      return { ledger: null, issue: `ledger ${where}.arm must be a string` };
    }

    const status = String(r["status"]);
    if (!["reserved", "committed", "abandoned", "unknown"].includes(status)) {
      return { ledger: null, issue: `ledger ${where}.status is not a known status` };
    }

    // `pid` must be a safe integer when present. -1 was the old "unknown"
    // sentinel; keep accepting it, but reject nonsense like NaN/strings.
    const pid = r["pid"];
    if (pid !== undefined && (typeof pid !== "number" || !Number.isSafeInteger(pid))) {
      return { ledger: null, issue: `ledger ${where}.pid must be a safe integer` };
    }
    const reservedAt = r["reservedAt"];
    if (reservedAt !== undefined && (typeof reservedAt !== "number" || !Number.isFinite(reservedAt) || reservedAt < 0)) {
      return { ledger: null, issue: `ledger ${where}.reservedAt must be a non-negative finite number` };
    }

    // transportRetries is a physical-attempt counter: never negative, never
    // fractional, and cumulative overflow of the total is checked below.
    const retriesIssue = counter(r["transportRetries"] ?? 0, `${where}.transportRetries`);
    if (retriesIssue !== null) return { ledger: null, issue: retriesIssue };
    const transportRetries = (r["transportRetries"] ?? 0) as number;

    // (status, consumed) must be one of the four legal combinations. Every
    // other pairing is a file that cannot be trusted to describe the budget.
    const consumedRaw = r["consumed"];
    let consumed: number | null;
    if (status === "reserved") {
      if (consumedRaw !== null && consumedRaw !== undefined) {
        return { ledger: null, issue: `ledger ${where} is "reserved" but carries a consumed count` };
      }
      consumed = null;
    } else if (status === "unknown") {
      if (consumedRaw !== null && consumedRaw !== undefined) {
        return { ledger: null, issue: `ledger ${where} is "unknown" but carries a consumed count` };
      }
      consumed = null;
    } else if (status === "committed") {
      const consumedIssue = counter(consumedRaw, `${where}.consumed`);
      if (consumedIssue !== null) return { ledger: null, issue: consumedIssue };
      consumed = consumedRaw as number;
      if (consumed > reserved) {
        return {
          ledger: null,
          issue: `ledger ${where} is "committed" with consumed ${consumed} > reserved ${reserved}`,
        };
      }
    } else {
      // abandoned: only a provably-undispatched attempt, so consumption is 0.
      if (consumedRaw !== 0) {
        return { ledger: null, issue: `ledger ${where} is "abandoned" but consumed is ${String(consumedRaw)} (must be 0)` };
      }
      consumed = 0;
    }

    entries.push({
      reservationId: r["reservationId"],
      arm: r["arm"],
      pid: typeof pid === "number" ? pid : -1,
      reservedAt: typeof reservedAt === "number" ? reservedAt : 0,
      reserved,
      status: status as R97ReservationStatus,
      consumed,
      transportRetries,
    });
  }

  const parsed: R97LedgerFile = {
    schemaVersion: R97_LEDGER_SCHEMA,
    planDigest: o["planDigest"],
    campaignModelCalls: grant,
    // Deliberately NOT defaulted: an absent identity must stay absent so the
    // identity check can refuse it by name instead of comparing a fabricated
    // value against a real one.
    campaignId: typeof campaignIdRaw === "string" ? campaignIdRaw : undefined,
    entries,
  };

  // The derived view is the thing that actually authorizes spending, so the
  // invariant is checked HERE rather than by clamping in viewOfR97Ledger: a
  // file whose entries exceed the grant is refused, never "limited" to zero
  // remaining and then treated as valid for a later top-up.
  const projected = viewOfR97Ledger(parsed, { clamp: false });
  if (projected.remaining < 0) {
    return {
      ledger: null,
      issue: `ledger consumption (${projected.committed + projected.outstanding + projected.unknown}) exceeds the grant ${grant} — a damaged ledger may never be clamped into validity`,
    };
  }

  return { ledger: parsed, issue: null };
}

/** Read a ledger without creating one. `null` = the file does not exist. */
export async function readR97LedgerFile(dir: string): Promise<R97LedgerFile | null> {
  let text: string;
  try {
    text = await readFile(join(dir, R97_LEDGER_FILENAME), "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("E4-R97: the budget ledger is not valid JSON — refusing to treat an unreadable budget as an empty one");
  }
  const { ledger, issue } = parseR97Ledger(raw);
  if (ledger === null) throw new Error(`E4-R97: refusing to use a damaged budget ledger: ${String(issue)}`);
  return ledger;
}

/** The view of a campaign's budget as a FRESH process would see it. */
export async function readR97BudgetView(dir: string): Promise<R97LedgerView | null> {
  const file = await readR97LedgerFile(dir);
  return file === null ? null : viewOfR97Ledger(file);
}

/** Atomically replace the ledger: write a temp file, then rename over it. */
async function writeLedgerAtomic(dir: string, ledger: R97LedgerFile): Promise<void> {
  const tmp = join(dir, `${R97_LEDGER_FILENAME}.tmp-${process.pid}-${Date.now()}`);
  await writeFile(tmp, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  await rename(tmp, join(dir, R97_LEDGER_FILENAME));
}

/** The on-disk lock record. The OWNER TOKEN is what makes release safe: a
 *  process may only delete a lock it still owns, so a slow owner's `finally`
 *  can never remove a lock another process has since acquired. */
interface R97LockRecord {
  token: string;
  pid: number;
  host: string;
  acquiredAt: number;
}

function newLockToken(): string {
  return randomBytes(16).toString("hex");
}

/** Parse a lock file. Unreadable/legacy content is treated as an UNKNOWN owner
 *  (conservatively occupied), never as a free lock. */
function parseLockRecord(text: string): R97LockRecord | null {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    if (typeof o["token"] !== "string" || o["token"] === "") return null;
    if (typeof o["pid"] !== "number" || !Number.isSafeInteger(o["pid"])) return null;
    return {
      token: o["token"],
      pid: o["pid"],
      host: typeof o["host"] === "string" ? o["host"] : "",
      acquiredAt: typeof o["acquiredAt"] === "number" ? o["acquiredAt"] : 0,
    };
  } catch {
    // Legacy/plain-text locks (`<pid>`) are still honoured as an owner hint so
    // an upgraded binary cannot steal a lock written by the previous version.
    const legacy = Number(text.trim());
    if (Number.isSafeInteger(legacy) && legacy > 0) {
      return { token: "", pid: legacy, host: "", acquiredAt: 0 };
    }
    return null;
  }
}

/**
 * Acquire the exclusive lock.
 *
 * Plan §R98 怎么做: "锁采用 owner token + 进程存活判断；年龄只能作为检查线索。活
 * owner 超时返回占用错误，不能删锁。"
 *
 * Measured defect this closes: the previous version reclaimed ANY lock whose
 * mtime was older than 30s, so a live process that had been holding the lock
 * for 60s had it deleted under it and two writers could interleave. Age is now
 * only a HINT used to decide whether to bother reading the owner record; the
 * decision to take over is based on the owner being provably dead.
 *
 * Returns the token, so the caller can release only its own lock.
 */
async function acquireLock(
  dir: string,
  timeoutMs: number,
  isAlive: (pid: number) => boolean,
  now: () => number,
): Promise<{ lockPath: string; token: string }> {
  const lockPath = join(dir, R97_LEDGER_LOCK_FILENAME);
  const deadline = now() + timeoutMs;
  for (;;) {
    const token = newLockToken();
    try {
      const fh = await open(lockPath, "wx");
      try {
        const record: R97LockRecord = {
          token,
          pid: process.pid,
          host: hostname(),
          acquiredAt: now(),
        };
        await fh.writeFile(JSON.stringify(record), "utf8");
      } finally {
        await fh.close();
      }
      return { lockPath, token };
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") throw err;
    }

    // The lock exists. Decide whether its owner is still alive.
    let holder: R97LockRecord | null = null;
    let age = 0;
    try {
      const [text, st] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]);
      holder = parseLockRecord(text);
      age = Math.max(0, now() - st.mtimeMs);
    } catch {
      // The holder released it between our open() and this read: retry at once.
      continue;
    }

    // A record with an unparseable owner is conservatively OCCUPIED: we cannot
    // prove the writer is gone, and stealing a live lock is the worse error.
    const ownerGone = holder !== null && holder.token !== "" && !isAlive(holder.pid);
    if (ownerGone) {
      // Provably dead owner — the crash this ledger exists to survive. Age is
      // deliberately NOT required: a fast crash must not deadlock the campaign.
      await rm(lockPath, { force: true });
      continue;
    }

    if (now() >= deadline) {
      const who = holder === null ? "an unreadable owner" : `pid ${holder.pid}`;
      throw new Error(
        `E4-R97: ${R97_LOCK_HELD}: could not acquire the budget ledger lock within ${timeoutMs}ms (${lockPath}) — it is held by ${who} (age ${age}ms)`,
      );
    }
    await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
  }
}

/** Release the lock ONLY if we still own it. A stale owner whose lock was taken
 *  over must never delete the new owner's lock. */
async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    const text = await readFile(lockPath, "utf8");
    const holder = parseLockRecord(text);
    if (holder === null || holder.token !== token) return; // no longer ours
  } catch {
    return; // already gone
  }
  await rm(lockPath, { force: true });
}

/**
 * Open the campaign budget ledger under an EXPLICIT mode.
 *
 * A ledger already present but bound to a DIFFERENT authorization — another plan
 * digest, another grant, or another persisted `campaignId` — is refused: the
 * budget belongs to one authorization, and silently adopting another's
 * consumption would either over-grant or under-grant.
 *
 * Plan §R98 怎么做 draws the line between FIRST CREATION and RESUME: the
 * `read() ?? emptyLedger()` fallback is only legal while establishing a new
 * campaign. Once this handle has OBSERVED durable state, that state vanishing,
 * corrupting, or being swapped for another authorization's must fail closed with
 * BUDGET_STATE_MISSING / CORRUPT / MISMATCH — never re-grant the allowance.
 *
 * Plan §R98 怎么做 (line 121) additionally requires that changing `--ledger`/
 * `--out` cannot silently start a SECOND empty budget for the SAME
 * authorization. That is what `opts.mode` and the persisted `campaignId` encode:
 * see `R97LedgerOpenMode` for the exact permissions of each mode.
 */
export async function openR97BudgetLedger(dir: string, opts: R97LedgerOpenOptions): Promise<R97BudgetLedger> {
  await mkdir(dir, { recursive: true });
  const lockTimeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const now = opts.now ?? (() => Date.now());
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const mode: R97LedgerOpenMode = opts.mode ?? "auto";

  /** True once this handle has seen the ledger on disk. After that, a missing
   *  file is a MISSING STATE, not a fresh campaign. */
  let established = false;

  /** Other directories that have claimed this SAME authorization. Non-empty
   *  means "this approval appears to be in use somewhere else" — see the
   *  cross-directory guard below. Recorded, and exposed on the handle. */
  let duplicateCampaignDirs: string[] = [];

  /** Resolved by the bootstrap: did this open CREATE the ledger, or adopt the
   *  state that already existed? `"auto"` collapses to one of the two. */
  let resolvedMode: "first-run" | "resume" = mode === "resume" ? "resume" : "first-run";

  /** Read the ledger. First creation may substitute an empty one — and ONLY in
   *  a mode that is allowed to create. A resume may NOT: it fails closed with a
   *  named code. Every PRESENT file is validated by the one shared helper. */
  const read = async (): Promise<R97LedgerFile> => {
    let present: R97LedgerFile | null;
    try {
      present = await readR97LedgerFile(dir);
    } catch (err) {
      // Damage detected by the reader (bad JSON / schema / invariant).
      const message = err instanceof Error ? err.message : String(err);
      if (established) {
        throw new Error(`E4-R97: ${R97_BUDGET_STATE_CORRUPT}: ${message}`);
      }
      throw err;
    }
    if (present === null) {
      if (established) {
        throw new Error(
          `E4-R97: ${R97_BUDGET_STATE_MISSING}: the budget ledger for this campaign no longer exists in ${dir} — refusing to treat a lost budget as a fresh full allowance`,
        );
      }
      // A MISSING file on a resume is never a fresh campaign: "recover what
      // exists" cannot mean "create a new full allowance".
      if (mode === "resume") {
        throw new Error(
          `E4-R97: ${R97_BUDGET_STATE_MISSING}: mode "resume" requires an existing budget ledger but none exists in ${dir} — a resume must never create a fresh allowance`,
        );
      }
      return emptyLedger(opts.planDigest, opts.campaignModelCalls);
    }
    // EVERY read re-validates schema, plan digest, grant AND campaign identity
    // through the single shared helper — not just the first open, and not with
    // a second hand-rolled copy that could drift from the bootstrap's checks.
    assertR97LedgerMatches(present, opts, dir);
    established = true;
    return present;
  };
  const view = async (): Promise<R97LedgerView> => viewOfR97Ledger(await read());

  /**
   * One locked read-modify-write. `mutate` returns the next entries plus a
   * result; `next: null` means "do not persist" (a pure refusal).
   *
   * EVERY mutate runs `read()` INSIDE the lock, so every locked read-modify-write
   * re-validates schema version, plan digest, grant AND campaign identity before
   * the mutation is applied or written. Plan §R98 怎么做 (line 119) requires
   * exactly that, and routing both this path and the bootstrap through
   * `assertR97LedgerMatches` is what stops the two from drifting: a ledger
   * swapped between open and a later `reserve()` cannot be written through.
   *
   * `next` is an explicit field rather than an optional `ledger` key so the
   * return type stays a single shape — an optional key makes the two branches a
   * discriminated union TypeScript cannot narrow through a generic.
   */
  const withLedger = async <T>(
    mutate: (current: R97LedgerFile, currentView: R97LedgerView) => { next: R97LedgerFile | null; result: T },
  ): Promise<T> => {
    const { lockPath, token } = await acquireLock(dir, lockTimeoutMs, isAlive, now);
    try {
      // Validation happens HERE, under the lock, on every single mutation.
      const current = await read();
      const currentView = viewOfR97Ledger(current);
      const { next, result } = mutate(current, currentView);
      if (next !== null) await writeLedgerAtomic(dir, next);
      return result;
    } finally {
      await releaseLock(lockPath, token);
    }
  };

  // ---- Bootstrap and validate the grant UNDER THE LOCK ---------------------
  //
  // This MUST be a locked read-modify-write. Doing it unlocked is a genuine
  // lost-update race: two processes opening the same campaign simultaneously
  // both observe "no ledger", and the second one's write of an EMPTY ledger
  // erases the first one's reservation. MEASURED before the fix: the
  // two-process contention test passed alone and failed roughly one run in six
  // when the suite ran in sequence, because both racers saw a missing file and
  // both were then granted the last call.
  //
  // The `null`-vs-present distinction comes from `readR97LedgerFile` directly,
  // NOT from `read()`: `read()` substitutes an empty ledger for a missing file,
  // so a missing file and a legitimately-empty one are indistinguishable there.
  {
    const { lockPath, token } = await acquireLock(dir, lockTimeoutMs, isAlive, now);
    try {
      const present = await readR97LedgerFile(dir);
      if (present !== null) {
        // A ledger bound to a different plan, grant or campaign identity is
        // refused by the SAME helper the mutate path uses — the bootstrap and
        // `withLedger` must not be able to drift apart.
        assertR97LedgerMatches(present, opts, dir);
      } else if (mode === "resume") {
        // Nothing on disk, and a resume may not create: it must fail closed
        // instead of conjuring a fresh allowance.
        throw new Error(
          `E4-R97: ${R97_BUDGET_STATE_MISSING}: mode "resume" requires an existing budget ledger but none exists in ${dir} — a resume must never create a fresh allowance`,
        );
      }

      // ---- The cross-directory guard (plan §R98 line 121). ------------------
      // A directory cannot SEE another directory's ledger: the ledger is
      // directory-local by construction, and no directory-local file can observe
      // a sibling. So the authorization's CLAIM ANCHOR (a small file outside any
      // single campaign directory) is consulted and updated here.
      //
      // This runs for EVERY open — adopting an existing ledger as much as
      // creating a new one — because being "in a new directory" is precisely
      // what the plan forbids going unnoticed. Checking only the create path
      // would let an open in the new directory bootstrap the ledger first and
      // then adopt it, hiding the conflict behind its own empty budget.
      //
      // DESIGN CHOICE — RECORD, DO NOT VETO (except on an explicit `first-run`).
      // A blanket strict refusal was considered and rejected: re-running an
      // approved plan in a different directory is a legitimate, ordinary
      // workflow (a cleaned CI workspace, a fresh machine, a deliberately
      // relocated `--out`). A machine-global veto would wedge those runs
      // permanently — and, being bypassable by deleting one anchor file, would
      // buy no real security. Plan §R98 line 121 scopes the guarantee to local
      // recovery integrity, not to defending against an operator with full
      // control of the filesystem.
      //
      // What is NOT acceptable is SILENCE. The conflict is therefore recorded
      // durably (every claiming directory is retained in the anchor) and
      // surfaced on the returned handle as `duplicateCampaignDirs`, so a caller
      // can refuse, warn, or attach it to the run report — see
      // `readR97CampaignClaim` to inspect it after the fact. An EXPLICIT
      // `first-run` additionally THROWS: the caller has declared "I am starting a
      // new campaign", which is exactly the claim the anchor contradicts, and an
      // explicit mode that ignored its own evidence would defeat its purpose.
      //
      // STALENESS IS CHECKED, and it is what keeps this rule from becoming a
      // permanent wedge. The anchor is machine-global and deliberately advisory,
      // so a directory it names may since have been DELETED — a cleaned CI
      // workspace, a pruned temp directory, a removed worktree. A claim whose
      // directory no longer holds a budget for this SAME campaign is not
      // evidence that the authorization is in use; vetoing on it would refuse
      // every later legitimate first run for the rest of the machine's life. So
      // only a claim that is still LIVE refuses the new directory. The default
      // liveness test is "does that directory still hold a ledger bound to this
      // campaign id", and a caller with a stronger notion of campaign existence
      // (the lifecycle header) may inject `isLiveClaimDir`.
      const campaignId = campaignIdOf(opts.planDigest, opts.campaignModelCalls);
      const priorClaim = await recordCampaignClaim(campaignId, dir, now, isAlive);
      if (priorClaim !== null) {
        const others = priorClaim.claimedDirs.filter((d) => d !== dir);
        const live = [];
        for (const other of others) {
          const probe = opts.isLiveClaimDir ?? defaultIsLiveClaimDir;
          if (await probe(other, campaignId)) live.push(other);
        }
        duplicateCampaignDirs = live;
      }

      // ---- The F2 guard: a CREATE for an already-ESTABLISHED approval. -----
      //
      // STALENESS IS STILL CHECKED, but it is no longer the whole rule. The
      // anchor distinguishes two kinds of claim: a directory that was only
      // PROBED (recorded, but no budget ever came into existence there) and one
      // that ESTABLISHED a budget. A probed claim stays ignorable — that is what
      // keeps a failed first run from wedging the authorization forever. An
      // ESTABLISHED claim whose directory is no longer readable is a LOSS of the
      // consumption record, and re-creating there would grant a SECOND allowance
      // for one approval (finding F2: one `rm -rf` was enough).
      //
      // Scoped to opens that would CREATE: a resume adopts what exists and
      // cannot mint anything, so it is never refused by this rule.
      const wouldCreate = present === null && mode !== "resume";
      if (wouldCreate) {
        const anchor = await readR97CampaignClaim(campaignId);
        const establishedDirs = anchor === null ? [] : anchor.establishedDirs;
        const lostHere = establishedDirs.includes(dir) ? [dir] : [];
        const lostElsewhere = establishedDirs.filter((d) => d !== dir && !duplicateCampaignDirs.includes(d));
        const lost = [...lostHere, ...lostElsewhere];
        if (lost.length > 0) {
          throw new Error(
            `E4-R97: ${R97_CAMPAIGN_STATE_LOST}: this authorization (campaign ${campaignId}) already ESTABLISHED a budget in ${lost.join(", ")}, and no campaign is readable there now — a deleted root is a LOSS of the consumed record, not a fresh allowance; restore that campaign, or use a new authorization`,
          );
        }
      }

      if ((mode === "first-run" || opts.mode === "first-run") && duplicateCampaignDirs.length > 0) {
        throw new Error(
          `E4-R97: ${R97_DUPLICATE_CAMPAIGN_DIR}: mode "first-run" would start a SECOND budget for an authorization already claimed by ${duplicateCampaignDirs.join(", ")} (campaign ${campaignId}, this directory ${dir}) — resume the existing campaign with mode "resume", or use a new authorization`,
        );
      }

      if (present !== null) {
        established = true;
        resolvedMode = "resume";
      } else {
        // Persist the grant on FIRST open, so a later process always has a file
        // to compare against and cannot re-grant itself a different allowance.
        await writeLedgerAtomic(dir, emptyLedger(opts.planDigest, opts.campaignModelCalls));
        established = true;
        resolvedMode = "first-run";
      }
      // Record durably that this approval has been ESTABLISHED here (F2). This is
      // the one moment a budget comes into existence, so it is the one moment the
      // "this approval has been spent from here" fact becomes true. A failure to
      // record it is a refusal, not a warning: an unrecorded establishment is
      // exactly the state in which a later `rm -rf` goes unnoticed.
      await markR97CampaignClaimEstablished(campaignId, dir, now, isAlive);
    } finally {
      await releaseLock(lockPath, token);
    }
  }

  return {
    dir,
    planDigest: opts.planDigest,
    campaignId: campaignIdOf(opts.planDigest, opts.campaignModelCalls),
    get mode() {
      return resolvedMode;
    },
    get duplicateCampaignDirs() {
      return duplicateCampaignDirs;
    },
    read,
    view,

    async reserve(arm: string, count: number): Promise<R97ReserveResult> {
      if (!Number.isSafeInteger(count) || count <= 0) {
        return {
          ok: false,
          reservationId: null,
          reason: `reservation count must be a positive safe integer (got ${String(count)})`,
          view: await view(),
        };
      }
      return withLedger<R97ReserveResult>((ledger, currentView) => {
        if (count > currentView.remaining) {
          return {
            next: null,
            result: {
              ok: false,
              reservationId: null,
              reason: `${R97_BUDGET_EXHAUSTED}: ${count} logical call(s) requested but only ${currentView.remaining} of ${currentView.granted} remain (committed ${currentView.committed}, outstanding ${currentView.outstanding}, unknown ${currentView.unknown})`,
              view: currentView,
            },
          };
        }
        const reservationId = `r-${now()}-${process.pid}-${ledger.entries.length}`;
        const entry: R97LedgerEntry = {
          reservationId,
          arm,
          pid: process.pid,
          reservedAt: now(),
          reserved: count,
          status: "reserved",
          consumed: null,
          transportRetries: 0,
        };
        const next: R97LedgerFile = { ...ledger, entries: [...ledger.entries, entry] };
        return {
          next,
          result: { ok: true, reservationId, reason: "", view: viewOfR97Ledger(next) },
        };
      });
    },

    async commit(reservationId: string, consumed: number, transportRetries = 0): Promise<R97LedgerView> {
      if (!Number.isSafeInteger(consumed) || consumed < 0) {
        throw new Error(`E4-R97: a commit must report a non-negative safe integer of consumed calls (got ${String(consumed)})`);
      }
      // transportRetries counts PHYSICAL attempts. A negative or fractional
      // count is not a measurement, and letting it through would corrupt the
      // separately-reported retry total.
      if (!Number.isSafeInteger(transportRetries) || transportRetries < 0) {
        throw new Error(
          `E4-R97: a commit must report a non-negative safe integer of transport retries (got ${String(transportRetries)})`,
        );
      }
      return withLedger((ledger) => {
        const i = ledger.entries.findIndex((e) => e.reservationId === reservationId);
        if (i < 0) throw new Error(`E4-R97: no reservation ${reservationId} to commit`);
        const entry = ledger.entries[i]!;
        if (entry.status !== "reserved") {
          throw new Error(`E4-R97: reservation ${reservationId} is already ${entry.status} — a terminal reservation cannot be committed twice`);
        }
        // Consuming MORE than reserved is refused: the caller must reserve the
        // full amount up front, because a post-hoc overrun cannot be undone.
        if (consumed > entry.reserved) {
          throw new Error(
            `E4-R97: reservation ${reservationId} reserved ${entry.reserved} call(s) but reports ${consumed} consumed — the budget must be reserved BEFORE the call, so an overrun is a caller defect`,
          );
        }
        const entries = [...ledger.entries];
        entries[i] = { ...entry, status: "committed", consumed, transportRetries };
        const next: R97LedgerFile = { ...ledger, entries };
        return { next, result: viewOfR97Ledger(next) };
      });
    },

    async abandon(reservationId: string): Promise<R97LedgerView> {
      return withLedger((ledger) => {
        const i = ledger.entries.findIndex((e) => e.reservationId === reservationId);
        if (i < 0) throw new Error(`E4-R97: no reservation ${reservationId} to abandon`);
        const entry = ledger.entries[i]!;
        if (entry.status !== "reserved") {
          throw new Error(`E4-R97: reservation ${reservationId} is already ${entry.status} — only an outstanding reservation can be abandoned`);
        }
        const entries = [...ledger.entries];
        entries[i] = { ...entry, status: "abandoned", consumed: 0 };
        const next: R97LedgerFile = { ...ledger, entries };
        return { next, result: viewOfR97Ledger(next) };
      });
    },

    async markUnknown(reservationId: string): Promise<R97LedgerView> {
      return withLedger((ledger) => {
        const i = ledger.entries.findIndex((e) => e.reservationId === reservationId);
        if (i < 0) throw new Error(`E4-R97: no reservation ${reservationId} to mark unknown`);
        const entry = ledger.entries[i]!;
        if (entry.status !== "reserved") {
          throw new Error(
            `E4-R97: reservation ${reservationId} is already ${entry.status} — only an outstanding reservation can be marked unknown`,
          );
        }
        const entries = [...ledger.entries];
        // `consumed: null` matches the parser's (status, consumed) contract for
        // `unknown`: the amount is the RESERVED count (see `viewOfR97Ledger`),
        // and the allowance is deliberately not returned.
        entries[i] = { ...entry, status: "unknown", consumed: null };
        const next: R97LedgerFile = { ...ledger, entries };
        return { next, result: viewOfR97Ledger(next) };
      });
    },

    async recover(): Promise<{ unknown: number; view: R97LedgerView }> {
      return withLedger((ledger) => {
        let unknown = 0;
        const entries = ledger.entries.map((e) => {
          if (e.status !== "reserved") return e;
          if (isAlive(e.pid)) return e; // still in flight in another live process
          unknown += 1;
          // The allowance is NOT returned: a dispatched attempt may have been
          // billed, and only a human decision may resolve it.
          return { ...e, status: "unknown" as const, consumed: null };
        });
        const next: R97LedgerFile = { ...ledger, entries };
        return { next, result: { unknown, view: viewOfR97Ledger(next) } };
      });
    },
  };
}
