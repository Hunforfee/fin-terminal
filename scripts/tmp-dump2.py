#!/usr/bin/env python3
"""Compact dump: groups as table + overview key metrics + review text."""
import json, sys, os

RAW = os.path.join(os.path.dirname(__file__), '..', 'src/data/analyses/_raw')
code = sys.argv[1]
what = sys.argv[2] if len(sys.argv) > 2 else 'all'

raw = json.load(open(os.path.join(RAW, code + '.json')))
mcp = json.load(open(os.path.join(RAW, code + '.mcp.json')))

if what in ('all', 'head'):
    print('NAME:', raw.get('name'), '| INDUSTRY:', raw.get('industry'), '| LISTDATE:', raw.get('listingDate'), '| REVIEWDATE:', raw.get('reviewDate'))
    print('\n--- PROFILE ---\n', raw.get('profile'))

if what in ('all', 'groups'):
    print('\n--- GROUPS ---')
    for g in (raw.get('groups') or []):
        print(f"[{g.get('label')}] {g.get('date')}")
        for it in g.get('items', []):
            inc = it.get('income')
            incs = f"{inc/1e8:.2f}亿" if isinstance(inc, (int, float)) and abs(inc) > 1e6 else (f"{inc}" if inc is not None else '-')
            print(f"   {it.get('name')}: 收入{incs} 占比{(it.get('incomeRatio') or 0)*100:.2f}% 毛利率{(it.get('grossMargin') or 0)*100:.2f}%")

if what in ('all', 'ov'):
    print('\n--- OVERVIEW ---')
    try:
        tabs = mcp['overview']['response']['transformed']['tables']
    except Exception:
        tabs = []
    for t in tabs:
        if t['name'] in ('financial_highlights', 'valuation_metrics', 'basic_overview', 'metadata', 'business_overview'):
            for r in t.get('rows', []):
                print(f"  [{t['name']}] " + ' | '.join(f'{k}={v}' for k, v in r.items()))

if what in ('all', 'review'):
    print('\n--- REVIEW ---\n', raw.get('review'))
