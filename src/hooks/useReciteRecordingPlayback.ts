/**
 * useReciteRecordingPlayback — 课堂录音的顺序播放（一段或同一会话的几段拼着播）。
 *
 * 一次学习可能录成好几段（关页面 / 切后台各停一次），这里把它们当成一条音频：
 *   - 按传入顺序一段一段播，播完一段自动接下一段；
 *   - 进度 / 总时长按整条算，拖动进度条能落到对应的那一段；
 *   - 全站同时只播一条：开始播新的会把正在播的那条停掉。
 *
 * 音频按需拉取（GET /api/recite/recordings/:id/audio），拉到就转 Blob URL 缓存，
 * 组件卸载时释放。顺序由 utils/reciteRecordings 的合并判定保证，这里只负责照单播放。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchReciteRecordingAudio } from './useRecite'
import type { RecordingGroup } from '../utils/reciteRecordings'

/** 同时缓存几段的 Blob URL：正常只有一两段，留点余量给切后台产生的多段 */
const URL_CACHE_LIMIT = 12

/** 全站唯一在播的那一条：换一条播时先把上一条停掉 */
let activeStop: (() => void) | null = null

export function base64ToBlobUrl(base64: string, mime: string): string {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: mime }))
}

export interface RecordingPlayback {
  loading: boolean
  playing: boolean
  failed: string
  /** 整条的已播秒数（跨段累计） */
  current: number
  /** 整条的总秒数 */
  duration: number
  /** 正在播第几段（从 0 起） */
  segmentIndex: number
  /** 每段在整条里的时长（秒）：先用服务端记录的，拿到真实元数据后以真实值为准 */
  lengths: number[]
  toggle: () => void
  seek: (seconds: number) => void
  setRate: (rate: number) => void
  /** 暂停在当前位置，再次 toggle 从这里接着播 */
  pause: () => void
  stop: () => void
}

/** 组里每段的时长（秒）：先用服务端记录的，拿到真实元数据后以真实值为准 */
function useSegments(group: RecordingGroup | null) {
  return useMemo(() => group?.segments ?? [], [group])
}

/** 只有服务端时长时的每段长度，等真实元数据到了再逐段替换 */
function fallbackLengths(list: RecordingGroup['segments']): number[] {
  return list.map(segment => Math.max(0, (segment.durationMs || 0) / 1000))
}

