// «Пять идей» без ПК: телефонная версия работает с копией на Яндекс Диске пользователя.
// Страница шлёт те же запросы, что и к ПК (/api/..., /media/...), а этот Service Worker отвечает на них
// данными из папки приложения на Диске. ПК раз в 5 минут выгружает туда снимок и видео и забирает
// оценки (actions/*.json). Токен Яндекса хранится только на телефоне (Cache Storage «vi-auth»).
const VERSION = 'v1'
const API = 'https://cloud-api.yandex.net/v1/disk/resources'
const hrefs = new Map() // путь на Диске → [временная ссылка, когда получена]

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

async function token() {
  const cache = await caches.open('vi-auth')
  const saved = await cache.match('token')
  return saved ? (await saved.text()).trim() : ''
}

async function local(key, fallback) {
  const cache = await caches.open('vi-data')
  const saved = await cache.match(key)
  if (!saved) return fallback
  try { return await saved.json() } catch { return fallback }
}

async function saveLocal(key, value) {
  const cache = await caches.open('vi-data')
  await cache.put(key, new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }))
}

class AuthError extends Error {}

async function api(suffix, params, init = {}) {
  const t = await token()
  if (!t) throw new AuthError('нет входа')
  const url = new URL(API + suffix)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const response = await fetch(url, { ...init, headers: { Authorization: 'OAuth ' + t, ...(init.headers || {}) } })
  if (response.status === 401) {
    await (await caches.open('vi-auth')).delete('token')
    throw new AuthError('вход устарел')
  }
  return response
}

async function href(path) {
  const known = hrefs.get(path)
  if (known && Date.now() - known[1] < 20 * 60 * 1000) return known[0]
  const response = await api('/download', { path: 'app:/' + path })
  if (response.status === 404) return null
  if (!response.ok) throw new Error('Диск ответил ' + response.status)
  const link = (await response.json()).href
  hrefs.set(path, [link, Date.now()])
  return link
}

async function upload(path, body) {
  let target = await api('/upload', { path: 'app:/' + path, overwrite: 'true' })
  if (target.status === 409) { // нет папки — создаём и пробуем снова
    await api('', { path: 'app:/' + path.split('/').slice(0, -1).join('/') }, { method: 'PUT' })
    target = await api('/upload', { path: 'app:/' + path, overwrite: 'true' })
  }
  if (!target.ok) throw new Error('Диск не дал загрузить: ' + target.status)
  const put = await fetch((await target.json()).href, { method: 'PUT', body })
  if (!put.ok && put.status !== 201 && put.status !== 202) throw new Error('Загрузка не удалась: ' + put.status)
}

// Снимок зашифрован (AES-256-GCM) и лежит рядом со страницей: ../data/snapshot.bin.
// Ключ — в свойствах файла key.json на Диске, его отдаёт только API с вашим входом.
async function diskKey() {
  const response = await api('', { path: 'app:/key.json', fields: 'custom_properties' })
  if (!response.ok) return null
  const k = ((await response.json()).custom_properties || {}).k
  if (!k) return null
  const raw = Uint8Array.from(atob(k), (c) => c.charCodeAt(0))
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt'])
}

async function readSnapshot() {
  const key = await diskKey()
  if (!key) return null
  const url = new URL('../data/snapshot.bin?t=' + Date.now(), self.registration.scope)
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) return null
  const blob = new Uint8Array(await response.arrayBuffer())
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.slice(0, 12) }, key, blob.slice(12))
  const text = await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
  return JSON.parse(text)
}

async function snapshot() {
  try {
    const fresh = await readSnapshot()
    if (fresh) { await saveLocal('snapshot', fresh); return fresh }
  } catch (error) {
    if (error instanceof AuthError) throw error
  }
  return local('snapshot', null) // нет сети — последний сохранённый
}

