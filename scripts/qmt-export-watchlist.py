# coding: ascii
"""Ordinary QMT built-in Python. Read/export only. No trading functions.

Official API: https://dict.thinktrader.net/innerApi/data_function.html
Uses download_history_data + ContextInfo.get_market_data_ex(subscribe=False).
Python 3.5+ syntax; source is ASCII to avoid broker editor encoding issues.
"""
import csv
import builtins
import datetime as dt
import hashlib
import io
import json
import math
import os
import re
import sys
import time
import traceback
import zipfile

ROOT = r"D:\ChatGpt\QMT_watchlist"
INPUT_CSV = os.path.join(ROOT, "watchlist.csv")
SAMPLE_MODE = True  # After a successful sample, change True to False.
INCLUDE_HK = False  # Sample still checks HK; bulk A first, HK remains in the handoff list.
DOWNLOAD_HISTORY = True
EXPORT_FRONT_REFERENCE = True
FAILURE_STOP = 3
VERSION = 1
_started = False


def china_now():
    return dt.datetime.now(dt.timezone.utc).replace(tzinfo=None) + dt.timedelta(hours=8)


def bounds(now=None):
    now = now or china_now()
    today = now.date()
    try:
        start = today.replace(year=today.year - 5)
    except ValueError:
        start = today.replace(year=today.year - 5, day=28)
    end = today if (now.hour, now.minute) >= (18, 30) else today - dt.timedelta(days=1)
    while end.weekday() >= 5:
        end -= dt.timedelta(days=1)
    return start.isoformat(), end.isoformat()


def load_scope(path=INPUT_CSV):
    with open(path, "rb") as handle:
        raw = handle.read()
    text = None
    for encoding in ("utf-8-sig", "gb18030", "utf-16"):
        try:
            decoded = raw.decode(encoding)
            if "\u4ee3\u7801" in decoded:
                text = decoded
                break
        except UnicodeError:
            pass
    if text is None:
        raise ValueError("Cannot decode CSV or find the stock-code column")
    rows = list(csv.DictReader(io.StringIO(text)))
    selected = {}
    for line, row in enumerate(rows, 2):
        symbol = (row.get("\u4ee3\u7801") or "").strip().lower()
        if not re.match(r"^(?:(?:sh|sz|bj)[0-9]{6}|hk[0-9]{5})$", symbol):
            raise ValueError("Invalid stock code at CSV line {0}: {1}".format(line, symbol))
        if symbol not in selected:
            selected[symbol] = {"symbol": symbol, "qmtCode": symbol[2:] + "." + symbol[:2].upper(),
                                "name": row.get("\u540d\u79f0", ""), "groups": []}
        group = row.get("\u5206\u7ec4", "")
        if group not in selected[symbol]["groups"]:
            selected[symbol]["groups"].append(group)
    if not selected:
        raise ValueError("Watchlist is empty")
    items = list(selected.values())
    items.sort(key=lambda item: item["symbol"].startswith("hk"))
    return items, hashlib.sha256(raw).hexdigest(), len(rows)


def date_of(value, fallback=None):
    for v in (value, fallback):
        if v is None:
            continue
        s = str(v).strip()
        try:
            if re.match(r"^\d{8}(?:\d{6})?$", s):
                return dt.datetime.strptime(s[:8], "%Y%m%d").date().isoformat()
            if re.match(r"^\d{4}-\d{2}-\d{2}", s):
                return dt.datetime.strptime(s[:10], "%Y-%m-%d").date().isoformat()
            number = float(s)
            if math.isfinite(number) and number > 100000000000:
                return (dt.datetime.utcfromtimestamp(number / 1000) + dt.timedelta(hours=8)).date().isoformat()
        except (ValueError, TypeError, OverflowError, OSError):
            pass
    raise ValueError("Cannot interpret a trading date: {0}".format(value))


