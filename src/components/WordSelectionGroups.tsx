import { Checkbox } from '../ui'
import type { StudyWordItem } from '../types/vocab'
import type { StudyWordGroup } from '../utils/studyWordGroups'

interface WordSelectionGroupsProps {
  groups: StudyWordGroup[]
  selectedWords: Set<string>
  onToggleWord: (word: string) => void
  onToggleGroup: (items: StudyWordItem[]) => void
  countLabel?: (items: StudyWordItem[]) => string
}

function displayTextOf(item: StudyWordItem): string {
  return item.type === 'sentence' && item.displayText?.trim() ? item.displayText.trim() : item.word
}

/** 共享词条分组选择区域，不包含具体业务流程和弹窗按钮。 */
export function WordSelectionGroups({
  groups,
  selectedWords,
  onToggleWord,
  onToggleGroup,
  countLabel,
}: WordSelectionGroupsProps) {
  return (
    <>
      {groups.map(group => (
        <div key={group.key} className="pick-modal__group">
          <div className="pick-modal__group-title">
            <span>{group.label}</span>
            {countLabel && <span className="pick-modal__group-count">{countLabel(group.items)}</span>}
            <Checkbox
              className="pick-modal__group-all"
              checked={group.items.length > 0 && group.items.every(item => selectedWords.has(item.word))}
              onChange={() => onToggleGroup(group.items)}
            >
              全选
            </Checkbox>
          </div>
          <div className="pick-grid">
            {group.items.map(item => (
              <Checkbox
                key={item.word}
                className="pick-grid__item"
                checked={selectedWords.has(item.word)}
                onChange={() => onToggleWord(item.word)}
              >
                {displayTextOf(item)}
              </Checkbox>
            ))}
          </div>
        </div>
      ))}
    </>
  )
}
