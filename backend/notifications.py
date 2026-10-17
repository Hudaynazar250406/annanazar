import asyncio, base64, contextlib, hashlib, json, logging, os, re
from contextlib import asynccontextmanager
from urllib.parse import urlparse
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization
from fastapi import Depends, HTTPException
from pydantic import BaseModel, Field
from pywebpush import webpush, WebPushException
import main as base
app=base.app
q=base.q
SOURCES={'chat':'messages','photos':'photos','memories':'memories','calendar':'events','wishes':'wishes','letters':'letters'}
TITLES={'chat':'Новое сообщение','photos':'Добавлено фото','memories':'Новое воспоминание','calendar':'Новое событие','wishes':'Новая идея','letters':'Письмо доступно для чтения'}
fernet=Fernet(base64.urlsafe_b64encode(hashlib.sha256(base.secret.encode()).digest()))
private_key=''
public_key=''
SCHEMA='''CREATE TABLE IF NOT EXISTS push_keys (id INT PRIMARY KEY, private TEXT NOT NULL, public TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notice_sources (kind TEXT PRIMARY KEY, baseline BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS notices (id BIGSERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, record_id BIGINT NOT NULL, seen BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(user_id,kind,record_id));
CREATE TABLE IF NOT EXISTS push_devices (endpoint TEXT PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), subscription TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS push_deliveries (notice_id BIGINT REFERENCES notices(id) ON DELETE CASCADE, endpoint TEXT REFERENCES push_devices(endpoint) ON DELETE CASCADE, done BOOLEAN NOT NULL DEFAULT FALSE, attempts INT NOT NULL DEFAULT 0, retry_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(notice_id,endpoint));
CREATE INDEX IF NOT EXISTS notices_unread_idx ON notices(user_id,seen,id)'''
VALID="(n.kind<>'chat' OR EXISTS(SELECT 1 FROM messages m WHERE m.id=n.record_id AND NOT m.deleted))"
def state(uid):
    rows=q('SELECT n.kind,count(*) AS count,max(n.id) AS last_id FROM notices n WHERE n.user_id=:u AND NOT n.seen AND '+VALID+' GROUP BY n.kind',{'u':uid})
    counts={k:0 for k in SOURCES}; limits={k:0 for k in SOURCES}
    for r in rows: counts[r['kind']]=r['count']; limits[r['kind']]=r['last_id']
    return {'counts':counts,'limits':limits,'total':sum(counts.values())}
def scan():
    for kind,table in SOURCES.items():
        extra=' AND NOT s.deleted' if kind=='chat' else ' AND s.opens_at<=now()' if kind=='letters' else ''
        recipient='u.id=s.recipient_id' if kind=='letters' else 'u.id<>s.user_id'
        q(f'INSERT INTO notices(user_id,kind,record_id) SELECT u.id,:k,s.id FROM {table} s CROSS JOIN users u WHERE s.id>(SELECT baseline FROM notice_sources WHERE kind=:k) AND {recipient}{extra} ON CONFLICT DO NOTHING',{'k':kind})
def safe_error(exc,subscription):
    response=getattr(exc,'response',None)
    code=response.status_code if response is not None else None
    provider=urlparse(subscription.get('endpoint','')).hostname or 'unknown'
    reason=''
    if response is not None:
        try:
            body=response.json()
            if isinstance(body,dict):
                reason=json.dumps({k:body[k] for k in ('reason','errno','code','error') if k in body},ensure_ascii=True)
        except Exception:
            reason=''
    if not reason or reason=='{}': reason=str(exc)
    secrets=[private_key,public_key,subscription.get('endpoint',''),*subscription.get('keys',{}).values(),base.secret,os.environ.get('DATABASE_URL','')]
    for value in secrets:
        if isinstance(value,str) and value: reason=reason.replace(value,'[redacted]')
    reason=re.sub(r'https?://[^\s<>"\x27]+','[url]',reason)
    reason=re.sub(r'[A-Za-z0-9_+/=-]{24,}','[redacted]',reason)
    reason=' '.join(reason.split())[:320]
    label='PUSH_HTTP_'+str(code) if code is not None else 'PUSH_LOCAL_'+type(exc).__name__
    hints={400:'Push-служба отклонила параметры запроса.',401:'Push-служба отклонила авторизацию VAPID.',403:'Push-служба отклонила доступ; требуется проверить VAPID и подписку.',404:'Подписка больше не найдена.',410:'Срок действия подписки закончился.',413:'Слишком большой push-пакет.',429:'Слишком много запросов к push-службе.'}
    hint=hints.get(code,'Ошибка отправки с сервера. Нужен код ниже.')
    logging.warning('Push diagnostic: %s provider=%s reason=%s',label,provider,reason)
    return f'{label} ({provider}). {hint} Детали: {reason}'
