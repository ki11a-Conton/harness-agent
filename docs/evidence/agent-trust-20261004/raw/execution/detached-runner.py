import json,subprocess,sys,time
from pathlib import Path
cmd=json.loads(sys.argv[1]);out=Path(sys.argv[2]);result=subprocess.run(cmd);out.write_text(json.dumps({"exitCode":result.returncode,"finishedAt":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime())},indent=2)+"\n");sys.exit(result.returncode)
