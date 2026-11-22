#!/usr/bin/env python3
"""Independent recount of global OMP output tokens over a fixed window (separate impl from the plugin).
Metric: sum of usage.output (provider output tokens), reasoningTokens reported separately as a
subset of output. Window is [end - win, end]; a file with >= 1 record in it is an active session.
Sources: sessions/<slug>/<file>.jsonl and sessions/<slug>/<session-id>/<file>.jsonl.
Record identity = id@timestamp (deduped); window strictly by record timestamp."""
import json,os,sys,datetime as dt
end = dt.datetime.fromisoformat(sys.argv[1].replace('Z','+00:00')) if len(sys.argv)>1 else dt.datetime.now(dt.timezone.utc)
win = float(os.environ.get('TPS_WINDOW_SECONDS','8'))
start = end - dt.timedelta(seconds=win)
root = os.path.expanduser(os.environ.get('TPS_SESSIONS_ROOT','~/.omp/agent/sessions'))
lo, hi = start.timestamp(), end.timestamp()
seen=set(); tok=0; rsn=0; recs=0; dups=0; files=0; bad=0
active=set()
paths=[]
for slug in os.listdir(root):
    d=os.path.join(root,slug)
    if not os.path.isdir(d): continue
    for name in os.listdir(d):
        p=os.path.join(d,name)
        if name.endswith('.jsonl'): paths.append(p)
        elif os.path.isdir(p):
            for n2 in os.listdir(p):
                if n2.endswith('.jsonl'): paths.append(os.path.join(p,n2))
for p in paths:
    try:
        if os.path.getmtime(p) < lo: continue
    except OSError: continue
    files+=1
    with open(p, errors='replace') as fh:
        for line in fh:
            if '"usage"' not in line: continue
            try: r=json.loads(line)
            except Exception: bad+=1; continue
            u=(r.get('message') or {}).get('usage') or r.get('usage')
            ts=r.get('timestamp')
            if not u or not isinstance(ts,str): continue
            try: t=dt.datetime.fromisoformat(ts.replace('Z','+00:00')).timestamp()
            except ValueError: continue
            n=u.get('output')
            if not isinstance(n,(int,float)): continue
            if not (lo <= t <= hi): continue
            key=f"{r.get('id')}@{ts}"
            if r.get('id') is not None:
                if key in seen: dups+=1; continue
                seen.add(key)
            rt=u.get('reasoningTokens')
            rsn+=rt if isinstance(rt,(int,float)) else 0
            tok+=n; recs+=1; active.add(p)
print(json.dumps({"window_s":win,"start":start.isoformat(),"end":end.isoformat(),
 "files_scanned":files,"active_sessions":len(active),"records":recs,
 "tokens":tok,"tokens_per_s":round(tok/win,3),
 "output_tokens":tok,"output_tokens_per_s":round(tok/win,3),
 "reasoning_tokens":rsn,"duplicate_records_skipped":dups,"bad_lines":bad}))
