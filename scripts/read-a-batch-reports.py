"""Extract selected original-disclosure pages as evidence, not human verification."""
import io,json,re,hashlib,urllib.request,concurrent.futures,sys
from pathlib import Path
from pypdf import PdfReader
ROOT=Path(__file__).resolve().parent.parent
SUFFIX='-2' if '--batch=2' in sys.argv else ''
RAW=ROOT/('src/data/analyses/_raw/a-batch-500'+SUFFIX)
BATCH=json.loads((ROOT/('docs/a-research-batch-500'+SUFFIX+'.json')).read_text(encoding='utf-8'))
def one(target):
    code=target['code']; out=RAW/(code+'.pdf-evidence.json')
    if out.exists():
        old=json.loads(out.read_text(encoding='utf-8'))
        if old.get('identityMatched'): return code,'cached'
    raw=json.loads((RAW/(code+'.json')).read_text(encoding='utf-8'))
    reports=raw['reports']; result={'code':code,'identityMatched':False,'extractionOnly':True,'humanReviewed':False,'pages':[]}
    if not reports: return code,'no_report_catalog'
    report=reports[0]; result['source']=report
    try:
        req=urllib.request.Request(report['pdfUrl'],headers={'User-Agent':'Mozilla/5.0'})
        with urllib.request.urlopen(req,timeout=25) as r: content=r.read(35_000_001)
        if len(content)>35_000_000 or not content.startswith(b'%PDF'): raise ValueError('not an allowed PDF')
        reader=PdfReader(io.BytesIO(content),strict=False)
        result['sha256']=hashlib.sha256(content).hexdigest();result['pageCount']=len(reader.pages)
        for i in range(min(22,len(reader.pages))):
            text=reader.pages[i].extract_text() or ''
            result['pages'].append({'pdfPage':i+1,'text':text})
        import unicodedata
        normalize=lambda s: re.sub(r'[\s()（）·]','',unicodedata.normalize('NFKC',s))
        identity=normalize(''.join(p['text'] for p in result['pages']))
        full_name_matched=normalize(raw['profile']['ORG_NAME']) in identity
        short_name=normalize(re.sub(r'-[UW].*$','',target['name']))
        result['identityMatched']=(code in identity and (full_name_matched or short_name in identity)) or (report.get('kind')=='prospectus' and full_name_matched)
        result['identityCheck']={'fullLegalNameMatched':full_name_matched,'securityCodeInExtractedPages':code in identity,'catalogIssuerCode':raw['code']}
        if not result['identityMatched']:result['error']='issuer identity not confirmed in opening pages'
        out.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
        return code,'extracted' if result['identityMatched'] else 'identity_failed'
    except Exception as e:
        result['error']=str(e);out.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8');return code,'error: '+str(e)
if __name__=='__main__':
    counts={}
    with concurrent.futures.ProcessPoolExecutor(max_workers=4) as pool:
        for i,(code,status) in enumerate(pool.map(one,BATCH['companies']),1):
            counts[status]=counts.get(status,0)+1
            if i%25==0 or status not in ['cached','extracted']:print(json.dumps({'done':i,'code':code,'status':status,'counts':counts},ensure_ascii=False),flush=True)
    print(json.dumps(counts,ensure_ascii=False))
