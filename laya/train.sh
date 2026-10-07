#!/usr/bin/env bash
# Train a Laya checkpoint on minos from a fresh server export.
# Usage: laya/train.sh [--timing] [--epochs N] [--micro-batch M] [--grad-accum G]
set -euo pipefail
cd "$(dirname "$0")"
HOME_DIR="${LAYA_HOME:-$HOME/laya-positivenews}"
SERVER="${LAYA_SERVER:-toni@bergholm.net}"
SSH_PORT="${LAYA_SERVER_PORT:-2222}"
EPOCHS=2; MB=8; GA=4; TIMING=0
[ -f "$HOME_DIR/train.env" ] && source "$HOME_DIR/train.env"
while [ $# -gt 0 ]; do case "$1" in
  --timing) TIMING=1;; --epochs) EPOCHS="$2"; shift;; --micro-batch) MB="$2"; shift;; --grad-accum) GA="$2"; shift;;
  *) echo "unknown arg $1"; exit 1;; esac; shift; done

mkdir -p "$HOME_DIR/data" "$HOME_DIR/checkpoints"
free_gb=$(df -Pk "$HOME_DIR" | awk 'NR==2{print int($4/1048576)}')
[ "$free_gb" -ge 15 ] || { echo "Refusing: only ${free_gb} GB free on the filesystem of $HOME_DIR (need 15)" >&2; exit 1; }
pmset -g batt | grep -q "AC Power" || { echo "Refusing: not on AC power" >&2; exit 1; }
# Keep the two newest checkpoints. `|| true`: ls fails when the directory is empty (set -e + pipefail).
{ ls -1dt "$HOME_DIR"/checkpoints/*/ 2>/dev/null | tail -n +3 | xargs -r rm -rf; } || true

ssh_s() { ssh -o BatchMode=yes -o ConnectTimeout=15 -p "$SSH_PORT" "$SERVER" "$@"; }
tmp=""
trap '[ -z "$tmp" ] || ssh_s "rm -rf \"$tmp\" \"$tmp.tmp\"" || true' EXIT
tmp=$(ssh_s 'd=$(mktemp -d) && cd ~/apps/positivenews && { pnpm -s laya:export --out "$d" >/dev/null || { rm -rf "$d"; exit 1; }; } && echo "$d"') \
  || { tmp=""; echo "Refusing: could not run laya:export on $SERVER (port $SSH_PORT)" >&2; exit 1; }
id=$(ssh_s "python3 -c 'import json;print(json.load(open(\"$tmp/manifest.json\"))[\"exportId\"])'") \
  || { echo "Refusing: could not read manifest.json from the export" >&2; exit 1; }
rsync -az -e "ssh -o BatchMode=yes -p $SSH_PORT" "$SERVER:$tmp/" "$HOME_DIR/data/$id/"
data="$HOME_DIR/data/$id"
train="$data/train.jsonl"
if [ "$TIMING" = 1 ]; then head -n 200 "$train" > "$data/train-timing.jsonl"; train="$data/train-timing.jsonl"; EPOCHS=1; fi
out="$HOME_DIR/checkpoints/$(date +%Y%m%d)-$id"
start=$(date +%s)
caffeinate -i uv run python laya_train.py --data "$train" --eval "$data/val.jsonl" --base convaiinnovations/laya-multilingual \
  --loss soft-ce --epochs "$EPOCHS" --micro-batch "$MB" --grad-accum "$GA" --out "$out"
echo "train seconds: $(( $(date +%s) - start )) rows: $(wc -l < "$train") epochs: $EPOCHS" | tee "$out/timing.txt"
cp "$data/contract.json" "$data/manifest.json" "$out/"
caffeinate -i uv run python evaluate.py --data "$data" --checkpoint "$out"
echo "checkpoint: $out"
