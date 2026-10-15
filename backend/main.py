import os, io, asyncio, datetime as dt
from pathlib import Path
from contextlib import asynccontextmanager
import bcrypt, jwt
from fastapi import FastAPI, Depends, Header, HTTPException, WebSocket, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import create_engine, text
from PIL import Image, ImageOps
from phrases import PHRASES
url=os.environ['DATABASE_URL']
for prefix in ('postgres://','postgresql://'):
    if url.startswith(prefix): url=url.replace(prefix,'postgresql+psycopg://',1)
engine=create_engine(url,pool_pre_ping=True)
secret=os.environ['JWT_SECRET']
origins=[x.strip() for x in os.environ.get('FRONTEND_ORIGIN','http://localhost:5173').split(',')]
clients={}
def q(sql,p=None):
    with engine.begin() as c:
        r=c.execute(text(sql),p or {})
        return [dict(x) for x in r.mappings()] if r.returns_rows else []
@asynccontextmanager
async def life(app):
    for filename in ('schema.sql','v2.sql'):
        with engine.begin() as c:
            for sql in Path(__file__).with_name(filename).read_text(encoding='utf-8').split(';'):
                if sql.strip(): c.execute(text(sql))
    for login,name,env in [('nazar','Назар','NAZAR_PASSWORD'),('anna','Анна','ANNA_PASSWORD')]:
        pw=os.environ[env].encode()
        if not 1<=len(pw)<=72: raise RuntimeError('Password must contain 1..72 UTF-8 bytes')
        q('INSERT INTO users(login,name,password_hash) VALUES(:l,:n,:h) ON CONFLICT(login) DO UPDATE SET password_hash=EXCLUDED.password_hash',{'l':login,'n':name,'h':bcrypt.hashpw(pw,bcrypt.gensalt()).decode()})
    for lang,phrase in PHRASES: q('INSERT INTO phrases(lang,text) VALUES(:l,:t) ON CONFLICT DO NOTHING',{'l':lang,'t':phrase})
    yield
    engine.dispose()
app=FastAPI(lifespan=life)
app.add_middleware(CORSMiddleware,allow_origins=origins,allow_methods=['*'],allow_headers=['*'])
@app.middleware('http')
async def no_cache(req,call):
    r=await call(req)
    if req.url.path.startswith('/api/'): r.headers['Cache-Control']='no-store'
    return r
def from_token(token):
    try: uid=int(jwt.decode(token,secret,algorithms=['HS256'])['sub'])
    except Exception: raise HTTPException(401,'Войдите снова')
    rows=q('SELECT id,name,login FROM users WHERE id=:id',{'id':uid})
    if not rows: raise HTTPException(401,'Войдите снова')
    return rows[0]
def user(authorization:str=Header(default='')):
    if not authorization.startswith('Bearer '): raise HTTPException(401,'Войдите снова')
    return from_token(authorization[7:])
def own(table,rid,u):
    rows=q(f'SELECT * FROM {table} WHERE id=:id',{'id':rid})
    if not rows: raise HTTPException(404,'Не найдено')
    if rows[0]['user_id']!=u['id']: raise HTTPException(403,'Можно менять только свои записи')
    return rows[0]
async def broadcast(data):
    for ws in list(clients):
        try: await ws.send_json(data)
        except Exception: clients.pop(ws,None)
class Login(BaseModel):
    login:str
    password:str=Field(max_length=100)
@app.post('/api/login')
def login(b:Login):
    rows=q('SELECT * FROM users WHERE login=:l',{'l':b.login.strip().lower()})
    pw=b.password.encode()
    if len(pw)>72 or not rows or not bcrypt.checkpw(pw,rows[0]['password_hash'].encode()): raise HTTPException(401,'Неверный логин или пароль')
    return {'token':jwt.encode({'sub':str(rows[0]['id']),'exp':dt.datetime.now(dt.timezone.utc)+dt.timedelta(days=7)},secret,algorithm='HS256')}
