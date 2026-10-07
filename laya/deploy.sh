#!/usr/bin/env bash
# Deploy a checkpoint as an immutable release on bergholm.net (run on minos).
# Usage: laya/deploy.sh <checkpoint-dir> [--experimental|--force]   |   laya/deploy.sh --rollback [release-id]
set -euo pipefail
cd "$(dirname "$0")"
SERVER="${LAYA_SERVER:-toni@bergholm.net}"; P="${LAYA_SERVER_PORT:-2222}"; R='~/apps/laya'
ssh_() { ssh -p "$P" "$SERVER" "$@"; }
switch_and_restart() {  # $1 = release id
  ssh_ "cd $R && ln -sfn releases/$1 current.tmp && mv -T current.tmp current && \
        (pm2 describe laya >/dev/null 2>&1 && pm2 restart laya --update-env || \
         LAYA_THREADS=2 LAYA_HOST=127.0.0.1 LAYA_PORT=8100 pm2 start .venv/bin/python --name laya --cwd $R/current -- serve.py) && pm2 save >/dev/null"
}
smoke() {
  ssh_ "for i in \$(seq 1 60); do curl -sf http://127.0.0.1:8100/health >/dev/null && break; sleep 2; done; \
        curl -sf http://127.0.0.1:8100/health && \
        curl -sf -X POST http://127.0.0.1:8100/v1/systemone -H 'content-type: application/json' \
          -d \"{\\\"state\\\":{\\\"title\\\":\\\"Volunteers restore a wetland\\\"},\\\"questions\\\":\$(python3 -c 'import json;print(json.dumps(json.load(open(\"$R/current/contract.json\"))[\"questions\"]))')}\" >/dev/null"
}
if [ "${1:-}" = "--rollback" ]; then
  target="${2:-$(ssh_ "cat $R/last-good")}"; switch_and_restart "$target"; smoke && echo "rolled back to $target"; exit
fi
ck="$1"; mode="${2:-}"
g=$(python3 -c "import json;print(json.load(open('$ck/report.json'))['gate'])")
case "$g:$mode" in pass:*|experimental:--experimental|*:--force) ;; *) echo "Refusing: gate=$g (use --experimental or --force)"; exit 1;; esac
id="$(basename "$ck")"; exp=$([ "$g" = experimental ] && echo true || echo false)
stage=$(mktemp -d); mkdir -p "$stage/checkpoint"
rsync -a "$ck/" "$stage/checkpoint/"; cp serve.py pyproject.toml uv.lock "$stage/"; cp "$ck/contract.json" "$stage/"
echo "{\"checkpoint\":\"$id\",\"experimental\":$exp}" > "$stage/release.json"
ssh_ "mkdir -p $R/releases/$id"
rsync -az -e "ssh -p $P" "$stage/" "$SERVER:$R/releases/$id/"
ssh_ "cd $R/releases/$id && ~/.local/bin/uv sync --frozen"
switch_and_restart "$id"
if smoke; then
  ssh_ "echo $id > $R/last-good && cd $R/releases && ls -1t | grep -vx \"\$(cat $R/last-good)\" | tail -n +3 | xargs -r rm -rf"
  echo "deployed $id (gate=$g)"
else
  echo "smoke failed — rolling back"; prev=$(ssh_ "cat $R/last-good 2>/dev/null || true")
  [ -n "$prev" ] && switch_and_restart "$prev" || ssh_ "pm2 stop laya"
  exit 1
fi
