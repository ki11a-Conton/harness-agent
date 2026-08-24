#!/usr/bin/env node
// P4-1/P4-2: deterministic generator for the regression (30) and holdout (30)
// suites. Every case gets the machine-readable layout
// request.md / expected.md / fixture/ / case.json. Rerun to regenerate:
//   node benchmarks/tools/generate-suite.mjs
// The suites are part of the repository (no generation at CI time) so diffs
// are reviewable; a conformance test pins the exact counts (P4-13).

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** One case definition. fixture values are written verbatim (UTF-8). */
const regression = [
  {
    id: "reg-01-implement-fizzbuzz",
    request: "Implement a `fizzbuzz(n)` function in src/fizzbuzz.py that returns an array of strings from 1 to n, replacing multiples of 3 with 'Fizz', multiples of 5 with 'Buzz', and multiples of both with 'FizzBuzz'. Export it from the module.",
    expected: "fizzbuzz(15) returns the canonical 15-element FizzBuzz sequence; the function is importable.",
    fixture: { "src/fizzbuzz.py": "def fizzbuzz(n):\n    # TODO: implement\n    return []\n" },
    verification: [{ kind: "command", command: "python3", args: ["-c", "from src.fizzbuzz import fizzbuzz; r=fizzbuzz(15); assert r[2]=='Fizz' and r[4]=='Buzz' and r[14]=='FizzBuzz' and len(r)==15"] }],
    tags: ["implementation", "python"],
  },
  {
    id: "reg-02-fix-reverse",
    request: "The `reverse` function in src/strings.js is supposed to return the input string reversed, but it returns the same string. Fix it.",
    expected: "reverse('hello') === 'olleh' and reverse('') === ''.",
    fixture: { "src/strings.js": "export function reverse(s) {\n  return s; // bug\n}\n" },
    verification: [{ kind: "command", command: "node", args: ["-e", "import('./src/strings.js').then(m => { if (m.reverse('hello') !== 'olleh' || m.reverse('') !== '') process.exit(1) })"] }],
    tags: ["bugfix", "javascript"],
  },
  {
    id: "reg-03-add-import",
    request: "src/main.py calls `math.sqrt` but never imports math. Add the missing import so the program runs.",
    expected: "src/main.py imports math and `python3 src/main.py` prints a numeric square root.",
    fixture: { "src/main.py": "# missing import math\n\ndef area(r):\n    return math.sqrt(r) * 2\n\nif __name__ == \"__main__\":\n    print(area(16))\n" },
    verification: [{ kind: "command", command: "python3", args: ["src/main.py"] }],
    tags: ["bugfix", "python"],
  },
  {
    id: "reg-04-fibonacci",
    request: "Implement `fib(n)` in src/fib.py returning the n-th Fibonacci number (fib(0)=0, fib(1)=1), without recursion (iterative).",
    expected: "fib(0)=0, fib(1)=1, fib(10)=55.",
    fixture: { "src/fib.py": "def fib(n):\n    # TODO: implement iteratively\n    return 0\n" },
    verification: [{ kind: "command", command: "python3", args: ["-c", "from src.fib import fib; assert fib(0)==0 and fib(1)==1 and fib(10)==55"] }],
    tags: ["implementation", "python"],
  },
  {
    id: "reg-05-off-by-one",
    request: "`countdown(n)` in src/countdown.js should print n, n-1, ..., 1 (one line each). It currently prints n..0. Fix the off-by-one.",
    expected: "countdown(3) prints 3,2,1 (no 0).",
    fixture: { "src/countdown.js": "export function countdown(n) {\n  for (let i = n; i >= 0; i--) console.log(i);\n}\n" },
    verification: [{ kind: "artifact", path: "out.txt", mustChange: false }],
    tags: ["bugfix", "javascript"],
  },
  {
    id: "reg-06-json-parse-test",
    request: "Write a test file test/parse.test.js that verifies `JSON.parse` round-trips a simple object ({\"a\":1}). Use node's built-in assert and make the test pass with `node --test test/`.",
    expected: "A test exists and `node --test test/` reports 1 passing test.",
    fixture: { "package.json": "{\"name\":\"j\",\"type\":\"module\"}\n" },
    verification: [{ kind: "command", command: "node", args: ["--test", "test/"] }],
    tags: ["testing", "javascript"],
  },
  {
    id: "reg-07-refactor-duplicate",
    request: "src/calc.js computes the sum and the product of a list with two nearly identical loops. Refactor the duplicated loop into a single helper and keep behavior identical.",
    expected: "sum([1,2,3]) is 6 and product([1,2,3]) is 6; no duplicated loop bodies remain.",
    fixture: { "src/calc.js": "export function sum(xs) { let s = 0; for (const x of xs) s += x; return s; }\nexport function product(xs) { let p = 1; for (const x of xs) p *= x; return p; }\n" },
    verification: [{ kind: "command", command: "node", args: ["-e", "import('./src/calc.js').then(m => { if (m.sum([1,2,3]) !== 6 || m.product([1,2,3]) !== 6) process.exit(1) })"] }],
    tags: ["refactor", "javascript"],
  },
  {
    id: "reg-08-quicksort",
    request: "Implement `quicksort(xs)` in src/sort.py that sorts a list of ints in place (or returns a new sorted list).",
    expected: "quicksort([3,1,2]) == [1,2,3]; quicksort([]) == [].",
    fixture: { "src/sort.py": "def quicksort(xs):\n    # TODO\n    return xs\n" },
    verification: [{ kind: "command", command: "python3", args: ["-c", "from src.sort import quicksort; assert quicksort([3,1,2])==[1,2,3] and quicksort([])==[]"] }],
    tags: ["implementation", "python"],
  },
  {
    id: "reg-09-null-check",
    request: "`safeLen` in src/util.js crashes when passed null. Add a null/undefined guard so it returns 0 instead.",
    expected: "safeLen(null) === 0, safeLen('abc') === 3.",
    fixture: { "src/util.js": "export function safeLen(value) {\n  return value.length;\n}\n" },
    verification: [{ kind: "command", command: "node", args: ["-e", "import('./src/util.js').then(m => { if (m.safeLen(null) !== 0 || m.safeLen('abc') !== 3) process.exit(1) })"] }],
    tags: ["bugfix", "javascript"],
  },
  {
    id: "reg-10-env-config",
    request: "config.py reads a port from the environment variable PORT (default 8080). Currently it hardcodes 8000. Make it env-driven with a default.",
    expected: "config.port equals the PORT env var when set, else 8080.",
    fixture: { "config.py": "PORT = 8000  # TODO: read from env with default 8080\n" },
    verification: [{ kind: "command", command: "python3", args: ["-c", "import config; assert config.PORT == 8080"] }],
    tags: ["config", "python"],
  },
  {
    id: "reg-11-binary-search",
    request: "Implement `binary_search(xs, target)` in src/search.py returning the index of target or -1. xs is sorted.",
    expected: "binary_search([1,3,5,7], 5) == 2; binary_search([1,3], 9) == -1.",
    fixture: { "src/search.py": "def binary_search(xs, target):\n    # TODO\n    return -1\n" },
    verification: [{ kind: "command", command: "python3", args: ["-c", "from src.search import binary_search; assert binary_search([1,3,5,7],5)==2 and binary_search([1,3],9)==-1"] }],
    tags: ["implementation", "python"],
  },
  {
    id: "reg-12-csv-parse",
    request: "`parse_csv(line)` in src/csv.js should split a CSV line on commas and strip surrounding whitespace from each field. It currently doesn't trim.",
    expected: "parse_csv('a, b ,c') == ['a','b','c'].",
    fixture: { "src/csv.js": "export function parse_csv(line) {\n  return line.split(',');\n}\n" },
    verification: [{ kind: "command", command: "node", args: ["-e", "import('./src/csv.js').then(m => { const r = m.parse_csv('a, b ,c'); if (r.join('|') !== 'a|b|c') process.exit(1) })"] }],
    tags: ["bugfix", "javascript"],
  },
  {
    id: "reg-13-markdown-doc",
    request: "Create docs/api.md documenting the `sum` function in src/calc.js: signature, one example, and a note that it accepts an array of numbers.",
    expected: "docs/api.md exists and mentions the sum signature and an example.",
    fixture: { "src/calc.js": "export function sum(xs) {\n  let s = 0; for (const x of xs) s += x; return s;\n}\n" },
    verification: [{ kind: "artifact", path: "docs/api.md", mustChange: true }],
    tags: ["documentation"],
  },
  {
    id: "reg-14-stack",
    request: "Implement a Stack class in src/stack.py with push, pop, and is_empty. pop on an empty stack returns None.",
    expected: "A stack pushes 1,2 and pops 2 then 1; empty stack pop returns None.",
    fixture: { "src/stack.py": "class Stack:\n    def __init__(self):\n        self.items = []\n    def push(self, x):\n        self.items.append(x)\n    def pop(self):\n        return self.items.pop()\n    def is_empty(self):\n        return len(self.items) == 0\n" },
    verification: [{ kind: "command", command: "python3", args: ["-c", "from src.stack import Stack; s=Stack(); s.push(1); s.push(2); assert s.pop()==2 and s.pop()==1 and s.is_empty() and s.pop() is None"] }],
    tags: ["implementation", "python"],
  },
  {
    id: "reg-15-infinite-loop",
    request: "The loop in src/loop.js never terminates for n>0. Fix it so it counts down to 0.",
    expected: "countDown(3) returns [3,2,1,0] (terminates).",
    fixture: { "src/loop.js": "export function countDown(n) {\n  const out = [];\n  let i = n;\n  while (i >= 0) { out.push(i); /* bug: i never changes */ }\n  return out;\n}\n" },
    verification: [{ kind: "command", command: "node", args: ["-e", "import('./src/loop.js').then(m => { const r = m.countDown(3); if (r.join(',') !== '3,2,1,0') process.exit(1) })"] }],
    tags: ["bugfix", "javascript"],
  },
  {
    id: "reg-16-cicd-step",
    request: "Add a CI step to .github/workflows/ci.yml that runs `node --test test/` on ubuntu-latest after checkout. Keep existing steps.",
    expected: "ci.yml contains a run step with `node --test test/`.",
    fixture: { ".github/workflows/ci.yml": "name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n" },
    verification: [{ kind: "artifact", path: ".github/workflows/ci.yml", mustChange: true }],
    tags: ["config", "ci"],
  },
  {
    id: "reg-17-gcd",
    request: "Implement `gcd(a, b)` in src/gcd.py using Euclid's algorithm.",
    expected: "gcd(48, 18) == 6; gcd(7, 13) == 1.",
    fixture: { "src/gcd.py": "def gcd(a, b):\n    # TODO\n    return 1\n" },
    verification: [{ kind: "command", command: "python3", args: ["-c", "from src.gcd import gcd; assert gcd(48,18)==6 and gcd(7,13)==1"] }],
    tags: ["implementation", "python"],
  },
  {
    id: "reg-18-date-format",
    request: "`formatDate(d)` in src/date.js should return YYYY-MM-DD. It currently returns MM/DD/YYYY. Fix it.",
    expected: "formatDate(new Date(2020, 0, 5)) === '2020-01-05'.",
    fixture: { "src/date.js": "export function formatDate(d) {\n  return `${d.getMonth()+1}/${d.getDate()}/${d.getFullYear()}`;\n}\n" },
    verification: [{ kind: "command", command: "node", args: ["-e", "import('./src/date.js').then(m => { if (m.formatDate(new Date(2020,0,5)) !== '2020-01-05') process.exit(1) })"] }],
    tags: ["bugfix", "javascript"],
  },
  {
    id: "reg-19-config-validator",
    request: "Write src/validate.js exporting `validateConfig(cfg)` that returns an array of error strings: missing 'name' or a 'port' outside 1..65535 are errors; returns [] when valid.",
    expected: "validateConfig({name:'x',port:80}) is []; validateConfig({}) has 2 errors.",
    fixture: { "src/validate.js": "export function validateConfig(cfg) {\n  return [];\n}\n" },
    verification: [{ kind: "command", command: "node", args: ["-e", "import('./src/validate.js').then(m => { if (m.validateConfig({name:'x',port:80}).length !== 0) process.exit(1); if (m.validateConfig({}).length < 2) process.exit(1) })"] }],
    tags: ["implementation", "javascript"],
  },
  {
    id: "reg-20-linked-list",
    request: "Implement a singly linked list in src/list.py: prepend(value), to_list() returning the values head-to-tail.",
    expected: "prepend 3,2,1 gives to_list() == [3,2,1].",
    fixture: { "src/list.py": "class Node:\n    def __init__(self, value, next=None):\n        self.value = value\n        self.next = next\n\nclass LinkedList:\n    def __init__(self):\n        self.head = None\n    def prepend(self, value):\n        # TODO\n        pass\n    def to_list(self):\n        out = []\n        cur = self.head\n        while cur:\n            out.append(cur.value)\n            cur = cur.next\n        return out\n" },
    verification: [{ kind: "command", command: "python3", args: ["-c", "from src.list import LinkedList; l=LinkedList(); [l.prepend(x) for x in (3,2,1)]; assert l.to_list()==[3,2,1]"] }],
    tags: ["implementation", "python"],
  },
  {
    id: "reg-21-regex",
    request: "The email regex in src/email.js matches emails without a domain. Fix it so `isEmail('a@b.com')` is true and `isEmail('nope')` is false.",
    expected: "isEmail('a@b.com') === true; isEmail('nope') === false.",
    fixture: { "src/email.js": "export function isEmail(value) {\n  return /^\\w+/.test(value);\n}\n" },
    verification: [{ kind: "command", command: "node", args: ["-e", "import('./src/email.js').then(m => { if (!m.isEmail('a@b.com') || m.isEmail('nope')) process.exit(1) })"] }],
    tags: ["bugfix", "javascript"],
  },
  {
    id: "reg-22-api-stub",
    request: "Add a stub endpoint to server.js: GET /health returns JSON {\"ok\": true} with status 200 using node:http (no framework).",
    expected: "server.js listens on PORT env (default 3000) and GET /health returns 200 {\"ok\":true}.",
    fixture: { "server.js": "const http = require('http');\n\nconst server = http.createServer((req, res) => {\n  res.writeHead(404);\n  res.end();\n});\n\nmodule.exports = server;\n" },
    verification: [{ kind: "command", command: "node", args: ["-e", "const s=require('./server.js'); s.listen(0, async () => { const port = s.address().port; const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.status !== 200) process.exit(1); const b = await r.json(); if (!b.ok) process.exit(1); s.close(); })"] }],
    tags: ["implementation", "node"],
  },
  {
    id: "reg-23-anagram",
    request: "Implement `isAnagram(a, b)` in src/anagram.py returning True when the strings are anagrams (ignore case).",
    expected: "isAnagram('Listen','Silent') is True; isAnagram('abc','abd') is False.",
    fixture: { "src/anagram.py": "def isAnagram(a, b):\n    # TODO\n    return False\n" },
    verification: [{ kind: "command", command: "python3", args: ["-c", "from src.anagram import isAnagram; assert isAnagram('Listen','Silent') and not isAnagram('abc','abd')"] }],
    tags: ["implementation", "python"],
  },
  {
    id: "reg-24-error-handling",
    request: "`readJson(path)` in src/io.js should catch JSON parse errors and return null instead of throwing.",
    expected: "readJson of a file with invalid JSON returns null; valid JSON returns the object.",
    fixture: { "src/io.js": "import { readFileSync } from 'node:fs';\nexport function readJson(path) {\n  return JSON.parse(readFileSync(path, 'utf8'));\n}\n", "data/bad.json": "{not json\n" },
    verification: [{ kind: "command", command: "node", args: ["-e", "import('./src/io.js').then(m => { if (m.readJson('data/bad.json') !== null) process.exit(1) })"] }],
    tags: ["bugfix", "javascript"],
  },
  {
    id: "reg-25-shell-script",
    request: "Write scripts/check.sh that exits 0 when a file path argument exists and is readable, exits 1 otherwise. Make it executable.",
    expected: "`bash scripts/check.sh README` succeeds; `bash scripts/check.sh missing-file` exits 1.",
    fixture: { "README": "hello\n", "scripts/check.sh": "#!/usr/bin/env bash\n# TODO: check $1 exists and is readable\n" },
    verification: [{ kind: "command", command: "bash", args: ["scripts/check.sh", "README"] }],
    tags: ["implementation", "shell"],
  },
  {
    id: "reg-26-queue",
    request: "Implement a Queue class in src/queue.py with enqueue and dequeue. dequeue on an empty queue returns None.",
    expected: "enqueue 1,2; dequeue returns 1 then 2; empty dequeue returns None.",
    fixture: { "src/queue.py": "class Queue:\n    def __init__(self):\n        self.items = []\n    def enqueue(self, x):\n        self.items.append(x)\n    def dequeue(self):\n        if not self.items:\n            return None\n        return self.items.pop(0)\n" },
    verification: [{ kind: "command", command: "python3", args: ["-c", "from src.queue import Queue; q=Queue(); q.enqueue(1); q.enqueue(2); assert q.dequeue()==1 and q.dequeue()==2 and q.dequeue() is None"] }],
    tags: ["implementation", "python"],
  },
  {
    id: "reg-27-type-annotation",
    request: "src/ann.ts is missing parameter/return types. Add TypeScript annotations to `sum(xs)` so it takes number[] and returns number.",
    expected: "src/ann.ts compiles with types (annotations present); run `npx tsc --noEmit src/ann.ts`.",
    fixture: { "src/ann.ts": "// TODO: add type annotations\nexport function sum(xs) {\n  return xs.reduce((a, b) => a + b, 0);\n}\n" },
    verification: [{ kind: "command", command: "npx", args: ["tsc", "--noEmit", "src/ann.ts"] }],
    tags: ["typescript"],
  },
  {
    id: "reg-28-logging",
    request: "Add structured logging to src/app.py: at startup print `starting service` to stdout, and on request log `request served`.",
    expected: "`python3 src/app.py` prints both 'starting service' and 'request served'.",
    fixture: { "src/app.py": "def serve():\n    pass\n\nif __name__ == \"__main__\":\n    serve()\n" },
    verification: [{ kind: "command", command: "python3", args: ["src/app.py"] }],
    tags: ["feature", "python"],
  },
  {
    id: "reg-29-palindrome",
    request: "Implement `isPalindrome(s)` in src/pal.py that ignores spaces and case.",
    expected: "isPalindrome('A man a plan a canal Panama') is True; isPalindrome('hello') is False.",
    fixture: { "src/pal.py": "def isPalindrome(s):\n    # TODO\n    return False\n" },
    verification: [{ kind: "command", command: "python3", args: ["-c", "from src.pal import isPalindrome; assert isPalindrome('A man a plan a canal Panama') and not isPalindrome('hello')"] }],
    tags: ["implementation", "python"],
  },
  {
    id: "reg-30-sort-order",
    request: "`sortUsers(users)` in src/users.js sorts by name but returns the array reversed. Fix it to sort ascending by name.",
    expected: "sortUsers([{name:'b'},{name:'a'}]) returns [{name:'a'},{name:'b'}].",
    fixture: { "src/users.js": "export function sortUsers(users) {\n  return users.sort((a, b) => (a.name < b.name ? -1 : 1)).reverse();\n}\n" },
    verification: [{ kind: "command", command: "node", args: ["-e", "import('./src/users.js').then(m => { const r = m.sortUsers([{name:'b'},{name:'a'}]); if (r[0].name !== 'a' || r[1].name !== 'b') process.exit(1) })"] }],
    tags: ["bugfix", "javascript"],
  },
];