@app.get('/api/health')
def health(): return {'ok':True,'version':2}
@app.get('/api/me')
def me(u=Depends(user)): return u
@app.get('/api/users')
def users(u=Depends(user)): return q('SELECT id,name FROM users ORDER BY id')
@app.get('/api/phrase')
def phrase(lang:str='ru'):
    return q('SELECT text FROM phrases WHERE lang=:l ORDER BY random() LIMIT 1',{'l':'en' if lang=='en' else 'ru'})[0]
@app.get('/api/settings')
def settings(u=Depends(user)): return q('SELECT first_meeting FROM couple_settings WHERE id=1')[0]
class Settings(BaseModel):
    first_meeting:dt.date
@app.put('/api/settings')
def setting(b:Settings,u=Depends(user)):
    q('UPDATE couple_settings SET first_meeting=:d WHERE id=1',{'d':b.first_meeting}); return {'ok':True}
@app.get('/api/messages')
def messages(u=Depends(user)):
    return q('SELECT m.*,u.name FROM messages m JOIN users u ON u.id=m.user_id ORDER BY m.id DESC LIMIT 200')[::-1]
class Message(BaseModel):
    text:str=Field(min_length=1,max_length=2000)
@app.patch('/api/messages/{rid}')
async def edit_message(rid:int,b:Message,u=Depends(user)):
    row=own('messages',rid,u)
    if row['deleted'] or not b.text.strip(): raise HTTPException(400,'Нельзя изменить сообщение')
    q('UPDATE messages SET text=:t,edited=TRUE WHERE id=:id',{'t':b.text.strip(),'id':rid})
    await broadcast({'type':'refresh'}); return {'ok':True}
@app.delete('/api/messages/{rid}')
async def delete_message(rid:int,u=Depends(user)):
    own('messages',rid,u)
    q("UPDATE messages SET text='',deleted=TRUE WHERE id=:id",{'id':rid})
    q("DELETE FROM reactions WHERE target='messages' AND target_id=:id",{'id':rid})
    await broadcast({'type':'refresh'}); return {'ok':True}
@app.websocket('/ws')
async def chat(ws:WebSocket):
    if ws.headers.get('origin') not in origins: await ws.close(code=4403); return
    await ws.accept()
    try:
        auth=await asyncio.wait_for(ws.receive_json(),timeout=15)
        u=from_token(auth.get('token',''))
        exp=jwt.decode(auth['token'],secret,algorithms=['HS256'])['exp']
        clients[ws]=u['id']; await ws.send_json({'type':'ready'})
        while True:
            b=await ws.receive_json()
            if dt.datetime.now(dt.timezone.utc).timestamp()>=exp: await ws.close(code=4401); break
            if b.get('type')=='typing': await broadcast({'type':'typing','user_id':u['id'],'name':u['name']})
            elif b.get('type')=='message' and isinstance(b.get('text'),str) and 0<len(b['text'].strip())<=2000:
                q('INSERT INTO messages(user_id,text) VALUES(:u,:t)',{'u':u['id'],'t':b['text'].strip()}); await broadcast({'type':'refresh'})
    except HTTPException:
        await ws.close(code=4401)
    except Exception:
        pass
    finally:
        clients.pop(ws,None)
        try: await ws.close()
        except RuntimeError: pass
@app.get('/api/photos')
def photos(u=Depends(user)): return q('SELECT p.id,p.user_id,p.caption,u.name FROM photos p JOIN users u ON u.id=p.user_id ORDER BY p.id DESC')
@app.post('/api/photos')
async def upload(file:UploadFile=File(...),caption:str=Form(''),u=Depends(user)):
    data=await file.read(15*1024*1024+1); await file.close()
    if len(data)>15*1024*1024: raise HTTPException(413,'Максимум 15 МБ')
    try:
        with Image.open(io.BytesIO(data)) as im:
            if im.width*im.height>30000000: raise ValueError()
            image=ImageOps.exif_transpose(im).convert('RGB')
    except Exception: raise HTTPException(400,'Нужно изображение до 30 мегапикселей')
    def encode(size):
        im=image.copy(); im.thumbnail((size,size)); b=io.BytesIO(); im.save(b,'JPEG',quality=82); return b.getvalue()
    return q('INSERT INTO photos(user_id,caption,data,thumb) VALUES(:u,:c,:d,:t) RETURNING id',{'u':u['id'],'c':caption[:300],'d':encode(1600),'t':encode(480)})[0]
