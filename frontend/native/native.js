import {Capacitor} from '@capacitor/core'
import {BiometricAuth} from '@aparajita/capacitor-biometric-auth'
import {SecureStorage} from '@aparajita/capacitor-secure-storage'
import {PushNotifications} from '@capacitor/push-notifications'
export const isNative=Capacitor.isNativePlatform()
const KEY='vault-passphrase'
const PROMPT={reason:'Открыть закрытый раздел',cancelTitle:'Отмена',allowDeviceCredential:false,androidTitle:'Закрытый раздел',androidSubtitle:'Подтвердите отпечаток или лицо'}
export const bio={
 async available(){if(!isNative)return false;try{const r=await BiometricAuth.checkBiometry();return !!r.isAvailable}catch{return false}},
 async has(){if(!isNative)return false;try{return !!(await SecureStorage.get(KEY))}catch{return false}},
 async enable(secret){await BiometricAuth.authenticate({...PROMPT,reason:'Включить вход по биометрии'});await SecureStorage.set(KEY,secret)},
 async unlock(){await BiometricAuth.authenticate(PROMPT);const value=await SecureStorage.get(KEY);return typeof value==='string'?value:null},
 async disable(){try{await SecureStorage.remove(KEY)}catch{}}
}
let listening=false,post=null
export async function registerPush(send){
 if(!isNative)return false
 post=send
 let perm=await PushNotifications.checkPermissions()
 if(perm.receive==='prompt'||perm.receive==='prompt-with-rationale')perm=await PushNotifications.requestPermissions()
 if(perm.receive!=='granted')return false
 if(!listening){
  listening=true
  await PushNotifications.addListener('registration',t=>{if(post)Promise.resolve(post(t.value)).catch(()=>{})})
  await PushNotifications.addListener('registrationError',()=>{})
  await PushNotifications.addListener('pushNotificationActionPerformed',a=>{const s=a.notification&&a.notification.data&&a.notification.data.section;if(s)history.replaceState(null,'','?section='+encodeURIComponent(s))})
 }
 await PushNotifications.register()
 return true
}
