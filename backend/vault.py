import asyncio, base64, os
from contextlib import asynccontextmanager
from fastapi import Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import text
import media as md
import main as base
app=md.app
q=base.q
BUDGET=int(os.environ.get('VAULT_BUDGET_MB','200'))*1024*1024
MAX_DATA=6*1024*1024
MAX_THUMB=300*1024
HEADERS={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}
SCHEMA=['CREATE TABLE IF NOT EXISTS vault_meta (user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, salt TEXT NOT NULL, iters INT NOT NULL, check_blob TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())',
'CREATE TABLE IF NOT EXISTS vault_items (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, data BYTEA NOT NULL, thumb BYTEA NOT NULL, size INT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())',
'ALTER TABLE vault_items ALTER COLUMN data SET STORAGE EXTERNAL',
'CREATE INDEX IF NOT EXISTS vault_items_user_idx ON vault_items(user_id,id)']
def setup():
    for statement in SCHEMA: q(statement)
old_lifespan=app.router.lifespan_context
@asynccontextmanager
async def lifespan(a):
    async with old_lifespan(a):
        await asyncio.to_thread(setup)
        yield
app.router.lifespan_context=lifespan
class Meta(BaseModel):
    salt:str=Field(min_length=16,max_length=40)
    iters:int=Field(ge=300000,le=5000000)
    check:str=Field(min_length=24,max_length=240)
def b64len(value):
    try: return len(base64.b64decode(value,validate=True))
    except Exception: return -1
@app.get('/api/vault/meta')
def vault_meta(u=Depends(base.user)):
    rows=q('SELECT salt,iters,check_blob FROM vault_meta WHERE user_id=:u',{'u':u['id']})
    if not rows: return {'exists':False}
    r=rows[0]
    return {'exists':True,'salt':r['salt'],'iters':r['iters'],'check':r['check_blob']}
@app.put('/api/vault/meta')
def vault_create(b:Meta,u=Depends(base.user)):
    if b64len(b.salt)!=16 or b64len(b.check)<29: raise HTTPException(400,'Некорректные параметры раздела')
    rows=q('INSERT INTO vault_meta(user_id,salt,iters,check_blob) VALUES(:u,:s,:i,:c) ON CONFLICT DO NOTHING RETURNING user_id',{'u':u['id'],'s':b.salt,'i':b.iters,'c':b.check})
    if not rows: raise HTTPException(409,'Раздел уже создан')
    return {'ok':True}
@app.get('/api/vault/items')
def vault_list(u=Depends(base.user)):
    items=q('SELECT id,size,created_at FROM vault_items WHERE user_id=:u ORDER BY id DESC',{'u':u['id']})
    used=q('SELECT COALESCE(sum(size),0) AS n FROM vault_items')[0]['n']
    return {'items':items,'used':used,'budget':BUDGET}
def store(uid,data,thumb):
    with base.engine.begin() as c:
        if not c.execute(text('SELECT 1 FROM vault_meta WHERE user_id=:u'),{'u':uid}).first(): raise HTTPException(400,'Сначала создайте раздел')
        used=c.execute(text('SELECT COALESCE(sum(size),0) FROM vault_items')).scalar()
        if used+len(data)+len(thumb)>BUDGET: raise HTTPException(413,'Место для раздела закончилось')
        return c.execute(text('INSERT INTO vault_items(user_id,data,thumb,size) VALUES(:u,:d,:t,:s) RETURNING id'),{'u':uid,'d':data,'t':thumb,'s':len(data)+len(thumb)}).scalar()
@app.post('/api/vault/items')
async def vault_add(data:UploadFile=File(...),thumb:UploadFile=File(...),u=Depends(base.user)):
    d=await data.read(MAX_DATA+1); await data.close()
    t=await thumb.read(MAX_THUMB+1); await thumb.close()
    if len(d)>MAX_DATA or len(t)>MAX_THUMB: raise HTTPException(413,'Файл слишком большой')
    if len(d)<64 or len(t)<64: raise HTTPException(400,'Некорректные данные')
    return {'id':await asyncio.to_thread(store,u['id'],d,t)}
@app.get('/api/vault/items/{iid}/{kind}')
def vault_get(iid:int,kind:str,u=Depends(base.user)):
    if kind not in ('data','thumb'): raise HTTPException(404,'Не найдено')
    rows=q(f'SELECT {kind} AS part FROM vault_items WHERE id=:i AND user_id=:u',{'i':iid,'u':u['id']})
    if not rows: raise HTTPException(404,'Не найдено')
    return Response(bytes(rows[0]['part']),media_type='application/octet-stream',headers=HEADERS)
@app.delete('/api/vault/items/{iid}')
def vault_delete(iid:int,u=Depends(base.user)):
    rows=q('DELETE FROM vault_items WHERE id=:i AND user_id=:u RETURNING id',{'i':iid,'u':u['id']})
    if not rows: raise HTTPException(404,'Не найдено')
    return {'ok':True}
@app.delete('/api/vault')
def vault_wipe(u=Depends(base.user)):
    q('DELETE FROM vault_items WHERE user_id=:u',{'u':u['id']})
    q('DELETE FROM vault_meta WHERE user_id=:u',{'u':u['id']})
    return {'ok':True}
