#!/usr/bin/env python3
"""Extra actual-DOM controls on real Harness/Gateway/WebServer; only model is scripted.
No private UI functions, no fake SSE/backend responses. One explicitly labelled HTTP abort.
"""
import argparse, hashlib, json, os, subprocess, time, traceback, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
parser = argparse.ArgumentParser()
parser.add_argument('--repo', type=Path, default=Path('/workspace/harness-agent'))
parser.add_argument('--out', type=Path, required=True)
parser.add_argument('--expected-sha', required=True)
args = parser.parse_args(); repo=args.repo.resolve(); out=args.out.resolve(); out.mkdir(parents=True, exist_ok=False)
fixture=repo/'scripts/research/web-dsh-20261004/fixture.mjs'; fix=out/'fixture'; fix.mkdir()
receipts=[]; errors=[]; requests=[]; responses=[]; network_errors=[]; assertions=0; ready=None; process=None; status='FAILED'; cleanup={}
def save(name,data): (out/name).write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
def expect(condition,message):
    global assertions
    assertions+=1
    if not condition: raise AssertionError(message)
def git(*argv): return subprocess.check_output(['git',*argv],cwd=repo,text=True).strip()
def snapshot():
    with urllib.request.urlopen(ready['inspector'],timeout=10) as r: return json.load(r)
def wait(predicate,timeout=20):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        data=snapshot()
        if predicate(data): return data
        time.sleep(.03)
    raise AssertionError('production inspector timed out')
def events(data): return [e for record in data['records'] for e in record['events']]
def all_messages(data): return [m for record in data['records'] for m in record['messages']]
def case(name,group,fn):
    before=assertions
    try: receipts.append({'name':name,'group':group,'passed':True,'observed':fn()})
    except Exception as e: receipts.append({'name':name,'group':group,'passed':False,'observed':{'error':str(e),'traceback':traceback.format_exc()}})
    receipts[-1]['assertCount']=assertions-before
