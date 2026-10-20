import asyncio, contextlib, datetime as dt, json, logging, os
from contextlib import asynccontextmanager
from fastapi import Depends, HTTPException
from pydantic import BaseModel, Field
import vault as vt
import notifications as nt
import main as base
app=vt.app
q=base.q
FIRST_MEETING=dt.date(2026,7,31)
SERVICE=os.environ.get('FCM_SERVICE_ACCOUNT_JSON','').strip()
INFO=None
if SERVICE:
    try: INFO=json.loads(SERVICE)
    except Exception: logging.warning('FCM_SERVICE_ACCOUNT_JSON is not valid JSON')
SCHEMA=['CREATE TABLE IF NOT EXISTS fcm_tokens (token TEXT PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT now())',
'CREATE TABLE IF NOT EXISTS fcm_deliveries (notice_id BIGINT REFERENCES notices(id) ON DELETE CASCADE, token TEXT REFERENCES fcm_tokens(token) ON DELETE CASCADE, done BOOLEAN NOT NULL DEFAULT FALSE, attempts INT NOT NULL DEFAULT 0, retry_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(notice_id,token))']
def setup():
    for statement in SCHEMA: q(statement)
    q('UPDATE couple_settings SET first_meeting=:d WHERE id=1',{'d':FIRST_MEETING})
old_lifespan=app.router.lifespan_context
@asynccontextmanager
async def lifespan(a):
    async with old_lifespan(a):
        await asyncio.to_thread(setup)
        yield
app.router.lifespan_context=lifespan
app.router.routes=[r for r in app.router.routes if not (getattr(r,'path',None)=='/api/settings' and 'PUT' in (getattr(r,'methods',None) or set()))]
@app.put('/api/settings')
def locked_settings(u=Depends(base.user)):
    raise HTTPException(403,'Дата первой встречи зафиксирована')
_cred=None
def bearer():
    global _cred
    import google.auth.transport.requests as transport
    from google.oauth2 import service_account
    if _cred is None: _cred=service_account.Credentials.from_service_account_info(INFO,scopes=['https://www.googleapis.com/auth/firebase.messaging'])
    if not _cred.valid: _cred.refresh(transport.Request())
    return _cred.token
def send_fcm(token,kind,count):
    import requests
    body={'message':{'token':token,'notification':{'title':'Anna & Nazar','body':nt.TITLES[kind]},'data':{'section':kind},'android':{'priority':'HIGH','notification':{'tag':'anna-nazar-'+kind,'notification_count':max(0,min(int(count),99)),'icon':'ic_stat_heart','color':'#B75B87'}}}}
    return requests.post(f'https://fcm.googleapis.com/v1/projects/{INFO["project_id"]}/messages:send',headers={'Authorization':'Bearer '+bearer()},json=body,timeout=10)
def bump(p):
    q("UPDATE fcm_deliveries SET attempts=attempts+1,retry_at=now()+interval '1 minute' WHERE notice_id=:id AND token=:t",p)
def fcm_dispatch():
    if not INFO: return
    q("INSERT INTO fcm_deliveries(notice_id,token) SELECT n.id,t.token FROM notices n JOIN fcm_tokens t ON t.user_id=n.user_id WHERE NOT n.seen AND n.created_at>=t.created_at AND n.created_at>now()-interval '24 hours' AND "+nt.VALID+" ON CONFLICT DO NOTHING")
    rows=q('SELECT p.notice_id,p.token,n.user_id,n.kind FROM fcm_deliveries p JOIN notices n ON n.id=p.notice_id WHERE NOT p.done AND NOT n.seen AND p.attempts<5 AND p.retry_at<=now() AND '+nt.VALID+' ORDER BY p.notice_id LIMIT 10')
    for row in rows:
        p={'id':row['notice_id'],'t':row['token']}
        try:
            resp=send_fcm(row['token'],row['kind'],nt.state(row['user_id'])['total'])
            if resp.status_code==200: q('UPDATE fcm_deliveries SET done=TRUE WHERE notice_id=:id AND token=:t',p)
            elif resp.status_code==404 or 'UNREGISTERED' in (resp.text or ''): q('DELETE FROM fcm_tokens WHERE token=:t',{'t':row['token']})
            else:
                bump(p); logging.warning('FCM delivery failed, status=%s',resp.status_code)
        except Exception:
            bump(p); logging.warning('FCM delivery failed; retry scheduled')
original_dispatch=nt.dispatch
def combined_dispatch():
    original_dispatch()
    try: fcm_dispatch()
    except Exception: logging.warning('FCM dispatch failed')
nt.dispatch=combined_dispatch
class Token(BaseModel):
    token:str=Field(min_length=20,max_length=600)
@app.post('/api/notifications/fcm')
def fcm_register(b:Token,u=Depends(base.user)):
    q('INSERT INTO fcm_tokens(token,user_id) VALUES(:t,:u) ON CONFLICT(token) DO UPDATE SET created_at=CASE WHEN fcm_tokens.user_id<>EXCLUDED.user_id THEN now() ELSE fcm_tokens.created_at END, user_id=EXCLUDED.user_id',{'t':b.token,'u':u['id']})
    q('DELETE FROM fcm_tokens WHERE user_id=:u AND token NOT IN (SELECT token FROM fcm_tokens WHERE user_id=:u ORDER BY created_at DESC LIMIT 10)',{'u':u['id']})
    return {'ok':True,'enabled':INFO is not None}
