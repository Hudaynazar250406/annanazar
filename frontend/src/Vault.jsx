import {useEffect,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import {api,request} from './api'
import {bio} from './native.js'
import './vault.css'
const ITERS=600000,LOCK_MS=60000,MIN_PASS=10
const enc=new TextEncoder(),dec=new TextDecoder()
const toB64=u=>{let s='';for(let i=0;i<u.length;i+=8192)s+=String.fromCharCode(...u.subarray(i,i+8192));return btoa(s)}
const fromB64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0))
async function derive(pass,salt,iters){const base=await crypto.subtle.importKey('raw',enc.encode(pass.normalize('NFKC')),'PBKDF2',false,['deriveKey']);return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:iters,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt'])}
async function seal(key,bytes,aad){const iv=crypto.getRandomValues(new Uint8Array(12));const body=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:enc.encode(aad)},key,bytes));const out=new Uint8Array(12+body.length);out.set(iv);out.set(body,12);return out}
async function unseal(key,bytes,aad){return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(0,12),additionalData:enc.encode(aad)},key,bytes.slice(12)))}
async function prepare(file){
 const url=URL.createObjectURL(file)
 try{
  const img=new Image();img.src=url;await img.decode()
  const render=async(max,quality)=>{
   const k=Math.min(1,max/Math.max(img.naturalWidth,img.naturalHeight))
   const c=document.createElement('canvas');c.width=Math.max(1,Math.round(img.naturalWidth*k));c.height=Math.max(1,Math.round(img.naturalHeight*k))
   c.getContext('2d').drawImage(img,0,0,c.width,c.height)
   const blob=await new Promise(res=>c.toBlob(res,'image/jpeg',quality));if(!blob)throw new Error('Не удалось обработать фото')
   return new Uint8Array(await blob.arrayBuffer())
  }
  return {full:await render(1600,0.85),thumb:await render(320,0.7)}
 }finally{URL.revokeObjectURL(url)}
}
function Thumb({item,keyRef,track,onOpen}){
 const [src,setSrc]=useState('')
 useEffect(()=>{
  let alive=true
  ;(async()=>{try{const res=await request(`/api/vault/items/${item.id}/thumb`);const plain=await unseal(keyRef.current,new Uint8Array(await res.arrayBuffer()),'vault:thumb');const url=track(URL.createObjectURL(new Blob([plain],{type:'image/jpeg'})));if(alive)setSrc(url)}catch{}})()
  return()=>{alive=false}
 },[item.id])
 return <button type="button" className="vault-thumb" onClick={()=>onOpen(item)}>{src?<img src={src} alt=""/>:<span>…</span>}</button>
}
export default function Vault({root}){
 const [open,setOpen]=useState(false),[meta,setMeta]=useState(undefined),[unlocked,setUnlocked]=useState(false),[items,setItems]=useState([]),[view,setView]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[pass,setPass]=useState(''),[pass2,setPass2]=useState(''),[used,setUsed]=useState({used:0,budget:0}),[bioAvail,setBioAvail]=useState(false),[bioSaved,setBioSaved]=useState(false)
 const key=useRef(null),urls=useRef(new Set()),file=useRef(null),passRef=useRef('')
 function track(url){urls.current.add(url);return url}
 function lock(){
  key.current=null;passRef.current='';urls.current.forEach(u=>URL.revokeObjectURL(u));urls.current.clear()
  setUnlocked(false);setItems([]);setView(null);setPass('');setPass2('');setError('');setMeta(undefined);setOpen(false)
 }
 useEffect(()=>{
  let timer,sx=0,sy=0
  const clear=()=>clearTimeout(timer)
  const down=e=>{const t=e.target;if(!(t instanceof Element)||!t.closest('.app > header h2'))return;sx=e.clientX;sy=e.clientY;clear();timer=setTimeout(()=>{if(navigator.vibrate)navigator.vibrate(20);setOpen(true)},900)}
  const move=e=>{if(Math.hypot(e.clientX-sx,e.clientY-sy)>12)clear()}
  const menu=e=>{if(e.target instanceof Element&&e.target.closest('.app > header h2'))e.preventDefault()}
  root.addEventListener('pointerdown',down,true);root.addEventListener('pointermove',move,true);root.addEventListener('pointerup',clear,true);root.addEventListener('pointercancel',clear,true);root.addEventListener('contextmenu',menu,true)
  return()=>{clear();root.removeEventListener('pointerdown',down,true);root.removeEventListener('pointermove',move,true);root.removeEventListener('pointerup',clear,true);root.removeEventListener('pointercancel',clear,true);root.removeEventListener('contextmenu',menu,true)}
 },[])
 useEffect(()=>{
  if(!open)return
  let alive=true
  api('/api/vault/meta').then(m=>{if(alive)setMeta(m)}).catch(e=>{if(alive)setError(e.message)})
  bio.available().then(v=>{if(alive)setBioAvail(v)}).catch(()=>{})
  bio.has().then(v=>{if(alive)setBioSaved(v)}).catch(()=>{})
  return()=>{alive=false}
 },[open])
 useEffect(()=>{
  if(!open)return
  let timer
  const reset=()=>{clearTimeout(timer);timer=setTimeout(lock,LOCK_MS)}
  const hide=()=>{if(document.visibilityState==='hidden')lock()}
  const events=['pointerdown','keydown','scroll','touchstart'];reset()
  events.forEach(n=>window.addEventListener(n,reset,true));document.addEventListener('visibilitychange',hide)
  return()=>{clearTimeout(timer);events.forEach(n=>window.removeEventListener(n,reset,true));document.removeEventListener('visibilitychange',hide)}
 },[open])
 async function refresh(){const d=await api('/api/vault/items');setItems(d.items);setUsed({used:d.used,budget:d.budget})}
 async function create(e){
  e.preventDefault();setError('')
  if(pass.length<MIN_PASS){setError('Минимум 10 символов');return}
  if(/^\d+$/.test(pass)){setError('Только цифры — слишком слабо. Добавьте буквы и слова.');return}
  if(pass!==pass2){setError('Фразы не совпадают');return}
  setBusy(true)
  try{
   const salt=crypto.getRandomValues(new Uint8Array(16));const k=await derive(pass,salt,ITERS)
   const check=toB64(await seal(k,enc.encode('vault-ok'),'vault:check'))
   await api('/api/vault/meta',{method:'PUT',json:{salt:toB64(salt),iters:ITERS,check}})
   key.current=k;passRef.current=pass;setPass('');setPass2('');setMeta({exists:true});setUnlocked(true);await refresh()
  }catch(err){setError(err.message)}finally{setBusy(false)}
 }
 async function doUnlock(phrase,fromBio){
  setError('');setBusy(true)
  try{
   if(meta.iters<300000||meta.iters>5000000)throw new Error('Некорректные параметры раздела')
   const k=await derive(phrase,fromB64(meta.salt),meta.iters)
   const ok=dec.decode(await unseal(k,fromB64(meta.check),'vault:check'))
   if(ok!=='vault-ok')throw new Error('bad')
   key.current=k;passRef.current=phrase;setPass('');setUnlocked(true);await refresh()
  }catch{
   if(fromBio){await bio.disable();setBioSaved(false);setError('Сохранённая фраза больше не подходит. Введите её вручную.')}
   else{setError('Неверная фраза');await new Promise(res=>setTimeout(res,800))}
  }finally{setBusy(false)}
 }
 async function unlockNow(e){e.preventDefault();await doUnlock(pass,false)}
 async function unlockBio(){
  setError('')
  try{const phrase=await bio.unlock();if(!phrase){setBioSaved(false);setError('Сохранённой фразы нет. Введите её вручную.');return}await doUnlock(phrase,true)}
  catch{setError('Биометрия не подтверждена')}
 }
 async function enableBio(){
  try{await bio.enable(passRef.current);setBioSaved(true);setError('')}
  catch{setError('Не удалось включить биометрию')}
 }
 async function disableBio(){await bio.disable();setBioSaved(false)}
 async function addFiles(e){
  const files=[...e.target.files];e.target.value='';if(!files.length)return
  setBusy(true);setError('')
  try{
   for(const f of files){
    if(!f.type.startsWith('image/')||f.size>20*1024*1024)throw new Error('Нужны изображения до 20 МБ')
    const {full,thumb}=await prepare(f);const form=new FormData()
    form.append('data',new Blob([await seal(key.current,full,'vault:img')],{type:'application/octet-stream'}),'a.bin')
    form.append('thumb',new Blob([await seal(key.current,thumb,'vault:thumb')],{type:'application/octet-stream'}),'t.bin')
    await api('/api/vault/items',{method:'POST',body:form})
   }
   await refresh()
  }catch(err){setError(err.message)}finally{setBusy(false)}
 }
 async function show(item){
  setBusy(true);setError('')
  try{const res=await request(`/api/vault/items/${item.id}/data`);const plain=await unseal(key.current,new Uint8Array(await res.arrayBuffer()),'vault:img');setView({id:item.id,url:track(URL.createObjectURL(new Blob([plain],{type:'image/jpeg'})))})}
  catch{setError('Не удалось расшифровать фото')}finally{setBusy(false)}
 }
 function closeView(){if(view){URL.revokeObjectURL(view.url);urls.current.delete(view.url)}setView(null)}
 async function remove(id){
  if(!confirm('Удалить это фото навсегда?'))return
  try{await api('/api/vault/items/'+id,{method:'DELETE'});closeView();await refresh()}catch(err){setError(err.message)}
 }
 async function wipe(){
  const answer=prompt('Все фото и парольная фраза раздела будут удалены. Введите СТЕРЕТЬ для подтверждения.')
  if(answer!=='СТЕРЕТЬ')return
  try{await api('/api/vault',{method:'DELETE'});await bio.disable();lock()}catch(err){setError(err.message)}
 }
 if(!open)return null
 return createPortal(<div className="vault-screen" role="dialog" aria-modal="true" aria-label="Закрытый раздел">
  <div className="vault-top"><h2>Закрытый раздел</h2><button type="button" className="v" onClick={lock}>Закрыть</button></div>
  {meta===undefined&&!error&&<p className="vault-note">Загрузка…</p>}
  {meta&&!meta.exists&&!unlocked&&<form className="vault-box" onSubmit={create}>
   <p className="vault-note">Создайте длинную парольную фразу. Фото шифруются на этом телефоне, сервер хранит только зашифрованные данные. Если забудете фразу, восстановить фото нельзя. Раздел только для взрослых: загружайте свои фото или те, на хранение которых есть согласие.</p>
   <input type="password" name="vault-secret" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="Парольная фраза (от 10 символов)" value={pass} onChange={e=>setPass(e.target.value)}/>
   <input type="password" name="vault-secret-repeat" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="Повторите фразу" value={pass2} onChange={e=>setPass2(e.target.value)}/>
   <button className="v primary" disabled={busy}>{busy?'Создаём…':'Создать'}</button>
  </form>}
  {meta&&meta.exists&&!unlocked&&<form className="vault-box" onSubmit={unlockNow}>
   {bioSaved&&<button type="button" className="v primary" disabled={busy} onClick={unlockBio}>Открыть по биометрии</button>}
   <input type="password" name="vault-secret" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="Парольная фраза" value={pass} onChange={e=>setPass(e.target.value)} autoFocus={!bioSaved}/>
   <button className="v primary" disabled={busy||!pass}>{busy?'Проверяем…':'Открыть'}</button>
  </form>}
  {unlocked&&<>
   <div className="vault-actions"><button type="button" className="v primary" disabled={busy} onClick={()=>file.current&&file.current.click()}>{busy?'Обработка…':'＋ Добавить фото'}</button><button type="button" className="v" onClick={lock}>Заблокировать</button>{bioAvail&&!bioSaved&&<button type="button" className="v" onClick={enableBio}>Включить вход по биометрии</button>}{bioSaved&&<button type="button" className="v" onClick={disableBio}>Выключить вход по биометрии</button>}</div>
   <input ref={file} type="file" accept="image/*" multiple hidden onChange={addFiles}/>
   <p className="vault-note">Занято {(used.used/1048576).toFixed(0)} из {(used.budget/1048576).toFixed(0)} МБ (общий лимит). Блокировка через минуту без действий.</p>
   <div className="vault-grid">{items.map(it=><Thumb key={it.id} item={it} keyRef={key} track={track} onOpen={show}/>)}</div>
   {!items.length&&<p className="vault-note">Здесь пока пусто.</p>}
   <button type="button" className="v danger" onClick={wipe}>Стереть весь раздел</button>
  </>}
  {error&&<p className="vault-error" role="alert">{error}</p>}
  {view&&<div className="vault-viewer"><img src={view.url} alt=""/><div className="vault-actions"><button type="button" className="v" onClick={closeView}>Закрыть</button><button type="button" className="v danger" onClick={()=>remove(view.id)}>Удалить</button></div></div>}
 </div>,document.body)
}
