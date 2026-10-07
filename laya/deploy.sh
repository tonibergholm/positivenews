#!/usr/bin/env bash
# Deploy a checkpoint as an immutable release on bergholm.net (run on minos).
# Usage: laya/deploy.sh <checkpoint-dir> [--experimental|--force]   |   laya/deploy.sh --rollback [release-id]
# --force overrides a failed gate and allows re-deploying an existing release id.
set -euo pipefail
cd "$(dirname "$0")"
SERVER="${LAYA_SERVER:-toni@bergholm.net}"; P="${LAYA_SERVER_PORT:-2222}"
# Remote paths. R is expanded by the remote shell ($HOME), RREL is relative to the remote home (for rsync).
R='$HOME/apps/laya'; RREL='apps/laya'
ssh_() { ssh -p "$P" "$SERVER" "$@"; }

# Remote smoke check. Args: <current-dir> <expected-release-id>. Checks that the running service is this
# release (checkpoint id and contract hash) and that /v1/systemone answers.
read -r -d '' SMOKE_PY <<'PYEOF' || true
import json, os, sys, time, urllib.request
cur = os.path.expanduser(os.path.expandvars(sys.argv[1])); want = sys.argv[2]
base = "http://127.0.0.1:8100"
contract = json.load(open(os.path.join(cur, "contract.json")))
health = None
for _ in range(60):
    try:
        health = json.load(urllib.request.urlopen(base + "/health", timeout=5)); break
    except Exception:
        time.sleep(2)
if health is None:
    sys.exit("smoke: /health never came up")
print(json.dumps(health))
if health.get("checkpoint") != want:
    sys.exit("smoke: /health checkpoint %r != release %r" % (health.get("checkpoint"), want))
if health.get("contract_hash") != contract["hash"]:
    sys.exit("smoke: /health contract_hash %r != release contract hash %r" % (health.get("contract_hash"), contract["hash"]))
req = urllib.request.Request(base + "/v1/systemone", headers={"content-type": "application/json"},
    data=json.dumps({"state": {"title": "Volunteers restore a wetland"}, "questions": contract["questions"]}).encode())
res = json.load(urllib.request.urlopen(req, timeout=120))
if res.get("model") != want or "keep" not in res.get("answers", {}):
    sys.exit("smoke: unexpected /v1/systemone response")
print("smoke ok")
PYEOF

switch_and_restart() {  # $1 = release id
  ssh_ "cd $R && ln -sfn releases/$1 current.tmp && mv -T current.tmp current && \
        (pm2 delete laya >/dev/null 2>&1 || true) && \
        LAYA_THREADS=2 LAYA_HOST=127.0.0.1 LAYA_PORT=8100 pm2 start $R/releases/$1/.venv/bin/python --name laya --interpreter none --cwd $R/releases/$1 -- serve.py >/dev/null && \
        pm2 save >/dev/null"
}
smoke() {  # $1 = release id
  printf '%s\n' "$SMOKE_PY" | ssh_ python3 - "$R/current" "$1"
}

if [ "${1:-}" = "--rollback" ]; then
  target="${2:-$(ssh_ "cat $R/last-good")}"
  if switch_and_restart "$target" && smoke "$target"; then echo "rolled back to $target"; else echo "rollback to $target FAILED"; exit 1; fi
  exit 0
fi

ck="${1:?usage: deploy.sh <checkpoint-dir> [--experimental|--force] | --rollback [release-id]}"; mode="${2:-}"
g=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]+'/report.json'))['gate'])" "$ck")
case "$g:$mode" in pass:*|experimental:--experimental|*:--force) ;; *) echo "Refusing: gate=$g (use --experimental or --force)"; exit 1;; esac
id="$(basename "$ck")"; exp=$([ "$g" = experimental ] && echo true || echo false)
if [ "$mode" != "--force" ] && ssh_ "test -e $R/releases/$id"; then
  echo "Refusing: release $id already exists on the server (releases are immutable; use --force to overwrite)"; exit 1
fi
stage=$(mktemp -d); trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/checkpoint"
rsync -a "$ck/" "$stage/checkpoint/"; cp serve.py pyproject.toml uv.lock "$stage/"; cp "$ck/contract.json" "$stage/"
echo "{\"checkpoint\":\"$id\",\"experimental\":$exp}" > "$stage/release.json"
ssh_ "mkdir -p $R/releases/$id"
rsync -az -e "ssh -p $P" "$stage/" "$SERVER:$RREL/releases/$id/"
ssh_ "cd $R/releases/$id && ~/.local/bin/uv sync --frozen"
if switch_and_restart "$id" && smoke "$id"; then
  ssh_ "echo $id > $R/last-good && cd $R/releases && { ls -1t | grep -vx \"\$(cat $R/last-good)\" | tail -n +3 | xargs -r rm -rf; } || true"
  echo "deployed $id (gate=$g)"
else
  echo "deploy of $id failed; rolling back" >&2
  prev=$(ssh_ "cat $R/last-good 2>/dev/null || true")
  if [ -n "$prev" ] && [ "$prev" != "$id" ]; then
    if switch_and_restart "$prev" && smoke "$prev"; then echo "rolled back to $prev" >&2
    else echo "ROLLBACK to $prev ALSO FAILED; service state unknown" >&2; fi
  else
    echo "no previous good release; stopping laya" >&2
    ssh_ "pm2 stop laya" || true
  fi
  exit 1
fi
