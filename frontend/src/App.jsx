import { useEffect, useRef, useState } from 'react'
import { API, api, getToken, setToken } from './api'

const T = {
  ru: {
    forYou: 'Для Анны ♥',
    enter: 'Войти',
    login: 'Логин',
    password: 'Пароль',
    signin: 'Открыть наш мир',
    chat: 'Чат',
    photos: 'Наши фото',
    write: 'Напиши что-нибудь тёплое…',
    send: 'Отправить',
    add: '+ Добавить фото',
    caption: 'Подпись (необязательно)',
    empty: 'Здесь пока пусто — самое время добавить первое фото ♥',
    logout: 'Выйти',
    wrong: 'Неверный логин или пароль',
    loading: 'Загружаем нежность…',
  },
  en: {
    forYou: 'For Anna ♥',
    enter: 'Enter',
    login: 'Login',
    password: 'Password',
    signin: 'Open our world',
    chat: 'Chat',
    photos: 'Our photos',
    write: 'Write something sweet…',
    send: 'Send',
    add: '+ Add photo',
    caption: 'Caption (optional)',
    empty: 'Nothing here yet — time to add the first photo ♥',
    logout: 'Log out',
    wrong: 'Wrong login or password',
    loading: 'Loading tenderness…',
  },
}

const FALLBACK = {
  ru: 'Ты — моё любимое «сегодня» и самое тёплое «завтра».',
  en: 'You are my favorite hello and my hardest goodbye.',
}

function Typewriter({ text }) {
  const [n, setN] = useState(0)
  useEffect(() => {
    setN(0)
    const i = setInterval(() => setN((x) => (x >= text.length ? (clearInterval(i), x) : x + 1)), 45)
    return () => clearInterval(i)
  }, [text])
  return (
    <span>
      {text.slice(0, n)}
      <i className="caret" />
    </span>
  )
}

function Hearts() {
  return (
    <div className="hearts" aria-hidden>
      {Array.from({ length: 14 }).map((_, i) => (
        <span key={i} style={{ left: `${(i * 37) % 100}%`, animationDelay: `${(i * 1.3) % 9}s`, fontSize: 14 + ((i * 7) % 22) }}>
          {i % 3 ? '♥' : '✦'}
        </span>
      ))}
    </div>
  )
}

function Welcome({ t, lang, onEnter }) {
  const [phrase, setPhrase] = useState('')
  useEffect(() => {
    let alive = true
    setPhrase('')
    api('/api/phrase?lang=' + lang)
      .then((d) => alive && setPhrase(d.text || FALLBACK[lang]))
      .catch(() => alive && setPhrase(FALLBACK[lang]))
    return () => {
      alive = false
    }
  }, [lang])
  return (
    <main className="center">
      <div className="card hero">
        <p className="eyebrow">{t.forYou}</p>
        <h1>Anna <em>&amp;</em> Nazar</h1>
        <p className="phrase">{phrase ? <Typewriter text={phrase} /> : t.loading}</p>
        <button className="btn" onClick={onEnter}>{t.enter}</button>
      </div>
    </main>
  )
}

function Login({ t, onDone }) {
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const d = await api('/api/login', { method: 'POST', json: { login, password } })
      setToken(d.token)
      onDone()
    } catch {
      setErr(t.wrong)
    }
    setBusy(false)
  }
  return (
    <main className="center">
      <form className="card login" onSubmit={submit}>
        <h2>Anna <em>&amp;</em> Nazar</h2>
        <input placeholder={t.login} value={login} onChange={(e) => setLogin(e.target.value)} autoCapitalize="none" autoComplete="username" />
        <input placeholder={t.password} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        {err && <p className="err">{err}</p>}
        <button className="btn" disabled={busy}>{t.signin}</button>
      </form>
    </main>
  )
}

