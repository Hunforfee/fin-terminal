"""Build offline admin records from SHA-verified QMT exports; never connects or uploads."""
import argparse
import datetime as dt
import hashlib
import json
import math
import zipfile
from decimal import Decimal
from pathlib import Path


def read(path):
    return json.loads(path.read_text('utf-8-sig'))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def unpack(value):
    if isinstance(value, dict) and value.get('kind') == 'mapping':
        result = {}
        for key, item in value['entries']:
            if key in result:
                raise ValueError('Duplicate raw mapping key')
            result[key] = unpack(item)
        return result
    if isinstance(value, list):
        return [unpack(item) for item in value]
    return value


def china_date(value):
    if value is None or Decimal(str(value)) <= 0:
        return None
    return (dt.datetime(1970, 1, 1) + dt.timedelta(milliseconds=float(value), hours=8)).date().isoformat()


MAPPING = {
    'profit': ('ASHAREINCOME', [('revenue', '一、营业总收入'), ('revenue_inc', '营业收入'),
        ('oper_profit', '三、营业利润'), ('net_profit_incl_min_int_inc', '五、净利润'),
        ('net_profit_excl_min_int_inc', '归属于母公司所有者的净利润')]),
    'balance': ('ASHAREBALANCESHEET', [('tot_assets', '资产总计'), ('tot_liab', '负债合计'),
        ('tot_shrhldr_eqy_excl_min_int', '归属于母公司股东权益合计'), ('cap_stk', '实收资本(或股本)')]),
    'cashflow': ('ASHARECASHFLOW', [('net_cash_flows_oper_act', '经营活动产生的现金流量净额'),
        ('cash_pay_acq_const_fiolta', '购建固定资产、无形资产和其他长期资产支付的现金')]),
}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--export', type=Path, required=True)
    ap.add_argument('--output', type=Path, required=True)
    ap.add_argument('--finance-backup-index', type=Path)
    ap.add_argument('--dividend-evidence', type=Path)
    args = ap.parse_args()
    if args.output.exists():
        raise ValueError('Preserve existing output; choose a new folder')
    root, out = args.export.resolve(), args.output.resolve()
    manifest = read(root / 'manifest.json')
    if manifest['schema'] != 'qmt-local-10y-v1':
        raise ValueError('Unexpected export schema')
    start, end = manifest['range']
    backup = read(args.finance_backup_index) if args.finance_backup_index else {}
    out.mkdir(parents=True)
    upload = out / 'admin-upload'
    upload.mkdir()
    report = {'range': [start, end], 'productionWritten': False, 'files': [], 'stocks': [],
        'sourceManifestSha256': digest(root / 'manifest.json'), 'limitations': [
        '按输入清单声明的 range 保留报告期；旧十年导出包不会凭空扩展到十二年，需重新导出缺失年份。',
        'QMT当前修订版公告日未证明是首次披露日，不写入历史估值披露日缓存。',
        'QMT只导出已查询的关键财务科目，不能证明整站所有指标已齐备。',
        '没有实际上市日期时保留为空，不以首根K线推断上市。',
        '分红仅复用明确给出的原始来源证据，不从复权因子猜测。']}

    def verified(relative, expected):
        path = (root / relative).resolve()
        if root not in path.parents or digest(path) != expected:
            raise ValueError('Raw export checksum/path mismatch: ' + relative)
        return read(path)

    def save(name, record, source):
        path = upload / name
        path.write_text(json.dumps(record, ensure_ascii=False, allow_nan=False) + '\n', 'utf-8')
        report['files'].append({'file': 'admin-upload/' + name, 'type': record['type'],
            'symbol': record['symbol'], 'sha256': digest(path), 'bytes': path.stat().st_size, 'source': source})

    for symbol, meta in manifest['stocks'].items():
        if meta['prices']['status'] != 'exported' or not symbol.startswith(('sh', 'sz', 'bj')):
            raise ValueError('Only successful A-share exports are accepted')
        code = symbol[2:]
        for relative, sha in meta['prices']['files'].items():
            verified(relative, sha)
        raw = read(root / 'raw' / (symbol + '.json'))
        if raw['symbol'] != symbol or raw['adjust'] != 'none':
            raise ValueError('Wrong price identity or adjustment')
        save('kline_' + symbol + '.json', {'type': 'kline', 'symbol': symbol, 'adjust': 'none',
            'period': 'day', 'listingDate': raw.get('listingDate'), 'candles': raw['candles']}, 'qmt:unadjusted')
        fields = {}
        for relative, item in meta['finance'].items():
            value = verified('finance/' + item['file'], item['sha256'])
            if value['status'] != 'returned':
                raise ValueError('Incomplete financial query: ' + relative)
            decoded = unpack(value['raw'])
            if list(decoded) != [value['code']] or value['code'].split('.')[0] != code:
                raise ValueError('Financial identity mismatch')
            if value['axis'] == 'report_time':
                fields[value['label']] = {k: {china_date(t): v for t, v in seq.items()}
                    for k, seq in decoded[value['code']].items()}
        dates = sorted(d for d in fields['profit']['ASHAREINCOME.net_profit_excl_min_int_inc']
            if d and start <= d <= end)
        for statement, (table, mapping) in MAPPING.items():
            values = {}
            announcements = {}
            evidence = []
            # Optional pre-import full pages preserve fields absent from QMT's small selection.
            for key, item in backup.items():
                if not key.startswith('source-sina-page:v1:' + code + ':' + statement + ':'):
                    continue
                p = read(Path(item['file']))
                if p.get('key', key) != key:
                    raise ValueError('Backup identity mismatch')
                p = p.get('payload', p)
                evidence.append({'key': key, 'sha256': digest(Path(item['file']))})
                for i, day in enumerate(p['dates']):
                    if start <= day <= end:
                        for row in p['rows']:
                            if row['kind'] == 'field':
                                v = row['vals'][i]
                                if v not in ('--', '—', '', None):
                                    values.setdefault(row['name'], {})[day] = float(str(v).replace(',', ''))
                        if p.get('announceDates'):
                            announcements[day] = p['announceDates'][i]
            for field, name in mapping:
                for day, amount in fields[statement][table + '.' + field].items():
                    if day and start <= day <= end and amount is not None:
                        if not math.isfinite(amount):
                            raise ValueError('Nonfinite amount')
                        values.setdefault(name, {})[day] = float(Decimal(str(amount)) / Decimal(10000))
            if statement == 'profit':
                values['基本每股收益(元/股)'] = {d: v for d, v in fields['indicators']['PERSHAREINDEX.s_fa_eps_basic'].items()
                    if d and start <= d <= end and v is not None}
            all_dates = sorted(set(dates) | {d for seq in values.values() for d in seq})
            save('finance_' + statement + '_' + code + '.json', {'type': 'finance', 'symbol': code,
                'statement': statement, 'unit': 'wan', 'currency': 'CNY', 'basis': 'cumulative',
                'reportDates': all_dates,
                'items': [{'name': name, 'vals': [seq.get(d) for d in all_dates]} for name, seq in values.items()]},
                {'primary': 'qmt:reported:wan', 'preservedFullPages': evidence})
        capital = sorted((d, v) for d, v in fields['capital']['CAPITALSTRUCTURE.total_capital'].items()
            if d and d <= end and v is not None)
        if any(not float(v).is_integer() or v <= 0 for _, v in capital):
            raise ValueError('CAPITALSTRUCTURE must contain integer actual shares')
        def asof(day):
            eligible = [int(v) for d, v in capital if d <= day]
            return eligible[-1] if eligible else None
        hist_items = []
        for target, label, field in [('npParent', 'profit', 'ASHAREINCOME.net_profit_excl_min_int_inc'),
                ('npTotal', 'profit', 'ASHAREINCOME.net_profit_incl_min_int_inc'),
                ('equityParent', 'balance', 'ASHAREBALANCESHEET.tot_shrhldr_eqy_excl_min_int')]:
            hist_items.append({'code': target, 'vals': [None if fields[label][field].get(d) is None else
                float(Decimal(str(fields[label][field][d])) / Decimal(10000)) for d in dates]})
        hist_items.append({'code': 'totalShares', 'vals': [asof(d) for d in dates]})
        save('financial_history_' + code + '.json', {'type': 'financial-history', 'symbol': code,
            'unit': 'wan', 'currency': 'CNY', 'shareUnit': 'shares', 'reportDates': dates, 'items': hist_items},
            'qmt:statements+actual-CAPITALSTRUCTURE')
        before = [(d, v) for d, v in capital if d < start]
        retained = before[-1:] + [(d, v) for d, v in capital if d >= start]
        save('share_history_' + code + '.json', {'type': 'share-history', 'symbol': symbol,
            'unit': 'shares', 'rows': [{'date': d, 'shares': int(v)} for d, v in retained]}, 'qmt:CAPITALSTRUCTURE')
        if args.dividend_evidence:
            for category, key, prop in [('dividend-plans', 'dividend-plans-v2', 'plans'),
                    ('dividend-impl', 'implemented-dividends-v4', 'rows')]:
                path = args.dividend_evidence / ('website_' + key + '_' + code + '.json')
                evidence = read(path)
                if evidence['key'] != key + ':' + code:
                    raise ValueError('Dividend evidence identity mismatch')
                save(category.replace('-', '_') + '_' + code + '.json', {'type': category, 'symbol': code,
                    prop: evidence['payload']}, {'original': evidence['source'], 'evidenceSha256': digest(path)})
        report['stocks'].append({'symbol': symbol, 'prices': len(raw['candles']), 'financialPeriods': len(dates),
            'latestActualShares': asof(end), 'listingDate': raw.get('listingDate')})
    (out / 'manifest.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), 'utf-8')
    with zipfile.ZipFile(out.with_suffix('.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
        for p in sorted(out.rglob('*')):
            if p.is_file():
                z.write(p, p.relative_to(out).as_posix())
    print(json.dumps({'files': len(report['files']), 'stocks': report['stocks'],
        'archiveBytes': out.with_suffix('.zip').stat().st_size, 'productionWritten': False}))


if __name__ == '__main__':
    main()
