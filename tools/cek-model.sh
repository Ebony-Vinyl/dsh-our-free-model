#!/usr/bin/env bash
# Uji cepat beberapa model lewat gateway OFM. Jeda 3 detik antar model.
KEY="ofm-X3NQCZ1UGsYzYI959kp00DOnvDSpvn-r"
for m in "$@"; do
  t0=$(date +%s)
  out=$(curl -s --max-time 90 http://127.0.0.1:18900/v1/chat/completions \
    -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
    -d "{\"model\":\"$m\",\"messages\":[{\"role\":\"user\",\"content\":\"Jawab satu kata: siap?\"}],\"max_tokens\":20}")
  t1=$(date +%s)
  short=$(printf '%s' "$out" | head -c 220)
  echo "[$((t1-t0))s] $m :: $short"
  sleep 3
done
