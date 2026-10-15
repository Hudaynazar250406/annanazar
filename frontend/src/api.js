export const API=(import.meta.env.VITE_API_URL||'http://localhost:8000').replace(/\/$/,'')
export const getToken=()=>localStorage.getItem('token')
export const setToken=t=>t?localStorage.setItem('token',t):localStorage.removeItem('token')
export async function request(path,opts={}){
 const headers={...opts.headers};if(getToken())headers.Authorization='Bearer '+getToken()
 if(opts.json!==undefined){headers['Content-Type']='application/json';opts={...opts,body:JSON.stringify(opts.json)}}
 const r=await fetch(API+path,{...opts,headers,cache:'no-store'})
 if(r.status===401&&getToken()&&path!=='/api/login'){setToken(null);location.reload()}
 if(!r.ok){const e=await r.json().catch(()=>({}));throw new Error(typeof e.detail==='string'?e.detail:'Ошибка: '+r.status)}return r
}
export async function api(path,opts={}){return(await request(path,opts)).json()}
