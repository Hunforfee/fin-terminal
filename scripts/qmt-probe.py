# coding: ascii
# Ordinary QMT built-in Python. No downloads and no trading.
import json
try:
    import builtins
except ImportError:
    import __builtin__ as builtins
import os
import sys

ROOT = r"D:\ChatGpt\QMT_watchlist"
_done = False


def init(ContextInfo):
    print("QMT_PROBE_START")
    print("PYTHON=" + sys.version.replace("\n", " "))
    print("CSV_EXISTS=" + str(os.path.isfile(os.path.join(ROOT, "watchlist.csv"))))
    print("DOWNLOAD_API=" + str(callable(globals().get("download_history_data") or getattr(builtins,"download_history_data",None))))
    for name in ("get_market_data_ex", "get_open_date", "get_divid_factors", "get_instrument_detail"):
        print(name + "=" + str(callable(getattr(ContextInfo, name, None))))
    print("QMT_PROBE_END")


def after_init(ContextInfo):
    pass


def handlebar(ContextInfo):
    pass