@app.get('/api/photos/{rid}/{kind}')
def photo(rid:int,kind:str,u=Depends(user)):
    if kind not in ('thumb','full'): raise HTTPException(404)
    col='thumb' if kind=='thumb' else 'data'; rows=q(f'SELECT {col} FROM photos WHERE id=:id',{'id':rid})
    if not rows: raise HTTPException(404)
    return Response(bytes(rows[0][col]),media_type='image/jpeg')
@app.delete('/api/photos/{rid}')
def remove_photo(rid:int,u=Depends(user)):
    own('photos',rid,u); q('DELETE FROM photos WHERE id=:id',{'id':rid}); q("DELETE FROM reactions WHERE target='photos' AND target_id=:id",{'id':rid}); return {'ok':True}
class Event(BaseModel):
    title:str=Field(min_length=1,max_length=200)
    day:dt.date
    annual:bool=False
class Memory(BaseModel):
    title:str=Field(min_length=1,max_length=200)
    body:str=Field(max_length=10000)
    day:dt.date
    photo_id:int|None=None
class Wish(BaseModel):
    title:str=Field(min_length=1,max_length=200)
    category:str=Field(min_length=1,max_length=80)
models={'events':Event,'memories':Memory,'wishes':Wish}
def kind_check(kind):
    if kind not in models: raise HTTPException(404)
@app.get('/api/collections/{kind}')
def collection(kind:str,u=Depends(user)):
    kind_check(kind); return q(f'SELECT t.*,u.name FROM {kind} t JOIN users u ON u.id=t.user_id ORDER BY t.id DESC')
def save_record(kind,b,u,rid=None):
    kind_check(kind)
    try: p=models[kind].model_validate(b).model_dump()
    except ValueError: raise HTTPException(422,'Проверьте поля формы')
    if not p['title'].strip(): raise HTTPException(422,'Введите название')
    if kind=='memories' and p['photo_id'] is not None and not q('SELECT id FROM photos WHERE id=:id',{'id':p['photo_id']}): raise HTTPException(400,'Фото уже удалено')
    if rid:
        own(kind,rid,u); assignments=','.join(k+'=:'+k for k in p); p['id']=rid; q(f'UPDATE {kind} SET {assignments} WHERE id=:id',p); return {'id':rid}
    p['user_id']=u['id']; cols=','.join(p); args=','.join(':'+k for k in p)
    return q(f'INSERT INTO {kind}({cols}) VALUES({args}) RETURNING id',p)[0]
@app.post('/api/collections/{kind}')
def add_record(kind:str,b:dict,u=Depends(user)): return save_record(kind,b,u)
@app.put('/api/collections/{kind}/{rid}')
def edit_record(kind:str,rid:int,b:dict,u=Depends(user)): return save_record(kind,b,u,rid)
@app.delete('/api/collections/{kind}/{rid}')
def delete_record(kind:str,rid:int,u=Depends(user)):
    kind_check(kind); own(kind,rid,u); q(f'DELETE FROM {kind} WHERE id=:id',{'id':rid}); return {'ok':True}
class Done(BaseModel):
    done:bool
@app.patch('/api/wishes/{rid}')
def done(rid:int,b:Done,u=Depends(user)):
    rows=q('UPDATE wishes SET done=:d WHERE id=:id RETURNING id',{'d':b.done,'id':rid})
    if not rows: raise HTTPException(404)
    return rows[0]
