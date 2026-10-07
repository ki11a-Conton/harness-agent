import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]).resolve();files=[]
for file in sorted(root.rglob('*')):
 if file.is_file() and file.name!='RAW-MANIFEST.json':
  data=file.read_bytes();files.append({'path':str(file.relative_to(root)),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
(root/'RAW-MANIFEST.json').write_text(json.dumps({'schemaVersion':1,'sourceSha':'a19fcabf7bd2ef186574227cf7676f26275aed08','baselineSha':'33eb6438130956be51706bb523071f7550ba83ab','files':files},indent=2)+'\n')
print(json.dumps({'files':len(files),'bytes':sum(file['bytes'] for file in files)}))
