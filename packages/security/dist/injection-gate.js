/**
 * Issue 6: prompt-injection detection gate for memory and skill persistence.
 *
 * Two-tier detection (structured, not naive substring — same discipline as
 * the network gate):
 *
 * - HARD patterns: unambiguous instruction-hijack families (dismissing
 *   previous instructions, overriding the system prompt, extracting the
 *   prompt, role-reversal, restriction bypass). Any hit denies the content.
 * - SOFT signals: directive framing combined with a command payload, plus
 *   standalone trap markers (decode-and-run, authority notices). These only
 *   produce flags and never deny: legitimate procedural lessons ("you must
 *   run node test.js to complete the task") share this shape.
 *
 * Scanning is line-aware so one poisoned line cannot hide inside otherwise
 * benign prose, and case-insensitive so casing tricks do not bypass it.
 */
/** Instruction-hijack families: any hit denies the content. */
const HARD_PATTERNS = [
    {
        name: "dismiss-previous-instructions",
        re: /\bignore\b.*\b(previous|prior|above|earlier)\b.*\b(instructions?|messages?|prompts?|context|directives?|guidelines?)\b/,
    },
    {
        name: "dismiss-all-instructions",
        re: /\bignore\b.*\b(all|any)\b.*\b(instructions?|prompts?|messages?|directives?|guidelines?)\b/,
    },
    {
        name: "override-own-instructions",
        re: /\b(ignore|disregard|forget|override|replace|erase|discard|delete|drop|skip|undo)\b.*\b(your|the|its|all (the )?|all of (the )?)?(previous |prior |above )?(instructions?|guidelines?|directives?|prompts?|system prompt)\b/,
    },
    {
        name: "extract-system-prompt",
        re: /\b(reveal|print|show|display|leak|share|repeat|output|give me|tell me)\b.*\b(your|the|its|all of your)\b.*\b(system prompt|instructions?|guidelines?|directives?|initial prompt|base prompt)\b/,
    },
    {
        name: "interrogate-instructions",
        re: /\bwhat (are|is) (your|its) (instructions?|guidelines?|directives?|rules)|what (is|are) (your|its|the) system prompt\b/,
    },
    {
        name: "jailbreak-now",
        re: /\b(you are now|from now on you are|now you are)\b.*\b(an |a )?(unrestricted|uncensored|unshackled|unlimited (ai|assistant|agent|model)|free (ai|assistant|agent|model)|free of (all )?(rules|restrictions|constraints|limits)|the (new |real )?(system|ai|assistant))\b/,
    },
    {
        name: "no-constraints",
        re: /\byou (have|are) (no|free of|without)\b.*\b(rules|restrictions|constraints|limits|instructions)\b/,
    },
    {
        name: "bypass-as-ai",
        re: /\bas an ai\b.*\b(ignore|disregard|bypass|override|skip|violate|break)\b/,
    },
    {
        name: "pretend-unbound",
        re: /\b(pretend|imagine) (you are|you're)\b.*\b(bound by|subject to|limited by)\b.*\b(rules|restrictions|constraints|instructions)\b/,
    },
    {
        name: "role-reversal",
        re: /\b(act|behave|respond) (as|like)\b.*\b(a |an |different |new |unrestricted |uncensored )?(assistant|ai|agent|model|chatbot)\b/,
    },
    // P0-8: low-trust content must not fake authority by impersonating the
    // system/developer channel. Line-anchored because the scanner tests each
    // line in isolation; a "SYSTEM:"/"DEVELOPER:" prefix on a line of
    // untrusted content is an authority-claim signal by itself.
    {
        name: "fake-system-prefix",
        re: /^\s*system\s*[:：]/,
    },
    {
        name: "fake-developer-prefix",
        re: /^\s*developer\s*[:：]/,
    },
];
/** Directive framing that makes a line with a command payload suspicious. */
const SOFT_FRAMING = [
    { name: "authority-notice", re: /\bauthority notice\b/ },
    { name: "you-must", re: /\byou must\b/ },
    { name: "you-are-instructed", re: /\byou are (required|instructed|obligated)\b/ },
    { name: "mandatory", re: /\bit is (mandatory|required|critical|essential)\b/ },
    { name: "important", re: /\bimportant\b/ },
    { name: "before-task", re: /\bbefore starting (any |the )?(task|work)\b/ },
    { name: "to-complete", re: /\bto complete the (task|work|job)\b/ },
    { name: "final-instruction", re: /\bfinal instruction\b/ },
    { name: "urgent", re: /\burgent\b|\bimmediately\b/ },
];
/** Command-like payloads; only suspicious together with framing. */
const SOFT_PAYLOAD = [
    { name: "execute", re: /\bexecute\b/ },
    { name: "run", re: /\brun \b/ },
    { name: "curl-wget", re: /\b(curl |wget |nc |netcat)\b/ },
    { name: "delete", re: /\b(rm -|delete the (workspace|project|repository))\b/ },
    { name: "transfer", re: /\b(upload|download|exfiltrat|send it to|post it to|clear history|erase)\b/ },
    { name: "encoded", re: /\bbase64\b/ },
];
/** Trap markers that flag a line on their own. */
const SOFT_STANDALONE = [
    { name: "decode-and-run", re: /\bdecode(-and-| and )?run\b/ },
    { name: "authority-notice", re: /\bauthority notice\b/ },
    { name: "before-task", re: /\bbefore starting any task\b/ },
    { name: "new-system-prompt", re: /\bnew system prompt\b/ },
    { name: "hidden-script", re: /\bhidden (script|instructions?|commands?)\b/ },
];
export function detectPromptInjection(content) {
    const reasons = [];
    const flags = [];
    const seen = new Set();
    const add = (out, name) => {
        if (!seen.has(name)) {
            seen.add(name);
            out.push(name);
        }
    };
    for (const line of content.split(/\r?\n/)) {
        const lower = line.toLowerCase();
        if (lower.trim() === "")
            continue;
        for (const { name, re } of HARD_PATTERNS) {
            if (re.test(lower))
                add(reasons, name);
        }
        const hasFraming = SOFT_FRAMING.some(({ name, re }) => re.test(lower));
        const hasPayload = SOFT_PAYLOAD.some(({ name, re }) => re.test(lower));
        if (hasFraming && hasPayload) {
            add(flags, "directive-payload");
            for (const { name, re } of SOFT_FRAMING) {
                if (re.test(lower))
                    add(flags, name);
            }
            for (const { name, re } of SOFT_PAYLOAD) {
                if (re.test(lower))
                    add(flags, name);
            }
        }
        for (const { name, re } of SOFT_STANDALONE) {
            if (re.test(lower))
                add(flags, name);
        }
    }
    return { hasInjection: reasons.length > 0, reasons, flags };
}
//# sourceMappingURL=injection-gate.js.map