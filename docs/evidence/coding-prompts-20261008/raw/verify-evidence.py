import argparse, collections, gzip, hashlib, json, pathlib, re, subprocess

p = argparse.ArgumentParser()
p.add_argument('archive', type=pathlib.Path)
p.add_argument('--repo', type=pathlib.Path)
a = p.parse_args()
root = a.archive.resolve()
def load(path):
    file = root / path
    return json.loads(gzip.decompress(file.read_bytes()) if file.suffix == '.gz' else file.read_text())
def require(condition, message):
    if not condition: raise AssertionError(message)
manifest = load('RAW-MANIFEST.json')
require(manifest['schemaVersion'] == 1, 'manifest schema')
sha = manifest['sourceSha']
require(re.fullmatch('[0-9a-f]{40}', sha), 'source SHA format')
listed = set()
for entry in manifest['files']:
    name = entry['path']; path = (root / name).resolve()
    require(path.is_relative_to(root) and name not in listed, 'unsafe or duplicate path')
    listed.add(name); data = path.read_bytes()
    require(len(data) == entry['bytes'] and hashlib.sha256(data).hexdigest() == entry['sha256'], 'artifact drift: ' + name)
actual = {str(f.relative_to(root)) for f in root.rglob('*') if f.is_file() and f.name != 'RAW-MANIFEST.json'}
require(actual == listed, 'manifest must cover every archived file')

def check_vitest(path, passed):
    report = load(path)
    require(report['numFailedTests'] == 0 and report['numPassedTests'] == passed, 'test totals: ' + path)
    states = collections.Counter(x['status'] for f in report['testResults'] for x in f['assertionResults'])
    require(states['failed'] == 0 and states['passed'] == passed, 'case states: ' + path)
    require(all(f['status'] in ('passed', 'pending') for f in report['testResults']), 'suite states: ' + path)
    return report

full = check_vitest('raw/full-suite.json.gz', 9099)
require(full['numPendingTests'] == 13, 'full-suite explicit skip count')
require(sum(x['status'] == 'passed' and x['fullName'].startswith('P07:') for f in full['testResults'] for x in f['assertionResults']) == 2, 'final CLI/Web champion combination guard')
require(any('n2-release-cli-forward.test.ts' in f['name'] and any(x['status'] == 'passed' for x in f['assertionResults']) for f in full['testResults']), 'final real N2 release CLI')
reaper = load('raw/full-suite-receipt.json')
require(reaper['sourceSha'] == sha and reaper['exitCode'] == 0, 'completed Linux run identity')
check_vitest('raw/process-recheck.json.gz', 89)
check_vitest('raw/n2-release.json.gz', 1)
check_vitest('raw/security.json.gz', 2135)
check_vitest('raw/protocol.json.gz', 52)
check_vitest('raw/targeted.json.gz', 48)
guard_red = load('raw/history/champion-combination-red.json')
require(guard_red['numFailedTests'] == 2, 'original unmeasured champion combination counterexamples')
red = load('baseline-red.json')
require(red['numFailedTests'] == 1 and any('P02:' in x['fullName'] and x['status'] == 'failed' for f in red['testResults'] for x in f['assertionResults']), 'original prompt drift counterexample')

windows = load('raw/windows-receipt.json')
cases = load('raw/windows-case-records.json')
require(windows['sourceSha'] == sha and windows['platform'] == 'win32' and windows['outcome'] == 'PASS', 'native Windows identity/status')
require(windows['passed'] == 253 and windows['failed'] == 0 and windows['skipped'] == 1, 'native Windows counts')
states = collections.Counter(x['status'] for f in cases for x in f['assertions'])
require(states['passed'] == 253 and states['failed'] == 0, 'native Windows case states')
require(hashlib.sha256((root / 'raw/windows-case-records.json').read_bytes()).hexdigest() == windows['caseRecordsSha256'], 'native Windows package identity')
require(len(windows['required']) == 12 and all(r['observed'] == ['passed'] for r in windows['required']), 'genuine Windows mandatory cases')

for selected, extra in [('coding-v1', 8), ('legacy', 6)]:
    result = load(selected + '/result.json')
    require(result['sourceSha'] == sha and result['sourceTreeClean'] and result['status'] == 'PASS', 'coding source/status: ' + selected)
    require(result['realModelQuality'] == 'NOT_PROVEN' and result['paidModelCalls'] == 0, 'scripted evidence cannot promote quality')
    require(result['inheritedCodingAssertions'] == 50 and len(result['assertions']) == extra, 'coding assertion count')
    primary = (root / selected / (selected + '-primary.txt')).read_text()
    require(hashlib.sha256(primary.encode()).hexdigest() == result['prompts']['primary']['sha256'], 'primary prompt digest')
    require(result['prompts']['primary']['estimatedTokens'] <= 1500, 'existing system budget')
    requests = load(selected + '/coding/requests.json')
    require(len(requests) == 19 and {'coding', 'web-coding'} <= {r['scenario'] for r in requests}, 'real CLI/Web requests')
    require(all(any(m['role'] == 'system' and primary in m['content'] for m in r['body']['messages']) for r in requests), 'exact policy on actual wire')

v1 = load('coding-v1/result.json')
win_v1 = load('raw/windows-prompt-coding.json')
require(win_v1['sourceSha'] == sha and win_v1['platform'] == 'win32' and win_v1['status'] == 'PASS', 'Windows prompt acceptance')
require(win_v1['prompts'] == v1['prompts'] and win_v1['inheritedCodingAssertions'] == 49 and len(win_v1['assertions']) == 8, 'cross-platform prompt bytes/assertions')
require(win_v1['realModelQuality'] == 'NOT_PROVEN', 'Windows quality boundary')
for name, count in [('security',2135),('protocol',52)]:
    text = (root / ('raw/' + name + '.log')).read_text()
    require(re.search(r'Tests\s+' + str(count) + r' passed \(' + str(count) + r'\)', text) is not None and ' FAIL ' not in text, 'independent gate: ' + name)
ci = load('raw/source-ci-run.json'); jobs = load('raw/source-ci-jobs.json')['jobs']
require(ci['head_sha'] == sha and ci['conclusion'] == 'success' and ci['status'] == 'completed', 'completed exact-source CI')
require(len(jobs) == 10 and all(j['conclusion'] == 'success' for j in jobs), 'all CI jobs including release attestation')

if a.repo:
    source = load('raw/product-source-files.json')
    require(source['sourceSha'] == sha, 'canonical Git source identity')
    for entry in source['files']:
        data = subprocess.check_output(['git', '-C', str(a.repo), 'show', sha + ':' + entry['path']])
        require(hashlib.sha256(data).hexdigest() == entry['sha256'], 'canonical source drift: ' + entry['path'])
print(json.dumps({'status':'PASS', 'sourceSha':sha, 'files':len(listed), 'linuxTestsPassed':9099,
    'nativeWindowsTestsPassed':253, 'realModelQuality':'NOT_PROVEN'}, ensure_ascii=False))
