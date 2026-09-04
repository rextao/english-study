import { useCallback, useEffect, useState } from 'react'
import type { VocabLibrary, VocabLibraryInfo } from '../types/vocab'

const SERVER = 'http://127.0.0.1:3456'
const LABELS_URL = SERVER + '/api/vocab-labels'
/** 本地服务没起时的兜底；服务可用时也镜像一份，下次离线还能看到自定义标签 */
const MIRROR_KEY = 'vocab-labels'

type LabelMap = Record<string, string>

export type UpdateLabelResult = { ok: true } | { ok: false; error: string }

function readMirror(): LabelMap {
  try {
    const parsed = JSON.parse(localStorage.getItem(MIRROR_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' ? (parsed as LabelMap) : {}
  } catch {
    return {}
  }
}

function writeMirror(labels: LabelMap) {
  try {
    localStorage.setItem(MIRROR_KEY, JSON.stringify(labels))
  } catch {
    // 隐私模式下写不了，忽略
  }
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

/** 构建期把 vocab/*.json 打包进来，所以离线也能查词库 */
function loadBundledLibraries(): VocabLibraryInfo[] {
  const modules = import.meta.glob('/vocab/*.json', { eager: true }) as Record<string, { default: VocabLibrary }>
  return Object.entries(modules)
    .map(([file, mod]) => ({
      ...mod.default,
      file: file.startsWith('/') ? file.slice(1) : file,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

export type VocabLibrariesApi = ReturnType<typeof useVocabLibraries>

export function useVocabLibraries() {
  const [libraries, setLibraries] = useState<VocabLibraryInfo[]>([])
  const [labels, setLabels]       = useState<LabelMap>({})
  const [loading, setLoading]     = useState(true)
  const [offline, setOffline]     = useState(false)

  useEffect(() => {
    setLibraries(loadBundledLibraries())
    let alive = true

    async function load() {
      const mirror = readMirror()
      try {
        const res  = await fetch(LABELS_URL)
        const data = (await res.json()) as { labels?: LabelMap }
        let next = data.labels ?? {}
        // 迁移：浏览器里有、服务端没有的标签推上去；两边都有时以服务端为准
        const missing = Object.fromEntries(
          Object.entries(mirror).filter(([id]) => next[id] == null),
        )
        if (Object.keys(missing).length > 0) {
          await fetch(LABELS_URL, jsonInit('POST', { labels: missing }))
          next = { ...next, ...missing }
        }
        if (!alive) return
        setLabels(next)
        writeMirror(next)
      } catch {
        if (!alive) return
        setOffline(true)
        setLabels(mirror)
      }
      if (alive) setLoading(false)
    }

    load()
    return () => { alive = false }
  }, [])

  /** 没改过标签就回落到词库 id */
  const getLabelById   = useCallback((id: string) => labels[id] ?? id, [labels])
  const hasCustomLabel = useCallback((id: string) => labels[id] != null, [labels])

  const applyLocally = useCallback((id: string, label: string | null) => {
    setLabels(prev => {
      const next = { ...prev }
      if (label == null) delete next[id]
      else next[id] = label
      writeMirror(next)
      return next
    })
  }, [])

  /** 改标签；服务端会拦空标签和重名，错误信息交给页面显示 */
  const updateLabel = useCallback(async (id: string, label: string): Promise<UpdateLabelResult> => {
    const value = label.trim()
    if (!value) return { ok: false, error: '标签不能为空' }
    try {
      const res  = await fetch(LABELS_URL + '/' + encodeURIComponent(id), jsonInit('PATCH', { label: value }))
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null
      if (!res.ok || data?.ok !== true) return { ok: false, error: data?.error ?? '保存失败' }
      setOffline(false)
    } catch {
      // 本地服务没起：先记在浏览器里，服务起来后会自动补齐到服务端
      setOffline(true)
    }
    applyLocally(id, value)
    return { ok: true }
  }, [applyLocally])

  /** 重置为默认标签（回落到词库 id） */
  const resetLabel = useCallback(async (id: string) => {
    try {
      await fetch(LABELS_URL + '/' + encodeURIComponent(id), { method: 'DELETE' })
      setOffline(false)
    } catch {
      setOffline(true)
    }
    applyLocally(id, null)
  }, [applyLocally])

  return { libraries, labels, loading, offline, getLabelById, hasCustomLabel, updateLabel, resetLabel }
}
