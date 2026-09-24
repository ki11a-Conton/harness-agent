/**
 * E4-R98-A — THE CAMPAIGN LIFECYCLE: one durable root per authorization.
 *
 * WHY THIS MODULE EXISTS (plan T1 / finding N2, priority P1)
 * ---------------------------------------------------------
 * MEASURED DEFECT N2 (plan §0.2):
 *
 *   "driver 打开 ledger 未传 mode；worker 显式 `mode:"auto"`；driver 不消费
 *    `duplicateCampaignDirs` … 同授权换目录仍可获得新预算，重启后缺失账本也可能按首次
 *    创建处理."
 *
 * The budget ledger already refused a foreign or damaged file, and it already
 * RECORDED when a second directory claimed the same authorization. But the
 * ledger is DIRECTORY-LOCAL: a fresh directory B has, by construction, no way to
 * observe a ledger sitting in A, and the only cross-directory evidence was an
 * ADVISORY claim anchor in a temp directory that the plan explicitly says must
 * not be the sole authority:
 *
 *   §T1 怎么做 7: "固定 campaign 根目录及 header 合同 … 单纯换 --out/--ledger 必须
 *   拒绝或要求新授权. 临时目录里的 advisory claim 不能是唯一权威状态."
 *
 * This module adds the missing durable fact: a CAMPAIGN HEADER written INSIDE the
 * campaign directory, recording the authorization it belongs to and the ROOT it
 * was created at. That makes three previously-invisible situations detectable:
 *
 *   1. A restart whose ledger was deleted, while the header survives. The header
 *      proves a campaign was ESTABLISHED here, so a missing ledger is
 *      BUDGET_STATE_MISSING — never a fresh allowance (§T1 怎么验收: "同一目录重启前
 *      删除 ledger、保留 header/状态：拒绝且 0 调用").
 *   2. A copy/relocation of an established campaign into a new directory. The
 *      header records the ORIGINAL root, so the new directory is refused with
 *      CAMPAIGN_ROOT_MISMATCH rather than adopting a foreign budget.
 *   3. A brand-new directory claiming an authorization another directory already
 *      established, which the ledger's advisory anchor records and this module
 *      now ENFORCES (CAMPAIGN_DIR_CONFLICT) instead of merely reporting.
 *
 * ORDER IS THE CONTRACT: the header is written BEFORE the ledger is opened for
 * creation. If the process dies between the two, the next run sees a header with
 * no ledger and refuses (case 1) — it never sees a ledger with no header, which
 * is the direction that would silently mint a second allowance.
 *
 * WHAT THIS IS NOT: it is not a second lock, not a second ledger, and not a
 * defence against an operator who deletes the ENTIRE campaign directory AND the
 * machine-global claim anchor. The plan states that boundary explicitly (§T1 怎么做
 * 9: "不承诺能防御操作者删除整个机器所有证据"), and this module keeps to it: it
 * guarantees that the NORMAL start / resume / relocate paths cannot re-grant one
 * authorization.
 *
 * FINDING F2 (plan §A2) — the boundary above was measured to be crossed by ONE
 * `rm -rf` of the campaign root, which is an ordinary cleanup, not an attack on
 * every piece of evidence on the machine. The claim anchor survives that, and it
 * now records which directories ESTABLISHED a budget, so a vanished root is a
 * named LOSS (CAMPAIGN_STATE_LOST) instead of a fresh full allowance. The honest
 * limit is unchanged: deleting the campaign root AND the claim anchor is still
 * indistinguishable from a genuinely new authorization, and the plan does not ask
 * for more.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  campaignIdOf,
  openR97BudgetLedger,
  readR97CampaignClaim,
  readR97LedgerFile,
  R97_CAMPAIGN_STATE_LOST,
  type R97BudgetLedger,
  type R97LedgerOpenMode,
} from "./r97-budget-ledger.js";
import { openR97ExecutionState, type R97ExecutionState } from "./r97-execution-state.js";

export const R97_CAMPAIGN_HEADER_SCHEMA = "e4-r97-campaign-header-v1";
export const R97_CAMPAIGN_HEADER_FILENAME = "campaign-header.json";

/** The header exists and vouches for this campaign, but the budget it describes
 *  is gone: an established campaign whose allowance cannot be read. */
