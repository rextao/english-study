/**
 * reciteRecordingQueue.ts — 录音片段的本地待传队列（IndexedDB）。
 *
 * 录音一停就先把整段字节存到本地，再往服务器传；传完才删本地副本。
 * 关页面 / 断网 / 上传失败时副本还在，下次进背词页自动补传（clientKey 保证不会重复入库）。
 * 存的是原始字节（ArrayBuffer），不转 base64：省一份体积，也免去编解码开销。
 *
 * 隐私模式 / 老浏览器没有 IndexedDB 时静默降级（不缓存，照常走在线上传）。
 */

const DB_NAME = 'es-recite-uploads'
const DB_VERSION = 1
const STORE = 'segments'
/** 与服务器保留期对齐：超过 15 天的片段再传也没意义，写入时顺带清掉 */
const TTL_MS = 15 * 86400000
/** 本地最多留多少段（再多的先丢最旧的，避免把手机空间吃满） */
const MAX_SEGMENTS = 80

export interface QueuedRecordingSegment {
  /** 片段幂等键，同时是主键 */
  key: string
  /** 绑定的会话：补传时也带着它，录音才落回这一次学习 */
  sessionId: string
  mime: string
  durationMs: number
  /** 开始录制的时间（客户端毫秒） */
  recordedAt: number
  /** 片段在这次学习里的序号（从 0 起） */
  segmentIndex: number
  size: number
  bytes: ArrayBuffer
  queuedAt: number
}

let dbPromise: Promise<IDBDatabase | null> | null = null

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
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' })
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

/** 本地留一份片段：写成功返回 true，写不进去（隐私模式 / 空间不足）返回 false */
export function queueRecordingSegment(segment: QueuedRecordingSegment): Promise<boolean> {
  return openDb().then(db => {
    if (!db) return false
    return new Promise<boolean>(resolve => {
      try {
        const transaction = db.transaction(STORE, 'readwrite')
        transaction.objectStore(STORE).put(segment)
        transaction.oncomplete = () => resolve(true)
        transaction.onerror = () => resolve(false)
        transaction.onabort = () => resolve(false)
      } catch {
        resolve(false)
      }
    })
  })
}

/** 上传成功 / 服务端明确不要了：删掉本地这份 */
export function dropQueuedRecordingSegment(key: string): Promise<void> {
  return openDb().then(db => {
    if (!db) return
    return new Promise<void>(resolve => {
      try {
        const transaction = db.transaction(STORE, 'readwrite')
        transaction.objectStore(STORE).delete(key)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => resolve()
        transaction.onabort = () => resolve()
      } catch {
        resolve()
      }
    })
  })
}

/** 待补传的片段：按录制时间排，先录的先传 */
export function listQueuedRecordingSegments(): Promise<QueuedRecordingSegment[]> {
  return openDb().then(db => {
    if (!db) return []
    return new Promise<QueuedRecordingSegment[]>(resolve => {
      try {
        const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
        request.onsuccess = () => {
          const rows = Array.isArray(request.result) ? request.result as QueuedRecordingSegment[] : []
          resolve(rows.slice().sort((left, right) => left.recordedAt - right.recordedAt))
        }
        request.onerror = () => resolve([])
      } catch {
        resolve([])
      }
    })
  })
}

/** 待补传的片段条数（调试面板用） */
export function countQueuedRecordingSegments(): Promise<number> {
  return listQueuedRecordingSegments().then(rows => rows.length)
}

/**
 * 清掉过期的片段，条数超上限时丢最旧的。
 * 只在写入后调用，扫描量很小（最多几十条元数据，字节不读进内存）。
 */
export function pruneQueuedRecordingSegments(): Promise<void> {
  return openDb().then(db => {
    if (!db) return
    return new Promise<void>(resolve => {
      try {
        const stale: IDBValidKey[] = []
        const request = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor()
        const rows: { key: IDBValidKey; queuedAt: number }[] = []
        request.onsuccess = () => {
          const cursor = request.result
          if (cursor) {
            const value = cursor.value as QueuedRecordingSegment | undefined
            const queuedAt = Number(value?.queuedAt) || 0
            if (Date.now() - queuedAt > TTL_MS) stale.push(cursor.key)
            else rows.push({ key: cursor.key as IDBValidKey, queuedAt })
            cursor.continue()
            return
          }
          rows.sort((left, right) => left.queuedAt - right.queuedAt)
          if (rows.length > MAX_SEGMENTS) {
            for (const row of rows.slice(0, rows.length - MAX_SEGMENTS)) stale.push(row.key)
          }
          if (stale.length === 0) {
            resolve()
            return
          }
          try {
            const transaction = db.transaction(STORE, 'readwrite')
            const store = transaction.objectStore(STORE)
            for (const key of stale) store.delete(key)
            transaction.oncomplete = () => resolve()
            transaction.onerror = () => resolve()
            transaction.onabort = () => resolve()
          } catch {
            resolve()
          }
        }
        request.onerror = () => resolve()
      } catch {
        resolve()
      }
    })
  })
}