def clean_json(value):
    if isinstance(value, dict):
        return {str(k): clean_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean_json(v) for v in value]
    if hasattr(value, "item"):
        return clean_json(value.item())
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def save_json(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temp = path + ".tmp"
    with io.open(temp, "w", encoding="utf-8") as handle:
        json.dump(clean_json(value), handle, ensure_ascii=False, allow_nan=False, indent=2)
    os.replace(temp, path)


def digest_file(path):
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def extract_bars(frame, start, end):
    if frame is None or not hasattr(frame, "iterrows") or len(frame) == 0:
        raise ValueError("No local daily bars; download/market permission may be unavailable")
    seen = set()
    rows = []
    for index, row in frame.iterrows():
        date = date_of(row.get("time"), index)
        if date < start or date > end:
            continue
        if date in seen:
            raise ValueError("Duplicate trading date: " + date)
        seen.add(date)
        bar = {"date": date}
        for field in ("open", "high", "low", "close"):
            number = float(row[field])
            if not math.isfinite(number):
                raise ValueError("Invalid " + field + " on " + date)
            bar[field] = number
        if bar["low"] <= 0 or bar["low"] > min(bar["open"], bar["close"]) or bar["high"] < max(bar["open"], bar["close"]):
            raise ValueError("Invalid raw OHLC on " + date)
        rows.append(bar)
    rows.sort(key=lambda bar: bar["date"])
    if not rows:
        raise ValueError("No completed daily bars within the requested range")
    return rows


def read_bars(C, code, start, end, adjust):
    data = C.get_market_data_ex(["time", "open", "high", "low", "close"], [code],
                               period="1d", start_time=start.replace("-", ""),
                               end_time=end.replace("-", "") + "235959", count=-1,
                               dividend_type=adjust, fill_data=False, subscribe=False)
    if not isinstance(data, dict):
        raise ValueError("Unexpected get_market_data_ex return type")
    return extract_bars(data.get(code), start, end)


def export_one(C, item, folder, start, end):
    code, symbol = item["qmtCode"], item["symbol"]
    if DOWNLOAD_HISTORY:
        downloader = globals().get("download_history_data") or getattr(builtins, "download_history_data", None)
        if not callable(downloader):
            raise RuntimeError("QMT download_history_data is unavailable; do not run this file with external Python")
        downloader(code, "1d", start.replace("-", ""), end.replace("-", "") + "235959")
    bars = None
    for attempt in range(3):
        try:
            bars = read_bars(C, code, start, end, "none")
            break
        except ValueError:
            if attempt == 2:
                raise
            time.sleep(1)
    listing = None
    optional_errors = {}
    try:
        listing = date_of(C.get_open_date(code))
        if listing > end:
            raise ValueError("Listing date is later than the export end")
    except Exception as error:
        listing = None
        optional_errors["listingDate"] = str(error)
        try:
            details = C.get_instrument_detail(code)
            listing = date_of(details.get("OpenDate")) if isinstance(details, dict) else None
            if listing and listing <= end:
                optional_errors.pop("listingDate", None)
            else:
                listing = None
        except Exception:
            pass
    expected = max(start, listing or start)
    first_gap = (dt.datetime.strptime(bars[0]["date"], "%Y-%m-%d") - dt.datetime.strptime(expected, "%Y-%m-%d")).days
    last_gap = (dt.datetime.strptime(end, "%Y-%m-%d") - dt.datetime.strptime(bars[-1]["date"], "%Y-%m-%d")).days
    warnings = []
    if first_gap > 14:
        warnings.append("History starts late; verify listing date, permission and download coverage")
    if last_gap > 14:
        warnings.append("Last bar is old; verify suspension, delisting or source coverage")
    dates = [dt.datetime.strptime(bar["date"], "%Y-%m-%d") for bar in bars]
    if any((right - left).days > 31 for left, right in zip(dates, dates[1:])):
        warnings.append("Long internal gaps; verify suspensions or incomplete download against the trading calendar")
    payload = {"schema": "fin-terminal-qmt-raw-v1", "symbol": symbol, "qmtCode": code,
               "name": item["name"], "source": "qmt", "currency": "HKD" if symbol.startswith("hk") else "CNY",
               "period": "day", "adjust": "none", "requestedFrom": start, "requestedTo": end,
               "acquiredAtChina": china_now().isoformat(), "fillData": False,
               "coverage": "partial" if warnings else "range-checked", "warnings": warnings,
               "listingDate": listing, "candles": bars}
    filename = symbol + ".json"
    save_json(os.path.join(folder, "raw", filename), payload)
    files = ["raw/" + filename]
    if EXPORT_FRONT_REFERENCE:
        try:
            front = read_bars(C, code, start, end, "front")
            save_json(os.path.join(folder, "front_reference", filename), {
                "symbol": symbol, "source": "qmt", "adjust": "QMT-front",
                "use": "reference-only; do not concatenate with another provider", "candles": front})
            files.append("front_reference/" + filename)
        except Exception as error:
            optional_errors["frontReference"] = str(error)
    try:
        factors = C.get_divid_factors(code)
        if not isinstance(factors, dict):
            raise ValueError("Unexpected factor format")
        selected = {str(k): clean_json(v) for k, v in factors.items() if start <= date_of(k) <= end}
        save_json(os.path.join(folder, "corporate_actions_reference", filename), {
            "symbol": symbol, "source": "qmt", "semantics": "raw QMT factors; dividend units and announcements need separate verification", "events": selected})
        files.append("corporate_actions_reference/" + filename)
    except Exception as error:
        optional_errors["corporateActions"] = str(error)
    return {"status": "exported", "from": bars[0]["date"], "to": bars[-1]["date"],
            "count": len(bars), "coverage": payload["coverage"], "warnings": warnings,
            "optionalErrors": optional_errors,
            "files": {name: digest_file(os.path.join(folder, name)) for name in files}}


def main(C):
    items, scope_hash, input_rows = load_scope()
    start, end = bounds()
    if SAMPLE_MODE:
        sample = []
        for prefix in ("sh", "sz", "hk"):
            found = next((item for item in items if item["symbol"].startswith(prefix)), None)
            if found:
                sample.append(found)
        targets = sample
    else:
        targets = items if INCLUDE_HK else [item for item in items if not item["symbol"].startswith("hk")]
    folder = os.path.join(ROOT, "export_{0}_{1}_{2}".format(start.replace("-", ""), end.replace("-", ""), scope_hash[:8]))
    state_path = os.path.join(folder, "manifest.json")
    if os.path.isfile(state_path):
        with io.open(state_path, "r", encoding="utf-8") as handle:
            state = json.load(handle)
        if state.get("scopeSha256") != scope_hash or state.get("version") != VERSION:
            raise ValueError("Checkpoint scope/version mismatch")
    else:
        state = {"version": VERSION, "scopeSha256": scope_hash, "requestedFrom": start,
                 "requestedTo": end, "inputRows": input_rows, "uniqueStocks": len(items),
                 "scope": items, "stocks": {}}
    state["mode"] = "sample" if SAMPLE_MODE else "full"
    state["selectedCount"] = len(targets)
    selected_symbols = set(item["symbol"] for item in targets)
    state["outsideSelection"] = [item for item in items if item["symbol"] not in selected_symbols]
    save_json(state_path, state)
    consecutive_failures = 0
    print("MODE={0}; UNIQUE={1}; TARGETS={2}; RANGE={3}..{4}".format(state["mode"], len(items), len(targets), start, end))
    print("OUTPUT=" + folder)
    for index, item in enumerate(targets, 1):
        if os.path.exists(os.path.join(ROOT, "STOP.txt")):
            print("STOP.txt found; checkpoint preserved")
            break
        symbol = item["symbol"]
        previous = state["stocks"].get(symbol, {})
        verified = previous.get("status") == "exported" and previous.get("files")
        if verified:
            for name, digest in previous["files"].items():
                try:
                    if digest_file(os.path.join(folder, name)) != digest:
                        verified = False
                except OSError:
                    verified = False
        if verified:
            print("[{0}/{1}] {2} RESUME-SKIP".format(index, len(targets), symbol))
            continue
        print("[{0}/{1}] {2} DOWNLOADING".format(index, len(targets), symbol))
        try:
            result = export_one(C, item, folder, start, end)
            state["stocks"][symbol] = result
            consecutive_failures = 0
            print("  EXPORTED {0} bars {1}..{2}; coverage={3}".format(result["count"], result["from"], result["to"], result["coverage"]))
        except Exception as error:
            consecutive_failures += 1
            state["stocks"][symbol] = {"status": "failed", "error": str(error), "traceback": traceback.format_exc()}
            print("  FAILED: " + str(error).encode("ascii", "backslashreplace").decode("ascii"))
        save_json(state_path, state)
        if consecutive_failures >= FAILURE_STOP:
            print("Paused after consecutive failures; see manifest.json. Successful files are preserved.")
            break
        time.sleep(0.5)
    current_results = [value for symbol, value in state["stocks"].items() if symbol in selected_symbols]
    state["summary"] = {"selected": len(targets),
                        "exported": sum(v.get("status") == "exported" for v in current_results),
                        "failed": sum(v.get("status") == "failed" for v in current_results),
                        "partialCoverage": sum(v.get("coverage") == "partial" for v in current_results),
                        "pending": len(targets) - len(current_results),
                        "outsideSelection": len(items) - len(targets)}
    save_json(state_path, state)
    archive = os.path.join(folder, state["mode"] + "_result.zip")
    with zipfile.ZipFile(archive + ".tmp", "w", zipfile.ZIP_DEFLATED) as handle:
        handle.write(state_path, "manifest.json")
        for symbol, result in state["stocks"].items():
            if symbol not in selected_symbols:
                continue
            if result.get("status") == "exported":
                for name in result["files"]:
                    handle.write(os.path.join(folder, name), name)
    os.replace(archive + ".tmp", archive)
    print("SUMMARY=" + json.dumps(state["summary"]))
    print("ZIP=" + archive)
    print("END. Missing financial reports and unverified dividend inputs must still be collected by the website.")


def init(ContextInfo):
    print("FinTerminal QMT watchlist exporter; Python=" + sys.version.split()[0])
    print("READ/EXPORT ONLY; SAMPLE_MODE=" + str(SAMPLE_MODE))


def _run_once(ContextInfo):
    global _started
    if _started:
        return
    _started = True
    try:
        if sys.version_info[0] < 3:
            raise RuntimeError("Select a Python 3 model in QMT before running this exporter")
        main(ContextInfo)
    except Exception:
        print(traceback.format_exc())


def after_init(ContextInfo):
    _run_once(ContextInfo)


def handlebar(ContextInfo):
    # Fallback for older clients without after_init. Never repeats per historical bar.
    _run_once(ContextInfo)


if __name__ == "__main__" and "--inspect" in sys.argv:
    _items, _sha, _rows = load_scope()
    print(json.dumps({"rows": _rows, "unique": len(_items), "A": sum(not s["symbol"].startswith("hk") for s in _items),
                      "HK": sum(s["symbol"].startswith("hk") for s in _items), "scopeSha256": _sha, "range": bounds()}, indent=2))