log=(out/'fixture.log').open('w')
try:
    expect(git('rev-parse','HEAD')==args.expected_sha,'unexpected source HEAD before fixture')
    expect(not git('status','--porcelain','--untracked-files=no'),'tracked source must be clean before fixture')
    process=subprocess.Popen(['node',str(fixture),'--repo',str(repo),'--out',str(fix)],cwd=repo,stdout=log,stderr=subprocess.STDOUT)
    end=time.monotonic()+30
    while not (fix/'ready.json').exists():
        if process.poll() is not None: raise AssertionError('fixture exited before ready')
        if time.monotonic()>end: raise AssertionError('ready timeout')
        time.sleep(.05)
    ready=json.loads((fix/'ready.json').read_text())
    expect(ready['sourceSha']==args.expected_sha and not ready['trackedDirty'],'fixture source provenance mismatch')
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox']); version=browser.version
        def new_page(mobile=False):
            context=browser.new_context(viewport={'width':390,'height':844} if mobile else {'width':1440,'height':900},is_mobile=mobile,has_touch=mobile)
            page=context.new_page()
            page.on('pageerror',lambda e: errors.append({'mobile':mobile,'error':str(e)}))
            page.on('request',lambda r: requests.append({'mobile':mobile,'method':r.method,'url':r.url,'postData':r.post_data}) if '/api/' in r.url else None)
            page.on('response',lambda r: responses.append({'mobile':mobile,'url':r.url,'status':r.status}) if '/api/' in r.url else None)
            page.on('requestfailed',lambda r: network_errors.append({'mobile':mobile,'url':r.url,'failure':r.failure}))
            page.goto(ready['base'],wait_until='domcontentloaded'); page.wait_for_function("localStorage.getItem('harness.web.activeFrom') && document.getElementById('conn-label').textContent.includes('已连接') && document.getElementById('agent-status').textContent==='就绪'")
            return context,page
        context,page=new_page()
        def idle(pg): pg.wait_for_function("document.getElementById('cancel-btn').disabled")
        def send(pg,text): pg.locator('#input').fill(text); pg.locator('#send-btn').click()
        def completed_reply(pg,text):
            wait(lambda d:any(m['role']=='assistant' and m.get('content')=='HARNESS_REPLY:'+text for m in all_messages(d)))
            rendered_prefix = text.split('\n```', 1)[0]
            pg.locator('.assistant-row').filter(has_text='HARNESS_REPLY:'+rendered_prefix).wait_for(timeout=20000); idle(pg)
        def keyboard_controls():
            before=len(snapshot()['calls']); posts=len([r for r in requests if r['method']=='POST' and '/api/messages' in r['url']])
            page.locator('#input').fill('真实DOM输入法保护')
            page.locator('#input').dispatch_event('compositionstart')
            page.locator('#input').press('Enter'); page.wait_for_timeout(100)
            expect(len(snapshot()['calls'])==before,'composition start + Enter triggered model')
            composition_input=page.locator('#input').input_value()
            expect(composition_input.strip()=='真实DOM输入法保护','composition Enter lost existing input')
            page.locator('#input').dispatch_event('compositionend')
            page.locator('#input').evaluate("node=>node.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}))")
            page.wait_for_timeout(80); expect(len(snapshot()['calls'])==before,'isComposing Enter sent')
            page.locator('#input').fill('真实DOM输入法保护'); page.locator('#input').press('End'); page.locator('#input').press('Shift+Enter'); page.locator('#input').type('下一行')
            text=page.locator('#input').input_value(); expect('\n' in text,'Shift+Enter failed to insert newline'); expect(len(snapshot()['calls'])==before,'Shift+Enter sent message')
            page.locator('#input').press('Enter'); completed_reply(page,text)
            current=snapshot(); expect(sum(c['prompt']==text for c in current['calls'])==1,'Enter did not invoke real model once')
            expect(len([r for r in requests if r['method']=='POST' and '/api/messages' in r['url']])-posts==1,'keyboard controls dispatched wrong POST count')
            return {'prompt':text,'compositionEnterInput':composition_input,'realProviderCalls':1,'realMessagePostCount':1,'imeMethod':'DOM compositionstart/end and isComposing keyboard events; Enter/Shift+Enter through Chromium keyboard'}
        case('desktop-enter-shift-enter-and-ime-real-backend','production-stack',keyboard_controls)
        def sessions_and_drafts():
            from_a=page.evaluate("localStorage.getItem('harness.web.activeFrom')"); page.locator('#input').fill('DRAFT_A_LOCAL_ONLY')
            page.locator('#new-session-btn').click(); page.wait_for_function("old=>localStorage.getItem('harness.web.activeFrom')!==old",arg=from_a)
            from_b=page.evaluate("localStorage.getItem('harness.web.activeFrom')"); page.wait_for_function("document.getElementById('agent-status').textContent==='就绪'")
            expect(page.locator('#input').input_value()=='','new session inherited old draft')
            send(page,'EXTRA_SESSION_B'); completed_reply(page,'EXTRA_SESSION_B'); page.locator('#input').fill('DRAFT_B_LOCAL_ONLY')
            page.locator(f'#session-list li[data-from="{from_a}"] button').click(); page.wait_for_function("from=>localStorage.getItem('harness.web.activeFrom')===from && document.getElementById('input').value==='DRAFT_A_LOCAL_ONLY'",arg=from_a)
            page.locator('.assistant-row').first.wait_for(); expect('EXTRA_SESSION_B' not in page.locator('#messages').inner_text(),'B history polluted A')
            page.locator(f'#session-list li[data-from="{from_b}"] button').click(); page.wait_for_function("from=>localStorage.getItem('harness.web.activeFrom')===from && document.getElementById('input').value==='DRAFT_B_LOCAL_ONLY'",arg=from_b)
            page.locator('.assistant-row').filter(has_text='HARNESS_REPLY:EXTRA_SESSION_B').wait_for(); expect('真实DOM输入法保护' not in page.locator('#messages').inner_text(),'A history polluted B')
            current=snapshot(); expect(len(current['records'])==2 and len(current['bindings'])==2,'UI session switching not bound to two genuine backend sessions')
            expect(not any('DRAFT_' in str(m.get('content')) for m in all_messages(current)),'draft transmitted to backend')
            return {'fromA':from_a,'fromB':from_b,'genuineBackendSessions':2,'draftA':'DRAFT_A_LOCAL_ONLY','draftB':'DRAFT_B_LOCAL_ONLY','draftsTransmitted':0,'switchTransport':'UI buttons + genuine history/SSE'}
        case('desktop-session-list-buttons-and-isolated-drafts','production-stack',sessions_and_drafts)
        def code_copy():
            prompt="代码如下\n```js\nconsole.log('ui-copy');\n```"; send(page,prompt); completed_reply(page,prompt)
            row=page.locator('.assistant-row').filter(has_text="console.log('ui-copy');")
            context.grant_permissions(['clipboard-read','clipboard-write'],origin=ready['base']); row.locator('.code-block .copy-button').click()
            copied=page.evaluate('navigator.clipboard.readText()'); expect(copied=="console.log('ui-copy');\n",'code copy bytes differ')
            expect(row.locator('.code-block code').inner_text()==copied,'rendered code and clipboard disagree')
            return {'clipboard':copied,'source':'scripted text via real Harness response + UI code-copy click + actual clipboard'}
        case('desktop-code-block-copy-actual-clipboard','production-stack',code_copy)
        def failed_send_reedit():
            text='CONTROLLED_HTTP_ABORT_THEN_REAL_RETRY'; faults=[]
            def handler(route):
                if not faults:
                    faults.append({'type':'controlled-http-fault','action':'abort-single-POST','url':route.request.url,'postData':route.request.post_data}); route.abort('failed')
                else: route.continue_()
            page.route('**/api/messages',handler)
            try:
                before=len(snapshot()['calls']); send(page,text); page.get_by_role('button',name='重新编辑',exact=True).wait_for()
                expect(len(snapshot()['calls'])==before,'aborted request reached model')
                expect(page.locator('#input').input_value()==text,'failed-send draft not restored')
                page.locator('#input').fill('TEMP_OTHER_DRAFT'); page.get_by_role('button',name='重新编辑',exact=True).click(); expect(page.locator('#input').input_value()==text,'retry edit failed to restore original')
                page.locator('#send-btn').click(); completed_reply(page,text)
                current=snapshot(); expect(sum(c['prompt']==text for c in current['calls'])==1,'resend model call count differs')
                expect(sum(m['role']=='user' and m.get('content')==text for m in all_messages(current))==1,'resend persisted duplicate user messages')
                return {'faults':faults,'originalInputRestored':True,'realBackendRetryCalls':1,'persistedUserMessages':1}
            finally: page.unroute('**/api/messages',handler)
        case('desktop-send-failure-reedit-and-genuine-retry','production-http-control',failed_send_reedit)
        page.screenshot(path=str(out/'desktop-extra-controls.png')); context.close()
        mobile_context,mobile=new_page(mobile=True)
        def mobile_send():
            send(mobile,'MOBILE_ACTUAL_AGENT'); completed_reply(mobile,'MOBILE_ACTUAL_AGENT'); current=snapshot()
            expect(sum(c['prompt']=='MOBILE_ACTUAL_AGENT' for c in current['calls'])==1,'mobile send did not invoke provider once')
            records=[r for r in current['records'] if any(m['role']=='user' and m.get('content')=='MOBILE_ACTUAL_AGENT' for m in r['messages'])]
            expect(len(records)==1,'mobile session not uniquely identified')
            expect(any(e['type']=='verification.completed' and e.get('payload',{}).get('passed') is True for e in records[0]['events']) and any(e['type']=='turn.completed' for e in records[0]['events']),'mobile turn lacks genuine verifier and completed events')
            from_id=mobile.evaluate("localStorage.getItem('harness.web.activeFrom')")
            expect(any(b['from']==from_id and b['sessionId']==records[0]['session']['id'] for b in current['bindings']),'mobile sender binding is incorrect')
            return {'realProviderCalls':1,'uiReply':'HARNESS_REPLY:MOBILE_ACTUAL_AGENT','viewport':[390,844],'from':from_id,'sessionId':records[0]['session']['id'],'verificationCompleted':True}
        case('mobile-send-to-real-harness','production-stack',mobile_send)
        def mobile_approval(decision):
            prompt='[allow-write]' if decision=='allow' else '[deny-write]'; filename='allowed.txt' if decision=='allow' else 'denied.txt'
            send(mobile,prompt); button=mobile.locator(f'.approval-card:not(.resolved) .{decision}-btn'); button.wait_for(timeout=20000)
            pending=snapshot()['pendingApprovals']; expect(len(pending)==1,'missing genuine pending approval'); approval_id=pending[0]['id']; expect(snapshot()['files'][filename] is None,'write happened before mobile approval')
            button.click(); completed_reply(mobile,prompt); current=snapshot()
            expect(not current['pendingApprovals'],'pending approval not resolved')
            expect(any(e['type']=='human.approval' and e.get('payload',{}).get('value')==decision for e in events(current)),'real human approval event missing')
            expect(current['files'][filename]==('ACTUAL_HARNESS_WRITE\n' if decision=='allow' else None),'mobile approval file result incorrect')
            expect(any(r['mobile'] and r['method']=='POST' and '/api/commands' in r['url'] and json.loads(r['postData'] or '{}').get('text')==f'approve:{approval_id}:{decision}' for r in requests),'mobile approval did not dispatch matching backend command')
            return {'approvalId':approval_id,'decision':decision,'file':filename,'fileContent':current['files'][filename],'actualHumanApprovalEvent':True}
        case('mobile-real-approval-deny','production-stack',lambda:mobile_approval('deny'))
        case('mobile-real-approval-allow','production-stack',lambda:mobile_approval('allow'))
        def mobile_stop():
            before=sum(e['type']=='turn.cancelled' for e in events(snapshot())); send(mobile,'[block]'); wait(lambda d:any(c['prompt']=='[block]' for c in d['calls']))
            mobile.wait_for_function("!document.getElementById('cancel-btn').disabled"); mobile.locator('#cancel-btn').click()
            current=wait(lambda d:sum(e['type']=='turn.cancelled' for e in events(d))==before+1); idle(mobile)
            expect(any(c['prompt']=='[block]' and c.get('aborted') is True for c in current['calls']),'mobile stop did not reach provider AbortSignal')
            expect(any(e['type']=='human.cancel' for e in events(current)),'mobile stop lacks actual human.cancel event')
            expect(any(r['mobile'] and r['method']=='POST' and '/api/commands' in r['url'] and json.loads(r['postData'] or '{}').get('text')=='cancel' for r in requests),'mobile stop did not dispatch cancel backend command')
            return {'providerAbort':True,'newTurnCancelledEvents':1,'humanCancel':True,'cancelButtonDisabled':mobile.locator('#cancel-btn').is_disabled()}
        case('mobile-stop-real-running-turn','production-stack',mobile_stop)
        def mobile_drawer_backdrop():
            mobile.locator('#sidebar-toggle').click(); mobile.wait_for_function("document.getElementById('sidebar-toggle').getAttribute('aria-expanded')==='true'")
            mobile.locator('#sidebar-backdrop').click(position={'x':380,'y':400}); mobile.wait_for_function("document.getElementById('sidebar-toggle').getAttribute('aria-expanded')==='false'")
            expect(mobile.locator('#input').is_visible(),'mobile composer missing after backdrop')
            return {'drawerClosed':True,'action':'real DOM backdrop click'}
        case('mobile-backdrop-closes-drawer','production-stack',mobile_drawer_backdrop)
        def mobile_drawer_escape():
            mobile.locator('#sidebar-toggle').click(); mobile.wait_for_function("document.getElementById('sidebar-toggle').getAttribute('aria-expanded')==='true'")
            mobile.keyboard.press('Escape'); mobile.wait_for_function("document.getElementById('sidebar-toggle').getAttribute('aria-expanded')==='false'")
            expect(mobile.locator('#input').is_visible(),'mobile composer missing after Escape')
            return {'drawerClosed':True,'action':'Chromium Escape keyboard input'}
        case('mobile-escape-closes-drawer','production-stack',mobile_drawer_escape)
        mobile.screenshot(path=str(out/'mobile-extra-controls.png')); mobile_context.close(); browser.close()
    save('production-observed-snapshot.json',snapshot())
    status='PASS' if receipts and all(r['passed'] for r in receipts) and not errors else 'FAILED'
