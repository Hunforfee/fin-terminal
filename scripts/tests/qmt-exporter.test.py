import ast
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import zipfile

SOURCE = Path(__file__).resolve().parents[1] / 'qmt-export-watchlist.py'
spec = importlib.util.spec_from_file_location('qmt_exporter', SOURCE)
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


class Frame:
    def __init__(self, rows): self.rows = rows
    def __len__(self): return len(self.rows)
    def iterrows(self): return iter(enumerate(self.rows))


class ExporterTests(unittest.TestCase):
    def test_ascii_and_old_python_syntax(self):
        SOURCE.read_bytes().decode('ascii')
        ast.parse(SOURCE.read_text('ascii'), feature_version=(3, 5))

    def test_scope_and_resume(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd() / 'data') as root:
            source = Path(root) / 'watchlist.csv'
            source.write_text('分组,代码,名称\n一,sh600519,贵州茅台\n二,sh600519,贵州茅台\n一,hk00700,腾讯\n', encoding='utf-8-sig')
            items, digest, count = exporter.load_scope(str(source))
            self.assertEqual((count, len(items)), (3, 2))
            self.assertEqual(items[0]['qmtCode'], '600519.SH')
            self.assertEqual(items[0]['groups'], ['一', '二'])
            self.assertEqual(items[1]['qmtCode'], '00700.HK')

    def test_market_time_and_invalid_prices(self):
        self.assertEqual(exporter.bounds(dt.datetime(2026, 10, 21, 16)), ('2021-10-21', '2026-10-20'))
        self.assertEqual(exporter.bounds(dt.datetime(2026, 10, 21, 19))[1], '2026-10-21')
        self.assertEqual(exporter.bounds(dt.datetime(2026, 10, 24, 19))[1], '2026-10-23')
        bar = dict(time='20261020', open=10, high=11, low=9, close=10.5)
        self.assertEqual(exporter.extract_bars(Frame([bar]), '2021-10-21', '2026-10-20')[0]['date'], '2026-10-20')
        for rows in ([bar, bar], [dict(bar, low=12)], [dict(bar, close=float('nan'))]):
            with self.assertRaises(ValueError): exporter.extract_bars(Frame(rows), '2021-10-21', '2026-10-20')

    def test_export_files_checksums_and_repeated_run(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd() / 'data') as root:
            source = Path(root) / 'watchlist.csv'
            source.write_text('分组,代码,名称\n一,sh600519,贵州茅台\n', encoding='utf-8-sig')
            calls = []
            class Context:
                def get_market_data_ex(self, fields, codes, **options):
                    self.options = options
                    assert options['subscribe'] is False and options['fill_data'] is False
                    return {codes[0]: Frame([dict(time='20211021', open=10, high=11, low=9, close=10), dict(time='20261020', open=10, high=11, low=9, close=10.5)])}
                def get_open_date(self, code): return 20010827
                def get_divid_factors(self, code): return {}
            values = (exporter.ROOT, exporter.INPUT_CSV, exporter.time.sleep, exporter.bounds)
            try:
                exporter.ROOT = root
                exporter.INPUT_CSV = str(source)
                exporter.load_scope.__defaults__ = (str(source),)
                exporter.time.sleep = lambda _: None
                exporter.bounds = lambda: ('2021-10-21', '2026-10-20')
                exporter.download_history_data = lambda *args: calls.append(args)
                exporter.main(Context()); exporter.main(Context())
                self.assertEqual(len(calls), 1)
                manifest = next(Path(root).glob('export_*/manifest.json'))
                state = json.loads(manifest.read_text('utf-8'))
                self.assertEqual(state['summary']['exported'], 1)
                archive = next(manifest.parent.glob('sample_result.zip'))
                with zipfile.ZipFile(archive) as handle:
                    self.assertIn('raw/sh600519.json', handle.namelist())
                raw = json.loads((manifest.parent / 'raw/sh600519.json').read_text('utf-8'))
                self.assertNotIn('volume', raw['candles'][0])
            finally:
                exporter.ROOT, exporter.INPUT_CSV, exporter.time.sleep, exporter.bounds = values


if __name__ == '__main__': unittest.main()
