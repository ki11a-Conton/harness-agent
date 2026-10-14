#!/usr/bin/env python3
"""Verify archived original bytes without extracting long Windows fixture paths."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import tarfile

root = Path(__file__).resolve().parent
manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
def digest(data):
    return hashlib.sha256(data).hexdigest()
archive = root / manifest["archive"]["path"]
raw = archive.read_bytes()
assert len(raw) == manifest["archive"]["bytes"], "archive size mismatch"
assert digest(raw) == manifest["archive"]["sha256"], "archive digest mismatch"
expected = {row["path"]: row for row in manifest["members"]}
assert len(expected) == len(manifest["members"]), "duplicate manifest member"
seen = set()
with tarfile.open(archive, "r:gz") as handle:
    for member in handle:
        path = PurePosixPath(member.name)
        assert member.isfile(), "non-file member"
        assert not path.is_absolute() and ".." not in path.parts, "unsafe member path"
        assert member.name in expected and member.name not in seen, "unexpected or duplicate member"
        data = handle.extractfile(member).read()
        row = expected[member.name]
        assert len(data) == row["bytes"] and digest(data) == row["sha256"], "member bytes changed: " + member.name
        seen.add(member.name)
assert seen == set(expected), "missing archived member"
for row in manifest["loose"]:
    data = (root / row["path"]).read_bytes()
    assert len(data) == row["bytes"] and digest(data) == row["sha256"], "loose file changed"
print(json.dumps({"status": "PASS", "sourceSha": manifest["sourceSha"], "sourceTree": manifest["sourceTree"], "members": len(seen), "archiveSha256": manifest["archive"]["sha256"]}))
