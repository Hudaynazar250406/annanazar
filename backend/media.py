import asyncio, contextlib, hashlib, hmac, logging, os, re, time
from contextlib import asynccontextmanager
from fastapi import Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response
from sqlalchemy import text
import notifications as nt
import main as base
app=nt.app
q=base.q
LIMITS={'voice':(300,6*1024*1024),'circle':(60,25*1024*1024)}
MIMES={('voice','webm'):'audio/webm',('voice','mp4'):'audio/mp4',('voice','ogg'):'audio/ogg',('circle','webm'):'video/webm',('circle','mp4'):'video/mp4'}
BUDGET=int(os.environ.get('MEDIA_BUDGET_MB','500'))*1024*1024
CHUNK=1500000
SCHEMA=['CREATE TABLE IF NOT EXISTS media_files (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, mime TEXT NOT NULL, size INT NOT NULL, data BYTEA NOT NULL, poster BYTEA, created_at TIMESTAMPTZ NOT NULL DEFAULT now())',
'ALTER TABLE media_files ALTER COLUMN data SET STORAGE EXTERNAL',
"ALTER TABLE messages ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'text'",
'ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_id INT REFERENCES media_files(id) ON DELETE SET NULL',
'ALTER TABLE messages ADD COLUMN IF NOT EXISTS duration_ms INT',
'ALTER TABLE messages ADD COLUMN IF NOT EXISTS waveform TEXT',
'CREATE INDEX IF NOT EXISTS messages_media_idx ON messages(media_id)']
def setup():
    for statement in SCHEMA: q(statement)
def purge():
    q("DELETE FROM media_files f WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.media_id=f.id AND NOT m.deleted) AND f.created_at<now()-interval '10 minutes'")
async def janitor():
    while True:
        await asyncio.sleep(600)
        try: await asyncio.to_thread(purge)
        except Exception: logging.warning('Media purge failed')
old_lifespan=app.router.lifespan_context
@asynccontextmanager
async def lifespan(a):
    async with old_lifespan(a):
        await asyncio.to_thread(setup)
        task=asyncio.create_task(janitor())
        try: yield
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError): await task
app.router.lifespan_context=lifespan
def sniff(head):
    if head[:4]==b'\x1a\x45\xdf\xa3': return 'webm'
    if head[4:8]==b'ftyp': return 'mp4'
    if head[:4]==b'OggS': return 'ogg'
    return None
def sign(mid,uid,exp):
    return hmac.new(base.secret.encode(),f'media:{mid}:{uid}:{exp}'.encode(),hashlib.sha256).hexdigest()
def visible(mid):
    rows=q('SELECT f.mime,f.size FROM media_files f WHERE f.id=:i AND EXISTS(SELECT 1 FROM messages m WHERE m.media_id=f.id AND NOT m.deleted)',{'i':mid})
    if not rows: raise HTTPException(404,'Файл недоступен')
    return rows[0]
def store(uid,kind,mime,data,poster,duration,peaks):
    with base.engine.begin() as c:
        used=c.execute(text('SELECT COALESCE(sum(size),0) FROM media_files')).scalar()
        if used+len(data)>BUDGET: raise HTTPException(413,'Хранилище медиа заполнено. Удалите старые голосовые или кружки.')
        mid=c.execute(text('INSERT INTO media_files(user_id,kind,mime,size,data,poster) VALUES(:u,:k,:m,:s,:d,:p) RETURNING id'),{'u':uid,'k':kind,'m':mime,'s':len(data),'d':data,'p':poster}).scalar()
        return c.execute(text("INSERT INTO messages(user_id,text,kind,media_id,duration_ms,waveform) VALUES(:u,'',:k,:m,:d,:w) RETURNING id"),{'u':uid,'k':kind,'m':mid,'d':duration,'w':peaks}).scalar()
