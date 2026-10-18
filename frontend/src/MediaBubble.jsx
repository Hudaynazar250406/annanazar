import {useEffect,useRef,useState} from 'react'
import {API,api,request} from './api'
import './media.css'
let active=null
const posters=new Map()
const clock=ms=>{const s=Math.max(0,Math.round(ms/1000));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')}
function useUrl(id){
 const box=useRef(null),cache=useRef(null)
 const get=async()=>{const c=cache.current;if(c&&c.exp-60>Date.now()/1000)return c.url;const r=await api(`/api/media/${id}/access`);cache.current={url:API+r.url,exp:r.expires};return cache.current.url}
 useEffect(()=>{const el=box.current;if(!el||!('IntersectionObserver' in window)){get().catch(()=>{});return}const io=new IntersectionObserver(items=>{if(items.some(i=>i.isIntersecting)){get().catch(()=>{});io.disconnect()}},{rootMargin:'300px'});io.observe(el);return()=>io.disconnect()},[id])
 return {box,get,cache}
}
function Voice({m}){
 const audio=useRef(null),{box,get,cache}=useUrl(m.media_id)
 const [playing,setPlaying]=useState(false),[pos,setPos]=useState(0),[rate,setRate]=useState(1),[err,setErr]=useState('')
 const peaks=(m.waveform||'').split(',').filter(Boolean).map(Number),bars=peaks.length?peaks:Array(40).fill(70)
 const dur=m.duration_ms||0,ratio=dur?Math.min(1,pos/dur):0
 useEffect(()=>()=>{const a=audio.current;if(a){a.pause();if(active===a)active=null}},[])
 async function toggle(e){
  e.stopPropagation();const a=audio.current;if(!a)return
  if(!a.paused){a.pause();return}
  try{
   setErr('');const c=cache.current;const url=c&&c.exp-60>Date.now()/1000?c.url:await get()
   if(!a.getAttribute('src'))a.src=url
   if(active&&active!==a)active.pause()
   active=a;a.playbackRate=rate;await a.play()
  }catch{setErr('Не удалось воспроизвести')}
 }
 function seek(e){
  e.stopPropagation();const a=audio.current;if(!a||!dur||!a.getAttribute('src'))return
  const rect=e.currentTarget.getBoundingClientRect();const t=(e.clientX-rect.left)/rect.width*dur/1000
  try{if(a.seekable&&a.seekable.length&&isFinite(t))a.currentTime=t}catch{}
 }
 function speed(e){e.stopPropagation();const n=rate===1?1.5:rate===1.5?2:1;setRate(n);if(audio.current)audio.current.playbackRate=n}
 return <div className="voice" ref={box}><audio ref={audio} preload="none" onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)} onEnded={()=>{setPlaying(false);setPos(0)}} onTimeUpdate={e=>setPos(e.currentTarget.currentTime*1000)} onError={()=>setErr('Формат не поддерживается этим телефоном')}/><button type="button" className="voice-play" onClick={toggle} aria-label={playing?'Пауза':'Воспроизвести'}>{playing?'❚❚':'▶'}</button><div className="voice-body"><div className="voice-wave" onClick={seek}>{bars.map((v,i)=><i key={i} className={i/bars.length<ratio?'done':''} style={{height:Math.max(12,v/255*100)+'%'}}/>)}</div><div className="voice-meta"><span>{err||clock(playing||pos?pos:dur)}</span><button type="button" className="voice-rate" onClick={speed}>{rate}×</button></div></div></div>
}
function Circle({m}){
 const video=useRef(null),{box,get,cache}=useUrl(m.media_id)
 const [poster,setPoster]=useState(posters.get(m.media_id)||''),[playing,setPlaying]=useState(false),[pos,setPos]=useState(0),[err,setErr]=useState('')
 useEffect(()=>{if(poster)return;let alive=true;request(`/api/media/${m.media_id}/poster`).then(r=>r.blob()).then(b=>{const u=URL.createObjectURL(b);posters.set(m.media_id,u);if(alive)setPoster(u)}).catch(()=>{});return()=>{alive=false}},[m.media_id])
 useEffect(()=>()=>{const v=video.current;if(v){v.pause();if(active===v)active=null}},[])
 async function toggle(e){
  e.stopPropagation();const v=video.current;if(!v)return
  if(!v.paused){v.pause();return}
  try{
   setErr('');const c=cache.current;const url=c&&c.exp-60>Date.now()/1000?c.url:await get()
   if(!v.getAttribute('src'))v.src=url
   if(active&&active!==v)active.pause()
   active=v;v.muted=false;await v.play()
  }catch{setErr('Не удалось воспроизвести')}
 }
 const dur=m.duration_ms||0,ratio=dur?Math.min(1,pos/dur):0,R=46,C=2*Math.PI*R
 return <div className="circle-box" ref={box} role="button" tabIndex={0} aria-label="Видеокружок" onClick={toggle} onKeyDown={e=>{if(e.key==='Enter'||e.key===' ')toggle(e)}} style={poster?{backgroundImage:`url(${poster})`}:undefined}><video ref={video} preload="none" playsInline disablePictureInPicture onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)} onEnded={()=>{setPlaying(false);setPos(0)}} onTimeUpdate={e=>setPos(e.currentTarget.currentTime*1000)} onError={()=>setErr('Формат не поддерживается этим телефоном')}/><svg className="circle-ring" viewBox="0 0 100 100"><circle cx="50" cy="50" r={R} fill="none" stroke="#ffffff88" strokeWidth="3"/><circle cx="50" cy="50" r={R} fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C*(1-ratio)}/></svg>{!playing&&<span className="circle-play">▶</span>}<span className="circle-time">{err||clock(playing||pos?pos:dur)}</span></div>
}
export default function MediaBubble({m,onMenu}){
 return <div className="media-wrap">{m.kind==='voice'?<Voice m={m}/>:<Circle m={m}/>}<button type="button" className="media-more" aria-label="Меню сообщения" onClick={e=>{e.stopPropagation();onMenu()}}>⋯</button></div>
}