export function useReciteRecordingPlayback(group: RecordingGroup | null): RecordingPlayback {
  const segments = useSegments(group)

  const [loading, setLoading] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [failed, setFailed] = useState('')
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(group ? group.durationMs / 1000 : 0)
  const [segmentIndex, setSegmentIndex] = useState(0)
  const [lengths, setLengths] = useState<number[]>(() => fallbackLengths(segments))

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlsRef = useRef(new Map<number, string>())
  const actualRef = useRef(new Map<number, number>())
  const indexRef = useRef(0)
  const playingRef = useRef(false)
  /** 整条播到结尾了：再次播放从头开始，而不是停在最后一刻 */
  const endedRef = useRef(false)
  const rateRef = useRef(1)
  const opRef = useRef(0)
  const mountedRef = useRef(true)
  const segmentsRef = useRef(segments)
  segmentsRef.current = segments

  /** 第 index 段之前的累计秒数 */
  const baseOf = useCallback((index: number) => {
    let sum = 0
    const list = segmentsRef.current
    for (let at = 0; at < index && at < list.length; at += 1) {
      sum += actualRef.current.get(at) ?? Math.max(0, (list[at]?.durationMs ?? 0) / 1000)
    }
    return sum
  }, [])

  const totalOf = useCallback(() => {
    let sum = 0
    const list = segmentsRef.current
    for (let at = 0; at < list.length; at += 1) {
      sum += actualRef.current.get(at) ?? Math.max(0, (list[at]?.durationMs ?? 0) / 1000)
    }
    return sum
  }, [])

  const revokeAll = useCallback(() => {
    for (const url of urlsRef.current.values()) URL.revokeObjectURL(url)
    urlsRef.current.clear()
  }, [])

  const stop = useCallback(() => {
    opRef.current += 1
    const audio = audioRef.current
    if (audio) {
      try { audio.pause() } catch { /* 已经停了 */ }
      // 停就是回到整条的开头：清掉 src，下次播放从第一段重新拉
      try {
        audio.removeAttribute('src')
        audio.load()
      } catch { /* 忽略 */ }
    }
    playingRef.current = false
    endedRef.current = false
    setPlaying(false)
    setLoading(false)
    setCurrent(0)
    indexRef.current = 0
    setSegmentIndex(0)
    if (activeStop === stop) activeStop = null
  }, [])

  /** 暂停：保留 src 与当前位置，再次 toggle 从这一秒接着播（不是回到开头） */
  const pause = useCallback(() => {
    // 正在换段 / 拖动时暂停：把在途的 playFrom 作废，避免它一会儿自己又响起来
    opRef.current += 1
    const audio = audioRef.current
    if (audio) {
      try { audio.pause() } catch { /* 已经停了 */ }
    }
    playingRef.current = false
    setPlaying(false)
    setLoading(false)
  }, [])

  const ensureUrl = useCallback(async (index: number): Promise<string> => {
    const cached = urlsRef.current.get(index)
    if (cached) return cached
    const recording = segmentsRef.current[index]
    if (!recording) throw new Error('这段录音不存在')
    const { audio, mime } = await fetchReciteRecordingAudio(recording.id)
    const url = base64ToBlobUrl(audio, mime || recording.mime || 'audio/mp4')
    if (!mountedRef.current) {
      URL.revokeObjectURL(url)
      throw new Error('已离开页面')
    }
    urlsRef.current.set(index, url)
    // 缓存太多就丢掉最早拉的那段（不丢正在播的）
    if (urlsRef.current.size > URL_CACHE_LIMIT) {
      for (const [key, value] of urlsRef.current) {
        if (key === index) continue
        URL.revokeObjectURL(value)
        urlsRef.current.delete(key)
        break
      }
    }
    return url
  }, [])

  const playFrom = useCallback(async (index: number, offset: number, autoPlay: boolean) => {
    const list = segmentsRef.current
    if (list.length === 0) return
    if (index < 0 || index >= list.length) return
    const token = ++opRef.current
    setFailed('')
    setLoading(true)
    try {
      const url = await ensureUrl(index)
      if (token !== opRef.current || !mountedRef.current) return

      let audio = audioRef.current
      if (!audio) {
        audio = new Audio()
        audio.preload = 'auto'
        audio.addEventListener('timeupdate', () => {
          const player = audioRef.current
          if (!player) return
          setCurrent(baseOf(indexRef.current) + player.currentTime)
        })
        audio.addEventListener('loadedmetadata', () => {
          const player = audioRef.current
          if (!player || !isFinite(player.duration) || player.duration <= 0) return
          const index = indexRef.current
          actualRef.current.set(index, player.duration)
          setLengths(previous => {
            const next = previous.slice()
            while (next.length < segmentsRef.current.length) next.push(0)
            next[index] = player.duration
            return next
          })
          setDuration(totalOf())
        })
        audio.addEventListener('play', () => {
          playingRef.current = true
          setPlaying(true)
        })
        audio.addEventListener('pause', () => {
          playingRef.current = false
          setPlaying(false)
        })
        audio.addEventListener('ended', () => {
          const next = indexRef.current + 1
          if (next < segmentsRef.current.length) {
            // 下一段：接着播，顺序就是数组顺序（已由合并判定保证）
            void playFrom(next, 0, true)
            return
          }
          playingRef.current = false
          endedRef.current = true
          setPlaying(false)
          setCurrent(totalOf())
          if (activeStop === stop) activeStop = null
        })
        audioRef.current = audio
      }
      endedRef.current = false
      indexRef.current = index
      setSegmentIndex(index)
      audio.src = url
      audio.playbackRate = rateRef.current
      if (offset > 0) {
        try { audio.currentTime = offset } catch { /* 元数据还没到，从头播 */ }
      }
      setCurrent(baseOf(index) + Math.max(0, offset))
      if (autoPlay) {
        if (activeStop && activeStop !== stop) activeStop()
        activeStop = stop
        await audio.play()
      }
    } catch (playError) {
      if (token !== opRef.current || !mountedRef.current) return
      setPlaying(false)
      setFailed(playError instanceof Error ? playError.message : '播放失败')
    } finally {
      if (token === opRef.current && mountedRef.current) setLoading(false)
    }
  }, [baseOf, ensureUrl, stop, totalOf])

  const toggle = useCallback(() => {
    const audio = audioRef.current
    if (playingRef.current) {
      // 暂停（不是停掉）：再点一次从这一秒接着播
      pause()
      return
    }
    if (endedRef.current) {
      void playFrom(0, 0, true)
      return
    }
    if (audio && audio.src && indexRef.current < segmentsRef.current.length) {
      if (activeStop && activeStop !== stop) activeStop()
      activeStop = stop
      void audio.play().catch(error => {
        if (!mountedRef.current) return
        setFailed(error instanceof Error ? error.message : '浏览器拒绝了播放')
      })
      return
    }
    void playFrom(0, 0, true)
  }, [pause, playFrom, stop])

  const seek = useCallback((seconds: number) => {
    const total = totalOf()
    const target = Math.min(Math.max(0, seconds), Math.max(0, total - 0.05))
    let index = 0
    let base = 0
    const list = segmentsRef.current
    for (let at = 0; at < list.length; at += 1) {
      const length = actualRef.current.get(at) ?? Math.max(0, (list[at]?.durationMs ?? 0) / 1000)
      if (target < base + length || at === list.length - 1) {
        index = at
        break
      }
      base += length
    }
    const offset = Math.max(0, target - base)
    endedRef.current = false
    if (index === indexRef.current && audioRef.current?.src) {
      try { audioRef.current.currentTime = offset } catch { /* 忽略 */ }
      setCurrent(target)
      return
    }
    void playFrom(index, offset, playingRef.current)
  }, [playFrom, totalOf])

  const setRate = useCallback((rate: number) => {
    rateRef.current = rate
    if (audioRef.current) audioRef.current.playbackRate = rate
  }, [])

  // 换一条录音：先把旧的停掉、释放 Blob URL
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    stop()
    revokeAll()
    actualRef.current.clear()
    setFailed('')
    setLengths(fallbackLengths(segmentsRef.current))
    setDuration(group ? group.durationMs / 1000 : 0)
    // 只在换组时重置；stop / revokeAll 都是稳定的
  }, [group, revokeAll, stop])

  // 卸载：停播 + 释放所有 Blob URL
  useEffect(() => () => {
    mountedRef.current = false
    opRef.current += 1
    const audio = audioRef.current
    if (audio) {
      try { audio.pause() } catch { /* 忽略 */ }
      audioRef.current = null
    }
    revokeAll()
    if (activeStop === stop) activeStop = null
  }, [revokeAll, stop])

  return { loading, playing, failed, current, duration, segmentIndex, lengths, toggle, seek, setRate, pause, stop }
}
