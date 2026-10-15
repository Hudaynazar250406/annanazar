export const API = (import.meta.env.VITE_API_URL || 'http://localhost:8000').replace(/\/$/, '')
export const getToken = () => localStorage.getItem('token')
export const setToken = (t) => (t ? localStorage.setItem('token', t) : localStorage.removeItem('token'))

export async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) }
  const token = getToken()
  if (token) headers.Authorization = 'Bearer ' + token
  let body = opts.body
  if (opts.json) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.json)
  }
  const r = await fetch(API + path, { ...opts, headers, body })
  if (r.status === 401 && token && path !== '/api/login') {
    setToken(null)
    location.reload()
  }
  if (!r.ok) {
    const e = await r.json().catch(() => ({}))
    throw new Error(e.detail || r.status)
  }
  return r.json()
}