except Exception as e:
    receipts.append({'name':'runner','group':'infrastructure','passed':False,'observed':{'error':str(e),'traceback':traceback.format_exc()},'assertCount':0})
finally:
    forced=False
    if process is not None and process.poll() is None:
        process.terminate()
        try:process.wait(timeout=15)
        except subprocess.TimeoutExpired:forced=True;process.kill();process.wait(timeout=5)
    log.close()
    try:
        expect(process is not None and process.returncode==0 and not forced,'fixture shutdown failure')
        final_runtime=json.loads((fix/'runtime-snapshot.json').read_text()); expect(isinstance(final_runtime.get('records'),list),'runtime snapshot unreadable')
        changed=[]
        for path,h in ready['fingerprints'].items():
            real=Path(ready['staticDir'])/path[len('static/'):] if path.startswith('static/') else repo/path
            if hashlib.sha256(real.read_bytes()).hexdigest()!=h:changed.append(path)
        expect(git('rev-parse','HEAD')==args.expected_sha and not git('status','--porcelain','--untracked-files=no') and not changed,'source/dist/static changed during browser probe')
        cleanup={'graceful':True,'exitCode':process.returncode,'forcedKill':False,'changedFingerprints':changed,'finalSourceSha':git('rev-parse','HEAD'),'trackedClean':True}
    except Exception as e:cleanup={'graceful':False,'error':str(e)};status='FAILED'
    save('requests.json',requests);save('responses.json',responses);save('network-errors.json',network_errors);save('browser-errors.json',errors)
    save('result.json',{'schema':'web-extra-controls.v1','status':status,'source':ready,'expectedSha':args.expected_sha,'probeSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'fixtureSha256':hashlib.sha256(fixture.read_bytes()).hexdigest(),'cases':len(receipts),'passed':sum(r['passed'] for r in receipts),'failed':sum(not r['passed'] for r in receipts),'assertions':assertions,'browserErrors':len(errors),'chromium':locals().get('version'),'paidCalls':0,'realModelQuality':'NOT_RUN','scope':'actual DOM + actual Harness/Gateway/WebServer/PermissionEngine/SandboxManager/Verifier, scripted model only; one explicitly marked aborted HTTP POST control; clipboard/sidebar are frontend controls','receipts':receipts,'cleanup':cleanup})
    artifacts=[]
    for f in sorted(out.rglob('*')):
        relative=f.relative_to(out)
        if f.is_file() and relative.parts[:2] not in [('fixture','runtime-data'),('fixture','workspace')] and f.name!='artifact-index.json':
            b=f.read_bytes();artifacts.append({'path':str(relative),'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()})
    save('artifact-index.json',{'schema':'web-extra-controls-artifacts.v1','artifacts':artifacts})
    print(json.dumps({'status':status,'cases':len(receipts),'passed':sum(r['passed'] for r in receipts),'failed':sum(not r['passed'] for r in receipts),'assertions':assertions,'browserErrors':len(errors),'out':str(out)},ensure_ascii=False))
    for r in receipts:print(json.dumps({'name':r['name'],'passed':r['passed'],'error':r['observed'].get('error')},ensure_ascii=False))
raise SystemExit(0 if status=='PASS' else 1)
