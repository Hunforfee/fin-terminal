#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""夸克网盘上传：本地文件 -> 夸克网盘（基于 QuarkManager 参考实现 + quark-drive skill 的登录态）。

流程: pre -> update/hash(秒传检测) -> 逐分片 auth+PUT -> complete auth+POST XML -> finish

用法:
  python3 quark_upload.py <本地文件> [目标目录fid] [--part-size MB]   上传（fid 缺省取 QUARK_DIR_FID）
  python3 quark_upload.py --check                                   校验 cookie 是否有效（0=有效 3=失效）
  python3 quark_upload.py prune <目录fid> <保留份数> [文件名前缀]      滚动保留（旧档进回收站，可恢复）

依赖 quark-drive skill 的 cookie（scripts/cookie.txt）；路径可用 QUARK_SKILL_SCRIPTS 覆盖。
cookie 失效时上传会失败——重跑 skill 的 get_cookie.py 扫码刷新即可。
"""
import base64
import ctypes
import hashlib
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

SCRIPTS = os.environ.get(
    "QUARK_SKILL_SCRIPTS",
    "/root/.codebuddy/skills/skill_2099415856622804992/quark-drive/scripts",
)
sys.path.insert(0, SCRIPTS)
import quark_api as q  # noqa: E402  （复用 cookie 与请求基础设施）

# 默认目标：夸克网盘 workbuddy 文件夹
DEFAULT_DIR_FID = os.environ.get(
    "QUARK_DIR_FID", "47bb20b4573b43d190ef9e64d0bcd7fc"
)

BASE = "https://drive-pc.quark.cn/1/clouddrive/"
PARAMS = {"pr": "ucpro", "fr": "pc", "uc_param_str": ""}
UA_MOBILE = "aliyun-sdk-js/1.0.0 Chrome Mobile 139.0.0.0 on Google Nexus 5 (Android 6.0)"
UA_PC = "aliyun-sdk-js/1.0.0 Chrome 139.0.0.0 on OS X 10.15.7 64-bit"
CHUNK = 4 * 1024 * 1024  # 4MB 分片

# ===== OpenSSL SHA1 中间态（x-oss-hash-ctx 用）=====
_libcrypto = ctypes.CDLL("libcrypto.so.3")


class _SHA1_CTX(ctypes.Structure):
    _fields_ = [("h0", ctypes.c_uint), ("h1", ctypes.c_uint), ("h2", ctypes.c_uint),
                ("h3", ctypes.c_uint), ("h4", ctypes.c_uint), ("Nl", ctypes.c_uint),
                ("Nh", ctypes.c_uint), ("data", ctypes.c_uint * 16),
                ("num", ctypes.c_uint), ("md_len", ctypes.c_uint)]


class Sha1State:
    """可快照的 SHA1：快照 = 已处理完整块后的中间态（h0-h4 + 位计数）。
    格式对齐 OSS x-oss-hash-ctx：{"hash_type":"sha1","h0":"..","Nl":"<已处理位数>",...}"""

    def __init__(self):
        self.ctx = _SHA1_CTX()
        self.nbytes = 0
        _libcrypto.SHA1_Init(ctypes.byref(self.ctx))

    def update(self, data):
        _libcrypto.SHA1_Update(ctypes.byref(self.ctx), data, len(data))
        self.nbytes += len(data)

    def snapshot_b64(self):
        snap = _SHA1_CTX()
        ctypes.memmove(ctypes.byref(snap), ctypes.byref(self.ctx),
                       ctypes.sizeof(_SHA1_CTX))
        bits = self.nbytes * 8
        d = {"hash_type": "sha1",
             "h0": str(snap.h0), "h1": str(snap.h1), "h2": str(snap.h2),
             "h3": str(snap.h3), "h4": str(snap.h4),
             "Nl": str(bits & 0xFFFFFFFF), "Nh": str(bits >> 32),
             "data": "", "num": "0"}
        return base64.b64encode(
            json.dumps(d, separators=(",", ":")).encode()).decode()


def api_post(path, body, params=None):
    """走 skill 的 call（带 cookie/风控头），返回完整 JSON。
    注意：query 参数 pr/fr/uc_param_str 必须带——不带会被服务端判为 guest。"""
    url = BASE + path + "?pr=ucpro&fr=pc&uc_param_str="
    return q.call(url, body)


def file_hashes(path):
    md5, sha1 = hashlib.md5(), hashlib.sha1()
    with open(path, "rb") as f:
        while True:
            b = f.read(1024 * 1024)
            if not b:
                break
            md5.update(b)
            sha1.update(b)
    return md5.hexdigest(), sha1.hexdigest()


def pre_upload(name, size, mime, pdir_fid):
    now = int(time.time() * 1000)
    body = {"ccp_hash_update": True, "parallel_upload": True, "pdir_fid": pdir_fid,
            "dir_name": "", "size": size, "file_name": name, "format_type": mime,
            "l_updated_at": now, "l_created_at": now}
    r = api_post("file/upload/pre", body, PARAMS)
    d = (r.get("data") or {})
    print(f"  pre: status={r.get('status')} code={r.get('code')} msg={r.get('message')} "
          f"task_id={d.get('task_id')} bucket={d.get('bucket')} obj_key={str(d.get('obj_key'))[:40]}...")
    if not d.get("task_id"):
        raise RuntimeError(f"预上传失败: {json.dumps(r, ensure_ascii=False)[:300]}")
    return d


def update_hash(task_id, md5, sha1):
    r = api_post("file/update/hash", {"task_id": task_id, "md5": md5, "sha1": sha1}, PARAMS)
    print(f"  update/hash: status={r.get('status')} code={r.get('code')} msg={r.get('message')} "
          f"data={json.dumps(r.get('data') or {}, ensure_ascii=False)[:200]}")
    return r


def part_auth(task_id, auth_info, upload_id, obj_key, bucket, mime, part_number, hash_ctx=""):
    oss_date = datetime.now(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S GMT")
    meta = (f"PUT\n\n{mime}\n{oss_date}\nx-oss-date:{oss_date}\n"
            f"x-oss-user-agent:{UA_MOBILE}\n"
            f"/{bucket}/{obj_key}?partNumber={part_number}&uploadId={upload_id}")
    if hash_ctx:
        meta = meta.replace(f"x-oss-user-agent:{UA_MOBILE}",
                            f"x-oss-hash-ctx:{hash_ctx}\nx-oss-user-agent:{UA_MOBILE}")
    r = api_post("file/upload/auth", {"task_id": task_id, "auth_info": auth_info, "auth_meta": meta})
    d = r.get("data") or {}
    auth_key = d.get("auth_key", "")
    if not auth_key:
        raise RuntimeError(f"分片{part_number}授权失败: {json.dumps(r, ensure_ascii=False)[:300]}")
    url = f"https://{bucket}.pds.quark.cn/{obj_key}?partNumber={part_number}&uploadId={upload_id}"
    headers = {"Content-Type": mime, "x-oss-date": oss_date, "x-oss-user-agent": UA_MOBILE,
               "authorization": auth_key}
    if hash_ctx:
        headers["X-Oss-Hash-Ctx"] = hash_ctx
    return url, headers


def put_part(url, headers, data, part_number):
    r = requests.put(url, data=data, headers=headers, timeout=300)
    if r.status_code != 200:
        raise RuntimeError(f"分片{part_number} PUT失败: HTTP {r.status_code} {r.text[:200]}")
    etag = r.headers.get("etag", "").strip('"')
    if not etag:
        raise RuntimeError(f"分片{part_number} PUT成功但无ETag")
    return etag


def complete_auth(task_id, auth_info, upload_id, obj_key, bucket, xml_data, callback_info):
    oss_date = datetime.now(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S GMT")
    xml_md5 = base64.b64encode(hashlib.md5(xml_data.encode()).digest()).decode()
    callback_b64 = base64.b64encode(
        json.dumps(callback_info, separators=(",", ":")).encode()).decode()
    meta = (f"POST\n{xml_md5}\napplication/xml\n{oss_date}\n"
            f"x-oss-callback:{callback_b64}\nx-oss-date:{oss_date}\n"
            f"x-oss-user-agent:{UA_PC}\n/{bucket}/{obj_key}?uploadId={upload_id}")
    r = api_post("file/upload/auth", {"task_id": task_id, "auth_info": auth_info, "auth_meta": meta})
    d = r.get("data") or {}
    auth_key = d.get("auth_key", "")
    if not auth_key:
        raise RuntimeError(f"合并授权失败: {json.dumps(r, ensure_ascii=False)[:300]}")
    url = f"https://{bucket}.pds.quark.cn/{obj_key}?uploadId={upload_id}"
    headers = {"Content-Type": "application/xml", "x-oss-date": oss_date,
               "x-oss-user-agent": UA_PC, "authorization": auth_key,
               "x-oss-callback": callback_b64, "Content-MD5": xml_md5}
    return url, headers


def finish_upload(task_id, obj_key):
    r = api_post("file/upload/finish", {"task_id": task_id, "obj_key": obj_key})
    print(f"  finish: status={r.get('status')} code={r.get('code')} msg={r.get('message')}")
    return r


def upload_file(path, pdir_fid="0", part_mb=4):
    path = Path(path)
    size = path.stat().st_size
    name = path.name
    mime = "application/gzip" if name.endswith(".gz") else "application/octet-stream"
    print(f"== 上传 {name} ({size:,} B) -> fid={pdir_fid}")

    md5, sha1 = file_hashes(path)
    print(f"  md5={md5} sha1={sha1}")

    pre = pre_upload(name, size, mime, pdir_fid)
    task_id = pre["task_id"]
    auth_info = pre.get("auth_info", "")
    upload_id = pre.get("upload_id", "")
    obj_key = pre.get("obj_key", "")
    bucket = pre.get("bucket") or "ul-zb"
    callback_info = pre.get("callback") or {}
    if not (upload_id and obj_key):
        raise RuntimeError(f"pre 响应缺 upload_id/obj_key: {json.dumps(pre, ensure_ascii=False)[:300]}")

    update_hash(task_id, md5, sha1)

    chunk = part_mb * 1024 * 1024
    parts = []
    remaining, pn = size, 1
    while remaining > 0:
        parts.append((pn, min(chunk, remaining)))
        remaining -= parts[-1][1]
        pn += 1
    print(f"  分片: {len(parts)} x {part_mb}MB")

    uploaded = []
    t0 = time.time()
    sha = Sha1State()  # 增量哈希：随分片推进，快照即下一分片的 hash-ctx
    with open(path, "rb") as f:
        for pn, psize in parts:
            data = f.read(psize)
            hash_ctx = sha.snapshot_b64() if pn > 1 else ""
            url, headers = part_auth(task_id, auth_info, upload_id, obj_key, bucket,
                                     mime, pn, hash_ctx=hash_ctx)
            etag = put_part(url, headers, data, pn)
            sha.update(data)
            uploaded.append((pn, etag))
            done = sum(p[1] for p in parts[:pn])
            el = time.time() - t0
            print(f"  分片 {pn}/{len(parts)}: {psize:,}B etag={etag[:16]}... "
                  f"进度 {done/size*100:.1f}% 耗时 {el:.0f}s", flush=True)

    xml_parts = "\n".join(f"<Part>\n<PartNumber>{pn}</PartNumber>\n<ETag>\"{etag}\"</ETag>\n</Part>"
                          for pn, etag in uploaded)
    xml = f'<?xml version="1.0" encoding="UTF-8"?>\n<CompleteMultipartUpload>\n{xml_parts}\n</CompleteMultipartUpload>'
    url, headers = complete_auth(task_id, auth_info, upload_id, obj_key, bucket, xml, callback_info)
    r = requests.post(url, data=xml.encode(), headers=headers, timeout=300)
    print(f"  complete POST: HTTP {r.status_code} {r.text[:120]}")
    if r.status_code not in (200, 203):
        raise RuntimeError(f"合并失败: HTTP {r.status_code} {r.text[:200]}")

    finish_upload(task_id, obj_key)
    print(f"== ✅ {name} 上传完成，总耗时 {time.time()-t0:.0f}s")
    return {"task_id": task_id, "obj_key": obj_key, "size": size}


def check_cookie():
    """校验 cookie 是否仍有效。返回进程退出码：0=有效，3=失效。"""
    try:
        used, total, pct = q.get_capacity()
    except Exception as e:
        print(f"COOKIE_INVALID\t{e}")
        return 3
    print(f"COOKIE_OK\t已用 {used:.1f}GB / {total:.0f}GB ({pct:.1f}%)")
    return 0


def prune(pdir_fid, keep, prefix=""):
    """滚动保留：按文件名倒序（名称含时间戳）保留前 keep 份，其余进回收站。"""
    entries, _ = q.list_dir(pdir_fid, page=1, size=500)
    files = [
        e for e in entries
        if not e.get("dir") and str(e.get("file_name", "")).startswith(prefix)
    ]
    files.sort(key=lambda e: e["file_name"], reverse=True)
    stale = files[keep:]
    if not stale:
        print(f"PRUNE\tnothing\t共 {len(files)} 份，保留 {keep}")
        return 0
    q.delete([e["fid"] for e in stale], to_trash=True)
    for e in stale:
        print(f"TRASHED\t{e['fid']}\t{e['file_name']}")
    print(f"PRUNE\tdone\t删除 {len(stale)} 份（回收站可恢复），保留 {len(files) - len(stale)} 份")
    return 0


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    part_mb = 4
    for a in sys.argv[1:]:
        if a.startswith("--part-size"):
            part_mb = int(a.split("=")[1]) if "=" in a else int(sys.argv[sys.argv.index(a) + 1])

    if "--check" in sys.argv[1:]:
        sys.exit(check_cookie())
    if args and args[0] == "prune":
        if len(args) < 3:
            print(__doc__)
            sys.exit(1)
        sys.exit(prune(args[1], int(args[2]), args[3] if len(args) > 3 else ""))

    if len(args) < 1:
        print(__doc__)
        sys.exit(1)
    pdir = args[1] if len(args) > 1 else DEFAULT_DIR_FID
    upload_file(args[0], pdir, part_mb)