def send(subscription,payload):
    if not private_key or not public_key: raise RuntimeError('VAPID keys are not initialized')
    return webpush(subscription_info=subscription,data=json.dumps(payload,ensure_ascii=True),vapid_private_key=private_key,vapid_claims={'sub':os.environ.get('VAPID_SUBJECT','https://hudaynazar250406.github.io/annanazar/')},ttl=3600,timeout=10)
def dispatch():
    scan()
    q('INSERT INTO push_deliveries(notice_id,endpoint) SELECT n.id,d.endpoint FROM notices n JOIN push_devices d ON d.user_id=n.user_id WHERE NOT n.seen AND n.created_at>=d.created_at AND n.created_at>now()-interval \'24 hours\' ON CONFLICT DO NOTHING')
    deliveries=q('SELECT p.notice_id,p.endpoint,p.attempts,d.subscription,n.user_id,n.kind FROM push_deliveries p JOIN notices n ON n.id=p.notice_id JOIN push_devices d ON d.endpoint=p.endpoint WHERE NOT p.done AND NOT n.seen AND p.attempts<5 AND p.retry_at<=now() AND '+VALID+' ORDER BY p.notice_id LIMIT 10')
    for row in deliveries:
        p={'id':row['notice_id'],'e':row['endpoint']}
        subscription={}
        try:
            subscription=json.loads(row['subscription'])
            counts=state(row['user_id'])
            send(subscription,{'title':'Anna & Nazar','body':TITLES[row['kind']],'section':row['kind'],'tag':'anna-nazar-'+row['kind'],'badge':counts['total']})
            q('UPDATE push_deliveries SET done=TRUE WHERE notice_id=:id AND endpoint=:e',p)
        except Exception as exc:
            safe_error(exc,subscription)
            response=getattr(exc,'response',None)
            code=response.status_code if response is not None else 0
            if code in (404,410): q('DELETE FROM push_devices WHERE endpoint=:e',{'e':row['endpoint']})
            else: q('UPDATE push_deliveries SET attempts=attempts+1,retry_at=now()+interval \'1 minute\' WHERE notice_id=:id AND endpoint=:e',p)
async def worker():
    while True:
        try: await asyncio.to_thread(dispatch)
        except Exception as exc: logging.warning('Notification worker iteration failed: %s',type(exc).__name__)
        await asyncio.sleep(3)
old_lifespan=app.router.lifespan_context
@asynccontextmanager
async def lifespan(app):
    global private_key,public_key
    async with old_lifespan(app):
        with base.engine.begin() as connection:
            for statement in SCHEMA.split(';'):
                if statement.strip(): connection.execute(base.text(statement))
        key=ec.generate_private_key(ec.SECP256R1())
        private=base64.b64encode(key.private_bytes(serialization.Encoding.DER,serialization.PrivateFormat.PKCS8,serialization.NoEncryption())).decode()
        public=base64.urlsafe_b64encode(key.public_key().public_bytes(serialization.Encoding.X962,serialization.PublicFormat.UncompressedPoint)).rstrip(b'=').decode()
        q('INSERT INTO push_keys VALUES(1,:a,:b) ON CONFLICT DO NOTHING',{'a':fernet.encrypt(private.encode()).decode(),'b':public})
        saved=q('SELECT private,public FROM push_keys WHERE id=1')[0]
        private_key=fernet.decrypt(saved['private'].encode()).decode(); public_key=saved['public']
        for kind,table in SOURCES.items(): q(f'INSERT INTO notice_sources SELECT :k,COALESCE(max(id),0) FROM {table} ON CONFLICT DO NOTHING',{'k':kind})
        task=asyncio.create_task(worker())
        try: yield
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError): await task
app.router.lifespan_context=lifespan
@app.get('/api/notifications/status')
def status(u=Depends(base.user)):
    data=state(u['id'])
    data['items']=q('SELECT n.id,n.kind,n.seen,n.created_at FROM notices n WHERE n.user_id=:u AND '+VALID+' ORDER BY n.id DESC LIMIT 30',{'u':u['id']})
    data['public_key']=public_key
    data['diagnostics_version']=1
    return data
