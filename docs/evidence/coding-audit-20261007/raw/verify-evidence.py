#!/usr/bin/env python3
"""Offline byte integrity and semantic acceptance checks; no network or model calls."""
import argparse,base64,gzip,hashlib,json,subprocess
from pathlib import Path
SOURCE='a19fcabf7bd2ef186574227cf7676f26275aed08'
BASELINE='33eb6438130956be51706bb523071f7550ba83ab'
def require(condition,reason):
 if not condition:raise ValueError(reason)
def read_json(path):
 data=path.read_bytes()
 if path.suffix=='.gz':
  with gzip.open(path,'rb') as stream:data=stream.read(32*1024*1024+1)
  require(len(data)<=32*1024*1024,'DECOMPRESSED_LIMIT')
 return json.loads(data)
def assertions(report):return [test for file in report['testResults'] for test in file['assertionResults']]
def main():
 parser=argparse.ArgumentParser();parser.add_argument('bundle',nargs='?',type=Path,default=Path(__file__).resolve().parents[1]);parser.add_argument('--repo',type=Path);args=parser.parse_args()
 root=args.bundle.resolve();manifest=read_json(root/'RAW-MANIFEST.json')
 require(manifest['sourceSha']==SOURCE and manifest['baselineSha']==BASELINE,'SOURCE_IDENTITY')
 paths=[]
 for entry in manifest['files']:
  target=(root/entry['path']).resolve();require(target.is_relative_to(root) and not (root/entry['path']).is_symlink(),'PATH_ESCAPE')
  data=target.read_bytes();require(len(data)==entry['bytes'] and hashlib.sha256(data).hexdigest()==entry['sha256'],'BYTE_INTEGRITY: '+entry['path']);paths.append(entry['path'])
 require(len(paths)==len(set(paths)),'DUPLICATE_MANIFEST_ENTRY')
 observed={str(path.relative_to(root)) for path in root.rglob('*') if path.is_file() and path.name!='RAW-MANIFEST.json'}
 require(observed==set(paths),'MANIFEST_MEMBERSHIP')
 full=read_json(root/'raw/full-suite.json.gz');tests=assertions(full)
 require(full['success'] and full['numFailedTests']==0 and full['numFailedTestSuites']==0 and all(test['status']!='failed' for test in tests),'FULL_SUITE_FAILED')
 require(sum(test['status']=='passed' for test in tests)==full['numPassedTests'] and len(tests)==full['numTotalTests'],'FULL_COUNTS')
 require(len(full['testResults'])==502 and full['numPassedTests']==9081 and full['numPendingTests']==13,'FULL_SCOPE')
 baseline=read_json(root/'raw/baseline-red.json.gz');require(baseline['numPassedTests']==36 and baseline['numFailedTests']==10,'BASELINE_REPRO')
 passed={test['fullName'] for test in tests if test['status']=='passed'}
 require(all(test['fullName'] in passed for test in assertions(baseline) if test['status']=='failed'),'BASELINE_FAILURE_NOT_FIXED')
 execution=read_json(root/'raw/subreaper-run-receipt.json');require(execution['sourceSha']==SOURCE and execution['sourceUnchanged'] and execution['exitCode']==0,'FULL_EXECUTION_PROVENANCE')
 for name,count in [('security',2135),('protocol',52)]:
  report=read_json(root/('raw/'+name+'.json.gz'));require(report['success'] and report['numFailedTests']==0 and report['numPassedTests']==count,'SPECIALIST_GATE: '+name)
 for name,platform,count in [('coding/result.json','linux',50),('raw/windows-coding.json','win32',49)]:
  report=read_json(root/name);require(report['status']=='PASS' and report['sourceSha']==SOURCE and report['sourceTreeClean'] and report['paidModelCalls']==0 and report['platform']==platform and len(report['assertions'])==count,'CODING_RECEIPT: '+name)
 receipt=read_json(root/'raw/windows-receipt.json');records=(root/'raw/windows-case-records.json').read_bytes();files=json.loads(records)
 require(hashlib.sha256(records).hexdigest()==receipt['caseRecordsSha256'],'WINDOWS_PACKET_HASH')
 require(receipt['sourceSha']==receipt['workflowSha']==SOURCE and receipt['platform']=='win32' and receipt['osType']=='Windows_NT' and receipt['treeClean'] and receipt['outcome']=='PASS','WINDOWS_IDENTITY')
 windows_run=read_json(root/'raw/windows-run.json');windows_jobs=read_json(root/'raw/windows-jobs.json')['jobs']
 require(windows_run['head_sha']==SOURCE and windows_run['status']=='completed' and windows_run['conclusion']=='success' and str(windows_run['id'])==receipt['runId'] and len(windows_jobs)==1 and windows_jobs[0]['conclusion']=='success','WINDOWS_RUN_PROVENANCE')
 cases=[test for file in files for test in file['assertions']]
 require(receipt['files']==len(files)==16 and sum(test['status']=='passed' for test in cases)==receipt['passed']==226 and receipt['failed']==0 and receipt['skipped']==1,'WINDOWS_COUNTS')
 require(len(receipt['required'])==12 and all(test['observed']==['passed'] for test in receipt['required']),'WINDOWS_REQUIRED_CASES')
 annotations=read_json(root/'raw/windows-annotations.json');packets=[json.loads(entry['message']) for entry in annotations if entry['title'].startswith('Windows case records chunk ')]
 packets.sort(key=lambda packet:packet['index']);require([packet['index'] for packet in packets]==list(range(packets[0]['total'])),'WINDOWS_PACKET_COMPLETENESS')
 require(gzip.decompress(base64.b64decode(''.join(packet['data'] for packet in packets)))==records,'WINDOWS_PACKET_CONTENT')
 coding_packet=json.loads(next(entry['message'] for entry in annotations if entry['title']=='Coding acceptance receipt'))
 require(json.loads(gzip.decompress(base64.b64decode(coding_packet['data'])))==read_json(root/'raw/windows-coding.json'),'WINDOWS_CODING_PACKET')
 ci=read_json(root/'raw/source-ci-run.json');jobs=read_json(root/'raw/source-ci-jobs.json')['jobs']
 require(ci['head_sha']==SOURCE and ci['status']=='completed' and ci['conclusion']=='success' and len(jobs)==10 and all(job['status']=='completed' and job['conclusion']=='success' for job in jobs),'CI_RELEASE_GATE')
 browser=read_json(root/'browser/browser-result.json');require(browser['status']=='PASS' and browser['caseCount']==27 and browser['assertCount']==77 and browser['failed']==browser['browserErrorCount']==browser['paidCalls']==0,'BROWSER_GATE')
 require(browser['requireCleanSource'] and not browser['source']['trackedDirty'] and browser['source']['sourceSha']==SOURCE and browser['cleanup']['finalSourceSha']==SOURCE and browser['cleanup']['graceful'] and browser['cleanup']['exitCode']==0 and not browser['cleanup']['changedFingerprints'],'BROWSER_PROVENANCE')
 syntax=read_json(root/'raw/script-syntax.json');require(syntax['sourceSha']==SOURCE and syntax['files']==207 and syntax['errors']==[],'SCRIPT_SYNTAX')
 if args.repo:
  fingerprints=read_json(root/'raw/product-source-files.json');require(fingerprints['sourceSha']==SOURCE,'SOURCE_FINGERPRINT_IDENTITY')
  files=fingerprints['files'];specs=''.join(SOURCE+':'+file['path']+'\n' for file in files).encode()
  output=subprocess.check_output(['git','-C',str(args.repo),'cat-file','--batch'],input=specs);offset=0
  for file in files:
   end=output.index(b'\n',offset);header=output[offset:end].split();require(len(header)==3 and header[1]==b'blob','SOURCE_BLOB_MISSING: '+file['path']);size=int(header[2]);start=end+1;data=output[start:start+size];offset=start+size+1
   require(len(data)==file['bytes'] and hashlib.sha256(data).hexdigest()==file['sha256'],'SOURCE_BLOB_MISMATCH: '+file['path'])
 print(json.dumps({'status':'PASS','sourceSha':SOURCE,'rawFiles':len(paths),'fullPassed':full['numPassedTests'],'nativeWindowsPassed':receipt['passed'],'codingAssertions':99,'paidModelQuality':'NOT_PROVEN'}))
if __name__=='__main__':main()
