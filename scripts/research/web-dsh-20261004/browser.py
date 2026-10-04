#!/usr/bin/env python3
"""Chromium acceptance on production composition roots + labelled race controls.

Requires Python Playwright and a Chromium executable. No paid model requests.
Build once first: pnpm build. See README.md for baseline/candidate commands.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import traceback
import urllib.request
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--repo', type=Path, default=HERE.parents[2])
parser.add_argument('--out', type=Path, required=True)
parser.add_argument('--mode', choices=['baseline', 'candidate'], default='candidate')
parser.add_argument('--static-dir', type=Path)
parser.add_argument('--chromium', default=os.environ.get('CHROMIUM', '/usr/bin/chromium'))
parser.add_argument('--require-clean', action='store_true', help='Fail unless the tracked source is clean at fixture startup and the source SHA/fingerprints stay unchanged.')
args = parser.parse_args()
args.repo = args.repo.resolve()
args.out = args.out.resolve()
args.out.mkdir(parents=True, exist_ok=False)
fixture_out = args.out / 'fixture'
fixture_out.mkdir()
probe_hashes = {}
for name in ['browser.py', 'protocol-control.js', 'fixture.mjs']:
    probe_hashes[name] = hashlib.sha256((HERE / name).read_bytes()).hexdigest()
receipts = []
browser_errors = []
network_errors = []
requests = []
responses = []
assertion_count = 0


def save(name, data):
    (args.out / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')


def record(name, group, passed, observed=None):
    receipts.append({'name': name, 'group': group, 'passed': bool(passed), 'observed': observed})


def expect(condition, message):
    global assertion_count
    assertion_count += 1
    if not condition:
        raise AssertionError(message)


def run_case(name, group, function):
    before = assertion_count
    try:
        observed = function()
        record(name, group, True, observed)
    except Exception as error:
        record(name, group, False, {'error': str(error), 'traceback': traceback.format_exc()})
    receipts[-1]['assertCount'] = assertion_count - before


def snapshot():
    with urllib.request.urlopen(ready['inspector'], timeout=10) as response:
        return json.load(response)


def wait_snapshot(predicate, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        current = snapshot()
        if predicate(current):
            return current
        time.sleep(.05)
    raise AssertionError('production inspector predicate timed out')


fixture_log = (args.out / 'fixture.log').open('w')
command = ['node', str(HERE / 'fixture.mjs'), '--repo', str(args.repo), '--out', str(fixture_out)]
if args.static_dir:
    command.extend(['--static-dir', str(args.static_dir.resolve())])
process = subprocess.Popen(command, cwd=args.repo, stdout=fixture_log, stderr=subprocess.STDOUT)
ready = None
status = 'FAILED'
cleanup = None
try:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if (fixture_out / 'ready.json').exists():
            ready = json.loads((fixture_out / 'ready.json').read_text())
            break
        if process.poll() is not None:
            raise RuntimeError('production fixture exited before ready')
        time.sleep(.05)
    if ready is None:
        raise RuntimeError('production fixture failed to become ready')
    if args.require_clean:
        expect(not ready['trackedDirty'], 'candidate requires clean tracked source at startup')

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=args.chromium, headless=True, args=['--no-sandbox'])
        chromium_version = browser.version

        def page_context(controlled=False, mobile=False):
            context = browser.new_context(viewport={'width': 390, 'height': 844} if mobile else {'width': 1440, 'height': 900})
            if controlled:
                context.add_init_script(path=str(HERE / 'protocol-control.js'))
            page = context.new_page()
            page.on('pageerror', lambda error: browser_errors.append({'controlled': controlled, 'error': str(error)}))
            page.on('requestfailed', lambda request: network_errors.append({'controlled': controlled, 'url': request.url, 'failure': request.failure}))
            page.on('request', lambda request: requests.append({'controlled': controlled, 'method': request.method, 'url': request.url}))
            page.on('response', lambda response: responses.append({'controlled': controlled, 'url': response.url, 'status': response.status}))
            page.goto(ready['base'], wait_until='domcontentloaded')
            page.wait_for_function("localStorage.getItem('harness.web.activeFrom') !== null")
            if controlled:
                page.get_by_text('B_ONLY_HISTORY', exact=True).wait_for()
            else:
                page.wait_for_function("document.getElementById('conn-label').textContent.includes('已连接')")
            return context, page

        def controlled_case(kind):
            context, page = page_context(controlled=True)
            try:
                if kind == 'consecutive-assistants-and-id-replay':
                    page.evaluate("""() => {
                        const i = __control.streams.length - 1;
                        __control.emit(i, {type:'assistant_text', messageId:'assistant-one',text:'CONTROL_REPLY_ONE'});
                        __control.emit(i, {type:'assistant_text', messageId:'assistant-two',text:'CONTROL_REPLY_TWO'});
                        __control.emit(i, {type:'assistant_text', messageId:'assistant-one',text:'CONTROL_REPLY_ONE'});
                    }""")
                    actual = page.locator('.assistant-row').all_text_contents()
                    expect(len(actual) == 2 and sum('CONTROL_REPLY_ONE' in text for text in actual) == 1 and sum('CONTROL_REPLY_TWO' in text for text in actual) == 1, f'expected two unique messages, observed {actual}')
                    return {'assistantRows': actual, 'inputFrames': 3, 'uniqueMessageIds': 2}
                if kind == 'slow-a-history-cannot-pollute-b':
                    page.evaluate('__control.holdHistory = true')
                    page.locator('[data-from="browser-control-A-123"]').click()
                    page.wait_for_function('__control.historyWaiters.length === 1')
                    page.locator('[data-from="browser-control-B-123"]').click()
                    page.get_by_text('B_ONLY_HISTORY', exact=True).wait_for()
                    page.evaluate('__control.resolveHistory()')
                    page.wait_for_timeout(100)
                    actual = page.locator('#messages').inner_text()
                    expect('B_ONLY_HISTORY' in actual and 'A_ONLY_HISTORY' not in actual, f'late A history contaminated B: {actual}')
                    return {'visibleText': actual, 'activeFrom': page.evaluate("localStorage.getItem('harness.web.activeFrom')")}
                if kind == 'xss-is-text':
                    payload = '<img src=x onerror="window.__XSS_EXECUTED=1"><script>window.__XSS_EXECUTED=2</script>'
                    page.evaluate("""payload => {
                        const i = __control.streams.length - 1;
                        __control.emit(i, {type:'text',text:payload});
                        __control.emit(i, {type:'assistant_text',messageId:'xss',text:payload});
                    }""", payload)
                    actual = page.locator('#messages').inner_text()
                    expect(payload in actual and page.locator('#messages img, #messages script').count() == 0 and page.evaluate('window.__XSS_EXECUTED ?? null') is None, 'HTML payload was parsed/executed or lost')
                    return {'payload': payload, 'literalText': actual, 'injectedElements': 0, 'executionMarker': None}
                if kind == 'closed-sse-callback-cannot-pollute-new-session':
                    old_index = page.evaluate('__control.streams.length - 1')
                    page.locator('[data-from="browser-control-A-123"]').click()
                    page.get_by_text('A_ONLY_HISTORY', exact=True).wait_for()
                    page.evaluate("""i => {
                        __control.emit(i, {type:'assistant_text',messageId:'old-stream',text:'OLD_STREAM_TEXT'});
                        __control.emit(i, {type:'event',event:{type:'turn.started',payload:{}}});
                        __control.streams[i].onerror?.({});
                    }""", old_index)
                    expect('OLD_STREAM_TEXT' not in page.locator('#messages').inner_text() and page.locator('#cancel-btn').is_disabled(), 'closed stream callback changed new session')
                    expect('已连接' in page.locator('#conn-label').inner_text(), 'closed stream onerror changed current connection')
                    return {'oldStreamClosed': page.evaluate(f'__control.streams[{old_index}].closed'), 'oldTextVisible': False, 'cancelDisabled': True}
                if kind == 'old-post-error-cannot-pollute-new-session':
                    page.evaluate('__control.holdPost = true')
                    page.locator('#input').fill('OLD_POST_INPUT')
                    page.locator('#send-btn').click()
                    page.wait_for_function('__control.postWaiters.length === 1')
                    page.locator('[data-from="browser-control-A-123"]').click()
                    page.get_by_text('A_ONLY_HISTORY', exact=True).wait_for()
                    page.evaluate('__control.resolvePost()')
                    page.wait_for_timeout(100)
                    actual = page.locator('#messages').inner_text()
                    expect('OLD_POST_FAILURE' not in actual and 'OLD_POST_INPUT' not in actual, f'old POST leaked: {actual}')
                    return {'lateResponseStatus': 400, 'activeText': actual, 'posts': page.evaluate('__control.posts')}
                if kind == 'ime-enter-does-not-send-and-enter-sends-once':
                    page.locator('#input').fill('输入法正在组合')
                    page.locator('#input').evaluate("node => node.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}))")
                    page.wait_for_timeout(80)
                    expect(page.evaluate('__control.posts.length') == 0, 'IME composing Enter sent a message')
                    expect(page.locator('#input').input_value() == '输入法正在组合', 'IME Enter cleared input')
                    page.locator('#input').press('Shift+Enter')
                    expect(page.evaluate('__control.posts.length') == 0, 'Shift+Enter sent a message')
                    page.locator('#input').press('Enter')
                    page.wait_for_function('__control.posts.length === 1')
                    return {'posts': page.evaluate('__control.posts'), 'composingPostCount': 0, 'shiftEnterPostCount': 0}
                if kind == 'history-and-live-id-replay-does-not-duplicate':
                    page.evaluate("""() => {
                        __control.holdHistory = true;
                        __control.histories = { [__control.A]: {sessionId:'history-live-session',messages:[
                            {id:'user-a',role:'user',content:'A_ONLY_HISTORY'},
                            {id:'shared-live-id',role:'assistant',content:'ONCE_ONLY'}
                        ]}};
                    }""")
                    page.locator('[data-from="browser-control-A-123"]').click()
                    page.wait_for_function('__control.historyWaiters.length === 1')
                    expect(page.evaluate("__control.streams.at(-1).url.includes(__control.A)"), 'live frame target does not belong to current A stream')
                    page.evaluate("""() => {
                        const i = __control.streams.length - 1;
                        __control.emit(i,{type:'assistant_text',messageId:'shared-live-id',text:'ONCE_ONLY'});
                        __control.emit(i,{type:'assistant_text',messageId:'shared-live-id',text:'ONCE_ONLY'});
                        __control.resolveHistory();
                    }""")
                    page.get_by_text('A_ONLY_HISTORY', exact=True).wait_for()
                    expect(page.get_by_text('ONCE_ONLY', exact=True).count() == 1, 'replayed complete message duplicated')
                    return {'frames': 2, 'historyRecords': 1, 'rendered': 1}
                if kind == 'hello-handshake-precedes-history-and-preserves-buffered-message':
                    page.evaluate("""() => {
                        __control.holdHello = true;
                        __control.holdHistory = true;
                    }""")
                    stream_count = page.evaluate('__control.streams.length')
                    page.locator('[data-from="browser-control-A-123"]').click()
                    page.wait_for_function('n => __control.streams.length === n+1', arg=stream_count)
                    page.wait_for_timeout(100)
                    expect(page.evaluate("__control.historyRequests.filter(request=>request.from===__control.A).length") == 0, 'history started before actual hello frame')
                    page.evaluate("""() => {
                        const i = __control.streams.length - 1;
                        __control.emit(i,{type:'assistant_text',messageId:'handshake-buffered',text:'HANDSHAKE_BUFFERED_MESSAGE'});
                        __control.emit(i,{type:'hello'});
                    }""")
                    page.wait_for_function('__control.historyWaiters.length === 1')
                    page.evaluate('__control.resolveHistory()')
                    page.get_by_text('A_ONLY_HISTORY', exact=True).wait_for()
                    page.get_by_text('HANDSHAKE_BUFFERED_MESSAGE', exact=True).wait_for()
                    expect(page.get_by_text('HANDSHAKE_BUFFERED_MESSAGE', exact=True).count() == 1, 'handshake-buffered message lost or duplicated')
                    return {'historyRequests': page.evaluate('__control.historyRequests'), 'helloFrames': page.evaluate('__control.helloFrames'), 'bufferedMessageCount': 1}
                if kind == 'history-before-live-id-replay-does-not-duplicate':
                    page.evaluate("""() => {
                        __control.histories = { [__control.A]: {sessionId:'history-first-session',messages:[
                            {id:'user-a',role:'user',content:'A_ONLY_HISTORY'},
                            {id:'history-first-shared',role:'assistant',content:'HISTORY_FIRST_ONCE'}
                        ]}};
                    }""")
                    page.locator('[data-from="browser-control-A-123"]').click()
                    page.get_by_text('HISTORY_FIRST_ONCE', exact=True).wait_for()
                    page.evaluate("""() => {
                        const i = __control.streams.length - 1;
                        __control.emit(i,{type:'assistant_text',messageId:'history-first-shared',text:'HISTORY_FIRST_ONCE'});
                        __control.emit(i,{type:'assistant_text',messageId:'history-first-shared',text:'HISTORY_FIRST_ONCE'});
                    }""")
                    expect(page.get_by_text('HISTORY_FIRST_ONCE', exact=True).count() == 1, 'history-first/live repeated complete message duplicated')
                    return {'historyRecords': 1, 'liveFramesAfterHistory': 2, 'rendered': 1}
                if kind == 'historical-and-expired-approvals-are-readonly':
                    page.evaluate("""() => {
                        const i = __control.streams.length - 1;
                        for (const [id,pending,expiresAt] of [['historical',false,Date.now()+60000],['expired',true,Date.now()-1000]])
                            __control.emit(i,{type:'event',event:{type:'approval.created',sessionId:'session-B',payload:{approvalId:id,action:'edit',target:'safe.txt',pending,expiresAt}}});
                    }""")
                    cards = page.locator('.approval-card')
                    expect(cards.count() == 2, 'readonly approvals missing')
                    expect(cards.locator('button:not([disabled])').count() == 0, 'historical or expired approval has actionable buttons')
                    expect(page.evaluate('__control.posts.length') == 0, 'readonly approval dispatched a command')
                    return {'cards': 2, 'actionableButtons': 0, 'commands': 0}
                if kind == 'resolved-approval-replay-is-idempotent':
                    page.evaluate("""() => {
                        const i = __control.streams.length - 1;
                        const created={type:'event',event:{type:'approval.created',sessionId:'session-B',payload:{approvalId:'same-approval',action:'edit',pending:true,expiresAt:Date.now()+60000}}};
                        const resolved={type:'event',event:{type:'approval.resolved',sessionId:'session-B',payload:{approvalId:'same-approval',value:'allow'}}};
                        __control.emit(i,created); __control.emit(i,resolved); __control.emit(i,resolved); __control.emit(i,created);
                    }""")
                    expect(page.locator('.approval-card').count() == 1 and page.locator('.approval-result').count() == 1, 'approval replay duplicated card/result')
                    expect(page.locator('.approval-card button:not([disabled])').count() == 0, 'replayed resolved approval became actionable')
                    return {'createdFrames': 2, 'resolvedFrames': 2, 'cards': 1, 'results': 1, 'actionableButtons': 0}
                if kind == 'reconnect-hello-merges-missed-history-without-duplicates':
                    page.evaluate("""() => {
                        const i = __control.streams.length - 1;
                        __control.emit(i,{type:'assistant_text',messageId:'known-before-gap',text:'KNOWN_BEFORE_GAP'});
                        __control.histories = { [__control.B]: {sessionId:'reconnect-B',messages:[
                            {id:`history-${__control.B}`,role:'user',content:'B_ONLY_HISTORY'},
                            {id:'known-before-gap',role:'assistant',content:'KNOWN_BEFORE_GAP'},
                            {id:'completed-during-gap',role:'assistant',content:'MISSED_DURING_GAP'}
                        ]}};
                        __control.emit(i,{type:'hello'});
                    }""")
                    page.get_by_text('MISSED_DURING_GAP', exact=True).wait_for()
                    expect(page.get_by_text('B_ONLY_HISTORY', exact=True).count() == 1, 'reconnect repeated known user history')
                    expect(page.get_by_text('KNOWN_BEFORE_GAP', exact=True).count() == 1 and page.get_by_text('MISSED_DURING_GAP', exact=True).count() == 1, 'reconnect duplicated known assistant or missed reply')
                    return {'helloFrames': page.evaluate('__control.helloFrames'), 'historyRequests': page.evaluate('__control.historyRequests'), 'knownUserCount': 1, 'knownAssistantCount': 1, 'missedAssistantCount': 1}
                raise AssertionError(f'unknown controlled case {kind}')
            finally:
                context.close()

        controls = ['consecutive-assistants-and-id-replay', 'slow-a-history-cannot-pollute-b', 'xss-is-text']
        if args.mode == 'candidate':
            controls += ['closed-sse-callback-cannot-pollute-new-session', 'old-post-error-cannot-pollute-new-session', 'ime-enter-does-not-send-and-enter-sends-once', 'history-and-live-id-replay-does-not-duplicate', 'history-before-live-id-replay-does-not-duplicate', 'hello-handshake-precedes-history-and-preserves-buffered-message', 'historical-and-expired-approvals-are-readonly', 'resolved-approval-replay-is-idempotent', 'reconnect-hello-merges-missed-history-without-duplicates']
        for kind in controls:
            run_case(kind, 'controlled-protocol', lambda kind=kind: controlled_case(kind))

        if args.mode == 'candidate':
            context, page = page_context()
            from_id = page.evaluate("localStorage.getItem('harness.web.activeFrom')")

            def send(text):
                page.locator('#input').fill(text)
                page.locator('#send-btn').click()

            def normal_turn(text):
                send(text)
                page.get_by_text(f'HARNESS_REPLY:{text}', exact=True).wait_for(timeout=20000)
                wait_snapshot(lambda data: any(event['type'] == 'turn.completed' for record in data['records'] for event in record['events']))
                page.wait_for_function("document.getElementById('cancel-btn').disabled")

            def layout():
                width = page.evaluate('({viewport:innerWidth,document:document.documentElement.scrollWidth})')
                expect(width['document'] <= width['viewport'], f'desktop horizontal overflow {width}')
                expect(page.locator('#input').is_visible() and page.locator('#send-btn').is_visible(), 'desktop composer hidden')
                page.screenshot(path=str(args.out / 'desktop-light.png'))
                return width
            run_case('desktop-1440x900-layout', 'production-stack', layout)

            def local_resources():
                names = ['/', '/app.js', '/style.css', '/vendor/deepseek/LICENSE', '/vendor/deepseek/source-manifest.json'] + [f'/vendor/deepseek/{name}.css' for name in ['base', 'corner-shape', 'design-platform', 'focus', 'scrollbar', 'gradient-shadow-text']]
                statuses = {}
                for path in names:
                    response = page.request.get(ready['base'] + path)
                    statuses[path] = response.status
                    expect(response.status == 200, f'local resource {path} returned {response.status}')
                resources = page.evaluate("performance.getEntriesByType('resource').map(entry=>entry.name)")
                expect(all(urlparse(url).netloc == urlparse(ready['base']).netloc for url in resources), f'external resource dependency {resources}')
                loaded_css = [urlparse(url).path for url in resources if url.endswith('.css')]
                expect(all(f'/vendor/deepseek/{name}.css' in loaded_css for name in ['base', 'corner-shape', 'design-platform', 'focus', 'scrollbar', 'gradient-shadow-text']), f'vendored theme sheets not loaded: {loaded_css}')
                return {'localHttpStatuses': statuses, 'loadedStylesheets': loaded_css, 'externalResourceCount': 0}
            run_case('vendored-assets-local-200-without-cdn', 'production-stack', local_resources)

            def theme_and_sidebar():
                light_background = page.locator('#app').evaluate('node => getComputedStyle(node).backgroundColor')
                page.locator('#theme-toggle').click()
                page.wait_for_function("document.body.hasAttribute('data-ds-dark-theme')")
                dark_background = page.locator('#app').evaluate('node => getComputedStyle(node).backgroundColor')
                expect(light_background != dark_background, f'theme changed attribute but not computed background {light_background}')
                page.screenshot(path=str(args.out / 'desktop-dark.png'))
                page.reload(wait_until='domcontentloaded')
                page.wait_for_function("document.body.hasAttribute('data-ds-dark-theme')")
                expect(page.locator('#app').evaluate('node => getComputedStyle(node).backgroundColor') == dark_background, 'refresh changed computed dark theme')
                expanded = page.locator('#sidebar').bounding_box()
                page.locator('#sidebar-toggle').click()
                page.wait_for_function("document.getElementById('sidebar-toggle').getAttribute('aria-expanded') === 'false'")
                page.wait_for_timeout(250)
                collapsed_box = page.locator('#sidebar').bounding_box()
                collapsed = page.evaluate("document.getElementById('app').className")
                expect(collapsed_box is None or collapsed_box['width'] < 5 or collapsed_box['x'] + collapsed_box['width'] <= 1, f'sidebar still occupies visible layout: {collapsed_box}')
                page.locator('#sidebar-toggle').click()
                page.wait_for_function("document.getElementById('sidebar-toggle').getAttribute('aria-expanded') === 'true'")
                page.wait_for_timeout(250)
                expect(page.locator('#sidebar').bounding_box()['width'] > 100, 'sidebar failed to expand')
                return {'lightComputedBackground': light_background, 'darkComputedBackground': dark_background, 'darkThemeSurvivedRefresh': True, 'expandedSidebarBox': expanded, 'collapsedSidebarBox': collapsed_box, 'collapsedAppClass': collapsed}
            run_case('theme-and-sidebar', 'production-stack', theme_and_sidebar)

            def two_replies():
                normal_turn('BROWSER_FIRST')
                normal_turn('BROWSER_SECOND')
                expect(page.get_by_text('HARNESS_REPLY:BROWSER_FIRST', exact=True).count() == 1 and page.get_by_text('HARNESS_REPLY:BROWSER_SECOND', exact=True).count() == 1, 'two actual runtime replies not uniquely visible')
                current = snapshot()
                events = [event for record in current['records'] for event in record['events']]
                completed = [event for event in events if event['type'] == 'turn.completed']
                verified = [event for event in events if event['type'] == 'verification.completed' and event['payload'].get('passed') is True]
                expect(len(completed) == 2 and len(verified) == 2, f'real verification gate counts completed={len(completed)} verified={len(verified)}')
                return {'completedTurns': len(completed), 'verifiedTurns': len(verified), 'assistantTexts': page.locator('.assistant-row').all_text_contents()}
            run_case('two-production-replies-and-verification', 'production-stack', two_replies)

            def refresh_history():
                page.reload(wait_until='domcontentloaded')
                page.get_by_text('HARNESS_REPLY:BROWSER_FIRST', exact=True).wait_for()
                page.get_by_text('HARNESS_REPLY:BROWSER_SECOND', exact=True).wait_for()
                expect(page.evaluate("localStorage.getItem('harness.web.activeFrom')") == from_id, 'refresh changed browser sender')
                expect(page.get_by_text('HARNESS_REPLY:BROWSER_FIRST', exact=True).count() == 1, 'history/SSE replay duplicated reply')
                return {'senderRetained': from_id, 'firstReplyCount': 1, 'secondReplyCount': page.get_by_text('HARNESS_REPLY:BROWSER_SECOND', exact=True).count()}
            run_case('refresh-restores-production-history', 'production-stack', refresh_history)

            def copy_reply():
                context.grant_permissions(['clipboard-read', 'clipboard-write'], origin=ready['base'])
                page.locator('.assistant-row').filter(has_text='HARNESS_REPLY:BROWSER_FIRST').locator('.message-actions .copy-button').click()
                copied = page.evaluate('navigator.clipboard.readText()')
                expect(copied == 'HARNESS_REPLY:BROWSER_FIRST', f'copy reply not exact: {copied!r}')
                return {'clipboardText': copied, 'source': 'actual browser clipboard after UI click'}
            run_case('copy-production-assistant-reply', 'production-stack', copy_reply)

            def allow_write():
                send('[allow-write]')
                page.locator('.approval-card .allow-btn').wait_for(timeout=15000)
                pending = snapshot()['pendingApprovals']
                expect(len(pending) == 1 and pending[0]['action'] == 'edit', f'not genuine write approval {pending}')
                expect(snapshot()['files']['allowed.txt'] is None, 'write occurred before approval')
                page.locator('.approval-card .allow-btn').click()
                page.get_by_text('HARNESS_REPLY:[allow-write]', exact=True).wait_for(timeout=15000)
                current = wait_snapshot(lambda data: data['files']['allowed.txt'] is not None)
                expect(current['files']['allowed.txt'] == 'ACTUAL_HARNESS_WRITE\n', 'approved production tool did not write expected bytes')
                events = [event for record in current['records'] for event in record['events']]
                expect(any(event['type'] == 'human.approval' and event['payload'].get('value') == 'allow' for event in events), 'no production human.approval event')
                return {'approvalId': pending[0]['id'], 'fileBytes': len(current['files']['allowed.txt']), 'toolName': 'write_file'}
            run_case('real-approval-allow-write', 'production-stack', allow_write)

            def deny_write():
                send('[deny-write]')
                page.locator('.approval-card:not(.resolved) .deny-btn').wait_for(timeout=15000)
                pending = snapshot()['pendingApprovals']
                before = snapshot()
                human_before = sum(event['type'] == 'human.approval' for record in before['records'] for event in record['events'])
                foreign = page.request.post(ready['base'] + '/api/commands', data={'from': 'foreign-browser-12345', 'text': f"approve:{pending[0]['id']}:allow"})
                after_foreign = snapshot()
                expect(foreign.status == 400 and any(item['id'] == pending[0]['id'] for item in after_foreign['pendingApprovals']), 'foreign sender changed approval')
                expect(sum(event['type'] == 'human.approval' for record in after_foreign['records'] for event in record['events']) == human_before, 'foreign approval emitted human.approval')
                page.locator('.approval-card:not(.resolved) .deny-btn').click()
                page.get_by_text('HARNESS_REPLY:[deny-write]', exact=True).wait_for(timeout=15000)
                current = snapshot()
                expect(current['files']['denied.txt'] is None and not current['pendingApprovals'], 'denied tool wrote or approval remains')
                expect(any(event['type'] == 'human.approval' and event['payload'].get('value') == 'deny' for record in current['records'] for event in record['events']), 'no deny intervention')
                return {'approvalId': pending[0]['id'], 'fileAbsent': True, 'foreignAttemptStatus': foreign.status, 'foreignPreservedPending': True, 'foreignHumanEventCount': 0}
            run_case('real-approval-deny-write', 'production-stack', deny_write)

            def sandbox_deny():
                send('[sandbox-deny]')
                page.locator('.approval-card:not(.resolved) .allow-btn').wait_for(timeout=15000)
                pending = snapshot()['pendingApprovals']
                page.locator('.approval-card:not(.resolved) .allow-btn').click()
                page.get_by_text('HARNESS_REPLY:[sandbox-deny]', exact=True).wait_for(timeout=15000)
                current = snapshot()
                expect(current['files']['../outside.txt'] is None, 'sandbox escape wrote outside admitted workspace')
                events = [event for record in current['records'] for event in record['events']]
                tool_failures = [event for event in events if event['type'] in ['tool.failed', 'tool.denied'] and ('sandbox' in json.dumps(event).lower() or 'SANDBOX' in json.dumps(event))]
                expect(tool_failures, 'outside write did not record sandbox denial')
                return {'approvalId': pending[0]['id'], 'outsideFileAbsent': True, 'sandboxEvents': tool_failures}
            run_case('real-sandbox-denies-approved-outside-write', 'production-stack', sandbox_deny)

            def cancel_block():
                send('[block]')
                page.wait_for_function("!document.getElementById('cancel-btn').disabled")
                wait_snapshot(lambda data: any(call['prompt'] == '[block]' for call in data['calls']))
                page.locator('#cancel-btn').click()
                current = wait_snapshot(lambda data: any(event['type'] == 'turn.cancelled' for record in data['records'] for event in record['events']))
                page.wait_for_function("document.getElementById('cancel-btn').disabled")
                expect(any(event['type'] == 'human.cancel' for record in current['records'] for event in record['events']), 'no production cancel intervention')
                return {'cancelledTurns': sum(event['type'] == 'turn.cancelled' for record in current['records'] for event in record['events']), 'providerAbortObserved': any(call.get('aborted') for call in current['calls'])}
            run_case('cancel-real-blocked-turn', 'production-stack', cancel_block)

            def reconnect_production():
                send('[disconnect-complete]')
                wait_snapshot(lambda data: any(call['prompt'] == '[disconnect-complete]' for call in data['calls']))
                context.set_offline(True)
                current = wait_snapshot(lambda data: any(message.get('content') == 'HARNESS_REPLY:[disconnect-complete]' for record in data['records'] for message in record['messages']))
                expect('HARNESS_REPLY:[disconnect-complete]' not in page.locator('#messages').inner_text(), 'offline browser received reply before reconnect')
                context.set_offline(False)
                page.get_by_text('HARNESS_REPLY:[disconnect-complete]', exact=True).wait_for(timeout=20000)
                page.wait_for_function("document.getElementById('conn-label').textContent.includes('已连接')")
                expect(page.get_by_text('HARNESS_REPLY:[disconnect-complete]', exact=True).count() == 1, 'reconnected production reply duplicated')
                expect(page.get_by_text('HARNESS_REPLY:BROWSER_FIRST', exact=True).count() == 1 and page.get_by_text('[disconnect-complete]', exact=True).count() == 1, 'reconnect duplicated known/user messages')
                return {'offlineCompletionPersisted': True, 'reconnectedReplyCount': 1, 'priorReplyCount': 1, 'actualBrowserNetworkOffline': True}
            run_case('real-offline-completion-reconnect-restores-reply', 'production-stack', reconnect_production)

            def new_session():
                page.locator('#new-session-btn').click()
                page.wait_for_function("old => localStorage.getItem('harness.web.activeFrom') !== old", arg=from_id)
                new_from = page.evaluate("localStorage.getItem('harness.web.activeFrom')")
                expect('BROWSER_FIRST' not in page.locator('#messages').inner_text(), 'new session contains old chat')
                normal_turn('NEW_SESSION')
                current = snapshot()
                expect(len(current['bindings']) == 2 and len(current['records']) == 2, 'new from did not create distinct production session')
                page.screenshot(path=str(args.out / 'desktop-chat.png'))
                return {'previousFrom': from_id, 'newFrom': new_from, 'sessionCount': len(current['records'])}
            run_case('new-session-isolation', 'production-stack', new_session)

            def mobile():
                mobile_context, mobile_page = page_context(mobile=True)
                try:
                    width = mobile_page.evaluate('({viewport:innerWidth,document:document.documentElement.scrollWidth})')
                    expect(width['document'] <= width['viewport'], f'mobile horizontal overflow {width}')
                    expect(mobile_page.locator('#input').is_visible() and mobile_page.locator('#send-btn').is_visible(), 'mobile composer hidden')
                    mobile_page.locator('#sidebar-toggle').click()
                    mobile_page.wait_for_function("document.getElementById('sidebar-toggle').getAttribute('aria-expanded') === 'true'")
                    expect(mobile_page.locator('#new-session-btn').is_visible(), 'mobile side drawer did not open')
                    mobile_page.screenshot(path=str(args.out / 'mobile-sidebar.png'))
                    mobile_page.locator('#sidebar-close').click()
                    mobile_page.wait_for_function("document.getElementById('sidebar-toggle').getAttribute('aria-expanded') === 'false'")
                    mobile_page.screenshot(path=str(args.out / 'mobile-chat.png'))
                    return width
                finally:
                    mobile_context.close()
            run_case('mobile-390x844-layout-and-drawer', 'production-stack', mobile)

            def verification_failure():
                send('[fail-verification]')
                page.locator('.approval-card:not(.resolved) .allow-btn').wait_for(timeout=15000)
                pending = snapshot()['pendingApprovals']
                page.locator('.approval-card:not(.resolved) .allow-btn').click()
                current = wait_snapshot(lambda data: any(event['type'] == 'turn.failed' for record in data['records'] for event in record['events']), timeout=25)
                records = [record for record in current['records'] if any(message.get('content') == '[fail-verification]' and message['role'] == 'user' for message in record['messages'])]
                expect(len(records) == 1, 'failed verification session not identifiable')
                starts = [event for event in records[0]['events'] if event['type'] == 'turn.started']
                turn_id = starts[-1].get('turnId', starts[-1]['payload'].get('turnId'))
                events = [event for event in records[0]['events'] if event.get('turnId', event['payload'].get('turnId')) == turn_id]
                expect(current['files']['fail-verification.flag'] is not None, 'verification marker was not written by actual approved tool')
                expect(any(event['type'] == 'verification.failed' for event in events), 'actual exit 7 did not produce verification.failed')
                expect(any(event['type'] == 'turn.failed' for event in events) and not any(event['type'] == 'turn.completed' for event in events), 'failed verification incorrectly completed turn')
                page.wait_for_function("document.getElementById('cancel-btn').disabled")
                visible = page.locator('#messages').inner_text()
                expect('验证失败' in visible or '验收失败' in visible, f'UI did not show actual verification failure: {visible}')
                return {'approvalId': pending[0]['id'], 'turnId': turn_id, 'verificationFailureEvents': [event for event in events if event['type'] == 'verification.failed'], 'terminalTypes': [event['type'] for event in events if event['type'] in ['turn.failed', 'turn.completed']], 'markerCreatedBy': 'production write_file after UI approval'}
            run_case('real-verification-exit7-prevents-completion', 'production-stack', verification_failure)
            save('production-observed-snapshot.json', snapshot())
            context.close()

        browser.close()
        if args.mode == 'baseline':
            checks = {receipt['name']: receipt['passed'] for receipt in receipts}
            reproduced = not checks.get('consecutive-assistants-and-id-replay', True) and not checks.get('slow-a-history-cannot-pollute-b', True) and checks.get('xss-is-text', False)
            status = 'BASELINE_REPRODUCED' if reproduced else 'FAILED'
        else:
            status = 'PASS' if receipts and all(receipt['passed'] for receipt in receipts) and not browser_errors else 'FAILED'
except Exception as error:
    record('runner', 'infrastructure', False, {'error': str(error), 'traceback': traceback.format_exc()})
finally:
    forced_kill = False
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            forced_kill = True
            process.kill()
            process.wait()
    fixture_log.close()
    final_snapshot_path = fixture_out / 'runtime-snapshot.json'
    try:
        final_runtime_snapshot = json.loads(final_snapshot_path.read_text())
        expect(process.returncode == 0 and not forced_kill, f'fixture shutdown failed: exit={process.returncode}, forcedKill={forced_kill}')
        expect(isinstance(final_runtime_snapshot.get('records'), list), 'fixture snapshot missing runtime records')
        final_sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=args.repo, text=True).strip()
        changed_fingerprints = []
        if ready:
            for path, expected in ready['fingerprints'].items():
                actual_path = Path(ready['staticDir']) / path[len('static/'):] if path.startswith('static/') else args.repo / path
                if hashlib.sha256(actual_path.read_bytes()).hexdigest() != expected:
                    changed_fingerprints.append(path)
        if args.require_clean:
            expect(final_sha == ready['sourceSha'] and not changed_fingerprints, f'source changed during browser acceptance: {changed_fingerprints}, HEAD={final_sha}')
        cleanup = {'graceful': True, 'exitCode': process.returncode, 'forcedKill': False, 'runtimeSnapshotReadable': True, 'finalSourceSha': final_sha, 'changedFingerprints': changed_fingerprints}
    except Exception as error:
        cleanup = {'graceful': False, 'exitCode': process.returncode, 'forcedKill': forced_kill, 'runtimeSnapshotReadable': final_snapshot_path.exists(), 'error': str(error)}
        record('fixture-cleanup', 'infrastructure', False, cleanup)
        status = 'FAILED'
    save('browser-errors.json', browser_errors)
    save('network-errors.json', network_errors)
    save('browser-requests.json', requests)
    save('browser-responses.json', responses)
    save('browser-result.json', {'schema': 'web-dsh-browser.v1', 'status': status, 'mode': args.mode, 'requireCleanSource': args.require_clean, 'scope': 'Real Chromium; production cases use actual Harness/Gateway/WebServer/PermissionEngine/SandboxManager/TaskVerifier with scripted provider; controlled-protocol cases replace browser fetch/EventSource only and do not prove model quality.', 'source': ready, 'probeSha256': probe_hashes, 'cleanup': cleanup, 'chromium': locals().get('chromium_version'), 'viewportDesktop': [1440, 900], 'viewportMobile': [390, 844], 'paidCalls': 0, 'realModelQuality': 'NOT_RUN', 'promotion': 'NOT_RUN', 'caseCount': len(receipts), 'assertCount': assertion_count, 'passed': sum(receipt['passed'] for receipt in receipts), 'failed': sum(not receipt['passed'] for receipt in receipts), 'browserErrorCount': len(browser_errors), 'receipts': receipts})
    artifacts = []
    for path in sorted(args.out.rglob('*')):
        relative = path.relative_to(args.out)
        if path.is_file() and relative.parts[:2] not in [('fixture', 'runtime-data'), ('fixture', 'workspace')] and relative.name != 'artifact-index.json':
            data = path.read_bytes()
            artifacts.append({'path': str(relative), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    save('artifact-index.json', {'schema': 'web-dsh-browser-artifacts.v1', 'artifacts': artifacts})
    print(json.dumps({'status': status, 'cases': len(receipts), 'passed': sum(receipt['passed'] for receipt in receipts), 'failed': sum(not receipt['passed'] for receipt in receipts), 'browserErrors': len(browser_errors), 'out': str(args.out)}))
    for receipt in receipts:
        print(json.dumps({'name': receipt['name'], 'group': receipt['group'], 'passed': receipt['passed'], 'error': receipt.get('observed', {}).get('error')}, ensure_ascii=False))
raise SystemExit(0 if status in ['PASS', 'BASELINE_REPRODUCED'] else 1)
