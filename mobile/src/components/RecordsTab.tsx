/**
 * RecordsTab.tsx — 单词记录 tab
 *
 * 按学习列表分组展示快照里的 list_words。搜索框放在主页头部（跟着 sticky 头走），
 * 这里只负责渲染筛选后的分组列表。
 */
import type { VocabLabels, WordRecord } from '../lib/snapshot'
import { formatTime } from '../lib/format'

interface Props {
  records: WordRecord[]
  labels: VocabLabels
}

/** 按单词 / 音标 / 中文释义模糊匹配，大小写无关；空关键词原样返回 */
export function filterRecords(records: WordRecord[], query: string): WordRecord[] {
  const keyword = query.trim().toLowerCase()
  if (!keyword) return records
  return records.filter(record =>
    record.word.toLowerCase().includes(keyword) ||
    record.phonetic.toLowerCase().includes(keyword) ||
    record.translation.toLowerCase().includes(keyword),
  )
}

interface Group {
  name: string
  items: WordRecord[]
}

/** records 已按列表顺序 + 字母序排好，顺着切分就能成分组 */
function groupRecords(records: WordRecord[]): Group[] {
  const groups: Group[] = []
  for (const record of records) {
    const last = groups[groups.length - 1]
    if (last && last.name === record.listName) last.items.push(record)
    else groups.push({ name: record.listName, items: [record] })
  }
  return groups
}

interface RowProps {
  record: WordRecord
  labels: VocabLabels
}

function WordRow({ record, labels }: RowProps) {
  const tags = record.sourceIds.map(id => labels[id] || id)
  return (
    <article className="word">
      <div className="word__top">
        <span className="word__word">{record.displayText}</span>
        <span className="word__stage">{record.status}</span>
      </div>
      {record.phonetic ? <p className="word__phonetic">/{record.phonetic}/</p> : null}
      {record.translation ? <p className="word__translation">{record.translation}</p> : null}
      <div className="word__foot">
        {tags.length ? (
          <div className="word__tags">
            {tags.map(tag => <span className="tag" key={tag}>{tag}</span>)}
          </div>
        ) : null}
        <span className="word__time">加入于 {formatTime(record.addedAt)}</span>
      </div>
    </article>
  )
}

export default function RecordsTab({ records, labels }: Props) {
  if (records.length === 0) return <p className="empty">云端还没有单词记录</p>
  return (
    <>
      {groupRecords(records).map(group => (
        <section className="card" key={group.name}>
          <header className="card__head">
            <h2 className="card__title">{group.name}</h2>
            <span className="card__count">{group.items.length} 个</span>
          </header>
          {group.items.map(record => (
            <WordRow key={record.listId + '|' + record.word} record={record} labels={labels} />
          ))}
        </section>
      ))}
    </>
  )
}
