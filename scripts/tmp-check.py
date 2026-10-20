#!/usr/bin/env python3
"""Check summary length/paragraphs for given codes against WRITER_GUIDE range."""
import json, sys, os
DIR = os.path.join(os.path.dirname(__file__), '..', 'src/data/analyses')
for c in sys.argv[1:]:
    p = os.path.join(DIR, c + '.json')
    if not os.path.exists(p):
        print(c, 'MISSING'); continue
    d = json.load(open(p))
    s = d.get('summary', '')
    paras = len([x for x in s.split('\n\n') if x])
    flag = 'OK ' if 1300 <= len(s) <= 2200 and paras == 5 else 'BAD'
    print(f'{flag} {c} 字数={len(s)} 段数={paras} moat={len(d.get("moat",[]))} comp={len(d.get("competitors",[]))} bull={len(d.get("bullCase",[]))} bear={len(d.get("bearCase",[]))} rs={d.get("ratingSummary")}')
