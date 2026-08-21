/**
 * Phase 9 network gate: structured detection of network intent in exec
 * commands. This is NOT a naive substring scan of the command text — the
 * command is tokenized with shell quoting/separator awareness, and each
 * classification (binary / subcommand / URL literal / interpreter inline
 * code / encoded shell) is checked at its correct position, so benign
 * lookalikes (`echo curl`, `type curl.md`, `git status`) stay allowed.
 *
 * The gate is a best-effort static classifier: commands like `node script.js`
 * whose network activity lives inside a file are only caught when a URL or
 * host literal appears in the argument list. OS-level network namespaces are
 * out of scope for this harness.
 */
/** Network-capable executables, matched by basename at command position only. */
const NETWORK_BINARIES = new Set([
    "curl",
    "wget",
    "wget2",
    "aria2c",
    "nc",
    "netcat",
    "ncat",
    "socat",
    "telnet",
    "ssh",
    "ssh-copy-id",
    "scp",
    "sftp",
    "ftp",
    "rlogin",
    "rsh",
    "wscat",
    "ping",
    "ping6",
    "traceroute",
    "tracert",
    "pathping",
    "nslookup",
    "dig",
    "getent",
    "whois",
    "rclone",
    "s3cmd",
    "lynx",
    "w3m",
    "elinks",
    "links",
    "httpie",
    "rsync",
    "iwr",
    "irm",
    "test-netconnection",
    "invoke-webrequest",
    "invoke-restmethod",
    "start-bitstransfer",
    // P2-24: PS remoting commandlets (aliases/equivalents of network ops).
    "invoke-command",
    "enter-pssession",
    "connect-wsman",
    "new-pssession",
    // P2-24: package executors that fetch/resolve packages from a registry.
    "npx",
    "pnpx",
    "bunx",
]);
/** Python modules that, when run via `-m`, perform network I/O. */
const MODULE_NETWORK = new Set([
    "http.server",
    "https.server",
    "socketserver",
    "urllib",
    "http.client",
    "ftplib",
    "smtplib",
    "telnetlib",
    "SimpleHTTPServer",
    "requests",
    "aiohttp",
    "pip",
    "pipenv",
]);
/** Commands whose subcommand selects a network operation. */
const NETWORK_SUBCOMMANDS = {
    git: ["fetch", "pull", "push", "clone", "ls-remote", "submodule"],
    npm: ["install", "i", "add", "publish", "download", "ci", "update"],
    pip: ["install", "download", "search"],
    pip3: ["install", "download", "search"],
    pnpm: ["add", "install", "publish"],
    yarn: ["add", "install", "publish"],
    docker: ["pull", "push", "login", "build"],
    cargo: ["add", "publish", "update"],
    go: ["get"],
    bun: ["add", "install", "uninstall", "remove", "update", "link", "unlink", "x"],
    deno: ["install", "add", "cache", "vendor", "info", "uninstall"],
    uv: ["add", "install", "pip"],
};
/** Shell wrappers that execute a nested command string (recursion targets). */
const WRAPPERS = {
    cmd: ["/c", "/k"],
    bash: ["-c"],
    sh: ["-c"],
    zsh: ["-c"],
    ksh: ["-c"],
    dash: ["-c"],
    pwsh: ["-c", "-Command", "-EncodedCommand"],
    powershell: ["-c", "-Command", "-EncodedCommand"],
    ps: ["-c", "-Command", "-EncodedCommand"],
};
/** Interpreters whose -e/-c/-r argument can contain inline network code. */
const INLINE_INTERPRETERS = {
    node: {
        flags: ["-e", "-p", "--eval"],
        markers: ["fetch(", "http.request", "https.request", "http.get", "https.get", "net.connect", "net.createConnection", "net.Socket", "WebSocket(", "XMLHttpRequest"],
    },
    python: {
        flags: ["-c"],
        markers: ["urllib", "requests.", "http.client", "socket.socket", "aiohttp", "httpx.", "smtplib", "ftplib", "telnetlib"],
    },
    python3: {
        flags: ["-c"],
        markers: ["urllib", "requests.", "http.client", "socket.socket", "aiohttp", "httpx.", "smtplib", "ftplib", "telnetlib"],
    },
    py: {
        flags: ["-c"],
        markers: ["urllib", "requests.", "http.client", "socket.socket", "aiohttp", "httpx.", "smtplib", "ftplib", "telnetlib"],
    },
    ruby: {
        flags: ["-e"],
        markers: ["Net::HTTP", "Net::FTP", "TCPSocket", "Socket.tcp"],
    },
    perl: {
        flags: ["-e"],
        markers: ["LWP::", "HTTP::", "IO::Socket"],
    },
    php: {
        flags: ["-r"],
        markers: ["file_get_contents(\"http", "file_get_contents('http", "curl_", "fsockopen", "stream_socket_client"],
    },
    pwsh: {
        flags: ["-c", "-Command"],
        markers: ["Invoke-WebRequest", "iwr", "Invoke-RestMethod", "irm", "Test-NetConnection", "WebClient", "HttpClient", "TcpClient", "Start-BitsTransfer", "New-Object System.Net"],
    },
    powershell: {
        flags: ["-c", "-Command"],
        markers: ["Invoke-WebRequest", "iwr", "Invoke-RestMethod", "irm", "Test-NetConnection", "WebClient", "HttpClient", "TcpClient", "Start-BitsTransfer", "New-Object System.Net"],
    },
    ps: {
        flags: ["-c", "-Command"],
        markers: ["Invoke-WebRequest", "iwr", "Invoke-RestMethod", "irm", "Test-NetConnection", "WebClient", "HttpClient", "TcpClient", "Start-BitsTransfer", "New-Object System.Net"],
    },
};
const URL_SCHEMES = new Set(["http", "https", "ftp", "ftps", "ws", "wss", "ssh", "git", "tcp", "udp", "telnet", "sftp", "smtp", "nntp", "irc"]);
const INFO_FLAGS = new Set(["--help", "-h", "/?", "--version", "-help"]);
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\/([^/\s'"<>]+)/i;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const HOST_PORT_RE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}:\d{1,5}$/i;
const LOCALHOST_PORT_RE = /^localhost:\d{1,5}$/i;
const BLOB_URL_RE = /(?:https?|ftp|ws|wss|ssh|git):\/\/[^\s'"<>`)\]]+/gi;
const BLOB_IP_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const SEPARATORS = new Set(["&", "|", ";", "<", ">", "(", ")"]);
/** Shell-aware tokenizer: quote-aware; `& | ; < > ( )` start a new command. */
function tokenize(command) {
    const tokens = [];
    let buf = "";
    let quote = null;
    let atCommandStart = true;
    let inWord = false;
    const flush = () => {
        if (!inWord)
            return;
        tokens.push({ text: buf, isCommandStart: atCommandStart });
        buf = "";
        inWord = false;
        atCommandStart = false;
    };
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (quote !== null) {
            if (ch === quote) {
                quote = null;
                inWord = true;
            }
            else {
                buf += ch;
            }
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            inWord = true;
            continue;
        }
        if (SEPARATORS.has(ch)) {
            flush();
            atCommandStart = true;
            continue;
        }
        if (/\s/.test(ch)) {
            flush();
            continue;
        }
        buf += ch;
        inWord = true;
    }
    flush();
    return tokens;
}
function basename(tok) {
    const t = tok.trim().toLowerCase();
    const slash = Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\"));
    let b = slash >= 0 ? t.slice(slash + 1) : t;
    if (b.endsWith(".exe") || b.endsWith(".com") || b.endsWith(".bat") || b.endsWith(".cmd")) {
        b = b.slice(0, b.lastIndexOf("."));
    }
    return b;
}
function detectUrlLiterals(text, report) {
    const schemeMatch = SCHEME_RE.exec(text);
    if (schemeMatch && URL_SCHEMES.has(schemeMatch[1].toLowerCase())) {
        const host = schemeMatch[2].split(/[/:?#]/, 1)[0].toLowerCase();
        report.hosts.push(host);
        report.reasons.push(`network URL: ${schemeMatch[0]}`);
        report.hasNetworkIntent = true;
        return;
    }
    if (IPV4_RE.test(text) || LOCALHOST_PORT_RE.test(text) || HOST_PORT_RE.test(text)) {
        const host = text.split(":", 1)[0].toLowerCase();
        report.hosts.push(host);
        report.reasons.push(`network host: ${text}`);
        report.hasNetworkIntent = true;
        return;
    }
    const devTcp = /\/dev\/(tcp|udp)\/([^/\s]+)/.exec(text);
    if (devTcp) {
        report.hosts.push(devTcp[2].toLowerCase());
        report.reasons.push(`/dev/${devTcp[1]} socket`);
        report.hasNetworkIntent = true;
        return;
    }
    // Fallback: unanchored URL / IP literal embedded inside a longer token
    // (e.g. a PowerShell expression). Only URL-bearing tokens are matched, so
    // benign lookalikes like `echo curl` / `file:README.md` are not affected.
    const urlHit = BLOB_URL_RE.exec(text);
    if (urlHit) {
        report.hosts.push(urlHost(urlHit[0]));
        report.reasons.push(`network URL: ${urlHit[0]}`);
        report.hasNetworkIntent = true;
        return;
    }
    const ipHit = BLOB_IP_RE.exec(text);
    if (ipHit) {
        report.hosts.push(ipHit[0]);
        report.reasons.push(`network host: ${ipHit[0]}`);
        report.hasNetworkIntent = true;
    }
}
/** Hostname from a full URL (strip scheme, stop at first delimiter). */
function urlHost(url) {
    return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/:?#]/, 1)[0].toLowerCase();
}
function scanInlineCode(blob, markers, report) {
    const lower = blob.toLowerCase();
    const hit = markers.some((m) => lower.includes(m));
    if (hit) {
        const reason = markers.find((m) => lower.includes(m));
        report.reasons.push(`inline network code (${reason})`);
    }
    for (const m of blob.matchAll(BLOB_URL_RE)) {
        report.hosts.push(urlHost(m[0]));
    }
    for (const m of blob.matchAll(BLOB_IP_RE)) {
        report.hosts.push(m[0]);
    }
    return hit || blob.includes("://");
}
function classifySegment(command, report, depth) {
    const tokens = tokenize(command);
    if (tokens.length === 0)
        return;
    for (let i = 0; i < tokens.length; i++) {
        if (!tokens[i].isCommandStart)
            continue;
        const argv0 = basename(tokens[i].text);
        const args = tokens.slice(i + 1);
        if (report.hasNetworkIntent)
            return;
        // 1. Shell wrapper: recurse into the nested command string.
        const wrapperFlags = WRAPPERS[argv0];
        if (wrapperFlags !== undefined && args.length > 0) {
            const flagIdx = args.findIndex((a) => wrapperFlags.includes(a.text));
            if (flagIdx >= 0) {
                if (args[flagIdx].text.toLowerCase() === "-encodedcommand") {
                    report.hasNetworkIntent = true;
                    report.reasons.push("encoded powershell command (opaque to static analysis)");
                    return;
                }
                const rest = args.slice(flagIdx + 1).map((t) => t.text).join(" ");
                if (rest.length > 0 && depth < 3) {
                    classifySegment(rest, report, depth + 1);
                    return;
                }
            }
        }
        // 2. Network binary at command position.
        if (NETWORK_BINARIES.has(argv0)) {
            const onlyInfoFlags = args.every((t) => INFO_FLAGS.has(t.text.toLowerCase()));
            if (!onlyInfoFlags) {
                report.hasNetworkIntent = true;
                report.reasons.push(`network binary: ${argv0}`);
            }
        }
        // 3. Subcommand selection (git push / npm install / docker pull / ...).
        const subcommands = NETWORK_SUBCOMMANDS[argv0];
        if (subcommands !== undefined && args.length > 0) {
            const sub = args[0].text.toLowerCase();
            if (subcommands.includes(sub)) {
                report.hasNetworkIntent = true;
                report.reasons.push(`network subcommand: ${argv0} ${sub}`);
            }
            else if (argv0 === "git" && sub === "remote" && (args[1]?.text.toLowerCase() === "add" || args[1]?.text.toLowerCase() === "set-url")) {
                report.hasNetworkIntent = true;
                report.reasons.push("network subcommand: git remote add");
            }
            else if (argv0 === "go" && sub === "mod" && args[1]?.text.toLowerCase() === "download") {
                report.hasNetworkIntent = true;
                report.reasons.push("network subcommand: go mod download");
            }
            else if (argv0 === "docker" && sub === "run") {
                // P2-24: inspect the container command — a network tool inside the
                // image (docker run img curl …) or host networking exposes the net.
                const containerArgs = args.slice(1);
                const netTool = containerArgs.find((t) => NETWORK_BINARIES.has(basename(t.text)));
                const flat = containerArgs.map((t) => t.text);
                const hostIdx = flat.findIndex((t) => /^--network/i.test(t));
                const hostNet = (hostIdx >= 0 && /^--network=(host|macvlan)$/i.test(flat[hostIdx])) ||
                    (hostIdx >= 0 && flat[hostIdx + 1]?.toLowerCase() === "host");
                if (netTool !== undefined) {
                    report.hasNetworkIntent = true;
                    report.reasons.push(`network tool inside docker run: ${netTool.text}`);
                }
                else if (hostNet) {
                    report.hasNetworkIntent = true;
                    report.reasons.push("docker run with host networking");
                }
            }
        }
        // 4. Interpreter inline code (node -e / python -c / ...).
        const interpreter = INLINE_INTERPRETERS[argv0];
        if (interpreter !== undefined) {
            for (let j = 0; j < args.length; j++) {
                const flag = args[j].text;
                const flagMatch = interpreter.flags.find((f) => flag === f || flag.startsWith(`${f}=`));
                if (flagMatch !== undefined && j + 1 < args.length) {
                    const blob = args[j + 1].text;
                    if (scanInlineCode(blob, interpreter.markers, report)) {
                        report.hasNetworkIntent = true;
                        report.reasons.push(`inline network code (${argv0} ${flagMatch})`);
                    }
                    break;
                }
            }
            // P2-24: python module execution via `-m` (python -m http.server …).
            if ((argv0 === "python" || argv0 === "python3" || argv0 === "py")) {
                for (let j = 0; j + 1 < args.length; j++) {
                    if (args[j].text === "-m" && MODULE_NETWORK.has(args[j + 1].text.toLowerCase())) {
                        report.hasNetworkIntent = true;
                        report.reasons.push(`python module with network I/O: -m ${args[j + 1].text}`);
                    }
                }
            }
        }
    }
    // 5. URL / host literals anywhere in the segment (incl. quoted args).
    for (const t of tokens) {
        detectUrlLiterals(t.text, report);
    }
}
/**
 * Detect whether a shell command line carries network intent.
 * Pure, deterministic, no side effects.
 */
export function detectNetworkIntent(command) {
    const report = { hasNetworkIntent: false, reasons: [], hosts: [] };
    if (typeof command !== "string" || command.trim().length === 0)
        return report;
    classifySegment(command, report, 0);
    report.hosts = [...new Set(report.hosts)];
    return report;
}
//# sourceMappingURL=network-gate.js.map