/**
 * useRecitePreload — 背词首页的发音预取（本地缓存）。
 *
 * 打开页面、还没点「开始学习」时，把本周要背的单词发音逐个拉到本地（IndexedDB），
 * 小朋友点喇叭时不再现场等网络。优先拉下一次要学的那一次（新的一周就是第 1 次），
 * 其余次序按 wordOrder 依次补齐；主动推送的那一次排在最后。
 *
 * 并发 2，不抢正着急的页面请求；发音服务没配好（503）或令牌失效（401 / 403）时
 * 整体停下并把原因交给调试面板，单个词断网只记失败、可单独重试。
 * 已经在本地缓存里的词直接跳过，反复打开页面不会重复下载。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../utils/apiBase'
import type { ReciteTask } from './useRecite'
import {
  audioCacheKeyOf,
  loadPersistedAudio,
  saveReciteMeta,
  storePersistedAudio,
} from '../utils/reciteCache'

/** 同时只下两个：网络差时也不至于把页面别的请求挤住 */
const CONCURRENCY = 2

export type RecitePreloadStatus = 'idle' | 'loading' | 'done' | 'error'

export interface RecitePreloadState {
  status: RecitePreloadStatus
  /** 本周要缓存的词数（已缓存的也算在里面，进度才能一眼看懂） */
  total: number
  /** 已落地的词数（含原本就缓存好的） */
  done: number
  /** 没拉成功的词，可在调试面板里单独重试 */
  failed: string[]
  /** 出错原因（致命中止 / 部分失败提示） */
  reason: string
}

export interface UseRecitePreloadResult extends RecitePreloadState {
  /** 重新拉取：传 words 只拉这几个（给失败词重试用），不传拉整周 */
  reload: (words?: string[]) => void
}

const IDLE: RecitePreloadState = { status: 'idle', total: 0, done: 0, failed: [], reason: '' }

type FetchOutcome = 'ok' | 'failed' | 'fatal-config' | 'fatal-auth'

/**
 * 本周要缓存发音的词：
 *  - 有 wordOrder 时把「下一次要学的那一次」排最前（第 1 次学习就是新一周的第一组），
 *    其余各次按顺序补上，让小朋友等最少的时间就能播到第一张卡；
 *  - 没有顺序信息就用任务词表兜底；
 *  - 主动推送的那一次也属本周，排在最后。
 */
function buildPreloadWords(task: ReciteTask | null): string[] {
  if (!task) return []
  const groups: string[][] = []
  const order = Array.isArray(task.wordOrder) ? task.wordOrder.filter(group => Array.isArray(group)) : []
  if (order.length > 0) {
    const next = task.activeSessionIndex ?? task.completedSessions + 1
    const priority = Math.min(Math.max(next - 1, 0), order.length - 1)
    groups.push(order[priority])
    order.forEach((group, index) => {
      if (index !== priority) groups.push(group)
    })
  } else {
    groups.push(task.words.map(item => item.word))
  }
  for (const session of task.sessions ?? []) {
    if (session.pushed && session.words?.length) groups.push(session.words)
  }
  const seen = new Set<string>()
  const words: string[] = []
  for (const word of groups.flat()) {
    const key = audioCacheKeyOf(word)
    if (!key || seen.has(key)) continue
    seen.add(key)
    words.push(word)
  }
  return words
}

async function fetchWordAudio(word: string): Promise<FetchOutcome> {
  try {
    const response = await apiFetch('/api/tts?text=' + encodeURIComponent(word))
    if (response.status === 503) return 'fatal-config'
    if (response.status === 401 || response.status === 403) return 'fatal-auth'
    let payload: { audio?: string; mime?: string } | null = null
    try { payload = await response.json() } catch { payload = null }
    if (!response.ok || !payload?.audio) return 'failed'
    await storePersistedAudio(audioCacheKeyOf(word), payload.audio, payload.mime || 'audio/mpeg')
    return 'ok'
  } catch {
    return 'failed'
  }
}

