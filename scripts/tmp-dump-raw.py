#!/usr/bin/env python3
"""Dump key sections of _raw/{code}.json and {code}.mcp.json for writing."""
import json, sys, os

RAW = os.path.join(os.path.dirname(__file__), '..', 'src/data/analyses/_raw')

def s(x, n=100000):
    t = json.dumps(x, ensure_ascii=False, indent=1)
    return t[:n]

def main(code, parts):
    raw = json.load(open(os.path.join(RAW, code + '.json')))
    mcp = json.load(open(os.path.join(RAW, code + '.mcp.json')))
    if 'profile' in parts:
        print('=== NAME/INDUSTRY/LISTDATE ===')
        print(raw.get('name'), '|', raw.get('industry'), '|', raw.get('listingDate'), '| reviewDate:', raw.get('reviewDate'))
        print('--- profile ---'); print(raw.get('profile'))
        print('--- scope ---'); print(raw.get('scope'))
    if 'review' in parts:
        print('=== REVIEW ==='); print(raw.get('review'))
    if 'groups' in parts:
        print('=== GROUPS ==='); print(s(raw.get('groups')))
    if 'finance' in parts:
        print('=== FINANCE ==='); print(s(raw.get('finance')))
    if 'overview' in parts:
        print('=== MCP OVERVIEW ===')
        try:
            tabs = mcp['overview']['response']['transformed']['tables']
        except Exception:
            tabs = mcp.get('overview', {}).get('response', {}).get('transformed', {}).get('tables', [])
        for t in tabs:
            print('\n#### TABLE:', t.get('name'))
            for r in t.get('rows', []):
                if isinstance(r, dict):
                    print(' | '.join(f'{k}={v}' for k, v in r.items()))
                else:
                    print(' | '.join('' if c is None else str(c) for c in r))
    if 'reports' in parts:
        print('=== REPORTS ===')
        d = mcp.get('reports', {})
        rows = d.get('data') if isinstance(d, dict) else d
        if not rows:
            print('NO REPORTS:', json.dumps(d, ensure_ascii=False)[:2000])
        else:
            for r in rows:
                print(' ||| '.join('' if c is None else str(c).replace('\n', ' ')[:600] for c in r))
    if 'err' in parts:
        for k in ('overviewError', 'reportsError'):
            if mcp.get(k): print(k, '=', mcp[k])

main(sys.argv[1], sys.argv[2:] or ['profile', 'review', 'groups', 'finance', 'overview', 'reports', 'err'])
