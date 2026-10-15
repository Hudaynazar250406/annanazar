import io
import os
import datetime as dt

import bcrypt
import jwt
from fastapi import (Depends, FastAPI, File, Form, Header, HTTPException, Query,
                     UploadFile, WebSocket, WebSocketDisconnect)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from PIL import Image, ImageOps
from pydantic import BaseModel
from sqlalchemy import create_engine, text

from phrases import PHRASES

DB = os.environ["DATABASE_URL"]
for old in ("postgres://", "postgresql://"):
    if DB.startswith(old):
        DB = DB.replace(old, "postgresql+psycopg://", 1)
SECRET = os.environ["JWT_SECRET"]
engine = create_engine(DB, pool_pre_ping=True)

app = FastAPI(title="annanazar")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("FRONTEND_ORIGIN", "http://localhost:5173").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def init():
    schema = open(os.path.join(os.path.dirname(__file__), "schema.sql"), encoding="utf-8").read()
    with engine.begin() as c:
        for stmt in schema.split(";"):
            if stmt.strip():
                c.execute(text(stmt))
        for login, name, env in (("nazar", "Назар", "NAZAR_PASSWORD"), ("anna", "Анна", "ANNA_PASSWORD")):
            pw = os.environ.get(env)
            if pw:
                h = bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()
                c.execute(text(
                    "INSERT INTO users(login,name,password_hash) VALUES(:l,:n,:h) "
                    "ON CONFLICT (login) DO UPDATE SET password_hash=EXCLUDED.password_hash"),
                    {"l": login, "n": name, "h": h})
        for lang, t in PHRASES:
            c.execute(text("INSERT INTO phrases(lang,text) VALUES(:l,:t) ON CONFLICT DO NOTHING"),
                      {"l": lang, "t": t})


def user_from_token(token: str):
    try:
        uid = int(jwt.decode(token, SECRET, algorithms=["HS256"])["sub"])
    except Exception:
        raise HTTPException(401, "bad token")
    with engine.connect() as c:
        r = c.execute(text("SELECT id,login,name FROM users WHERE id=:i"), {"i": uid}).mappings().first()
    if not r:
        raise HTTPException(401, "no user")
    return dict(r)


def current(authorization: str = Header(None)):
    if not authorization:
        raise HTTPException(401, "no token")
    return user_from_token(authorization.removeprefix("Bearer "))


class Login(BaseModel):
    login: str
    password: str


@app.get("/api/health")
def health():
    return {"ok": True}


@app.post("/api/login")
def login(body: Login):
    with engine.connect() as c:
        r = c.execute(text("SELECT id,name,password_hash FROM users WHERE login=:l"),
                      {"l": body.login.strip().lower()}).mappings().first()
    if not r or not bcrypt.checkpw(body.password.encode(), r["password_hash"].encode()):
        raise HTTPException(401, "Invalid login or password")
    exp = dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=30)
    token = jwt.encode({"sub": str(r["id"]), "exp": exp}, SECRET, algorithm="HS256")
    return {"token": token, "name": r["name"]}


@app.get("/api/me")
def me(u=Depends(current)):
    return u


@app.get("/api/phrase")
def phrase(lang: str = "ru"):
    lang = lang if lang in ("ru", "en") else "ru"
    with engine.connect() as c:
        r = c.execute(text("SELECT text FROM phrases WHERE lang=:l ORDER BY random() LIMIT 1"),
                      {"l": lang}).first()
    return {"text": r[0] if r else ""}


def msg_dict(r):
    return {"id": r["id"], "user_id": r["user_id"], "name": r["name"],
            "text": r["text"], "created_at": r["created_at"].isoformat()}


@app.get("/api/messages")
def messages(limit: int = 200, u=Depends(current)):
    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT m.id,m.user_id,u.name,m.text,m.created_at FROM messages m "
            "JOIN users u ON u.id=m.user_id ORDER BY m.id DESC LIMIT :n"),
            {"n": min(limit, 500)}).mappings().all()
    return [msg_dict(r) for r in reversed(rows)]


clients = set()


@app.websocket("/ws")
async def ws(websocket: WebSocket, token: str = Query(...)):
    try:
        u = user_from_token(token)
    except HTTPException:
        await websocket.close(code=4401)
        return
    await websocket.accept()
    clients.add(websocket)
    try:
        while True:
            data = await websocket.receive_json()
            t = (data.get("text") or "").strip()[:2000]
            if not t:
                continue
            with engine.begin() as c:
                r = c.execute(text("INSERT INTO messages(user_id,text) VALUES(:u,:t) RETURNING id,created_at"),
                              {"u": u["id"], "t": t}).one()
            msg = {"id": r[0], "user_id": u["id"], "name": u["name"], "text": t,
                   "created_at": r[1].isoformat()}
            for cl in list(clients):
                try:
                    await cl.send_json(msg)
                except Exception:
                    clients.discard(cl)
    except WebSocketDisconnect:
        pass
    finally:
        clients.discard(websocket)


@app.get("/api/photos")
def photos(u=Depends(current)):
    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT p.id,p.caption,p.created_at,u.name FROM photos p "
            "JOIN users u ON u.id=p.user_id ORDER BY p.id DESC")).mappings().all()
    return [{"id": r["id"], "caption": r["caption"], "name": r["name"],
             "created_at": r["created_at"].isoformat()} for r in rows]


@app.post("/api/photos")
async def upload(file: UploadFile = File(...), caption: str = Form(""), u=Depends(current)):
    raw = await file.read()
    if len(raw) > 15 * 1024 * 1024:
        raise HTTPException(413, "File too large")
    try:
        im = ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert("RGB")
    except Exception:
        raise HTTPException(400, "Not an image")

    def enc(size, q):
        i = im.copy()
        i.thumbnail((size, size))
        b = io.BytesIO()
        i.save(b, "JPEG", quality=q)
        return b.getvalue()

    with engine.begin() as c:
        r = c.execute(text(
            "INSERT INTO photos(user_id,caption,data,thumb) VALUES(:u,:c,:d,:t) RETURNING id"),
            {"u": u["id"], "c": caption[:300], "d": enc(1600, 82), "t": enc(480, 75)}).one()
    return {"id": r[0]}


@app.get("/api/photos/{pid}/{kind}")
def photo_file(pid: int, kind: str, token: str = Query(...)):
    user_from_token(token)
    col = "thumb" if kind == "thumb" else "data"
    with engine.connect() as c:
        r = c.execute(text(f"SELECT {col} FROM photos WHERE id=:i"), {"i": pid}).first()
    if not r:
        raise HTTPException(404)
    return Response(bytes(r[0]), media_type="image/jpeg",
                    headers={"Cache-Control": "private, max-age=86400"})


@app.delete("/api/photos/{pid}")
def delete_photo(pid: int, u=Depends(current)):
    with engine.begin() as c:
        c.execute(text("DELETE FROM photos WHERE id=:i"), {"i": pid})
    return {"ok": True}
