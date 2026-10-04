import json,time,subprocess,urllib.request,hashlib
from pathlib import Path
from playwright.sync_api import sync_playwright
repo=Path('/workspace/harness-agent'); out=repo/'.ci/web-recheck-20261004/queued-stop-reproducer'; fix=out/'fixture'; fix.mkdir(exist_ok=True)
log=(out/'fixture.log').open('w'); process=subprocess.Popen(['node',str(repo/'scripts/research/web-dsh-20261004/fixture.mjs'),'--repo',str(repo),'--out',str(fix)],cwd=repo,stdout=log,stderr=subprocess.STDOUT)
def save(name,data): (out/name).write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
def snapshot():
    with urllib.request.urlopen(ready['inspector'],timeout=5) as r:return json.load(r)
def wait(predicate):
    end=time.monotonic()+15
    while time.monotonic()<end:
        data=snapshot()
        if predicate(data):return data
        time.sleep(.05)
    raise AssertionError('wait timeout')
requests=[]; responses=[]
try:
    end=time.monotonic()+20
    while not (fix/'ready.json').exists():
        if process.poll() is not None: raise AssertionError('fixture exited')
        if time.monotonic()>end: raise AssertionError('ready timeout')
        time.sleep(.05)
    ready=json.loads((fix/'ready.json').read_text())
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox']); page=browser.new_page(viewport={'width':1280,'height':900})
        page.on('request',lambda r:requests.append({'method':r.method,'url':r.url,'postData':r.post_data}) if '/api/' in r.url else None)
        page.on('response',lambda r:responses.append({'status':r.status,'url':r.url}) if '/api/' in r.url else None)
        page.goto(ready['base']);page.wait_for_function("document.querySelector('#agent-status').textContent==='就绪'")
        page.locator('#input').fill('[disconnect-complete]');page.locator('#send-btn').click()
        wait(lambda d:any(c['prompt']=='[disconnect-complete]' for c in d['calls']))
        page.locator('#input').fill('[block]');page.locator('#send-btn').click()
        before=wait(lambda d:any(c['prompt']=='[block]' for c in d['calls']))
        page.wait_for_function("!document.querySelector('#cancel-btn').disabled")
        save('snapshot-before-stop.json',before);page.locator('#cancel-btn').click();time.sleep(1)
        after=snapshot();save('snapshot-after-stop.json',after)
        page.screenshot(path=str(out/'after-stop.png'),full_page=True)
        running=[{'sessionId':r['session']['id'],'turnId':e.get('turnId'),'type':e['type']} for r in after['records'] for e in r['events'] if e['type'] in ['turn.started','turn.completed','turn.cancelled','human.cancel']]
        block=next(c for c in after['calls'] if c['prompt']=='[block]')
        result={'sourceSha':ready['sourceSha'],'trackedDirtyAtStart':ready['trackedDirty'],'status':'CONFIRMED_BUG' if not block.get('aborted') and page.locator('#cancel-btn').is_enabled() else 'NOT_REPRODUCED','productionStack':True,'scriptedModelOnly':True,'paidCalls':0,'uiStatus':page.locator('#agent-status').inner_text(),'uiText':page.locator('#messages').inner_text(),'cancelEnabledAfterClick':page.locator('#cancel-btn').is_enabled(),'providerBlockedCall':block,'events':running,'requests':requests,'responses':responses}
        save('result.json',result);print(json.dumps({'status':result['status'],'sourceSha':result['sourceSha'],'cancelEnabledAfterClick':result['cancelEnabledAfterClick'],'events':running},ensure_ascii=False));browser.close()
finally:
    process.terminate()
    try:process.wait(timeout=15)
    except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
    log.close()
