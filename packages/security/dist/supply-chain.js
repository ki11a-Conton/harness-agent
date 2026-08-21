const INSTALL_CMDS = {
    npm: ["install", "i", "ci"],
    npx: ["install"],
    pnpm: ["install", "add", "i"],
    yarn: ["install", "add"],
    bun: ["install", "add"],
    deno: ["install", "add"],
    pip: ["install", "download"],
    pip3: ["install", "download"],
    pipx: ["install"],
    uv: ["pip", "add", "install"],
    poetry: ["install", "add"],
    pipenv: ["install", "sync"],
    pipelint: [],
    "pip-tools": ["compile", "sync"],
    cargo: ["add", "install", "update"],
    go: ["get", "mod"],
    dotnet: ["add"],
    gem: ["install"],
    composer: ["install", "require", "update"],
    apt: ["install", "update", "upgrade"],
    "apt-get": ["install", "update", "upgrade"],
    brew: ["install", "update", "upgrade"],
};
/** curl | sh style remote-exec. Pipe detection is PRECEDENCE-1 (before install)
 *  so `curl https://x/script | sh` is remote_code_execution, never "command". */
const REMOTE_EXEC_RE = /\b(?:curl|wget|aria2c)\b[^|&;\n]*\|\s*(?:sudo\s+)?(?:bash|sh|zsh|dash|fish)\b/i;
const REMOTE_EXEC_SUBSHELL_RE = /\b(?:bash|sh|zsh|dash)\b[^|&\n]*<\(\s*(?:sudo\s+)?(?:curl|wget)\b/i;
/** Split into pipe-free leading argv0 + first non-option token. */
function verbOf(command) {
    const m = /^\s*([^\s|&;]+)\s+(-[^\s]+ )*([^\s|&;]+)/.exec(command) ?? /^\s*([^\s|&;]+)/.exec(command);
    if (!m)
        return { argv0: null, verb: null };
    const argv0 = m[1].replace(/\\/g, "/").split("/").pop().toLowerCase();
    const verb = m[3] !== undefined ? m[3].toLowerCase() : null;
    return { argv0, verb };
}
/** Classify a command string against the supply-chain categories. */
export function classifySupplyChain(command) {
    if (typeof command !== "string")
        return "command";
    if (REMOTE_EXEC_RE.test(command) || REMOTE_EXEC_SUBSHELL_RE.test(command)) {
        return "remote_code_execution";
    }
    const { argv0, verb } = verbOf(command);
    if (argv0 !== null && verb !== null && Object.prototype.hasOwnProperty.call(INSTALL_CMDS, argv0)) {
        const verbs = INSTALL_CMDS[argv0];
        if (verbs.includes(verb) || verbs.includes(verb.split("/")[0])) {
            return "dependency_install";
        }
        // `go mod download`, `uv pip install`, `dotnet add package`
        if (argv0 === "go" && verb === "mod")
            return "dependency_install";
        if (argv0 === "uv" && verb === "pip")
            return "dependency_install";
    }
    return "command";
}
export function supplyChainRisk(category) {
    return category === "remote_code_execution" ? "critical" : "elevated";
}
//# sourceMappingURL=supply-chain.js.map