"""Give Linux container test descendants a real parent that reaps them."""
import ctypes
import os
import subprocess
import sys
import time

libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
    raise OSError(ctypes.get_errno(), "cannot enable child subreaper")

process = subprocess.Popen(sys.argv[1:])
exit_code = None
reaped_descendants = 0
while exit_code is None:
    try:
        pid, status = os.waitpid(-1, os.WNOHANG)
    except ChildProcessError:
        raise RuntimeError("test command disappeared without an exit status")
    if pid == 0:
        time.sleep(0.02)
    elif pid == process.pid:
        exit_code = os.waitstatus_to_exitcode(status)
        process.returncode = exit_code
    else:
        reaped_descendants += 1

print(f"[review supervisor] command exit={exit_code}; reaped orphan descendants={reaped_descendants}", flush=True)
sys.exit(exit_code if exit_code >= 0 else 128 - exit_code)
