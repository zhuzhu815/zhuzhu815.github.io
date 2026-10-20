/**
 * 灵感墙 · 分享接收 Service Worker（M6，独立 scope `/share-target/`）
 *
 * 为什么是独立 SW：主 PWA Service Worker 由 vite-plugin-pwa 的 generateSW 生成（scope `/`），
 * 负责离线/更新；系统分享是 POST 导航，需要自定义 fetch 处理。这里用同源更窄 scope 的
 * 独立 worker 只接管 `/share-target/`，主 SW 完全不动，M7 部署风险最小。
 *
 * 流程：
 * 1. Android 系统分享 → POST /share-target（multipart/form-data，字段 title/text/url/media）
 * 2. 解析 FormData，图片与元数据暂存到 CacheStorage（cache: inspiration-share-inbox-v1）
 * 3. 303 重定向到 /#/capture?shareToken=<token>，由速记页读取、预填并清理
 *
 * 注意：本文件位于 public/ 会被原样拷贝到 dist，不经 TS/打包；客户端对共享格式的读取见
 * src/features/share/shareInbox.ts，两边的常量与 key 必须保持一致。
 */
const SHARE_CACHE_NAME = 'inspiration-share-inbox-v1'
/** 兼容带/不带尾斜杠的 action（manifest 使用 `/share-target/`，SW scope 为路径前缀匹配） */
const SHARE_PATHS = new Set(['/share-target', '/share-target/'])
const SHARE_TOKEN_PARAM = 'shareToken'
const SHARE_ERROR_PARAM = 'shareError'
const STAGING_PATH_PREFIX = '/__share_inbox__/'
const MAX_FILES = 9
const MAX_FILE_BYTES = 12 * 1024 * 1024
const MAX_TEXT_LENGTH = 10_000
const MAX_TITLE_LENGTH = 200
const MAX_URL_LENGTH = 2048

self.addEventListener('install', () => {
  // 分享 worker 立即进入 waiting→active，保证安装后即可被系统分享命中
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

/** 生成本次分享的一次性 token（兼容没有 randomUUID 的旧内核） */
function createToken() {
  if (self.crypto && typeof self.crypto.randomUUID === 'function') {
    return self.crypto.randomUUID()
  }
  const random = Math.random().toString(36).slice(2)
  return `${Date.now().toString(36)}-${random}`
}

function stagingUrl(token, suffix) {
  return new URL(`${STAGING_PATH_PREFIX}${token}/${suffix}`, self.location.origin).href
}

function redirectTo(params) {
  const query = params.toString()
  const target = `${self.location.origin}/#/capture${query ? `?${query}` : ''}`
  return Response.redirect(target, 303)
}

function isUploadedFile(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.size === 'number' &&
    typeof value.type === 'string' &&
    typeof value.arrayBuffer === 'function'
  )
}

function safeString(value, maxLength) {
  if (typeof value !== 'string') return ''
  return value.slice(0, maxLength)
}

/** 清空上一次分享的暂存，只保留最新一次（避免 CacheStorage 无限增长） */
async function clearStaging(cache) {
  const keys = await cache.keys()
  await Promise.all(keys.map((request) => cache.delete(request)))
}

async function handleShare(request) {
  let token = ''
  try {
    token = createToken()
    const form = await request.formData()
    const cache = await self.caches.open(SHARE_CACHE_NAME)
    await clearStaging(cache)

    const media = form.getAll('media').filter(isUploadedFile)
    const files = []
    let savedCount = 0

    for (const file of media) {
      if (savedCount >= MAX_FILES) break
      if (!file.type.startsWith('image/')) continue
      if (file.size <= 0 || file.size > MAX_FILE_BYTES) continue

      const index = savedCount
      const safeName = typeof file.name === 'string' && file.name.length > 0 ? file.name : ''
      await cache.put(
        new Request(stagingUrl(token, `file/${index}`)),
        new Response(file, {
          headers: {
            'content-type': file.type,
            'x-file-name': encodeURIComponent(safeName),
          },
        }),
      )
      files.push({ index, name: safeName, type: file.type, size: file.size })
      savedCount += 1
    }

    const meta = {
      version: 1,
      token,
      title: safeString(form.get('title'), MAX_TITLE_LENGTH),
      text: safeString(form.get('text'), MAX_TEXT_LENGTH),
      url: safeString(form.get('url'), MAX_URL_LENGTH),
      files,
      receivedAt: new Date().toISOString(),
    }
    await cache.put(
      new Request(stagingUrl(token, 'meta')),
      new Response(JSON.stringify(meta), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    )

    return redirectTo(new URLSearchParams({ [SHARE_TOKEN_PARAM]: token }))
  } catch (error) {
    // 任何解析/写缓存失败都回落到速记页并给出中文提示，不把错误页丢给用户
    console.warn('[share-target] 接收分享失败，已回落到手动添加', error)
    if (token) {
      try {
        const cache = await self.caches.open(SHARE_CACHE_NAME)
        await clearStaging(cache)
      } catch {
        // 清理失败不影响回落
      }
    }
    return redirectTo(new URLSearchParams({ [SHARE_ERROR_PARAM]: '1' }))
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return
  if (event.request.method !== 'POST' || !SHARE_PATHS.has(url.pathname)) return
  event.respondWith(handleShare(event.request))
})
