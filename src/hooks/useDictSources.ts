import { useCallback, useEffect, useMemo, useState } from 'react'

import { queryApi } from '../utils/apiCache'

export interface DictSources {
  /** 服务端能不能联外网（DICT_NO_NETWORK=1 时为 false） */
  network: boolean
  /** 词典缓存统计 */
  cache: CacheStats
  /** 外部接口的链路状态，按调用顺序 */
  external: ExternalSource[]
}

/** 词典缓存统计 */
export interface CacheStats {
  total: number
  /** status===ok 的条数 */
  complete: number
}

/** 一个外部接口的链路状态 */
export interface ExternalSource {
  id: string
  name: string
  url: string
  needsKey: boolean
  /** 查词时这一步会不会实际执行 */
  available: boolean
  /** 下面四个只有需要密钥的接口才有 */
  hasKey?: boolean
  hasAppId?: boolean
  keyHint?: string
  appIdHint?: string
}

/** 设置页「查词链路」里的一步 */
export interface DictChainStep {
  id: string
  name: string
  /** 这一步干什么 */
  desc: string
  /** 查词时会不会实际走到这一步；false = 灰色「跳过」 */
  available: boolean
  /** available=false 时给用户看的跳过原因 */
  reason: string
  needsKey: boolean
  hasKey?: boolean
  hasAppId?: boolean
  keyHint?: string
  appIdHint?: string
}

type JsonBody = Record<string, unknown>

/**
 * 字段齐全才认这份数据。
 * 旧版本服务没有这个接口时会回 404 { error: 'not found' }，
 * 照抄进 state 的话界面会显示「缓存 undefined 条」。
 */
function toSources(body: JsonBody): DictSources | null {
  if (typeof body.network !== 'boolean') return null
  // 没有 external 数组说明是老版本服务，查词链路段没法显示
  if (!Array.isArray(body.external)) return null
  const external = (body.external as unknown[]).map(toExternal).filter((s): s is ExternalSource => s !== null)
  if (external.length === 0) return null
  const cache = toCacheStats(body.cache)
  return { network: body.network, cache, external }
}

function toCacheStats(body: unknown): CacheStats {
  if (body === null || typeof body !== 'object') return { total: 0, complete: 0 }
  const obj = body as JsonBody
  const total = typeof obj.total === 'number' && Number.isFinite(obj.total) ? obj.total : 0
  const complete = typeof obj.complete === 'number' && Number.isFinite(obj.complete) ? obj.complete : 0
  return { total, complete }
}

function toExternal(body: unknown): ExternalSource | null {
  if (body === null || typeof body !== 'object') return null
  const obj = body as JsonBody
  if (typeof obj.id !== 'string' || typeof obj.name !== 'string' || typeof obj.available !== 'boolean') return null
  return {
    id: obj.id,
    name: obj.name,
    url: typeof obj.url === 'string' ? obj.url : '',
    needsKey: obj.needsKey === true,
    available: obj.available,
    hasKey: obj.hasKey === true,
    hasAppId: obj.hasAppId === true,
    keyHint: typeof obj.keyHint === 'string' ? obj.keyHint : '',
    appIdHint: typeof obj.appIdHint === 'string' ? obj.appIdHint : '',
  }
}

/**
 * 把服务端状态排成设置页给用户看的顺序：缓存 → 免费词典 API → 百度翻译。
 * 查词时就是按这个顺序依次试的，某一步拿到完整释义就不再往后走。
 * （云端没有本地 ECDICT 词典，这一层已随上云移除。）
 */
function buildChain(s: DictSources): DictChainStep[] {
  const externalById = new Map(s.external.map(src => [src.id, src]))
  const steps: DictChainStep[] = [
    {
      id: 'cache',
      name: '云端缓存',
      desc: '已经查过的词存在云端缓存里，再查时直接返回，一个请求都不发。',
      available: true,
      reason: '',
      needsKey: false,
    },
  ]
  const dictionaryapi = externalById.get('dictionaryapi')
  if (dictionaryapi) {
    steps.push({
      id: 'dictionaryapi',
      name: dictionaryapi.name,
      desc: '先打这个免费接口取音标和英文释义，不需要密钥。',
      available: dictionaryapi.available,
      reason: s.network ? '' : '离线模式：Worker 以 DICT_NO_NETWORK=1 启动，不会发起任何网络请求',
      needsKey: false,
    })
  }
  const baidu = externalById.get('baidu')
  if (baidu) {
    steps.push({
      id: 'baidu',
      name: baidu.name,
      desc: '英文释义拿到后再打百度翻译取中文；密钥由 Worker 的环境变量（secret）配置。',
      available: baidu.available,
      reason: !s.network
        ? '离线模式：Worker 以 DICT_NO_NETWORK=1 启动，不会发起任何网络请求'
        : !baidu.hasKey || !baidu.hasAppId
          ? '未配置密钥，查词时会跳过这一步（在 Cloudflare 后台执行 wrangler secret put BAIDU_TRANSLATE_API_KEY / BAIDU_TRANSLATE_APP_ID）'
          : '',
      needsKey: true,
      hasKey: baidu.hasKey,
      hasAppId: baidu.hasAppId,
      keyHint: baidu.keyHint,
      appIdHint: baidu.appIdHint,
    })
  }
  return steps
}

/**
 * 查一次服务端的词典来源状态。
 * 服务不可达 / 是旧版本都返回 null，界面据此什么都不显示——
 * 这只是个提示，缺了不影响查词。
 */
export function useDictSources() {
  const [sources, setSources] = useState<DictSources | null>(null)

  const [reloadToken, setReloadToken] = useState(0)

  const reload = useCallback(() => setReloadToken(token => token + 1), [])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const body: unknown = await queryApi('/api/dict/sources', {}, {
          staleTime: 60_000, tags: ['dict-sources'],
        })
        if (!alive || body === null || typeof body !== 'object') return
        setSources(toSources(body as JsonBody))
      } catch {
        // 服务不可达，不提示
      }
    })()
    return () => { alive = false }
  }, [reloadToken])

  const chain = useMemo(() => (sources ? buildChain(sources) : []), [sources])

  return { sources, chain, reload }
}
