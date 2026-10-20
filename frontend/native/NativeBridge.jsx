import {useEffect} from 'react'
import {api,getToken} from './api'
import {isNative,registerPush} from './native.js'
export default function NativeBridge(){
 useEffect(()=>{
  if(!isNative)return
  let stopped=false,doneFor='',busy=false
  const tick=async()=>{
   const jwt=getToken()
   if(!jwt||busy||stopped||doneFor===jwt)return
   busy=true
   try{const ok=await registerPush(value=>api('/api/notifications/fcm',{method:'POST',json:{token:value}}));if(ok)doneFor=jwt}
   catch{}
   finally{busy=false}
  }
  const id=setInterval(tick,4000);tick()
  return()=>{stopped=true;clearInterval(id)}
 },[])
 return null
}
