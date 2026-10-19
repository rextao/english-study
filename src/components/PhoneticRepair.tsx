import { useCallback, useEffect, useState } from 'react'
import { Button, Tag } from '../ui'
import { useDictPrefetch } from '../hooks/useDictPrefetch'
import { invalidateApiCache, queryApi } from '../utils/apiCache'
import './PhoneticRepair.css'

interface MissingPhoneticItem {
  word: string
  type: 'word' | 'sentence'
  listCount: number
}

interface MissingPhoneticReply {
  items?: MissingPhoneticItem[]
}

/** 设置页的音标补齐：只关注学习列表里仍没有音标快照的词和句子。 */
export function PhoneticRepair() {
  const [items, setItems] = useState<MissingPhoneticItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [repairing, setRepairing] = useState(false)

  const loadMissing = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await queryApi<MissingPhoneticReply>('/api/dict/missing-phonetics', {}, {
        staleTime: 15_000,
        tags: ['missing-phonetics'],
      })
      setItems(Array.isArray(data.items) ? data.items : [])
    } catch (cause) {
      setError(cause instanceof Error && cause.message
        ? cause.message
        : '无法读取缺少音标的词条，请确认云端服务可用。')
    } finally {
      setLoading(false)
    }
  }, [])

  const reloadAfterRepair = useCallback(() => {
    // 服务端会把新音标同步回 list_words；清掉列表缓存，切回学习列表时显示最新快照。
    invalidateApiCache(['missing-phonetics', 'dictionary', 'dictionary-batch', 'lists'])
    void loadMissing()
  }, [loadMissing])
  const prefetch = useDictPrefetch(reloadAfterRepair)

  useEffect(() => { void loadMissing() }, [loadMissing])

  async function repairAll() {
    if (items.length === 0 || repairing || prefetch.busy) return
    setRepairing(true)
    setError('')
    // 不把页面快照当作最终名单，服务端在入队前再扫描一次当前学习列表。
    const result = await prefetch.repairPhonetics()
    setRepairing(false)
    if (!result.ok) {
      setError(result.error)
    } else if (result.queued === 0) {
      invalidateApiCache(['missing-phonetics'])
      await loadMissing()
    }
  }

  return (
    <div className="phonetic-repair">
      <div className="phonetic-repair__head">
        <div>
          <h2 className="settings-section__title">补充音标</h2>
        </div>
        <Button
          type="primary"
          loading={repairing || prefetch.busy}
          disabled={loading || items.length === 0 || repairing || prefetch.busy}
          onClick={() => { void repairAll() }}
        >
          {prefetch.busy ? '补充中...' : prefetch.state.failed > 0 ? '重试缺失音标' : '全部补充音标'}
        </Button>
      </div>

      {(error || prefetch.error) && (
        <div className="callout callout--error phonetic-repair__message" role="alert">
          {error || prefetch.error}
        </div>
      )}

      {!repairing && !prefetch.busy && prefetch.state.failed > 0 && !error && !prefetch.error && (
        <div className="callout callout--error phonetic-repair__message" role="alert">
          本次补充有 {prefetch.state.failed} 条失败，请稍后重试。
          {prefetch.state.errors.length > 0 && (
            <ul>
              {prefetch.state.errors.map(item => (
                <li key={item.word + item.message}>{item.word}：{item.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {(repairing || prefetch.busy) && (
        <div className="callout callout--warn phonetic-repair__message" role="status" aria-live="polite">
          <span className="ui-spin" aria-hidden="true" />
          正在补充音标：已处理 {prefetch.state.done} / {prefetch.state.total || items.length} 条
          {prefetch.state.pending > 0 && <>，队列中还有 {prefetch.state.pending} 条</>}
          {prefetch.state.failed > 0 && <>，失败 {prefetch.state.failed} 条</>}
        </div>
      )}

      {loading ? (
        <p className="empty phonetic-repair__loading"><span className="ui-spin" aria-hidden="true" />正在读取缺少音标的词条...</p>
      ) : items.length === 0 ? (
        <div className="callout callout--success phonetic-repair__empty">
          ✓ 当前学习列表里的单词和句子都已经有音标了。
        </div>
      ) : (
        <>
          <div className="phonetic-repair__summary">
            <strong>共 {items.length} 条</strong>
            <span>补充操作会后台执行，可以离开当前分区。</span>
          </div>
          <ul className="phonetic-repair__list">
            {items.map(item => (
              <li className="phonetic-repair__item" key={item.word}>
                <span className="phonetic-repair__word">{item.word}</span>
                <Tag color={item.type === 'sentence' ? 'default' : 'blue'}>
                  {item.type === 'sentence' ? '句子' : '单词'}
                </Tag>
                {item.listCount > 1 && <span className="phonetic-repair__lists">{item.listCount} 个列表</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
