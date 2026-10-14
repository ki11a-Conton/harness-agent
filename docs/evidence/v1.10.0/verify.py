import hashlib, json, pathlib, sys, tarfile

def verify(root):
 root=pathlib.Path(root)
 inventory=json.loads((root/'inventory.json').read_text(encoding='utf8'))
 actual=sorted(f.relative_to(root).as_posix() for f in root.rglob('*') if f.is_file() and f.name!='inventory.json')
 assert actual==sorted(row['path'] for row in inventory['files']), 'loose inventory differs'
 for row in inventory['files']:
  p=root/row['path'];assert not p.is_symlink();b=p.read_bytes()
  assert len(b)==row['bytes'] and hashlib.sha256(b).hexdigest()==row['sha256'], row['path']
 index=json.loads((root/'fixture-records-index.json').read_text(encoding='utf8'))
 assert hashlib.sha256((root/index['archive']).read_bytes()).hexdigest()==index['archiveSha256']
 with tarfile.open(root/index['archive'],'r:gz') as archive:
  members=archive.getmembers();assert len(members)==len(index['files'])
  for member,row in zip(members,index['files']):
   assert member.isfile() and not pathlib.PurePosixPath(member.name).is_absolute() and '..' not in pathlib.PurePosixPath(member.name).parts
   b=archive.extractfile(member).read()
   assert member.name==row['path'] and len(b)==row['bytes'] and hashlib.sha256(b).hexdigest()==row['sha256'], member.name
 print(json.dumps({'status':'PASS','sourceSha':inventory['sourceSha'],'looseFiles':len(actual),'preservedFixtureFiles':len(index['files']),'fixturesExtracted':False}))

if __name__=='__main__':verify(sys.argv[1] if len(sys.argv)>1 else pathlib.Path(__file__).parent)