export const R97_CAMPAIGN_HEADER_MISSING = "CAMPAIGN_HEADER_MISSING";
/** The header is present but unreadable or structurally invalid. */
export const R97_CAMPAIGN_HEADER_CORRUPT = "CAMPAIGN_HEADER_CORRUPT";
/** This authorization is already established in a DIFFERENT directory. */
export const R97_CAMPAIGN_DIR_CONFLICT = "CAMPAIGN_DIR_CONFLICT";
/** The header records a different root than the directory it was found in. */
export const R97_CAMPAIGN_ROOT_MISMATCH = "CAMPAIGN_ROOT_MISMATCH";

/**
 * The durable identity of one campaign ROOT.
 *
 * Every field is a fact about the AUTHORIZATION or the LOCATION, never a
 * measurement: this file answers "is this the same campaign?" and nothing else.
 */
export interface R97CampaignHeader {
  schemaVersion: string;
  /** Derived from `(planDigest, campaignModelCalls)` — see `campaignIdOf`. */
  campaignId: string;
  planDigest: string;
  campaignModelCalls: number;
  /** The ABSOLUTE, normalised directory this campaign was created in. */
  rootDir: string;
  createdAt: number;
}

/** Read a campaign header. `null` = absent. Throws on a present-but-unreadable
 *  file: a damaged header must never be mistaken for "no campaign here", which
 *  is precisely how a second allowance would get minted. */
