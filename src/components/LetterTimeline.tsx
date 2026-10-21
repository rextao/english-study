import './LetterTimeline.css'

interface LetterTimelineProps {
  letters: string[]
  activeLetter?: string
  onSelect: (letter: string) => void
  ariaLabel?: string
  className?: string
}

/** 可复用的字母时间轴导航，字母列表和当前高亮项由调用方控制。 */
export function LetterTimeline({
  letters,
  activeLetter,
  onSelect,
  ariaLabel = '按字母跳转',
  className = '',
}: LetterTimelineProps) {
  return (
    <nav className={'letter-timeline ' + className} aria-label={ariaLabel}>
      {letters.map(letter => (
        <button
          key={letter}
          type="button"
          className={'letter-timeline__item' + (letter === activeLetter ? ' letter-timeline__item--active' : '')}
          aria-label={'跳转到 ' + letter + ' 开头的单词'}
          aria-current={letter === activeLetter ? 'true' : undefined}
          onClick={() => onSelect(letter)}
        >
          {letter}
        </button>
      ))}
    </nav>
  )
}