/** 拉一批词：先在本地排队扣掉已缓存的，剩下的并发 2 逐个下载 */
async function preloadWords(
  words: string[],
  report: (state: RecitePreloadState) => void,
): Promise<RecitePreloadState> {
  const total = words.length
  let done = 0
  const failed: string[] = []
  let fatalReason = ''
  let aborted = false

  const pending: string[] = []
  for (const word of words) {
    const persisted = await loadPersistedAudio(audioCacheKeyOf(word))
    if (persisted) done += 1
    else pending.push(word)
  }
  report({ status: 'loading', total, done, failed: [], reason: '' })

  let cursor = 0
  const worker = async () => {
    while (!aborted && cursor < pending.length) {
      const word = pending[cursor]
      cursor += 1
      const outcome = await fetchWordAudio(word)
      if (outcome === 'fatal-config') {
        fatalReason = '发音服务没配置（GOOGLE_TTS_API_KEY 缺失），本次没有拉取'
        aborted = true
        return
      }
      if (outcome === 'fatal-auth') {
        fatalReason = '访问令牌失效了，重新输入令牌后再试'
        aborted = true
        return
      }
      if (outcome === 'failed') failed.push(word)
      done += 1
      report({ status: 'loading', total, done, failed: [...failed], reason: '' })
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, Math.max(pending.length, 1)) }, () => worker()),
  )

  const status: RecitePreloadStatus = aborted ? 'error' : 'done'
  const reason = fatalReason || (failed.length > 0 ? failed.length + ' 个词没拉成功，可单独重试' : '')
  return { status, total, done, failed, reason }
}

/**
 * @param task 本周任务（首页的 homeTask）
 * @param enabled 还没点「开始学习」才拉（点了开始后页面会按需取，别抢网络）
 */
export function useRecitePreload(task: ReciteTask | null, enabled: boolean): UseRecitePreloadResult {
  const [state, setState] = useState<RecitePreloadState>(IDLE)
  const runToken = useRef(0)
  const signatureRef = useRef('')
  const taskRef = useRef(task)
  taskRef.current = task

  const run = useCallback((target: string[]) => {
    const token = runToken.current + 1
    runToken.current = token
    if (target.length === 0) {
      setState(IDLE)
      return
    }
    setState({ status: 'loading', total: target.length, done: 0, failed: [], reason: '' })
    void preloadWords(target, next => {
      if (runToken.current !== token) return
      setState(next)
    }).then(result => {
      if (runToken.current !== token) return
      setState(result)
      const current = taskRef.current
      if (!current) return
      void saveReciteMeta({
        taskId: current.id,
        weekStart: current.weekStart,
        weekEnd: current.weekEnd,
        total: result.total,
        done: result.done,
        failed: result.failed,
        status: result.status === 'error' ? 'error' : 'done',
        reason: result.reason,
        cachedAt: Date.now(),
      })
    })
  }, [])

  useEffect(() => {
    if (!enabled || !task) return
    const target = buildPreloadWords(task)
    const signature = task.id + '|' + task.configVersion + '|' + target.join('\n')
    if (signature === signatureRef.current) return
    signatureRef.current = signature
    run(target)
    return () => {
      // 点了开始 / 离开页面 / 换了任务：这次拉取作废；签名清掉，下次进来重拉（已缓存的会跳过）
      runToken.current += 1
      signatureRef.current = ''
    }
  }, [task, enabled, run])

  // 点了「开始学习」后预取让位给背词页自己的请求：把「拉取中」的进度收口，
  // 免得调试面板一直停在「拉取中」（已缓存的词下次进首页会跳过）
  useEffect(() => {
    if (enabled) return
    setState(previous => previous.status === 'loading'
      ? { ...previous, status: 'idle', reason: '已开始学习，本周预取先暂停' }
      : previous)
  }, [enabled])

  const reload = useCallback((words?: string[]) => {
    const full = buildPreloadWords(taskRef.current)
    if (!words || words.length === 0) {
      run(full)
      return
    }
    // 只重试失败词时也按整周的词数算进度：把要重试的排到队头，其余照旧（已缓存的会跳过）
    const priority = new Set(words.map(audioCacheKeyOf))
    const ordered = [...words, ...full.filter(word => !priority.has(audioCacheKeyOf(word)))]
    run(ordered)
  }, [run])

  return { ...state, reload }
}
