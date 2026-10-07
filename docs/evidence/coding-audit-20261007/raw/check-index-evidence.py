import hashlib,json,pathlib,subprocess,sys
root=pathlib.Path(sys.argv[1]);manifest=json.loads((root/'RAW-MANIFEST.json').read_text());entries=manifest['files'];paths=[str(root/entry['path']) for entry in entries]+[str(root/'RAW-MANIFEST.json')]
subprocess.check_output(['git','ls-files','--error-unmatch','--',*paths])
output=subprocess.check_output(['git','cat-file','--batch'],input=''.join(':'+p+'\n' for p in paths).encode());offset=0
for path in paths:
 end=output.index(b'\n',offset);header=output[offset:end].split();assert len(header)==3 and header[1]==b'blob',path;size=int(header[2]);start=end+1;blob=output[start:start+size];offset=start+size+1
 assert pathlib.Path(path).read_bytes()==blob,('INDEX_BYTES_CHANGED',path)
scratch=pathlib.Path('.ci/coding-audit/final-checkout-byte-proof').resolve();scratch.mkdir(parents=True,exist_ok=True)
subprocess.run(['git','-c','core.autocrlf=true','-c','core.eol=crlf','checkout-index','--force','--prefix='+str(scratch)+'/', '--',*paths],check=True)
for path in paths:assert (scratch/path).read_bytes()==pathlib.Path(path).read_bytes(),('CHECKOUT_BYTES_CHANGED',path)
print(json.dumps({'status':'PASS','sourceSha':manifest['sourceSha'],'manifestFiles':len(entries),'indexFiles':len(paths),'indexBlobBytesEqual':True,'forcedCrlfCheckoutBytesEqual':True,'scope':'Linux Git conversion proof; genuine Windows runtime is recorded separately.'}))
