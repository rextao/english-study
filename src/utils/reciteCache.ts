/**
 * reciteCache.ts — 背单词页的本地音频缓存（IndexedDB）。
 *
 * 打开背词首页、还没点「开始学习」时，先把本周要背的单词发音拉到本地，
 * 小朋友点喇叭时不再现场等网络，断网也能播。查询词义不进这里，只缓存发音。
 *
 * 三个仓库：
 *  - audio：key = 归一化后的单词，value = base64 音频本体（与 /api/tts 的返回格式一致）；
 *  - audioMeta：同样的 key，只存大小 / 时间——统计和清过期不用把音频读进内存；
 *  - meta：整份「本周缓存概况」，调试面板里给家长看进度。
 *
 * 隐私模式 / 老浏览器没有 IndexedDB 时全部静默降级：不缓存，页面照常用。
 */

const DB_NAME = 'es-recite-cache'
const DB_VERSION = 1
const STORE_AUDIO = 'audio'
const STORE_AUDIO_META = 'audioMeta'
const STORE_META = 'meta'
const META_KEY = 'recite'
/** 音频留 30 天：够覆盖一整周的复习周期，再久就白占空间 */
const AUDIO_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** 每写 50 条清一次过期音频，不用每次写都扫全库 */
const PRUNE_EVERY = 50

export interface PersistedAudio {
  /** base64 编码的音频（MP3 / MP4），与 /api/tts 返回的 audio 字段一致 */
  audio: string
  mime: string
  /** 大小按 base64 长度估（× 0.75），统计占用用，不必精确到字节 */
  size: number
  cachedAt: number
}

export interface ReciteCacheMeta {
  taskId: string
  weekStart: number
  weekEnd: number
  total: number
  done: number
  failed: string[]
  status: 'done' | 'error'
  reason: string
  cachedAt: number
}

export interface AudioCacheStats {
  count: number
  bytes: number
}

let dbPromise: Promise<IDBDatabase | null> | null = null
let writeCounter = 0

/** 数据库只开一次：打开失败 / 不支持就永久记住 null，后面的读写全走空实现 */
function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  if (typeof indexedDB === 'undefined') {
    dbPromise = Promise.resolve(null)
    return dbPromise
  }
  dbPromise = new Promise<IDBDatabase | null>(resolve => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE_AUDIO)) db.createObjectStore(STORE_AUDIO)
        if (!db.objectStoreNames.contains(STORE_AUDIO_META)) db.createObjectStore(STORE_AUDIO_META)
        if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META)
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
      request.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

