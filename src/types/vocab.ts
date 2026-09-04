// Dictionary cache

/** 这条词条的释义是哪来的：ecdict = 本地 ECDICT 词典，api = 外部在线接口 */
export type DictionarySource = 'ecdict' | 'api'

/** 缓存里的一条释义；id = 词性 + 井号 + 该词性下的序号，如 noun#0 */
export interface DictionarySense {
  id: string
  pos: string
  definition: string
}

export interface DictionaryEntry {
  word: string
  phonetic?: string
  translation?: string
  /** 释义全集：所有词性下的释义都留着，学习列表再从里面挑这一阶段要背的几条 */
  senses: DictionarySense[]
  cachedAt: number
  /** ok = 音标 / 英文释义 / 中文都拿到了；partial = 缺一部分，下次查还会重取 */
  status?: 'ok' | 'partial'
  /** 释义来源；老缓存里没有这个字段，所以是可选的 */
  source?: DictionarySource
}

// Vocab library JSON files

export interface VocabWord {
  word: string
  pos: string[]
  examples: string[]
}

export interface VocabLibrary {
  id: string
  name: string
  level: string
  source: string
  description?: string
  words: VocabWord[]
}

/** 词库 + 它是从哪个文件打包进来的，词库页面要显示来源 */
export interface VocabLibraryInfo extends VocabLibrary {
  /** 相对项目根目录，如 vocab/ket.json */
  file: string
}

// Study lists

/** new 未开始 / due 今天该复习 / scheduled 已排期 / mastered 轮次走完 */
export type StudyState = 'new' | 'due' | 'scheduled' | 'mastered'

/**
 * 打标动作：
 * start 开始学习 / restart 重新开始 / done 记住了 / again 没记住 / stop 退出学习 / print 导出了卡片
 */
export type StudyMarkAction = 'start' | 'restart' | 'done' | 'again' | 'stop' | 'print'

/** 复习打卡动作：done 记住了（进下一轮）/ again 没记住（周期重置）/ stop 退出学习 */
export type StudyReviewAction = 'done' | 'again' | 'stop'

/** 打标粒度：按天一次，还是一周一次 */
export type StudyMarkScope = 'day' | 'week'

/** 一次打标记录，界面上不显示，留给后续统计类功能 */
export interface StudyMark {
  at: number
  action: StudyMarkAction
  scope?: StudyMarkScope
  /** 打标之后的轮次，便于回溯当时进度 */
  stage?: number
}

export interface StudyWordItem {
  word: string
  type: 'word' | 'sentence'
  sourceIds: string[]
  addedAt: number
  /** 这一阶段要背的释义 id；不填就是自动（中文 + 第一条英文释义） */
  senseIds?: string[]
  /** 开始学习的时间；没有这个字段说明还没进入复习计划 */
  startedAt?: number
  /** 已完成的复习轮次，0 表示开始了但还没复习过 */
  stage?: number
  /** 每次复习打卡的时间戳，服务端只保留最近 40 条 */
  reviewedAt?: number[]
  /** 打标日志，服务端只保留最近 40 条；界面不显示 */
  marks?: StudyMark[]
  /** 累计打标次数，不随 marks 截断而丢失 */
  markCount?: number
  /** 累计复习打卡次数（done 与 again 各算一次） */
  reviewCount?: number
  /** 服务端算好的下次复习日期，轮次走完是 null */
  nextDueAt?: number | null
  state?: StudyState
}

export interface StudyList {
  id: string
  name: string
  createdAt: number
  wordCount: number
}

export interface StudyListDetail extends StudyList {
  words: StudyWordItem[]
}

// Study plan（艾宾浩斯复习计划）

export interface StudyPlanItem extends StudyWordItem {
  listId: string
  listName: string
  /** 开始学习那一周的周一 0 点，用于按周分批罗列 */
  weekStart: number
}

export interface StudyPlan {
  /** 复习节奏（天），如 [1, 2, 4, 7, 15, 30, 60] */
  intervals: number[]
  /** 服务端当天 0 点，到期判断都以它为基准 */
  today: number
  items: StudyPlanItem[]
}

// 打印批次（导出卡片的留档）

/** 批次里的一个词；进度是读接口时从学习列表实时算的，批次文件只存 listId + word */
export interface PrintBatchItem {
  listId: string
  listName: string
  word: string
  /** 这个词已经从学习列表里移除了，整批打卡会跳过它 */
  missing?: boolean
  /** 下面三个是派生字段，不落盘 */
  state?: StudyState
  stage?: number
  nextDueAt?: number | null
}

/** 一次卡片导出的记录：留档是为了过一段时间（比如一周后）拿着卡片回来整批打卡 */
export interface PrintBatch {
  id: string
  printedAt: number
  /** start = 挑新词那一批 / review = 复习面板导出的那一批 */
  kind: 'start' | 'review'
  /** 打印时的粒度，整批打卡默认沿用它 */
  scope?: StudyMarkScope
  title: string
  wordCount: number
  items: PrintBatchItem[]
  /** 最近一次整批打卡的时间 / 动作 / 影响到的词数 */
  reviewedAt?: number
  reviewAction?: StudyReviewAction
  reviewedCount?: number
  /** 这一批被整批打卡过几次 */
  reviewCount?: number
  /** 下面三个是派生字段，不落盘：到期数 / 能打卡的词数 / 已被移除的词数 */
  dueCount: number
  markableCount: number
  missingCount: number
}
