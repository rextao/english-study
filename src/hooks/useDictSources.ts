import { useEffect, useState } from 'react'

const SERVER = 'http://127.0.0.1:3456'

/** 本地词典（ECDICT）装没装 */
export interface LocalDictInfo {
  ready: boolean
  /** 词条数；没装就是 0 */
  count: number
  /** 产物目录，没装时用来提示往哪儿放 */
  dir: string
  /** 用 DICT_ECDICT_OFF=1 手动关掉了 */
  disabled: boolean
}

export interface DictSources {
  local: LocalDictInfo
  /** 服务端能不能联外网（DICT_NO_NETWORK=1 时为 false） */
  network: boolean
}

type JsonBody = Record<string, unknown>

/**
 * 字段齐全才认这份数据。
 * 旧版本服务没有这个接口时会回 404 { error: 'not found' }，
 * 照抄进 state 的话界面会显示「本地词典 undefined 词条」。
 */
function toSources(body: JsonBody): DictSources | null {
  const local = body.local
  if (local === null || typeof local !== 'object') return null
  const info = local as JsonBody
  if (typeof info.ready !== 'boolean' || typeof body.network !== 'boolean') return null
  const count = typeof info.count === 'number' && Number.isFinite(info.count) ? info.count : 0
  return {
    local: {
      ready: info.ready,
      count,
      dir: typeof info.dir === 'string' ? info.dir : '',
      disabled: info.disabled === true,
    },
    network: body.network,
  }
}

/**
 * 查一次服务端的词典来源状态。
 * 服务没起 / 是旧版本都返回 null，界面据此什么都不显示——
 * 这只是个提示，缺了不影响查词。
 */
export function useDictSources() {
  const [sources, setSources] = useState<DictSources | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await fetch(SERVER + '/api/dict/sources')
        if (!res.ok) return
        const body: unknown = await res.json()
        if (!alive || body === null || typeof body !== 'object') return
        setSources(toSources(body as JsonBody))
      } catch {
        // 服务没起，不提示
      }
    })()
    return () => { alive = false }
  }, [])

  return { sources }
}
