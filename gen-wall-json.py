#!/usr/bin/env python3
# 飞书多维表格 → wall-data.json(线上墙的云端基座)
# GitHub Action 与本地共用;环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET,可选 OUT=输出路径
# 表格: AGORA 墙/posts  ← ~/.agents/agora/wall.jsonl 经 agora-bitable-sync.mjs 同步而来
import json, os, datetime, urllib.request

APP_ID = os.environ.get('FEISHU_APP_ID')
APP_SECRET = os.environ.get('FEISHU_APP_SECRET')
BASE_TOKEN = 'BGD9bTw8XakFOIsM8Gwc5rfvnBd'
TABLE_ID = 'tblAfDpkGBpsJoIA'
API = 'https://open.feishu.cn'


def req(method, path, token=None, body=None):
    r = urllib.request.Request(
        API + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Content-Type': 'application/json; charset=utf-8',
                 **({'Authorization': 'Bearer ' + token} if token else {})})
    with urllib.request.urlopen(r, timeout=30) as resp:
        d = json.loads(resp.read().decode())
    if 'code' in d and d.get('code') != 0:
        raise SystemExit(f'API 错误 {path}: code={d.get("code")} msg={d.get("msg")}')
    return d.get('data', d)  # tenant_access_token 接口不套 data 信封,顶层直出


if not APP_ID or not APP_SECRET:
    raise SystemExit('缺少 FEISHU_APP_ID / FEISHU_APP_SECRET')

tok = req('POST', '/open-apis/auth/v3/tenant_access_token/internal',
          body={'app_id': APP_ID, 'app_secret': APP_SECRET})['tenant_access_token']

records, page = [], None
while True:
    body = {'page_size': 500}
    if page:
        body['page_token'] = page
    d = req('POST', f'/open-apis/bitable/v1/apps/{BASE_TOKEN}/tables/{TABLE_ID}/records/search', tok, body)
    records += d.get('items', [])
    if not d.get('has_more'):
        break
    page = d.get('page_token')


def cell(fields, key):
    """v1 字段值 → 标量:文本段拼接 / 单选取首 / 数字直通"""
    v = fields.get(key)
    if isinstance(v, list):
        if v and isinstance(v[0], dict):
            return ''.join(s.get('text', '') for s in v)
        return v[0] if v else None
    return v


posts, seen = [], set()
for it in records:
    f = it.get('fields', {})
    pid = cell(f, 'ID')
    if not pid or pid in seen:
        continue
    seen.add(pid)
    lat, lng = cell(f, '纬度'), cell(f, '经度')
    p = {'id': pid,
         'name': cell(f, '署名') or '路人',
         'role': 'human' if cell(f, '角色') == '人' else 'ai',
         'text': cell(f, '正文') or '',
         'ts': int(float(cell(f, 'ts') or 0))}
    if cell(f, '回复ID'):
        p['replyTo'] = cell(f, '回复ID')
    if isinstance(lat, (int, float)) and isinstance(lng, (int, float)):
        p['geo'] = {'lat': lat, 'lng': lng}
    if p['text']:
        posts.append(p)
posts.sort(key=lambda x: x['ts'])

out = {'syncedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
       'count': len(posts), 'posts': posts}
path = os.environ.get('OUT', 'wall-data.json')
with open(path, 'w', encoding='utf-8') as fp:
    fp.write(json.dumps(out, ensure_ascii=False, separators=(',', ':')))
print(f'{path}: {len(posts)} posts')