function Chat({ t, me }) {
  const [msgs, setMsgs] = useState([])
  const [text, setText] = useState('')
  const ws = useRef(null)
  const end = useRef(null)
  useEffect(() => {
    let closed = false
    let timer
    api('/api/messages').then(setMsgs).catch(() => {})
    const connect = () => {
      const s = new WebSocket(API.replace(/^http/, 'ws') + '/ws?token=' + getToken())
      ws.current = s
      s.onmessage = (e) => setMsgs((m) => [...m, JSON.parse(e.data)])
      s.onclose = () => {
        if (!closed) timer = setTimeout(connect, 2000)
      }
    }
    connect()
    return () => {
      closed = true
      clearTimeout(timer)
      ws.current && ws.current.close()
    }
  }, [])
  useEffect(() => end.current?.scrollIntoView({ behavior: 'smooth' }), [msgs])
  const send = (e) => {
    e.preventDefault()
    if (!text.trim() || ws.current?.readyState !== 1) return
    ws.current.send(JSON.stringify({ text }))
    setText('')
  }
  return (
    <section className="card chat">
      <div className="msgs">
        {msgs.map((m) => (
          <div key={m.id} className={'bubble ' + (m.user_id === me.id ? 'mine' : 'theirs')}>
            <small>{m.name} · {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>
            <p>{m.text}</p>
          </div>
        ))}
        <div ref={end} />
      </div>
      <form className="composer" onSubmit={send}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t.write} />
        <button className="btn">{t.send}</button>
      </form>
    </section>
  )
}

function Gallery({ t }) {
  const [list, setList] = useState([])
  const [open, setOpen] = useState(null)
  const [caption, setCaption] = useState('')
  const file = useRef(null)
  const load = () => api('/api/photos').then(setList).catch(() => {})
  useEffect(() => {
    load()
  }, [])
  const url = (id, k) => `${API}/api/photos/${id}/${k}?token=${getToken()}`
  const upload = async (e) => {
    const f = e.target.files[0]
    if (!f) return
    const fd = new FormData()
    fd.append('file', f)
    fd.append('caption', caption)
    await api('/api/photos', { method: 'POST', body: fd })
    setCaption('')
    e.target.value = ''
    load()
  }
  return (
    <section>
      <div className="card uploader">
        <input value={caption} onChange={(e) => setCaption(e.target.value)} placeholder={t.caption} />
        <button className="btn" onClick={() => file.current.click()}>{t.add}</button>
        <input ref={file} type="file" accept="image/*" hidden onChange={upload} />
      </div>
      {list.length === 0 && <p className="muted">{t.empty}</p>}
      <div className="grid">
        {list.map((p) => (
          <figure key={p.id} className="tile" onClick={() => setOpen(p)}>
            <img src={url(p.id, 'thumb')} loading="lazy" alt={p.caption} />
            {p.caption && <figcaption>{p.caption}</figcaption>}
          </figure>
        ))}
      </div>
      {open && (
        <div className="lightbox" onClick={() => setOpen(null)}>
          <img src={url(open.id, 'full')} alt={open.caption} />
          {open.caption && <p>{open.caption}</p>}
        </div>
      )}
    </section>
  )
}

export default function App() {
  const [lang, setLang] = useState(localStorage.getItem('lang') || 'ru')
  const [stage, setStage] = useState('welcome')
  const [tab, setTab] = useState('chat')
  const [me, setMe] = useState(null)
  const t = T[lang]
  useEffect(() => localStorage.setItem('lang', lang), [lang])
  useEffect(() => {
    if (getToken()) api('/api/me').then(setMe).catch(() => {})
  }, [])
  const enter = () => (me ? setStage('app') : setStage('login'))
  const logged = async () => {
    setMe(await api('/api/me'))
    setStage('app')
  }
  const logout = () => {
    setToken(null)
    location.reload()
  }
  return (
    <>
      <div className="bg" />
      <Hearts />
      <button className="lang" onClick={() => setLang(lang === 'ru' ? 'en' : 'ru')}>{lang === 'ru' ? 'EN' : 'RU'}</button>
      {stage === 'welcome' && <Welcome t={t} lang={lang} onEnter={enter} />}
      {stage === 'login' && <Login t={t} onDone={logged} />}
      {stage === 'app' && me && (
        <div className="app">
          <header>
            <h2>Anna <em>&amp;</em> Nazar</h2>
            <nav>
              <button className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>{t.chat}</button>
              <button className={tab === 'photos' ? 'on' : ''} onClick={() => setTab('photos')}>{t.photos}</button>
              <button onClick={logout}>{t.logout}</button>
            </nav>
          </header>
          {tab === 'chat' ? <Chat t={t} me={me} /> : <Gallery t={t} />}
        </div>
      )}
    </>
  )
}
