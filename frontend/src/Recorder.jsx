import {useEffect,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import {api} from './api'
import './media.css'
import './gestures.css'
const LIMIT={voice:300,circle:60}
const AUDIO=['audio/mp4;codecs=mp4a.40.2','audio/mp4','audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus']
const VIDEO=['video/mp4;codecs=avc1.42E01E,mp4a.40.2','video/mp4','video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm']
const AUDIO_CONSTRAINTS={echoCancellation:true,noiseSuppression:true,autoGainControl:true}
const pick=list=>typeof MediaRecorder==='undefined'||!MediaRecorder.isTypeSupported?'':(list.find(t=>MediaRecorder.isTypeSupported(t))||'')
const clock=ms=>{const s=Math.max(0,Math.floor(ms/1000));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')}
const ext=t=>/mp4/.test(t)?'mp4':/ogg/.test(t)?'ogg':'webm'
const bucket=(a,n=48)=>{if(!a.length)return Array(n).fill(80);const out=[];for(let i=0;i<n;i++){const from=Math.floor(i*a.length/n),to=Math.max(from+1,Math.floor((i+1)*a.length/n));out.push(Math.max(...a.slice(from,to)))}const mx=Math.max(...out,1);return out.map(v=>Math.round(Math.max(20,v/mx*255)))}
function explain(e){
 if(e&&e.name==='NotAllowedError')return 'Доступ к микрофону или камере запрещён. Разрешите его в настройках браузера или телефона.'
 if(e&&e.name==='NotFoundError')return 'Микрофон или камера не найдены.'
 if(e&&e.name==='NotReadableError')return 'Камера или микрофон заняты другим приложением.'
 return (e&&e.message)||'Не удалось начать запись.'
}
export default function Recorder({root}){
 const [host,setHost]=useState(null),[mode,setMode]=useState(null),[phase,setPhase]=useState('start'),[hold,setHold]=useState(false),[locked,setLocked]=useState(false),[drag,setDrag]=useState({dx:0,dy:0}),[pref,setPref]=useState(()=>localStorage.getItem('recKind')==='circle'?'circle':'voice'),[hint,setHint]=useState(''),[error,setError]=useState(''),[elapsed,setElapsed]=useState(0),[levels,setLevels]=useState([]),[review,setReview]=useState(null),[facing,setFacing]=useState('user'),[muted,setMuted]=useState(true)
 const r=useRef({}),g=useRef(null),canvas=useRef(null),holdRef=useRef(false),lockRef=useRef(false),hintTimer=useRef(0)
 const wanted=()=>holdRef.current||lockRef.current
 function toast(t){setHint(t);clearTimeout(hintTimer.current);hintTimer.current=setTimeout(()=>setHint(''),2600)}
 useEffect(()=>{
  const sync=()=>setHost(old=>{const el=root.querySelector('.app .chat .composer');return old===el?old:el})
  const observer=new MutationObserver(sync);observer.observe(root,{childList:true,subtree:true});sync()
  return()=>observer.disconnect()
 },[])
 useEffect(()=>()=>abortAll(),[])
 useEffect(()=>{
  if(!mode)return
  const hidden=()=>{if(document.visibilityState==='hidden'&&r.current.rec&&r.current.rec.state==='recording'){r.current.autoSend=false;stopRecording()}}
  document.addEventListener('visibilitychange',hidden);return()=>document.removeEventListener('visibilitychange',hidden)
 },[mode])
 function abortAll(){
  const s=r.current
  clearInterval(s.timer);clearInterval(s.levelTimer);cancelAnimationFrame(s.raf)
  if(s.rec&&s.rec.state!=='inactive'){s.rec.onstop=null;try{s.rec.stop()}catch{}}
  if(s.stream)s.stream.getTracks().forEach(t=>t.stop())
  if(s.videoStream)s.videoStream.getTracks().forEach(t=>t.stop())
  if(s.ctx&&s.ctx.close)s.ctx.close().catch(()=>{})
  r.current={}
 }
 function reset(){abortAll();holdRef.current=false;lockRef.current=false;setLocked(false);setHold(false);setDrag({dx:0,dy:0});setMode(null);setPhase('start');setError('')}
 function close(){if(review&&review.url)URL.revokeObjectURL(review.url);setReview(null);reset()}
 async function begin(kind){
  const ctx=kind==='voice'?new (window.AudioContext||window.webkitAudioContext)():null
  if(ctx&&ctx.resume)ctx.resume().catch(()=>{})
  setMode(kind);setHold(true);setLocked(false);lockRef.current=false;setPhase('start');setError('');setReview(null);setElapsed(0);setLevels([]);setFacing('user')
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia||typeof MediaRecorder==='undefined'){holdRef.current=false;setHold(false);setPhase('error');setError('Этот браузер не поддерживает запись. На iPhone нужен Safari с iOS 14.3 или новее.');return}
  const token=Symbol('rec');r.current={token}
  try{if(kind==='voice')await prepareVoice(token,ctx);else await prepareCircle(token,'user')}
  catch(e){if(r.current.token===token){abortAll();holdRef.current=false;lockRef.current=false;setLocked(false);setHold(false);setPhase('error');setError(explain(e))}}
 }
 async function prepareVoice(token,ctx){
  const stream=await navigator.mediaDevices.getUserMedia({audio:{...AUDIO_CONSTRAINTS,channelCount:1}})
  if(r.current.token!==token){stream.getTracks().forEach(t=>t.stop());if(ctx&&ctx.close)ctx.close().catch(()=>{});return}
  if(!wanted()){stream.getTracks().forEach(t=>t.stop());if(ctx&&ctx.close)ctx.close().catch(()=>{});reset();toast('Зажмите кнопку и говорите');return}
  const s=r.current;s.stream=stream;s.ctx=ctx
  const an=ctx.createAnalyser();an.fftSize=512;ctx.createMediaStreamSource(stream).connect(an);s.an=an
  startRecorder(stream,'voice',pick(AUDIO),{audioBitsPerSecond:48000})
 }
 async function prepareCircle(token,face){
  const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:face},width:{ideal:720},height:{ideal:720},frameRate:{ideal:30,max:30}},audio:AUDIO_CONSTRAINTS})
  if(r.current.token!==token){stream.getTracks().forEach(t=>t.stop());return}
  if(!wanted()){stream.getTracks().forEach(t=>t.stop());reset();toast('Зажмите кнопку и записывайте');return}
  const s=r.current;s.stream=stream;s.videoStream=new MediaStream(stream.getVideoTracks())
  const v=document.createElement('video');v.muted=true;v.playsInline=true;v.setAttribute('playsinline','');v.srcObject=s.videoStream;await v.play();s.video=v
  const c=canvas.current;if(!c)throw new Error('Окно камеры не готово')
  c.width=480;c.height=480;const ctx2=c.getContext('2d')
  const draw=()=>{const w=v.videoWidth,h=v.videoHeight;if(w&&h){const side=Math.min(w,h);ctx2.drawImage(v,(w-side)/2,(h-side)/2,side,side,0,0,480,480)}s.raf=requestAnimationFrame(draw)}
  draw()
  s.out=c.captureStream(30);stream.getAudioTracks().forEach(t=>s.out.addTrack(t))
  if(r.current.token!==token)return
  if(!wanted()){reset();toast('Зажмите кнопку и записывайте');return}
  startRecorder(s.out,'circle',pick(VIDEO),{videoBitsPerSecond:1200000,audioBitsPerSecond:64000})
 }
 function startRecorder(stream,kind,type,opts){
  const s=r.current
  const rec=new MediaRecorder(stream,{...(type?{mimeType:type}:{}),...opts})
  s.rec=rec;s.kind=kind;s.chunks=[];s.posterBlob=null;s.autoSend=false;s.type=rec.mimeType||type||(kind==='voice'?'audio/webm':'video/webm')
  rec.ondataavailable=e=>{if(e.data&&e.data.size)s.chunks.push(e.data)}
  rec.onstop=()=>finish()
  rec.onerror=()=>toast('Ошибка записи. Попробуйте ещё раз.')
  rec.start(1000);s.startAt=performance.now();s.peaks=[];setPhase('recording');setElapsed(0);setLevels([])
  s.timer=setInterval(()=>{const t=(performance.now()-s.startAt)/1000;setElapsed(t);if(t>=LIMIT[kind]){s.autoSend=lockRef.current?false:holdRef.current;stopRecording()}},200)
  if(s.an){const buf=new Uint8Array(s.an.fftSize);s.levelTimer=setInterval(()=>{s.an.getByteTimeDomainData(buf);let peak=0;for(const v of buf)peak=Math.max(peak,Math.abs(v-128));const level=Math.min(255,peak*3.2);s.peaks.push(level);setLevels(a=>[...a.slice(-39),level])},100)}
  if(kind==='circle')setTimeout(()=>makePoster(),600)
 }
 function makePoster(){
  const s=r.current,c=canvas.current;if(!c||!s.rec)return
  const t=document.createElement('canvas');t.width=240;t.height=240;t.getContext('2d').drawImage(c,0,0,240,240)
  t.toBlob(b=>{if(b&&r.current===s)s.posterBlob=b},'image/jpeg',0.72)
 }
 function stopRecording(){const s=r.current;if(s.rec&&s.rec.state==='recording'){s.duration=performance.now()-s.startAt;s.rec.stop()}}
 function stopForReview(){r.current.autoSend=false;stopRecording()}
 function finish(){
  const s=r.current
  clearInterval(s.timer);clearInterval(s.levelTimer);cancelAnimationFrame(s.raf)
  if(s.stream)s.stream.getTracks().forEach(t=>t.stop())
  if(s.videoStream)s.videoStream.getTracks().forEach(t=>t.stop())
  if(s.ctx&&s.ctx.close)s.ctx.close().catch(()=>{})
  const blob=new Blob(s.chunks||[],{type:s.type}),duration=s.duration||0,auto=!!s.autoSend
  if(blob.size<1500||duration<700){
   if(auto){reset();toast('Слишком коротко. Зажмите кнопку и держите хотя бы секунду');return}
   holdRef.current=false;lockRef.current=false;setLocked(false);setHold(false);setError('Запись слишком короткая.');setPhase('error');return
  }
  const rv={kind:s.kind,blob,url:URL.createObjectURL(blob),duration,peaks:bucket(s.peaks||[]),poster:s.posterBlob||null}
  holdRef.current=false;lockRef.current=false;setLocked(false);setHold(false);setReview(rv)
  if(auto)doSend(rv);else setPhase('review')
 }
 async function doSend(rv){
  setPhase('sending');setError('')
  const form=new FormData()
  form.append('kind',rv.kind);form.append('duration_ms',String(Math.round(rv.duration)));form.append('peaks',rv.peaks.join(','))
  form.append('file',rv.blob,'media.'+ext(rv.blob.type));if(rv.poster)form.append('poster',rv.poster,'poster.jpg')
  try{await api('/api/media/messages',{method:'POST',body:form});URL.revokeObjectURL(rv.url);setReview(null);reset()}
  catch(e){setReview(rv);setError(e.message||'Не удалось отправить. Запись сохранена на экране, попробуйте снова.');setPhase('review')}
 }
 async function flip(){
  const s=r.current;if(!s.video||!s.videoStream)return
  const next=facing==='user'?'environment':'user'
  s.videoStream.getTracks().forEach(t=>t.stop())
  try{
   const vs=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:next},width:{ideal:720},height:{ideal:720},frameRate:{ideal:30,max:30}}})
   s.videoStream=vs;s.video.srcObject=vs;await s.video.play();setFacing(next)
  }catch(e){toast(explain(e))}
 }
 function togglePref(){const n=pref==='voice'?'circle':'voice';try{localStorage.setItem('recKind',n)}catch{}setPref(n)}
 function onDown(e){
  if(mode||(e.button!==undefined&&e.button>0))return
  try{e.currentTarget.setPointerCapture(e.pointerId)}catch{}
  const s={x:e.clientX,y:e.clientY,started:false,cancelled:false};g.current=s
  s.timer=setTimeout(()=>{s.started=true;holdRef.current=true;if(navigator.vibrate)navigator.vibrate(15);begin(pref)},250)
 }
 function onMove(e){
  const s=g.current;if(!s||!s.started||s.cancelled)return
  const dx=e.clientX-s.x,dy=e.clientY-s.y;setDrag({dx,dy})
  if(lockRef.current)return
  if(dy<-90){lockRef.current=true;setLocked(true);if(navigator.vibrate)navigator.vibrate(10)}
  else if(dx<-110){s.cancelled=true;holdRef.current=false;if(navigator.vibrate)navigator.vibrate(10);close()}
 }
 function onUp(interrupted){
  const s=g.current;if(!s)return
  clearTimeout(s.timer);g.current=null
  if(!s.started){if(!interrupted)togglePref();return}
  holdRef.current=false;setDrag({dx:0,dy:0})
  if(s.cancelled||lockRef.current)return
  if(r.current.rec&&r.current.rec.state==='recording'){r.current.autoSend=!interrupted;stopRecording()}
 }
 const limit=mode?LIMIT[mode]:60
 const showFloat=!!mode&&hold&&(phase==='start'||phase==='recording')
 const cancelOpacity=Math.min(1,Math.max(0.35,-drag.dx/110)),lockOpacity=Math.min(1,Math.max(0.35,-drag.dy/90))
 return <>
  {host&&createPortal(<span className="rec-buttons"><button type="button" className={'rec-btn'+(hold?' hot':'')} aria-label={pref==='voice'?'Голосовое: зажмите для записи, нажмите для переключения на кружок':'Кружок: зажмите для записи, нажмите для переключения на голосовое'} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={()=>onUp(false)} onPointerCancel={()=>onUp(true)} onContextMenu={e=>e.preventDefault()} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();togglePref()}}}>{pref==='voice'?'🎤':'📹'}</button></span>,host)}
  {hint&&createPortal(<div className="rec-toast" role="status">{hint}</div>,document.body)}
  {showFloat&&createPortal(<div className={'rec-float'+(locked?' locked':'')}><div className="rec-dim"/><div className="rec-card">
   {mode==='circle'&&<div className="rec-circle"><canvas ref={canvas} style={{transform:facing==='user'?'scaleX(-1)':'none'}}/><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="48" fill="none" stroke="#ffffff77" strokeWidth="2"/><circle cx="50" cy="50" r="48" fill="none" stroke="#e0457b" strokeWidth="3" strokeLinecap="round" strokeDasharray="302" strokeDashoffset={302*(1-Math.min(1,elapsed/limit))}/></svg></div>}
   {mode==='voice'&&<div className="rec-wave">{levels.map((v,i)=><i key={i} style={{height:Math.max(8,v/255*100)+'%'}}/>)}</div>}
   <div className="rec-time">{phase==='recording'?clock(elapsed*1000):'…'} <small>/ {clock(limit*1000)}</small></div>
   {phase==='start'&&<p>Разрешите доступ, если браузер спросит…</p>}
   {!locked&&<div className="rec-hints"><span style={{opacity:cancelOpacity}}>← Отмена</span><span style={{opacity:lockOpacity}}>↑ Зафиксировать</span></div>}
   {locked&&<div className="rec-actions"><button type="button" onClick={close}>🗑 Отмена</button>{mode==='circle'&&<button type="button" onClick={flip}>🔄 Камера</button>}<button type="button" className="primary" onClick={stopForReview}>■ Стоп</button></div>}
  </div></div>,document.body)}
  {mode&&!showFloat&&createPortal(<div className="rec-overlay" onClick={e=>{if(e.target===e.currentTarget&&phase==='error')close()}}><section className="rec-sheet" role="dialog" aria-modal="true" aria-label={mode==='voice'?'Голосовое сообщение':'Видеокружок'}>
   <h3>{mode==='voice'?'Голосовое сообщение':'Видеокружок'}</h3>
   {mode==='circle'&&review&&<div className="rec-circle"><video src={review.url} playsInline autoPlay loop muted={muted} onClick={()=>setMuted(v=>!v)}/></div>}
   {mode==='circle'&&review&&phase==='review'&&<small>{muted?'Нажмите на кружок, чтобы включить звук':'Звук включён'}</small>}
   {mode==='voice'&&review&&<audio className="rec-audio" controls src={review.url}/>}
   {review&&<div className="rec-time">{clock(review.duration)} <small>/ {clock(limit*1000)}</small></div>}
   {phase==='sending'&&<p>Отправка…</p>}
   {error&&<p role="alert" className="rec-error">{error}</p>}
   <div className="rec-actions">
    {phase==='review'&&<><button type="button" onClick={close}>Отмена</button><button type="button" onClick={()=>{close();toast('Зажмите кнопку, чтобы записать заново')}}>Заново</button><button type="button" className="primary" onClick={()=>review&&doSend(review)}>Отправить</button></>}
    {phase==='sending'&&<button type="button" disabled>Отправка…</button>}
    {phase==='error'&&<button type="button" onClick={close}>Закрыть</button>}
   </div>
  </section></div>,document.body)}
 </>
}
