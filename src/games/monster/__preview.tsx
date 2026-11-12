import { createRoot } from 'react-dom/client'
import { MonsterGame } from './MonsterGame'
import '../../index.css'
import '../../App.css'
import '../games.css'

const words = [
  { word: 'apple', translation: '苹果' },
  { word: 'banana', translation: '香蕉' },
  { word: 'library', translation: '图书馆' },
  { word: 'mountain', translation: '山；山脉' },
  { word: 'delicious', translation: '美味的' },
  { word: 'important', translation: '重要的' },
  { word: 'remember', translation: '记得；记住' },
  { word: 'beautiful', translation: '美丽的' },
]

// ?w=1440&h=900 模拟指定视口：布局按这个尺寸算，超出桌面窗口时整体缩放，方便截图
const params = new URLSearchParams(window.location.search)
const width = Number(params.get('w')) || window.innerWidth
const height = Number(params.get('h')) || window.innerHeight
const raw = params.get('raw') === '1'
const fit = () => raw
  ? 1
  : Math.min(1, window.innerWidth / width, window.innerHeight / height)
const scale = fit()

function syncScale() {
  const el = document.getElementById('preview-shell')
  if (el) el.style.transform = fit() < 1 ? 'scale(' + fit() + ')' : ''
}
window.addEventListener('resize', syncScale)

createRoot(document.getElementById('root')!).render(
  <div
    id="preview-shell"
    className="games"
    style={{
      inset: 'auto',
      left: 0,
      top: 0,
      width,
      height,
      transform: scale < 1 ? 'scale(' + scale + ')' : undefined,
      transformOrigin: 'top left',
    }}
  >
    <MonsterGame words={words} />
  </div>,
)