async function state() {
  const data = await snapshot()
  if (!data) return json({ detail: 'Копии на Диске пока нет: включите программу на ПК один раз' }, 503)
  const actions = (await local('actions', [])).filter((a) => Date.now() - a.ts < 14 * 86400000)
  const done = new Set(actions.map((a) => a.id))
  const pool = [...(data.wanted || []), ...(data.candidates || []), ...(data.qwen || [])]
  for (const key of ['candidates', 'qwen', 'wanted']) {
    if (Array.isArray(data[key])) data[key] = data[key].filter((c) => !done.has(c.id))
  }
  // «Снимаю» и «Смонтировал», отмеченные на телефоне, показываем сразу.
  const filmingIds = new Set(actions.filter((a) => a.rating === 'filming').map((a) => a.id))
  const usedIds = new Set(actions.filter((a) => a.rating === 'used').map((a) => a.id))
  if (Array.isArray(data.filming)) {
    for (const id of filmingIds) {
      const clip = pool.find((c) => c.id === id)
      if (clip && !data.filming.some((c) => c.id === id)) data.filming.unshift(clip)
    }
    data.filming = data.filming.filter((c) => !usedIds.has(c.id))
  }
  const extra = await local('ideas', [])
  data.ideas = [...extra, ...(data.ideas || [])]
  delete data.bank_top
  return json({ ...data, offline: true, offline_actions: actions.length, token: 'offline' })
}

async function act(id, rating, want) {
  const ts = Date.now()
  const action = { id, rating, want: !!want, ts }
  await upload(`actions/${ts}-${id}-${rating}.json`, JSON.stringify(action))
  const actions = (await local('actions', [])).filter((a) => Date.now() - a.ts < 14 * 86400000)
  actions.push(action)
  await saveLocal('actions', actions)
}

async function nextIdea() {
  const data = await snapshot()
  const shown = await local('ideas', [])
  const seen = new Set([...shown.map((i) => i.bank_id), ...((data && data.ideas) || []).map((i) => i.bank_id)].filter(Boolean))
  const next = ((data && data.bank_top) || []).find((i) => !seen.has(i.bank_id))
  if (!next) return json({ detail: 'Лучшие идеи банка закончились — новые придумает ПК, когда включится' }, 404)
  await saveLocal('ideas', [{ ...next, id: 'bank-' + next.bank_id, created: new Date().toISOString(), model: 'банк идей (ПК выключен)' }, ...shown].slice(0, 30))
  return json({ saved: true, message: 'ПК выключен — вот лучшая идея из банка' })
}

async function media(path) {
  const link = await href(path)
  if (!link) return new Response('Этот файл не сохранён для работы без ПК', { status: 404 })
  return Response.redirect(link, 302)
}

async function handle(request, url) {
  const path = url.pathname
  try {
    if (path === '/api/mobile/state') return await state()
    if (path === '/api/pair') return json({ saved: true })
    let m = path.match(/^\/media\/(\d{10,25})\/(?:video|phone)\.mp4$/) || path.match(/^\/api\/preview\/(\d{10,25})$/)
    if (m) return await media(`media/${m[1]}/video.mp4`)
    m = path.match(/^\/media\/(\d{10,25})\/cover\.jpg$/) || path.match(/^\/api\/trend-cover\/(\d{10,25})$/)
    if (m) return await media(`media/${m[1]}/cover.jpg`)
    m = path.match(/^\/api\/idea-frame\/(\d+)\/(shot-[1-6]\.jpg)$/)
    if (m) return await media(`frames/${m[1]}/${m[2]}`)
    m = path.match(/^\/api\/feedback\/(\d{10,25})$/)
    if (m && request.method === 'POST') {
      const body = await request.json().catch(() => ({}))
      if (!['suitable', 'unsuitable', 'used'].includes(body.rating)) return json({ detail: 'Неизвестная оценка' }, 400)
      await act(m[1], body.rating, body.want)
      return json({ saved: true, message: 'ПК выключен: оценка сохранена на Диске и применится, когда ПК включится' })
    }
    m = path.match(/^\/api\/filming\/(\d{10,25})$/)
    if (m && request.method === 'POST') {
      await act(m[1], 'filming', false)
      return json({ saved: true, message: 'Перенесено в «Снимаю» (применится на ПК)' })
    }
    if (path === '/api/idea' && request.method === 'POST') return await nextIdea()
    return json({ detail: 'ПК выключен: это действие заработает, когда программа на ПК запустится' }, 503)
  } catch (error) {
    if (error instanceof AuthError) return json({ detail: 'Войдите в Яндекс заново: закройте и откройте приложение' }, 503)
    return json({ detail: 'Нет связи с Яндекс Диском: ' + (error && error.message) }, 503)
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')) {
    event.respondWith(handle(event.request, url))
  }
})