/** 在单个仓库上跑一个请求；出错统一回 null，不把 IndexedDB 的异常抛到业务里 */
function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return openDb().then(db => {
    if (!db) return null
    return new Promise<T | null>(resolve => {
      try {
        const request = run(db.transaction(storeName, mode).objectStore(storeName))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  })
}

/**
 * 音频缓存键：与 speech.ts 的内存 Map 同一套归一化规则（去前后空格、压缩中间空格、小写），
 * 保证预取写进去的键，点喇叭时也能用同一个键读出来。
 */
export function audioCacheKeyOf(text: string) {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** 读本地音频；没有（或缓存不可用）返回 null */
export function loadPersistedAudio(key: string): Promise<PersistedAudio | null> {
  return withStore<PersistedAudio | undefined>(STORE_AUDIO, 'readonly', store => store.get(key))
    .then(value => value ?? null)
}

/** 写一条音频：本体和元数据一次事务写进两个仓库，统计时不用解码音频 */
export function storePersistedAudio(key: string, audio: string, mime: string): Promise<void> {
  const entry: PersistedAudio = {
    audio,
    mime,
    size: Math.round(audio.length * 0.75),
    cachedAt: Date.now(),
  }
  writeCounter += 1
  if (writeCounter % PRUNE_EVERY === 0) void pruneExpiredAudio()
  return openDb().then(db => {
    if (!db) return
    return new Promise<void>(resolve => {
      try {
        const transaction = db.transaction([STORE_AUDIO, STORE_AUDIO_META], 'readwrite')
        transaction.objectStore(STORE_AUDIO).put(entry, key)
        transaction.objectStore(STORE_AUDIO_META).put({ size: entry.size, cachedAt: entry.cachedAt }, key)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => resolve()
        transaction.onabort = () => resolve()
      } catch {
        resolve()
      }
    })
  })
}

/** 本地音频的总条数与占用大小（只扫元数据仓库） */
export function getAudioCacheStats(): Promise<AudioCacheStats> {
  return openDb().then(db => {
    if (!db) return { count: 0, bytes: 0 }
    return new Promise<AudioCacheStats>(resolve => {
      try {
        let count = 0
        let bytes = 0
        const request = db.transaction(STORE_AUDIO_META, 'readonly').objectStore(STORE_AUDIO_META).openCursor()
        request.onsuccess = () => {
          const cursor = request.result
          if (!cursor) {
            resolve({ count, bytes })
            return
          }
          const value = cursor.value as { size?: number } | undefined
          count += 1
          bytes += Number(value?.size) || 0
          cursor.continue()
        }
        request.onerror = () => resolve({ count, bytes })
      } catch {
        resolve({ count: 0, bytes: 0 })
      }
    })
  })
}

/** 清掉过期音频：只在元数据里找超过 30 天的键，再照着删两个仓库 */
function pruneExpiredAudio(): Promise<void> {
  return openDb().then(db => {
    if (!db) return
    return new Promise<void>(resolve => {
      try {
        const stale: IDBValidKey[] = []
        const request = db.transaction(STORE_AUDIO_META, 'readonly').objectStore(STORE_AUDIO_META).openCursor()
        request.onsuccess = () => {
          const cursor = request.result
          if (!cursor) {
            if (stale.length === 0) {
              resolve()
              return
            }
            try {
              const transaction = db.transaction([STORE_AUDIO, STORE_AUDIO_META], 'readwrite')
              const audio = transaction.objectStore(STORE_AUDIO)
              const meta = transaction.objectStore(STORE_AUDIO_META)
              for (const key of stale) {
                audio.delete(key)
                meta.delete(key)
              }
              transaction.oncomplete = () => resolve()
              transaction.onerror = () => resolve()
              transaction.onabort = () => resolve()
            } catch {
              resolve()
            }
            return
          }
          const value = cursor.value as { cachedAt?: number } | undefined
          if (value && typeof value.cachedAt === 'number' && Date.now() - value.cachedAt > AUDIO_TTL_MS) {
            stale.push(cursor.key)
          }
          cursor.continue()
        }
        request.onerror = () => resolve()
      } catch {
        resolve()
      }
    })
  })
}

/** 记一份本周缓存概况，下次进来不用重拉也能在调试面板里看到上次的结果 */
export function saveReciteMeta(meta: ReciteCacheMeta): Promise<void> {
  return withStore(STORE_META, 'readwrite', store => store.put(meta, META_KEY))
    .then(() => undefined)
}

export function loadReciteMeta(): Promise<ReciteCacheMeta | null> {
  return withStore<ReciteCacheMeta | undefined>(STORE_META, 'readonly', store => store.get(META_KEY))
    .then(value => value ?? null)
}

/** 清空本地缓存（音频 + 元数据 + 概况），调试面板里的危险操作 */
export function clearReciteCache(): Promise<void> {
  return openDb().then(db => {
    if (!db) return
    return new Promise<void>(resolve => {
      try {
        const transaction = db.transaction([STORE_AUDIO, STORE_AUDIO_META, STORE_META], 'readwrite')
        transaction.objectStore(STORE_AUDIO).clear()
        transaction.objectStore(STORE_AUDIO_META).clear()
        transaction.objectStore(STORE_META).clear()
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => resolve()
        transaction.onabort = () => resolve()
      } catch {
        resolve()
      }
    })
  })
}