export async function readR97CampaignHeader(dir: string): Promise<R97CampaignHeader | null> {
  let text: string;
  try {
    text = await readFile(join(dir, R97_CAMPAIGN_HEADER_FILENAME), "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`E4-R97: ${R97_CAMPAIGN_HEADER_CORRUPT}: the campaign header in ${dir} is not valid JSON`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`E4-R97: ${R97_CAMPAIGN_HEADER_CORRUPT}: the campaign header in ${dir} is not a JSON object`);
  }
  const o = raw as Record<string, unknown>;
  if (o["schemaVersion"] !== R97_CAMPAIGN_HEADER_SCHEMA) {
    throw new Error(
      `E4-R97: ${R97_CAMPAIGN_HEADER_CORRUPT}: the campaign header in ${dir} declares schemaVersion ${JSON.stringify(o["schemaVersion"])}, not ${R97_CAMPAIGN_HEADER_SCHEMA}`,
    );
  }
  const campaignId = o["campaignId"];
  const planDigest = o["planDigest"];
  const rootDir = o["rootDir"];
  if (typeof campaignId !== "string" || campaignId === "") {
    throw new Error(`E4-R97: ${R97_CAMPAIGN_HEADER_CORRUPT}: the campaign header in ${dir} has no campaignId`);
  }
  if (typeof planDigest !== "string" || planDigest === "") {
    throw new Error(`E4-R97: ${R97_CAMPAIGN_HEADER_CORRUPT}: the campaign header in ${dir} has no planDigest`);
  }
  if (typeof rootDir !== "string" || rootDir === "") {
    throw new Error(`E4-R97: ${R97_CAMPAIGN_HEADER_CORRUPT}: the campaign header in ${dir} has no rootDir`);
  }
  const grant = o["campaignModelCalls"];
  if (typeof grant !== "number" || !Number.isSafeInteger(grant) || grant < 0) {
    throw new Error(`E4-R97: ${R97_CAMPAIGN_HEADER_CORRUPT}: the campaign header in ${dir} has an invalid campaignModelCalls`);
  }
  return {
    schemaVersion: R97_CAMPAIGN_HEADER_SCHEMA,
    campaignId,
    planDigest,
    campaignModelCalls: grant,
    rootDir,
    createdAt: typeof o["createdAt"] === "number" ? o["createdAt"] : 0,
  };
}

/** Write the header atomically, so a partially written file is never readable
 *  as a valid one (the same rule the ledger and the execution state follow). */
async function writeHeaderAtomic(dir: string, header: R97CampaignHeader): Promise<void> {
  const tmp = join(dir, `${R97_CAMPAIGN_HEADER_FILENAME}.tmp-${process.pid}-${Date.now()}`);
  await writeFile(tmp, `${JSON.stringify(header, null, 2)}\n`, "utf8");
  await rename(tmp, join(dir, R97_CAMPAIGN_HEADER_FILENAME));
}

export interface R97CampaignOpenOptions {
  planDigest: string;
  campaignModelCalls: number;
  /**
   * `"first-run"` — the caller is STARTING the campaign. It may create the
   *   header and the ledger, but ONLY in a directory that no other directory has
   *   claimed for this authorization, and never over an existing header that
   *   describes a different root.
   * `"resume"` — the caller is RECOVERING it. The header AND the ledger must both
   *   already exist, and both must match this authorization. Nothing is created.
   * `"auto"` — FAILS CLOSED by choosing between the two from what is on disk. A
   *   missing header means no campaign was established here, so it behaves as
   *   `"first-run"`; a present header means the campaign IS established, so it
   *   behaves as `"resume"` and refuses a missing ledger instead of creating one.
   *   This is the mode the driver uses, and it is why a deleted ledger is a
   *   refusal rather than a fresh allowance.
   */
  mode?: R97LedgerOpenMode;
  now?: () => number;
  /** Test seam: the claim anchor directory is machine-global, so tests point it
   *  at a scratch location through the ledger's own env override. */
  isAlive?: (pid: number) => boolean;
}

export interface R97Campaign {
  readonly dir: string;
  readonly planDigest: string;
  readonly campaignId: string;
  /** How this open resolved: `"first-run"` created the campaign here,
   *  `"resume"` adopted the existing one. */
  readonly mode: "first-run" | "resume";
  readonly header: R97CampaignHeader;
  /** Other directories that have claimed this SAME authorization. Non-empty
   *  means the same approval looks spent somewhere else — see the ledger's
   *  advisory anchor. `mode: "first-run"` already REFUSES in that case; this is
   *  exposed so a resumed campaign can still report it. */
  readonly duplicateCampaignDirs: readonly string[];
  readonly ledger: R97BudgetLedger;
  /**
   * The durable case×arm×repetition state, created in the SAME ordered step as
   * the header and the ledger.
   *
   * It is part of the campaign handle because "established" must mean all three
   * artifacts exist. A lazily-created state file would leave a window in which a
   * fully authorized campaign has no state, making a resume there
   * indistinguishable from a DELETED state file — the loss the store refuses.
   */
  readonly execState: R97ExecutionState;
}

/**
 * Open a campaign root: validate the durable header, then open the budget under
 * the matching mode.
 *
 * The order is deliberate and is the whole guarantee: the HEADER is consulted
 * and (on a genuine first run) written BEFORE the ledger can be created, so the
 * only reachable "header without ledger" state is a refusal, never a new
 * allowance.
 */
export async function openR97Campaign(dir: string, opts: R97CampaignOpenOptions): Promise<R97Campaign> {
  const root = resolve(dir);
  const now = opts.now ?? (() => Date.now());
  const mode: R97LedgerOpenMode = opts.mode ?? "auto";
  const campaignId = campaignIdOf(opts.planDigest, opts.campaignModelCalls);

  await mkdir(root, { recursive: true });

  // A damaged header throws here, before anything can be created.
  const header = await readR97CampaignHeader(root);
  const ledgerFile = await readR97LedgerFile(root);

  // ---- What is on disk decides the resolved mode for `auto`. --------------
  const established = header !== null;
  const resolvedMode: "first-run" | "resume" = mode === "resume" ? "resume" : mode === "first-run" ? "first-run" : established ? "resume" : "first-run";

  // ---- 1. The header must agree with the authorization and the location. ---
  if (header !== null) {
    if (header.campaignId !== campaignId || header.planDigest !== opts.planDigest || header.campaignModelCalls !== opts.campaignModelCalls) {
      throw new Error(
        `E4-R97: BUDGET_STATE_MISMATCH: the campaign header in ${root} belongs to a different authorization (campaign ${header.campaignId}, plan ${header.planDigest}, grant ${header.campaignModelCalls}) than this run (campaign ${campaignId}, plan ${opts.planDigest}, grant ${opts.campaignModelCalls})`,
      );
    }
    // A header that names a DIFFERENT root means this directory holds a COPY of
    // another campaign's state. Adopting it would spend one authorization in two
    // places, so it is refused by name.
    if (header.rootDir !== root) {
      throw new Error(
        `E4-R97: ${R97_CAMPAIGN_ROOT_MISMATCH}: the campaign header in ${root} records root ${header.rootDir}, not this directory — a relocated campaign may not adopt another root's budget; resume it at its own root, or start a new authorization`,
      );
    }
  }

  // ---- 2. An established campaign with no budget is a LOSS, not a fresh start.
  if (established && ledgerFile === null) {
    throw new Error(
      `E4-R97: BUDGET_STATE_MISSING: ${root} holds an established campaign header for this authorization but no ${"budget-ledger.json"} — refusing to treat a lost budget as a fresh full allowance; restore the ledger, or start a new authorization`,
    );
  }

  // ---- 3. A ledger with no header cannot be proven to belong here. --------
  // (Only reachable for a file written before this header existed, or by hand.)
  if (!established && ledgerFile !== null) {
    throw new Error(
      `E4-R97: ${R97_CAMPAIGN_HEADER_MISSING}: ${root} holds a budget ledger that no campaign header vouches for — a budget whose campaign root cannot be established is refused rather than adopted; restore the header, or start a new authorization`,
    );
  }

  // ---- 4. A resume must find an established campaign. ---------------------
  if (mode === "resume" && !established) {
    throw new Error(
      `E4-R97: ${R97_CAMPAIGN_HEADER_MISSING}: mode "resume" requires an established campaign but ${root} holds no campaign header — a resume must never create one`,
    );
  }

  // ---- 5. A NEW root for an already-claimed authorization is a conflict. ---
  // This is the plan's §T1 怎么做 8 requirement that `duplicateCampaignDirs`
  // AFFECT the outcome rather than sit unused on a handle.
  //
  // FINDING F2 (plan §A2): the rule below used to refuse ONLY while the claiming
  // directory was still READABLE. That made the refusal depend on the one thing
  // an operator deletes: `rm -rf out` turned an authorization that had already
  // SPENT its allowance back into a first run, with a full second budget. The
  // anchor is the durable record of "this approval established a campaign", so it
  // — not the presence of the directory — decides.
  //
  // The distinction that keeps this honest: a directory that was only PROBED
  // (an open that recorded the claim but never created a budget) is still safely
  // ignorable, so a failed first run cannot wedge the authorization forever. Only
  // an ESTABLISHED claim is authoritative.
  let duplicateCampaignDirs: readonly string[] = [];
  if (resolvedMode === "first-run") {
    const claim = await readR97CampaignClaim(campaignId);
    if (claim !== null) {
      const others = claim.claimedDirs.filter((d) => resolve(d) !== root);
      const live = [];
      for (const other of others) {
        // A directory that cannot be read, or that holds no matching header, is
        // not a live campaign.
        let otherHeader: R97CampaignHeader | null = null;
        try {
          otherHeader = await readR97CampaignHeader(other);
        } catch {
          // A CORRUPT header elsewhere is still evidence that SOMETHING is
          // there; treat it as live rather than silently ignoring it.
          live.push(other);
          continue;
        }
        if (otherHeader !== null && otherHeader.campaignId === campaignId) live.push(other);
      }
      duplicateCampaignDirs = live;
      if (live.length > 0) {
        throw new Error(
          `E4-R97: ${R97_CAMPAIGN_DIR_CONFLICT}: this authorization (campaign ${campaignId}) is already established in ${live.join(", ")} — starting it again in ${root} would grant a SECOND budget for one approval; resume it at its own root, or use a new authorization`,
        );
      }

      // Nothing is LIVE, so this open would CREATE a budget. If the anchor says
      // this approval already established one — HERE (the path was deleted and
      // recreated) or ELSEWHERE (the other root was deleted) — that is a LOSS of
      // the consumption record, not a fresh start.
      const lostHere = claim.establishedDirs.some((d) => resolve(d) === root);
      const lostElsewhere = claim.establishedDirs.filter((d) => resolve(d) !== root);
      const lost = lostHere ? [root, ...lostElsewhere] : lostElsewhere;
      if (lost.length > 0) {
        throw new Error(
          `E4-R97: ${R97_CAMPAIGN_STATE_LOST}: this authorization (campaign ${campaignId}) already ESTABLISHED a campaign in ${lost.join(", ")}, and no campaign header is readable there now — a deleted root is a LOSS of the consumed record, not a fresh allowance; restore that campaign, or use a new authorization`,
        );
      }
    }
  }

  // ---- 6. Write the header FIRST on a first run, then open the budget. ----
  let effectiveHeader: R97CampaignHeader;
  if (resolvedMode === "first-run") {
    effectiveHeader = {
      schemaVersion: R97_CAMPAIGN_HEADER_SCHEMA,
      campaignId,
      planDigest: opts.planDigest,
      campaignModelCalls: opts.campaignModelCalls,
      rootDir: root,
      createdAt: now(),
    };
    await writeHeaderAtomic(root, effectiveHeader);
  } else {
    // Non-null by the checks above: a resume without a header already threw.
    effectiveHeader = header!;
  }

  // The ledger is opened in the SAME resolved mode, so the two can never
  // disagree about whether this is a creation or a recovery.
  const ledger = await openR97BudgetLedger(root, {
    planDigest: opts.planDigest,
    campaignModelCalls: opts.campaignModelCalls,
    mode: resolvedMode,
    now,
    ...(opts.isAlive === undefined ? {} : { isAlive: opts.isAlive }),
    // The header is the authoritative "a campaign is established HERE" fact, so
    // the ledger's claim-liveness test is delegated to it. That is strictly
    // stronger than the ledger's default (a ledger file existing): a directory
    // holding a stale ledger whose header is gone or names another root is not a
    // live campaign.
    isLiveClaimDir: async (otherDir, id) => {
      try {
        const other = await readR97CampaignHeader(otherDir);
        return other !== null && other.campaignId === id;
      } catch {
        return true; // a damaged header elsewhere is still evidence of presence
      }
    },
  });

  // The ledger's own cross-directory evidence is surfaced on the handle. On a
  // resume this is the only place the conflict is visible, because a resume is
  // legitimate at the root the header names.
  if (resolvedMode === "resume" && duplicateCampaignDirs.length === 0) {
    duplicateCampaignDirs = ledger.duplicateCampaignDirs;
  }

  // ---- 7. Establish the CASE STATE in the SAME ordered step. --------------
  //
  // ORDER IS THE CONTRACT, and this is the last part of it. The execution state
  // is what proves which units already ran, so "the state file is missing" must
  // mean "it was DELETED", never "this campaign never got that far". If the
  // state were created lazily — by the driver, on its way to the first unit —
  // there would be a window in which a fully authorized campaign (header +
  // ledger on disk) had no state file, and a resume inside that window would be
  // indistinguishable from a deleted state file. Creating it HERE, in the same
  // ordered sequence as the header and the ledger, closes that window by
  // construction: an established campaign always has all three artifacts.
  //
  // A resume re-opens the existing state in the SAME resolved mode, so a state
  // file that really has gone missing is the named EXEC_STATE_MISSING refusal
  // rather than a silently blank slate.
  const execState = await openR97ExecutionState(root, {
    experimentId: opts.planDigest,
    planDigest: opts.planDigest,
    mode: resolvedMode,
  });

  return {
    dir: root,
    planDigest: opts.planDigest,
    campaignId,
    mode: resolvedMode,
    header: effectiveHeader,
    duplicateCampaignDirs,
    ledger,
    execState,
  };
}
