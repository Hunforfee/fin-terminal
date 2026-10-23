#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
通过 HTTP MCP 直连 tdx-connector，抓取日线(不复权)并导出为导入 bundle。

用法:
  python3 tdx_fetch.py --codes sh600415,sz000001,hk00700 --out bundle.json
  python3 tdx_fetch.py --input hunforfee-codes.txt --out bundle.json --years 12

依赖: 仅标准库 (urllib)。tdx 端点为内网 HTTP MCP，无需额外鉴权。
"""
import datetime as dt
import json, sys, time as _time, urllib.request, urllib.error, argparse

BASE = "http://tdx-connector.agent-gateway.auth-proxy.local/txmcp"
HDR = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}

SETCODE = {"sh": "1", "sz": "0", "bj": "2", "hk": "31"}

# ---- 极简 HTTP MCP 客户端 ----
class TdxMCP:
    def __init__(self, base=BASE, timeout=30):
        self.base = base; self.timeout = timeout; self.sid = None
    def _post_once(self, body):
        data = json.dumps(body).encode()
        req = urllib.request.Request(self.base, data=data, headers=HDR, method="POST")
        if self.sid: req.add_header("Mcp-Session-Id", self.sid)
        resp = urllib.request.urlopen(req, timeout=self.timeout)
        sid = resp.headers.get("Mcp-Session-Id")
        if sid: self.sid = sid
        raw = resp.read().decode()
        candidates = [line[5:].strip() for line in raw.splitlines() if line.startswith("data:")]
        if not candidates: candidates = [raw.strip()]
        for c in candidates:
            try: return json.loads(c)
            except Exception: continue
        raise RuntimeError("无法解析 MCP 响应: " + raw[:200])
    def _post(self, method, params=None, rid=1, notify=False, tries=3):
        body = {"jsonrpc": "2.0", "method": method}
        if not notify: body["id"] = rid
        if params is not None: body["params"] = params
        last = None
        for _ in range(tries):
            try: return self._post_once(body), None
            except Exception as e:
                last = e; _time.sleep(0.5)
        return None, str(last)[:300]
    def initialize(self):
        for _ in range(3):
            r, err = self._post("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "tdx-fetch", "version": "1.0"}})
            if r and r.get("result"):
                self._post("notifications/initialized", notify=True); return
            _time.sleep(0.6)
        raise RuntimeError("MCP initialize 失败: " + str(err))
    def call(self, name, args, rid=2):
        r, err = self._post("tools/call", {"name": name, "arguments": args}, rid=rid)
        if err: raise RuntimeError("tools/call 失败: " + err)
        if r is None or "result" not in r: raise RuntimeError("tools/call 无结果: " + str(r)[:300])
        return r["result"]["content"][0]["text"]

# ---- 从「摘要+内嵌JSON」文本里抠出 JSON 对象 ----
def extract_json(text):
    i = text.find("{")
    if i < 0: raise RuntimeError("返回中找不到 JSON")
    depth = 0; instr = False; esc = False
    for j in range(i, len(text)):
        c = text[j]
        if instr:
            if esc: esc = False
            elif c == "\\": esc = True
            elif c == '"': instr = False
        else:
            if c == '"': instr = True
            elif c == "{": depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    return text[i:j+1]
    raise RuntimeError("JSON 未闭合")

def parse_rows(text):
    obj = json.loads(extract_json(text))
    rows = obj.get("Rows", [])
    out = []
    for r in rows:
        d = r.get("Data", "")
        if not d or len(d) != 8: continue
        date = f"{d[:4]}-{d[4:6]}-{d[6:8]}"
        try:
            o = float(r["Open"]); h = float(r["High"]); l = float(r["Low"]); c = float(r["Close"])
        except (ValueError, TypeError):
            continue
        out.append({"date": date, "open": o, "high": h, "low": l, "close": c})
    out.sort(key=lambda x: x["date"])
    return out

def fetch_symbol(mcp, symbol, years=12, per_page=1000, max_pages=12, delay=0.15):
    """分页拉取 symbol 的日线(不复权)全量。startxh 为倒序偏移。"""
    sym = symbol.lower()
    market = sym[:2]; code = sym[2:]
    setcode = SETCODE.get(market)
    if not setcode: raise ValueError(f"未知市场前缀: {symbol}")
    allrows = []
    seen = set()
    offset = 0
    CAP = 700  # tdx 单次返回上限(实测), 分页按实际返回量推进
    while True:
        text = mcp.call("tdx_kline", {"code": code, "setcode": setcode, "period": "4", "tqFlag": "0", "wantNum": per_page, "startxh": offset}, rid=10+(offset//per_page))
        rows = parse_rows(text)
        if not rows: break
        new = [r for r in rows if r["date"] not in seen]
        if not new: break  # 已到最旧
        for r in new: seen.add(r["date"])
        allrows.extend(new)
        offset += len(rows)
        if len(rows) < CAP: break  # 最后一页
        if offset > 3200: break  # 安全上限 (~13年)
        time.sleep(delay)
    allrows.sort(key=lambda x: x["date"])
    # 仅保留近 years 年(宽一点, 由导入侧 cutoff 精确裁剪)
    if years:
        cutoff = f"{dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).year - years - 1}-01-01"
        allrows = [r for r in allrows if r["date"] >= cutoff]
    return {"symbol": sym, "code": code, "market": market, "period": "day", "adjust": "none", "candles": allrows}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--codes", help="逗号分隔代码, 如 sh600415,hk00700")
    ap.add_argument("--input", help="代码文件, 每行一个")
    ap.add_argument("--out", required=True)
    ap.add_argument("--years", type=int, default=12)
    ap.add_argument("--limit", type=int, default=0, help="仅抓取前 N 只(调试)")
    args = ap.parse_args()

    codes = []
    if args.codes: codes += [c.strip() for c in args.codes.split(",") if c.strip()]
    if args.input:
        for line in open(args.input, encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#"): codes.append(line)
    if args.limit: codes = codes[:args.limit]
    if not codes:
        print("无代码可抓", file=sys.stderr); sys.exit(1)

    mcp = TdxMCP(); mcp.initialize()
    print(f"MCP 已连接, 共 {len(codes)} 只", file=sys.stderr)
    records = []
    for i, sym in enumerate(codes, 1):
        try:
            rec = fetch_symbol(mcp, sym, years=args.years)
            n = len(rec["candles"])
            first = rec["candles"][0]["date"] if n else "-"
            last = rec["candles"][-1]["date"] if n else "-"
            print(f"  [{i}/{len(codes)}] {sym}: {n} 根 ({first}~{last})", file=sys.stderr)
            records.append(rec)
        except Exception as e:
            print(f"  [{i}/{len(codes)}] {sym}: 失败 {e}", file=sys.stderr)
    bundle = {"version": 1, "source": "tdx", "generatedAt": _time.strftime("%Y-%m-%dT%H:%M:%S"), "records": records}
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(bundle, f, ensure_ascii=False)
    print(f"已写出 {len(records)} 只 -> {args.out}  (总 {sum(len(r['candles']) for r in records)} 根)", file=sys.stderr)

if __name__ == "__main__":
    main()
