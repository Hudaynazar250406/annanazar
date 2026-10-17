import {useEffect,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import {API,api,getToken} from './api'
import './notifications.css'
const sections=['home','chat','photos','calendar','memories','letters','wishes']
const titles={chat:'Новое сообщение',photos:'Добавлено фото',calendar:'Новое событие',memories:'Новое воспоминание',letters:'Письмо открыто',wishes:'Новая идея'}
const decode=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4)),c=>c.charCodeAt(0))
export default function Notifications({root}){
 const [header,setHeader]=useState(null),[tabs,setTabs]=useState([]),[data,setData]=useState(null),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[enabled,setEnabled]=useState(false)
 const current=useRef(''),endpoint=useRef(''),working=useRef(false),limits=useRef({})
 async function refresh(){
  if(working.current)return;working.current=true
  try{
   const token=getToken()
   if(token!==current.current){
    const old=current.current;current.current=token||'';setData(null);limits.current={};setOpen(false)
    if(old&&endpoint.current){await fetch(API+'/api/notifications/disable',{method:'POST',headers:{Authorization:'Bearer '+old,'Content-Type':'application/json'},body:JSON.stringify({endpoint:endpoint.current})}).catch(()=>{});endpoint.current='';setEnabled(false)}
    if(token&&'serviceWorker'in navigator){const reg=await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);const sub=await reg?.pushManager?.getSubscription();if(sub){await api('/api/notifications/device',{method:'POST',json:sub.toJSON()});endpoint.current=sub.endpoint;setEnabled(true)}}
   }
   if(!token){navigator.clearAppBadge?.().catch(()=>{});return}
   const d=await api('/api/notifications/status');setData(d)
   if(d.total)navigator.setAppBadge?.(d.total).catch(()=>{});else navigator.clearAppBadge?.().catch(()=>{})
   const buttons=[...root.querySelectorAll('.app > .tabs button')];const index=buttons.findIndex(b=>b.classList.contains('on'));const kind=sections[index]
   const box=root.querySelector('.chat .msgs');const atEnd=box&&box.children.length>1&&box.scrollHeight-box.scrollTop-box.clientHeight<24
   if(document.visibilityState==='visible'&&kind&&kind!=='home'&&(kind!=='chat'||atEnd)&&d.limits[kind]>0&&limits.current[kind]!==d.limits[kind]){
    await api('/api/notifications/read',{method:'POST',json:{kind,until:d.limits[kind]}});limits.current[kind]=d.limits[kind]
    const fresh=await api('/api/notifications/status');setData(fresh);if(fresh.total)navigator.setAppBadge?.(fresh.total).catch(()=>{});else navigator.clearAppBadge?.().catch(()=>{})
   }
  }catch(e){if(open)setError(e.message)}finally{working.current=false}
 }
 useEffect(()=>{
  const sync=()=>{const h=root.querySelector('.app > header'),list=[...root.querySelectorAll('.app > .tabs button')];setHeader(old=>old===h?old:h);setTabs(old=>old.length===list.length&&old.every((v,i)=>v===list[i])?old:list)}
  const observer=new MutationObserver(sync);observer.observe(root,{childList:true,subtree:true});sync()
  const tick=()=>{if(document.visibilityState==='visible')refresh()};const timer=setInterval(tick,5000);tick()
  const message=e=>{if(e.data?.type==='open-notification'){const index=sections.indexOf(e.data.section);root.querySelectorAll('.app > .tabs button')[index]?.click();refresh()}}
  navigator.serviceWorker?.addEventListener('message',message);document.addEventListener('visibilitychange',tick)
  const navigate=()=>{const section=new URL(location.href).searchParams.get('section');if(section){const index=sections.indexOf(section);const button=root.querySelectorAll('.app > .tabs button')[index];if(button){button.click();const url=new URL(location.href);url.searchParams.delete('section');history.replaceState(null,'',url)}}};const navTimer=setInterval(navigate,1000)
  return()=>{observer.disconnect();clearInterval(timer);clearInterval(navTimer);document.removeEventListener('visibilitychange',tick);navigator.serviceWorker?.removeEventListener('message',message)}
 },[])
 async function perform(fn){setBusy(true);setError('');try{await fn()}catch(e){setError(e.message)}finally{setBusy(false)}}
 async function enable(){
  if(!('Notification'in window)||!('PushManager'in window)||!('serviceWorker'in navigator))throw new Error('На iPhone установите сайт через Safari → Поделиться → На экран Домой и откройте его оттуда. Нужна iOS 16.4 или новее.')
  const permission=await Notification.requestPermission();if(permission!=='granted')throw new Error('Разрешите уведомления для сайта в настройках телефона или браузера.')
  const reg=await navigator.serviceWorker.register(import.meta.env.BASE_URL+'sw.js');await reg.update();await navigator.serviceWorker.ready
  const config=await api('/api/notifications/status');let sub=await reg.pushManager.getSubscription()
  if(!sub)sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:decode(config.public_key)})
  await api('/api/notifications/device',{method:'POST',json:sub.toJSON()});endpoint.current=sub.endpoint;setEnabled(true);setError('Подключено. Нажмите «Тест».')
 }
 async function disable(){const reg=await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);const sub=await reg?.pushManager?.getSubscription();if(sub){await api('/api/notifications/disable',{method:'POST',json:{endpoint:sub.endpoint}});await sub.unsubscribe()}endpoint.current='';setEnabled(false)}
 function jump(kind){const index=sections.indexOf(kind);tabs[index]?.click();setOpen(false);refresh()}
 return <>{header&&createPortal(<button className="notification-bell" aria-label="Уведомления" onClick={()=>{setOpen(true);setError('');refresh()}}>♧ {data?.total>0&&<span className="notification-count">{data.total}</span>}</button>,header)}{tabs.map((button,i)=>data?.counts[sections[i]]>0?createPortal(<span className="notification-count">{data.counts[sections[i]]}</span>,button,sections[i]):null)}{open&&createPortal(<div className="notification-overlay" onClick={e=>{if(e.target===e.currentTarget)setOpen(false)}}><section className="notification-panel" role="dialog" aria-modal="true" aria-label="Уведомления"><header><h2>Уведомления</h2><button onClick={()=>setOpen(false)} aria-label="Закрыть">×</button></header><p>На экране блокировки — только тип события, без текста переписки. Разрешение нужно включить отдельно на каждом телефоне.</p><div className="notification-controls"><button disabled={busy} onClick={()=>perform(enable)}>{enabled?'Переподключить':'Включить на этом телефоне'}</button>{enabled&&<><button disabled={busy} onClick={()=>perform(async()=>{await api('/api/notifications/test',{method:'POST',json:{endpoint:endpoint.current}});setError('Push-служба приняла тест. Проверьте уведомления телефона.')} )}>Тест</button><button disabled={busy} onClick={()=>perform(disable)}>Выключить на этом телефоне</button></>}</div>{error&&<p role="status">{error}</p>}{!data&&<p>Если настройки не загружаются, проверьте, что Render запускает notifications:app.</p>}{data?.items.map(item=><button className={'notification-item '+(!item.seen?'unread':'')} key={item.id} onClick={()=>jump(item.kind)}>{titles[item.kind]} · {new Date(item.created_at).toLocaleString()}</button>)}{data?.items.length===0&&<p>Новых событий пока нет. Старую историю мы не помечаем непрочитанной.</p>}<small>Письма проверяются, пока сервер работает. На бесплатном Render уведомление об открытии письма может задержаться до пробуждения сервера.</small></section></div>,document.body)}</>
}
