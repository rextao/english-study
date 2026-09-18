import { useCallback, useEffect, useMemo, useState } from 'react'

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
 * 照抄进 state 的话界面会显示「本地词典 undefined 词条」。
 */
function toSources(body: JsonBody): DictSources | null {
  const local = body.local
  if (local === null || typeof local !== 'object') return null
  const info = local as JsonBody
  if (typeof info.ready !== 'boolean' || typeof body.network !== 'boolean') return null
  const count = typeof info.count === 'number' && Number.isFinite(info.count) ? info.count : 0
  // 没有 external 数组说明是老版本服务，查词链路段没法显示
  if (!Array.isArray(body.external)) return null
  const external = (body.external as unknown[]).map(toExternal).filter((s): s is ExternalSource => s !== null)
  if (external.length === 0) return null
  const cache = toCacheStats(body.cache)
  return {
    local: {
      ready: info.ready,
      count,
      dir: typeof info.dir === 'string' ? info.dir : '',
      disabled: info.disabled === true,
    },
    network: body.network,
    cache,
    external,
  }
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
 * 把服务端状态排成设置页给用户看的顺序：缓存 → 本地词典 → 免费词典 API → 百度翻译。
 * 查词时就是按这个顺序依次试的，某一步拿到完整释义就不再往后走。
 */
function buildChain(s: DictSources): DictChainStep[] {
  const externalById = new Map(s.external.map(src => [src.id, src]))
  const steps: DictChainStep[] = [
    {
      id: 'cache',
      name: '本地缓存',
      desc: '已经查过的词存在缓存里，再查时直接返回，一个请求都不发。',
      available: true,
      reason: '',
      needsKey: false,
    },
    {
      id: 'ecdict',
      name: '本机词典（ECDICT）',
      desc: '约 77 万词条的开源英汉词典，命中就用它，音标和中文都是人工校对的。',
      available: s.local.ready,
      reason: s.local.disabled
        ? '已通过 DICT_ECDICT_OFF=1 关闭'
        : '还没安装：运行 npm run ecdict:fetch 把词典产物放进 ' + (s.local.dir || 'data/ecdict/'),
      needsKey: false,
    },
  ]
  const dictionaryapi = externalById.get('dictionaryapi')
  if (dictionaryapi) {
    steps.push({
      id: 'dictionaryapi',
      name: dictionaryapi.name,
      desc: '本地词典没有的词打这个免费接口取音标和英文释义，不需要密钥。',
      available: dictionaryapi.available,
      reason: s.network ? '' : '离线模式：服务端以 DICT_NO_NETWORK=1 启动，不会发起任何网络请求',
      needsKey: false,
    })
  }
  const baidu = externalById.get('baidu')
  if (baidu) {
    steps.push({
      id: 'baidu',
      name: baidu.name,
      desc: '英文释义拿到后再打百度翻译取中文；密钥可以在下面配置。',
      available: baidu.available,
      reason: !s.network
        ? '离线模式：服务端以 DICT_NO_NETWORK=1 启动，不会发起任何网络请求'
        : !baidu.hasKey || !baidu.hasAppId
          ? '未配置密钥，查词时会跳过这一步（可在此处配置，或在 .env.local 里设置环境变量）'
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

type BaiduKeyField = 'baiduApiKey' | 'baiduAppId'

/**
 * 查一次服务端的词典来源状态。
 * 服务没起 / 是旧版本都返回 null，界面据此什么都不显示——
 * 这只是个提示，缺了不影响查词。
 */
export function useDictSources() {
  const [sources, setSources] = useState<DictSources | null>(null)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)

  const reload = useCallback(() => setReloadToken(token => token + 1), [])

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
  }, [reloadToken])

  const chain = useMemo(() => (sources ? buildChain(sources) : []), [sources])

  /**
   * 把密钥覆盖项写进 cache/dict-keys.json（不进 git）。
   * 字符串 = 覆盖，null = 清除覆盖项回落到环境变量。
   * 写完会重新拉一次状态，界面立刻显示新的脱敏预览。
   */
  const saveKeys = useCallback(async (patch: Partial<Record<BaiduKeyField, string | null>>): Promise<boolean> => {
    setSaving(true)
    setError('')
    try {
      const res = await fetch(SERVER + '/api/dict/keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const body: unknown = await res.json().catch(() => null)
      if (!res.ok) {
        setError((body as JsonBody | null)?.error as string || '保存失败')
        return false
      }
      reload()
      return true
    } catch {
      setError('保存失败：本地服务未启动')
      return false
    } finally {
      setSaving(false)
    }
  }, [reload])

  /** 清除密钥覆盖项，回落到 .env.local 里的环境变量 */
  const clearKeys = useCallback(async (fields: BaiduKeyField[]): Promise<boolean> => {
    const patch: Partial<Record<BaiduKeyField, null>> = {}
    for (const field of fields) patch[field] = null
    return saveKeys(patch)
  }, [saveKeys])

  return { sources, chain, saving, error, saveKeys, clearKeys, reload }
}
