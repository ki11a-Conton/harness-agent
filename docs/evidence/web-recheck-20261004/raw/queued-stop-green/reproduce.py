import json,time,subprocess,urllib.request,hashlib
from pathlib import Path
from playwright.sync_api import sync_playwright
repo=Path('/workspace/harness-agent'); out=repo/'.ci/web-recheck-20261004/queued-stop-green'; fix=out/'fixture'; fix.mkdir(exist_ok=True)
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
expected_sha='3adbebe8af87a8490e63365a077840b6765296ea'
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()==expected_sha
assert not subprocess.check_output(['git','status','--porcelain','--untracked-files=no'],cwd=repo,text=True).strip()
requests=[]; responses=[]
try:
    end=time.monotonic()+20
    while not (fix/'ready.json').exists():
        if process.poll() is not None: raise AssertionError('fixture exited')
        if time.monotonic()>end: raise AssertionError('ready timeout')
        time.sleep(.05)
    ready=json.loads((fix/'ready.json').read_text())
    assert ready['sourceSha']==expected_sha and ready['trackedDirty'] is False
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
        first_id=next(e['turnId'] for e in running if e['type']=='turn.completed')
        second_id=next(e['turnId'] for e in running if e['type']=='turn.started' and e['turnId']!=first_id)
        checks={'providerAbort':block.get('aborted') is True,'stopDisabled':page.locator('#cancel-btn').is_disabled(),'followupCancelled':any(e['type']=='turn.cancelled' and e['turnId']==second_id for e in running),'humanCancelTargetsFollowup':any(e['type']=='human.cancel' and e['turnId']==second_id for e in running),'firstCompleted':any(e['type']=='turn.completed' and e['turnId']==first_id for e in running),'oldTurnNotCancelled':not any(e['type']=='turn.cancelled' and e['turnId']==first_id for e in running)}
        result={'sourceSha':ready['sourceSha'],'trackedDirtyAtStart':ready['trackedDirty'],'status':'PASS' if all(checks.values()) else 'FAIL','checks':checks,'productionStack':True,'scriptedModelOnly':True,'paidCalls':0,'uiStatus':page.locator('#agent-status').inner_text(),'uiText':page.locator('#messages').inner_text(),'cancelEnabledAfterClick':page.locator('#cancel-btn').is_enabled(),'providerBlockedCall':block,'events':running,'requests':requests,'responses':responses}
        result['sourceStillClean']=not subprocess.check_output(['git','status','--porcelain','--untracked-files=no'],cwd=repo,text=True).strip()
        result['sourceShaAfter']=subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()
        result['fingerprintsUnchanged']=all(hashlib.sha256((Path(ready['staticDir'])/key[7:] if key.startswith('static/') else repo/key).read_bytes()).hexdigest()==value for key,value in ready['fingerprints'].items())
        assert result['sourceStillClean'] and result['sourceShaAfter']==expected_sha and result['fingerprintsUnchanged']
        save('result.json',result);print(json.dumps({'status':result['status'],'sourceSha':result['sourceSha'],'cancelEnabledAfterClick':result['cancelEnabledAfterClick'],'events':running},ensure_ascii=False));browser.close();assert result['status']=='PASS',checks
finally:
    process.terminate()
    try:process.wait(timeout=15)
    except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
    log.close()