const holdout = [
  {
    id: "ho-01-review-smells",
    request: "Review src/app.py and list code smells you find in notes/review.md: duplicated code, magic numbers, and the missing error handling. Be specific with line references.",
    expected: "notes/review.md mentions at least two distinct smells with line references.",
    fixture: { "src/app.py": "def process(x):\n    y = x * 1000\n    y = x * 1000\n    return y\n\ndef main():\n    data = open('in.txt').read()\n    return data\n", "in.txt": "data\n" },
    verification: [{ kind: "artifact", path: "notes/review.md", mustChange: true }],
    tags: ["review"],
  },
  {
    id: "ho-02-parse-log",
    request: "Parse logs/app.log and extract every line containing 'ERROR' into out/errors.txt, preserving line order. Count them and write the count to out/count.txt.",
    expected: "out/errors.txt contains the ERROR lines in order; out/count.txt contains the count.",
    fixture: { "logs/app.log": "[1] INFO boot\n[2] ERROR boom\n[3] INFO ok\n[4] ERROR kaboom\n[5] WARN meh\n" },
    verification: [{ kind: "command", command: "bash", args: ["-c", "test -f out/errors.txt && test -f out/count.txt && [ $(grep -c ERROR out/errors.txt) -eq 2 ]"] }],
    tags: ["analysis"],
  },
  {
    id: "ho-03-convert-format",
    request: "Convert data/input.csv to data/output.json: each row becomes an object with the header keys, values coerced to numbers when numeric.",
    expected: "data/output.json parses to [{a:1,b:'x'},...] matching the CSV.",
    fixture: { "data/input.csv": "a,b\n1,x\n2,y\n3,z\n" },
    verification: [{ kind: "command", command: "node", args: ["-e", "const r = require('./data/output.json'); if (r.length !== 3 || r[0].a !== 1 || r[1].b !== 'y') process.exit(1)"] }],
    tags: ["conversion"],
  },
  {
    id: "ho-04-audit-deps",
    request: "Audit package.json for dependencies that are declared but never imported anywhere in src/. Write your findings to out/audit.md naming each unused dependency.",
    expected: "out/audit.md names the unused dependency 'left-pad'.",
    fixture: { "package.json": "{\"name\":\"a\",\"dependencies\":{\"left-pad\":\"1.0.0\",\"used-dep\":\"1.0.0\"}}\n", "src/index.js": "import 'used-dep';\nconsole.log('x');\n" },
    verification: [{ kind: "artifact", path: "out/audit.md", mustChange: true }],
    tags: ["audit"],
  },
  {
    id: "ho-05-complexity",
    request: "Analyze src/slow.py and explain its time complexity in out/complexity.md, then suggest a faster approach.",
    expected: "out/complexity.md mentions O(n²) and a faster suggestion.",
    fixture: { "src/slow.py": "def find_duplicates(xs):\n    out = []\n    for i, a in enumerate(xs):\n        for j, b in enumerate(xs):\n            if i != j and a == b and a not in out:\n                out.append(a)\n    return out\n" },
    verification: [{ kind: "artifact", path: "out/complexity.md", mustChange: true }],
    tags: ["analysis"],
  },
  {
    id: "ho-06-migration-script",
    request: "Write scripts/migrate.sh that renames data/old.txt to data/new.txt (moving it), creating data/ if needed.",
    expected: "data/old.txt no longer exists and data/new.txt exists with the same content.",
    fixture: { "data/old.txt": "payload\n" },
    verification: [{ kind: "command", command: "bash", args: ["-c", "test ! -f data/old.txt && test -f data/new.txt && grep -q payload data/new.txt"] }],
    tags: ["scripting"],
  },
  {
    id: "ho-07-permissions",
    request: "secure.sh should exit non-zero unless the file given as $1 is not group/world writable. Apply it and fix the permission on secret.txt so the check passes.",
    expected: "`bash secure.sh secret.txt` exits 0 after the fix (secret.txt is not group/world writable).",
    fixture: { "secret.txt": "s3cret\n", "secure.sh": "#!/usr/bin/env bash\n# TODO: exit 1 if $1 is group or world writable\n" },
    verification: [{ kind: "command", command: "bash", args: ["secure.sh", "secret.txt"] }],
    tags: ["security"],
  },
  {
    id: "ho-08-optimize",
    request: "src/fetch.js downloads a list of URLs sequentially. Optimize it to fetch them concurrently and return results in the same order.",
    expected: "The optimized fetchAll resolves all URLs concurrently (results in input order).",
    fixture: { "src/fetch.js": "export async function fetchAll(urls) {\n  const out = [];\n  for (const u of urls) out.push(await fetch(u).then((r) => r.status));\n  return out;\n}\n" },
    verification: [{ kind: "command", command: "node", args: ["-e", "import('./src/fetch.js').then(m => m.fetchAll(['https://example.com','https://example.org']).then(r => { if (r.length !== 2) process.exit(1) }))"] }],
    tags: ["performance"],
  },
  {
    id: "ho-09-document-api",
    request: "Write docs/api.md for the REST endpoints in server.js: GET /items and POST /items. Document method, path, and a short purpose for each.",
    expected: "docs/api.md documents both GET /items and POST /items.",
    fixture: { "server.js": "const http = require('http');\nconst server = http.createServer((req, res) => {\n  if (req.method === 'GET' && req.url === '/items') { res.writeHead(200); res.end('[]'); return; }\n  if (req.method === 'POST' && req.url === '/items') { res.writeHead(201); res.end('{}'); return; }\n  res.writeHead(404); res.end();\n});\nmodule.exports = server;\n" },
    verification: [{ kind: "artifact", path: "docs/api.md", mustChange: true }],
    tags: ["documentation"],
  },
  {
    id: "ho-10-validate-schema",
    request: "src/schema.js exports `validate(obj)` returning error strings for: missing 'id' or a 'value' that is not a number. Implement it and make the sample call in the check pass.",
    expected: "validate({id:1,value:2}) is []; validate({value:'x'}) mentions missing id; validate({id:1,value:'x'}) mentions value.",
    fixture: { "src/schema.js": "export function validate(obj) {\n  return [];\n}\n" },
    verification: [{ kind: "command", command: "node", args: ["-e", "import('./src/schema.js').then(m => { if (m.validate({id:1,value:2}).length !== 0) process.exit(1); const e = m.validate({id:1,value:'x'}); if (!e.some(s => s.includes('value'))) process.exit(1) })"] }],
    tags: ["validation"],
  },
  {
    id: "ho-11-release-notes",
    request: "Generate out/release-notes.md from the git-style changelog in CHANGELOG.md, listing only the 'Fixed' entries of the latest version section.",
    expected: "out/release-notes.md contains the Fixed entries from the [1.2.0] section and nothing from [1.1.0].",
    fixture: { "CHANGELOG.md": "# Changelog\n\n## [1.2.0]\n### Fixed\n- crash on empty input\n### Added\n- new flag\n\n## [1.1.0]\n### Fixed\n- old typo\n" },
    verification: [{ kind: "command", command: "bash", args: ["-c", "grep -q 'crash on empty input' out/release-notes.md && ! grep -q 'old typo' out/release-notes.md"] }],
    tags: ["documentation"],
  },
  {
    id: "ho-12-refactor-esm",
    request: "Convert src/legacy.js from CommonJS to ESM (import/export) and update the import in src/index.js accordingly. Keep behavior.",
    expected: "Both files use ESM syntax; `node src/index.js` prints 'hi'.",
    fixture: { "src/legacy.js": "module.exports = { hi: () => 'hi' };\n", "src/index.js": "const { hi } = require('./legacy.js');\nconsole.log(hi());\n" },
    verification: [{ kind: "command", command: "node", args: ["src/index.js"] }],
    tags: ["refactor", "esm"],
  },
  {
    id: "ho-13-debug-flaky",
    request: "src/flaky.js returns 1 half the time. Find the bug (it reads a global before resetting it) and fix it so next() is deterministic.",
    expected: "Calling next() five times returns 0,1,2,3,4 deterministically.",
    fixture: { "src/flaky.js": "let seen = new Set();\nexport function next() {\n  const n = seen.size;\n  if (seen.has(n)) return -1;\n  seen.add(n);\n  return n;\n}\n" },
    verification: [{ kind: "command", command: "node", args: ["-e", "import('./src/flaky.js').then(m => { const r = [0,1,2,3,4].map(() => m.next()); if (r.join(',') !== '0,1,2,3,4') process.exit(1) })"] }],
    tags: ["debugging"],
  },
  {
    id: "ho-14-test-matrix",
    request: "Create .github/workflows/matrix.yml running the test job on node 20 and node 22 using a strategy matrix.",
    expected: "matrix.yml uses a strategy matrix with node-version [20, 22].",
    fixture: { ".github/workflows/matrix.yml": "name: matrix\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n" },
    verification: [{ kind: "artifact", path: ".github/workflows/matrix.yml", mustChange: true }],
    tags: ["config", "ci"],
  },
  {
    id: "ho-15-rate-limiter",
    request: "Implement a token-bucket rate limiter in src/limiter.js: `new Limiter(2, 1000)` allows 2 tokens per second; `allow()` returns boolean.",
    expected: "A Limiter(1, 1000) allows the first call and blocks a second immediate call.",
    fixture: { "src/limiter.js": "export class Limiter {\n  constructor(ratePerSecond, windowMs) {\n    this.ratePerSecond = ratePerSecond;\n    this.windowMs = windowMs;\n  }\n  allow() {\n    return true;\n  }\n}\n" },
    verification: [{ kind: "command", command: "node", args: ["-e", "import('./src/limiter.js').then(m => { const l = new m.Limiter(1, 1000); if (!l.allow()) process.exit(1); if (l.allow()) process.exit(1) })"] }],
    tags: ["implementation"],
  },
  {
    id: "ho-16-analyze-query",
    request: "Explain src/query.py in out/query-analysis.md: what it computes and one correctness problem you see.",
    expected: "out/query-analysis.md states what the function computes and names a correctness problem.",
    fixture: { "src/query.py": "def top_n(scores, n):\n    return sorted(scores, key=lambda s: s['score'], reverse=True)[:n]\n" },
    verification: [{ kind: "artifact", path: "out/query-analysis.md", mustChange: true }],
    tags: ["analysis"],
  },
  {
    id: "ho-17-changelog",
    request: "Add an entry to CHANGELOG.md under a new '## [Unreleased]' section with '### Added - summary of unreleased work'.",
    expected: "CHANGELOG.md has an '## [Unreleased]' section with an Added bullet.",
    fixture: { "CHANGELOG.md": "# Changelog\n\n## [1.0.0]\n" },
    verification: [{ kind: "artifact", path: "CHANGELOG.md", mustChange: true }],
    tags: ["documentation"],
  },
  {
    id: "ho-18-race-condition",
    request: "src/counter.js increments a shared counter with a race-prone read-modify-write. Make `increment()` atomic (use a single synchronous expression).",
    expected: "Calling increment() 1000 times sequentially always leaves count === 1000.",
    fixture: { "src/counter.js": "let count = 0;\nexport function increment() {\n  const current = count;\n  count = current + 1;\n  return count;\n}\nexport function value() { return count; }\n" },
    verification: [{ kind: "command", command: "node", args: ["-e", "import('./src/counter.js').then(m => { for (let i = 0; i < 1000; i++) m.increment(); if (m.value() !== 1000) process.exit(1) })"] }],
    tags: ["bugfix"],
  },
  {
    id: "ho-19-cache",
    request: "Add an in-memory cache to src/api.js so `get(key)` returns the same value for repeated calls without recomputing.",
    expected: "get('a') called twice returns the same result; the compute function runs once.",
    fixture: { "src/api.js": "let calls = 0;\nexport function compute(key) { calls += 1; return key + calls; }\nexport function get(key) { return compute(key); }\nexport function callCount() { return calls; }\n" },
    verification: [{ kind: "command", command: "node", args: ["-e", "import('./src/api.js').then(m => { const a = m.get('x'); const b = m.get('x'); if (a !== b || m.callCount() !== 1) process.exit(1) })"] }],
    tags: ["implementation"],
  },
  {
    id: "ho-20-normalize",
    request: "Write src/normalize.js exporting `normalize(rows)` that lowercases string values, trims whitespace, and coerces 'true'/'false' to booleans.",
    expected: "normalize([{a:'  Hi '},{a:'TRUE'}]) → [{a:'hi'},{a:true}].",
    fixture: { "src/normalize.js": "export function normalize(rows) {\n  return rows;\n}\n" },
    verification: [{ kind: "command", command: "node", args: ["-e", "import('./src/normalize.js').then(m => { const r = m.normalize([{a:'  Hi '},{a:'TRUE'}]); if (r[0].a !== 'hi' || r[1].a !== true) process.exit(1) })"] }],
    tags: ["transformation"],
  },
  {
    id: "ho-21-build-report",
    request: "Write a script scripts/report.sh that prints a markdown table with header | Metric | Value | and two rows (Passed: 10, Failed: 2).",
    expected: "`bash scripts/report.sh` prints a markdown table with the two rows.",
    fixture: { "scripts/report.sh": "#!/usr/bin/env bash\n# TODO\n" },
    verification: [{ kind: "command", command: "bash", args: ["scripts/report.sh"] }],
    tags: ["scripting"],
  },
  {
    id: "ho-22-fix-vuln",
    request: "src/shell.js builds a shell command by string concatenation, allowing injection. Fix it to pass the argument as an array (no shell).",
    expected: "run('x; rm -rf /') never executes the injected part — it runs the command with a literal argument.",
    fixture: { "src/shell.js": "import { execSync } from 'node:child_process';\nexport function run(arg) {\n  return execSync(`echo ${arg}`).toString().trim();\n}\n" },
    verification: [{ kind: "command", command: "node", args: ["-e", "import('./src/shell.js').then(m => { const r = m.run('safe'); if (r !== 'safe') process.exit(1) })"] }],
    tags: ["security"],
  },
  {
    id: "ho-23-retry-logic",
    request: "src/retry.js has an exponential backoff retry. Make the backoff configurable via options {maxRetries, baseDelayMs} and default to {3, 100}.",
    expected: "`withRetry(fn, {maxRetries: 2, baseDelayMs: 5})` retries at most 2 times.",
    fixture: { "src/retry.js": "export async function withRetry(fn) {\n  let last;\n  for (let i = 0; i < 3; i++) {\n    try { return await fn(); } catch (e) { last = e; }\n  }\n  throw last;\n}\n" },
    verification: [{ kind: "command", command: "node", args: ["-e", "import('./src/retry.js').then(m => { let n = 0; return m.withRetry(async () => { n++; if (n < 3) throw new Error('x'); return 'ok'; }, {maxRetries: 5, baseDelayMs: 1}).then(r => { if (r !== 'ok') process.exit(1) }) })"] }],
    tags: ["implementation"],
  },
  {
    id: "ho-24-extract-constants",
    request: "src/prices.js repeats the tax rate 0.0825 in three places. Extract it to a named constant TAX_RATE and keep behavior.",
    expected: "TAX_RATE is defined once and used in all three spots; total(100) === 108.25.",
    fixture: { "src/prices.js": "export function total(net) { return net * (1 + 0.0825); }\nexport function tax(net) { return net * 0.0825; }\nexport function netOf(gross) { return gross / (1 + 0.0825); }\n" },
    verification: [{ kind: "command", command: "node", args: ["-e", "import('./src/prices.js').then(m => { if (Math.abs(m.total(100) - 108.25) > 0.001) process.exit(1) })"] }],
    tags: ["refactor"],
  },
  {
    id: "ho-25-cron-config",
    request: "Create cron.txt with a crontab line that runs `backup.sh` every day at 02:30.",
    expected: "cron.txt matches a crontab schedule for 02:30 daily and references backup.sh.",
    fixture: { "backup.sh": "#!/usr/bin/env bash\necho backup\n" },
    verification: [{ kind: "command", command: "bash", args: ["-c", "grep -q '30 2' cron.txt && grep -q backup.sh cron.txt"] }],
    tags: ["config"],
  },
  {
    id: "ho-26-analyze-errors",
    request: "Analyze logs/errors.log: find the most frequent error message and write the top error and its count to out/top-error.txt.",
    expected: "out/top-error.txt contains the most frequent error message.",
    fixture: { "logs/errors.log": "timeout\nboom\ntimeout\nboom\nboom\n" },
    verification: [{ kind: "command", command: "bash", args: ["-c", "grep -q boom out/top-error.txt"] }],
    tags: ["analysis"],
  },
  {
    id: "ho-27-pagination",
    request: "Implement `paginate(items, page, pageSize)` in src/paginate.js returning the page slice and `totalPages(items, pageSize)`.",
    expected: "paginate([1..10], 2, 4) === [5,6,7,8]; totalPages(10, 4) === 3.",
    fixture: { "src/paginate.js": "export function paginate(items, page, pageSize) { return items; }\nexport function totalPages(count, pageSize) { return 1; }\n" },
    verification: [{ kind: "command", command: "node", args: ["-e", "import('./src/paginate.js').then(m => { const r = m.paginate([1,2,3,4,5,6,7,8,9,10], 2, 4); if (r.join(',') !== '5,6,7,8' || m.totalPages(10,4) !== 3) process.exit(1) })"] }],
    tags: ["implementation"],
  },
  {
    id: "ho-28-refactor-naming",
    request: "src/names.js uses single-letter variables. Rename them to descriptive names without changing behavior.",
    expected: "No single-letter identifiers remain in src/names.js; compute(2,3) still returns 11.",
    fixture: { "src/names.js": "export function compute(a, b) {\n  const x = a * a;\n  const y = b * b;\n  return x + y + a * b;\n}\n" },
    verification: [{ kind: "command", command: "node", args: ["-e", "import('./src/names.js').then(m => { if (m.compute(2,3) !== 11) process.exit(1) })"] }],
    tags: ["refactor"],
  },
  {
    id: "ho-29-benchmark",
    request: "Write bench/compare.mjs that times two functions (loop vs while) summing 1..1e6 and prints which is faster.",
    expected: "`node bench/compare.mjs` runs and prints a faster-or-tie conclusion.",
    fixture: { "bench/compare.mjs": "// TODO: time sumLoop vs sumWhile over 1..1e6 and print the faster one\n" },
    verification: [{ kind: "command", command: "node", args: ["bench/compare.mjs"] }],
    tags: ["performance"],
  },
  {
    id: "ho-30-healthcheck",
    request: "src/health.js exports `healthCheck(services)` returning 'ok' only when every service is reachable (status 200), else 'degraded'. Implement with a fetch per service.",
    expected: "healthCheck with all-200 services returns 'ok'; with one failing service returns 'degraded'.",
    fixture: { "src/health.js": "export async function healthCheck(services) {\n  return 'ok';\n}\n" },
    verification: [{ kind: "command", command: "node", args: ["-e", "import('./src/health.js').then(async m => { const r = await m.healthCheck(['https://example.com']); if (r !== 'ok') process.exit(1) })"] }],
    tags: ["implementation"],
  },
];

function caseJson(def, suite) {
  const payload = {
    expected: { status: "completed" },
    suite,
    tags: def.tags,
  };
  if (def.verification !== undefined) payload.verification = def.verification;
  return JSON.stringify(payload, null, 2) + "\n";
}

async function writeCase(suite, def) {
  const dir = join(root, suite, def.id);
  await mkdir(join(dir, "fixture"), { recursive: true });
  await writeFile(join(dir, "request.md"), def.request + "\n");
  await writeFile(join(dir, "expected.md"), def.expected + "\n");
  await writeFile(join(dir, "case.json"), caseJson(def, suite));
  for (const [rel, content] of Object.entries(def.fixture)) {
    const abs = join(dir, "fixture", rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content);
  }
}

async function main() {
  for (const def of regression) await writeCase("regression", def);
  for (const def of holdout) await writeCase("holdout", def);
  console.log(`regression: ${regression.length}, holdout: ${holdout.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
