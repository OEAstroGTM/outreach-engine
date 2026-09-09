#!/bin/bash
B=https://send.outreachenginedashboard.co
for n in $(env | grep -o '^EB_SEND_KEY_[A-Z0-9_]*' | sort -u); do
  k=${!n}; l=$(echo ${n#EB_SEND_KEY_} | tr 'A-Z' 'a-z')
  [ -z "$k" ] && { echo "$l: no value, skipped"; continue; }
  echo "[]" > /tmp/acc.json; p=1; last=1
  while [ $p -le $last ]; do
    c=$(curl -sS -o /tmp/pg.json -w '%{http_code}' -H "Authorization: Bearer $k" \
        -H "Accept: application/json" --max-time 60 \
        "$B/api/warmup/sender-emails?page=$p&per_page=500")
    if [ "$c" = "429" ]; then echo "$l p$p rate-limited, waiting"; sleep 5; continue; fi
    if [ "$c" != "200" ]; then echo "$l p$p HTTP $c"; break; fi
    if [ $p -eq 1 ]; then last=$(jq -r '.meta.last_page // 1' /tmp/pg.json); fi
    jq -s '.[0]+(.[1].data//[])' /tmp/acc.json /tmp/pg.json > /tmp/acc2.json && mv /tmp/acc2.json /tmp/acc.json
    p=$((p+1)); sleep 0.4
  done
  jq -n --arg l "$l" --slurpfile d /tmp/acc.json '{label:$l,count:($d[0]|length),data:$d[0]}' > warmup-$l.json
  echo "$l -> $(jq -r .count warmup-$l.json) rows"
done