class Read(BaseModel):
    kind:str
    until:int=Field(ge=0)
@app.post('/api/notifications/read')
def read(b:Read,u=Depends(base.user)):
    if b.kind not in SOURCES: raise HTTPException(400)
    q('UPDATE notices SET seen=TRUE WHERE user_id=:u AND kind=:k AND id<=:n',{'u':u['id'],'k':b.kind,'n':b.until})
    return state(u['id'])
class Device(BaseModel):
    endpoint:str=Field(max_length=2000)
    keys:dict[str,str]
def validate(b):
    url=urlparse(b.endpoint); host=url.hostname or ''
    allowed=host in ('fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com') or host.endswith('.push.apple.com') or host.endswith('.notify.windows.com')
    try: valid_port=url.port in (None,443)
    except ValueError: valid_port=False
    if url.scheme!='https' or not allowed or url.username or url.password or not valid_port: raise HTTPException(400,'Неподдерживаемая служба push')
    try:
        decode=lambda s:base64.urlsafe_b64decode(s+'='*((4-len(s)%4)%4))
        if len(decode(b.keys['p256dh']))!=65 or len(decode(b.keys['auth']))!=16: raise ValueError()
    except Exception: raise HTTPException(400,'Некорректная подписка')
@app.post('/api/notifications/device')
def register(b:Device,u=Depends(base.user)):
    validate(b)
    existing=q('SELECT user_id FROM push_devices WHERE endpoint=:e',{'e':b.endpoint})
    if not existing and q('SELECT count(*) AS n FROM push_devices WHERE user_id=:u',{'u':u['id']})[0]['n']>=10: raise HTTPException(400,'Максимум 10 устройств')
    if existing and existing[0]['user_id']!=u['id']: q('DELETE FROM push_devices WHERE endpoint=:e',{'e':b.endpoint})
    q('INSERT INTO push_devices(endpoint,user_id,subscription) VALUES(:e,:u,:s) ON CONFLICT(endpoint) DO UPDATE SET subscription=EXCLUDED.subscription',{'e':b.endpoint,'u':u['id'],'s':json.dumps(b.model_dump())})
    return {'ok':True}
class Endpoint(BaseModel):
    endpoint:str=Field(max_length=2000)
@app.post('/api/notifications/disable')
def disable(b:Endpoint,u=Depends(base.user)):
    q('DELETE FROM push_devices WHERE endpoint=:e AND user_id=:u',{'e':b.endpoint,'u':u['id']}); return {'ok':True}
@app.post('/api/notifications/test')
def test(b:Endpoint,u=Depends(base.user)):
    rows=q('SELECT subscription FROM push_devices WHERE endpoint=:e AND user_id=:u',{'e':b.endpoint,'u':u['id']})
    if not rows: raise HTTPException(404,'Сначала включите уведомления')
    subscription={}
    try:
        subscription=json.loads(rows[0]['subscription'])
        response=send(subscription,{'title':'Anna & Nazar','body':'Тестовое уведомление: подключение работает','section':'chat','badge':state(u['id'])['total'],'tag':'anna-nazar-test'})
    except Exception as exc: raise HTTPException(502,safe_error(exc,subscription)) from None
    return {'ok':True,'provider_status':response.status_code,'diagnostics_version':1}
