import gzip,hashlib,json,pathlib,shutil,subprocess,sys
root=pathlib.Path(sys.argv[1]).resolve();scratch=root.parent/'evidence-negative-controls';scratch.mkdir(exist_ok=True);records=[]
positive=subprocess.run([sys.executable,str(root/'raw/verify-evidence.py'),str(root)],capture_output=True,text=True)
assert positive.returncode==0, (positive.stdout,positive.stderr)
def update(target,path):
 manifest=json.loads((target/'RAW-MANIFEST.json').read_text());data=(target/path).read_bytes()
 entry=next(entry for entry in manifest['files'] if entry['path']==path);entry.update(bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
 (target/'RAW-MANIFEST.json').write_text(json.dumps(manifest,indent=2)+'\n')
for name,expected in [('changed-bytes','BYTE_INTEGRITY'),('rehash-failed-suite','FULL_SUITE_FAILED'),('rehash-windows-sha','WINDOWS_IDENTITY')]:
 target=scratch/name
 if target.exists():shutil.rmtree(target)
 shutil.copytree(root,target)
 if name=='changed-bytes':
  p=target/'coding/result.json';p.write_bytes(p.read_bytes()+b' ')
 elif name=='rehash-failed-suite':
  p=target/'raw/full-suite.json.gz';d=json.loads(gzip.decompress(p.read_bytes()));d['numFailedTests']=1;d['success']=False;p.write_bytes(gzip.compress(json.dumps(d).encode(),mtime=0));update(target,'raw/full-suite.json.gz')
 else:
  p=target/'raw/windows-receipt.json';d=json.loads(p.read_text());d['sourceSha']='0'*40;p.write_text(json.dumps(d));update(target,'raw/windows-receipt.json')
 result=subprocess.run([sys.executable,str(target/'raw/verify-evidence.py'),str(target)],capture_output=True,text=True)
 assert result.returncode!=0 and expected in result.stderr, (name,result.returncode,result.stdout,result.stderr)
 records.append({'name':name,'expectedReason':expected,'exitCode':result.returncode,'status':'REJECTED','stdout':result.stdout,'stderr':result.stderr})
(root/'raw/evidence-negative-controls.json').write_text(json.dumps({'sourceSha':'a19fcabf7bd2ef186574227cf7676f26275aed08','status':'PASS','controls':records},indent=2)+'\n')
print(json.dumps({'status':'PASS','rejected':len(records)}))