@app.post('/api/media/messages')
async def send_media(kind:str=Form(...),duration_ms:int=Form(...),peaks:str=Form(''),file:UploadFile=File(...),poster:UploadFile|None=File(None),u=Depends(base.user)):
    if kind not in LIMITS: raise HTTPException(400,'Неизвестный тип записи')
    seconds,max_bytes=LIMITS[kind]
    data=await file.read(max_bytes+1); await file.close()
    if len(data)>max_bytes: raise HTTPException(413,'Запись слишком большая')
    if len(data)<1024: raise HTTPException(400,'Запись слишком короткая')
    fmt=sniff(data[:12]); mime=MIMES.get((kind,fmt))
    if not mime: raise HTTPException(400,'Неподдерживаемый формат записи')
    duration=max(500,min(duration_ms,seconds*1000+1500))
    clean=peaks if peaks and re.fullmatch(r'\d{1,3}(,\d{1,3}){0,63}',peaks) and all(int(x)<=255 for x in peaks.split(',')) else ''
    picture=None
    if kind=='circle' and poster is not None:
        raw=await poster.read(120001); await poster.close()
        if len(raw)<=120000 and raw[:3]==b'\xff\xd8\xff': picture=raw
    msg=await asyncio.to_thread(store,u['id'],kind,mime,data,picture,duration,clean)
    await asyncio.to_thread(purge)
    await base.broadcast({'type':'refresh'})
    return {'id':msg}
@app.get('/api/media/usage')
def usage(u=Depends(base.user)):
    return {'used':q('SELECT COALESCE(sum(size),0) AS n FROM media_files')[0]['n'],'budget':BUDGET}
@app.get('/api/media/{mid}/access')
def media_access(mid:int,u=Depends(base.user)):
    visible(mid)
    exp=int(time.time())+1800
    return {'url':f'/media/stream/{mid}?uid={u["id"]}&exp={exp}&sig={sign(mid,u["id"],exp)}','expires':exp}
@app.get('/api/media/{mid}/poster')
def media_poster(mid:int,u=Depends(base.user)):
    visible(mid)
    rows=q('SELECT poster FROM media_files WHERE id=:i',{'i':mid})
    if not rows or rows[0]['poster'] is None: raise HTTPException(404,'Нет обложки')
    return Response(bytes(rows[0]['poster']),media_type='image/jpeg')
def byte_range(header,size):
    if not header: return 0,size-1,False
    m=re.fullmatch(r'bytes=(\d*)-(\d*)',header.strip())
    if not m or not (m.group(1) or m.group(2)): return 0,size-1,False
    if m.group(1)=='':
        start=max(0,size-int(m.group(2))); end=size-1
    else:
        start=int(m.group(1)); end=int(m.group(2)) if m.group(2) else size-1
    if start>=size or end<start: raise HTTPException(416,'Диапазон недоступен',headers={'Content-Range':f'bytes */{size}'})
    return start,min(end,size-1,start+CHUNK-1),True
@app.get('/media/stream/{mid}')
def stream(mid:int,request:Request,uid:int,exp:int,sig:str):
    if exp<time.time() or not hmac.compare_digest(sig,sign(mid,uid,exp)): raise HTTPException(403,'Ссылка устарела')
    if not q('SELECT 1 AS ok FROM users WHERE id=:u',{'u':uid}): raise HTTPException(403,'Нет доступа')
    info=visible(mid); size=info['size']
    start,end,partial=byte_range(request.headers.get('range'),size)
    rows=q('SELECT substr(data,:s,:l) AS part FROM media_files WHERE id=:i',{'s':start+1,'l':end-start+1,'i':mid})
    if not rows: raise HTTPException(404,'Файл недоступен')
    headers={'Accept-Ranges':'bytes','Cache-Control':'private, max-age=600','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'cross-origin'}
    if partial:
        headers['Content-Range']=f'bytes {start}-{end}/{size}'
        return Response(bytes(rows[0]['part']),206,headers,media_type=info['mime'])
    return Response(bytes(rows[0]['part']),200,headers,media_type=info['mime'])
