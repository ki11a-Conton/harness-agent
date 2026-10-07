import ctypes,json,os,pathlib,subprocess,sys
libc=ctypes.CDLL(None,use_errno=True)
if libc.prctl(36,1,0,0,0)!=0:raise OSError(ctypes.get_errno(),'PR_SET_CHILD_SUBREAPER failed')
sha=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
if subprocess.check_output(['git','status','--porcelain'],text=True).strip():raise RuntimeError('clean source required')
print(json.dumps({'hostSetup':'linux-child-subreaper','sourceSha':sha,'treeClean':True}),flush=True)
main=subprocess.Popen(sys.argv[1:]);exit_code=None;reaped=[]
while exit_code is None:
 pid,status=os.waitpid(-1,0)
 if pid==main.pid:exit_code=os.waitstatus_to_exitcode(status);main.returncode=exit_code
 else:reaped.append({'pid':pid,'exitCode':os.waitstatus_to_exitcode(status)})
after=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
receipt={'sourceSha':sha,'sourceUnchanged':after==sha,'exitCode':exit_code,'orphanedDescendantsReaped':reaped}
pathlib.Path('.ci/coding-audit/subreaper-run-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
if after!=sha:raise RuntimeError('source SHA changed during tests')
sys.exit(exit_code if exit_code>=0 else 128-exit_code)
