import { useCallback, useEffect, useState } from 'react'

const SERVER = 'http://127.0.0.1:3456'
const GOAL_URL = SERVER + '/api/study/goal'

/**
* 学习目标 = 某个词库。只存「目标是哪个词库」，存在服务端（study-history.sqlite），
 * 不用 localStorage，后续换成云端数据库时只要改这个接口。
 */
export function useStudyGoal() {
  const [libraryId, setLibraryId] = useState('')
  const [loading, setLoading]     = useState(true)
  const [offline, setOffline]     = useState(false)

  useEffect(() => {
    let alive = true

    async function load() {
      try {
        const res  = await fetch(GOAL_URL)
        const data = (await res.json()) as { libraryId?: string }
        if (!alive) return
        if (typeof data?.libraryId === 'string') setLibraryId(data.libraryId)
      } catch {
        if (!alive) return
        setOffline(true)
      }
      if (alive) setLoading(false)
    }

    load()
    return () => { alive = false }
  }, [])

  /** 先本地生效再写服务端，选词库时不用等网络 */
  const setGoal = useCallback(async (next: string) => {
    setLibraryId(next)
    try {
      await fetch(GOAL_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ libraryId: next }),
      })
      setOffline(false)
    } catch {
      setOffline(true)
    }
  }, [])

  return { libraryId, loading, offline, setGoal }
}
