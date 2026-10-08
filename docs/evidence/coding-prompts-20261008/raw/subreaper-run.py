import argparse, ctypes, json, os, pathlib, subprocess, time

p = argparse.ArgumentParser()
p.add_argument('--log', required=True)
p.add_argument('--receipt', required=True)
p.add_argument('command', nargs=argparse.REMAINDER)
a = p.parse_args()
command = a.command[1:] if a.command[:1] == ['--'] else a.command
assert command
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), 'PR_SET_CHILD_SUBREAPER failed')
started = time.time()
reaped = []
with open(a.log, 'wb') as output:
    child = subprocess.Popen(command, stdout=output, stderr=subprocess.STDOUT)
    root_status = None
    root_finished = None
    while True:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            if root_status is not None: break
            raise
        if pid:
            if pid == child.pid:
                root_status = os.waitstatus_to_exitcode(status)
                child.returncode = root_status
                root_finished = time.time()
            else:
                reaped.append({'pid':pid, 'exitCode':os.waitstatus_to_exitcode(status)})
            continue
        if root_finished is not None and time.time() - root_finished > 10:
            raise RuntimeError('test root exited but an adopted descendant is still running')
        time.sleep(0.01)
receipt = {'kind':'linux-test-host-subreaper', 'sourceSha':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),
    'command':command, 'exitCode':root_status, 'adoptedDescendantsReaped':len(reaped), 'reaped':reaped,
    'durationSeconds':round(time.time()-started,3), 'note':'Container PID 1 retains orphan zombies. PR_SET_CHILD_SUBREAPER reaps this test invocation\'s orphan descendants without weakening process-termination assertions.'}
pathlib.Path(a.receipt).write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({k:v for k,v in receipt.items() if k!='reaped'}),flush=True)
raise SystemExit(root_status)