class Letter(BaseModel):
    title:str=Field(min_length=1,max_length=200)
    body:str=Field(min_length=1,max_length=20000)
    recipient_id:int
    opens_at:dt.datetime
@app.get('/api/letters')
def letters(u=Depends(user)):
    return q('SELECT l.id,l.user_id,l.recipient_id,l.title,l.opens_at,u.name,l.opens_at<=now() AS unlocked, CASE WHEN l.user_id=:u OR l.opens_at<=now() THEN l.body ELSE NULL END AS body FROM letters l JOIN users u ON u.id=l.user_id WHERE (l.user_id=:u OR l.recipient_id=:u) AND NOT EXISTS(SELECT 1 FROM letter_hidden h WHERE h.letter_id=l.id AND h.user_id=:u) ORDER BY l.opens_at DESC',{'u':u['id']})
def letter_params(b,u):
    if b.opens_at.tzinfo is None or b.opens_at<=dt.datetime.now(dt.timezone.utc): raise HTTPException(400,'Выберите будущее время')
    if b.recipient_id==u['id'] or not q('SELECT id FROM users WHERE id=:id',{'id':b.recipient_id}): raise HTTPException(400,'Выберите получателя')
    return b.model_dump()
@app.post('/api/letters')
def add_letter(b:Letter,u=Depends(user)):
    p=letter_params(b,u); p['user_id']=u['id']; return q('INSERT INTO letters(user_id,recipient_id,title,body,opens_at) VALUES(:user_id,:recipient_id,:title,:body,:opens_at) RETURNING id',p)[0]
@app.put('/api/letters/{rid}')
def edit_letter(rid:int,b:Letter,u=Depends(user)):
    own('letters',rid,u); p=letter_params(b,u); p['id']=rid
    rows=q('UPDATE letters SET title=:title,body=:body,recipient_id=:recipient_id,opens_at=:opens_at WHERE id=:id AND opens_at>now() RETURNING id',p)
    if not rows: raise HTTPException(409,'Письмо уже доставлено')
    return rows[0]
@app.delete('/api/letters/{rid}')
def delete_letter(rid:int,u=Depends(user)):
    p={'id':rid,'u':u['id']}
    if not q('SELECT id FROM letters WHERE id=:id AND (user_id=:u OR recipient_id=:u)',p): raise HTTPException(404)
    with engine.begin() as c:
        row=c.execute(text('DELETE FROM letters WHERE id=:id AND user_id=:u AND opens_at>now() RETURNING id'),p).first()
        if not row: c.execute(text('INSERT INTO letter_hidden VALUES(:id,:u) ON CONFLICT DO NOTHING'),p)
    return {'ok':True}
@app.get('/api/reactions')
def reactions(u=Depends(user)): return q('SELECT * FROM reactions')
class Reaction(BaseModel):
    emoji:str
@app.post('/api/reactions/{target}/{rid}')
async def react(target:str,rid:int,b:Reaction,u=Depends(user)):
    if target not in ('messages','photos') or b.emoji not in ('❤️','🥰','😂','😍','🫂'): raise HTTPException(400)
    rows=q(f'SELECT * FROM {target} WHERE id=:id',{'id':rid})
    if not rows or (target=='messages' and rows[0]['deleted']): raise HTTPException(404)
    p={'t':target,'id':rid,'u':u['id'],'e':b.emoji}
    with engine.begin() as c:
        old=c.execute(text('SELECT emoji FROM reactions WHERE target=:t AND target_id=:id AND user_id=:u'),p).first()
        if old and old[0]==b.emoji: c.execute(text('DELETE FROM reactions WHERE target=:t AND target_id=:id AND user_id=:u'),p)
        else: c.execute(text('INSERT INTO reactions VALUES(:t,:id,:u,:e) ON CONFLICT(target,target_id,user_id) DO UPDATE SET emoji=EXCLUDED.emoji'),p)
    await broadcast({'type':'refresh'}); return {'ok':True}
