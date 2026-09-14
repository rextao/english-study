// Dictionary cache

/** 这条词条的释义是哪来的：ecdict = 本地 ECDICT 词典，api = 外部在线接口 */
export type DictionarySource = 'ecdict' | 'api'

/** 缓存里的一条释义；id = 词性 + 井号 + 该词性下的序号，如 noun#0 */
export interface DictionarySense {
  id: string
  pos: string
  definition: string
}

/** 一条可单独勾选的中文词义；id 按词典返回顺序稳定生成。 */
export interface DictionaryTranslation {
  id: string
  text: string
  pos?: string
  source?: DictionarySource
}

export type DictionaryErrorCode =
  | 'timeout'
  | 'http_error'
  | 'network_error'
  | 'invalid_response'
  | 'not_found'
  | 'not_configured'

export interface DictionaryError {
  source: 'dictionaryapi' | 'baidu'
  code: DictionaryErrorCode
  message: string
  status?: number
  target?: string
}

export interface DictionaryEntry {
  word: string
  /** 本次句子查询使用的展示文本；word 仍保持小写归一化主键。 */
  displayText?: string
  phonetic?: string
  translation?: string
  /** 中文词义全集；translation 是兼容旧缓存的摘要字段。 */
  translations?: DictionaryTranslation[]
  /** 释义全集：所有词性下的释义都留着，学习列表再从里面挑这一阶段要背的几条 */
  senses: DictionarySense[]
  cachedAt: number
  /** ok = 核心查询成功；partial = 有一部分没有拿到，下次查还会重取 */
  status?: 'ok' | 'partial'
  /** 句子音标可以是部分成功，不影响整句中文翻译。 */
  phoneticStatus?: 'complete' | 'partial' | 'missing'
  /** 中文翻译的独立状态，便于区分免费词典失败和百度失败。 */
  translationStatus?: 'ok' | 'error' | 'missing'
  /**
   * 单词拼写校验状态：valid = 本地或免费词典已命中；suspect = 两者均明确未命中；
   * unknown = 外部词典异常，暂时无法确认；unchecked = 句子或短语，不执行拼写校验。
   */
  spellingStatus?: 'valid' | 'suspect' | 'unknown' | 'unchecked'
  /** 最近一次查询遇到的可展示错误；不会包含 API Key。 */
  errors?: DictionaryError[]
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
 * start 开始学习 / restart 重新开始 / done 记住了 / again 没记住 / stop 退出学习
 * print 导出了卡片 / spelling 会拼写
 */
export type StudyMarkAction = 'start' | 'restart' | 'done' | 'again' | 'stop' | 'print' | 'spelling'

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

// 永久学习记录（由独立历史库提供，不随学习列表词条删除）

/** 一次不可变的学习操作；词义信息仅在数据层保留，当前界面按单词聚合展示。 */
export interface StudyHistoryEvent {
  id: string
  action: StudyMarkAction
  at: number
  scope?: StudyMarkScope
  stage?: number
  /** 稳定词义键，供后续按不同词义统计。 */
  meaningKey?: string
  /** 操作发生时的词义快照，避免词典更新后历史含义漂移。 */
  meaningSnapshot?: string
}

/** 一个单词的永久学习历史及其聚合次数。 */
export interface StudyHistoryItem {
  word: string
  sourceIds: string[]
  reviewCount: number
  rememberedCount: number
  forgottenCount: number
  lastAt: number
  events: StudyHistoryEvent[]
}

/** 学习成果列表使用的轻量聚合结果。 */
export interface StudyAchievementItem {
  word: string
  sourceIds: string[]
  reviewCount: number
  rememberedCount: number
  forgottenCount: number
  lastAt: number
}

export interface StudyWordItem {
  word: string
  type: 'word' | 'sentence'
  /** 句子的展示文本；选择、删除、复习和接口请求仍使用 word 主键。 */
  displayText?: string
  sourceIds: string[]
  addedAt: number
  /** 加入学习列表时保存的音标快照；旧词条可能没有这个字段 */
  phonetic?: string
  /** 加入学习列表时保存的中文翻译；旧词条可能没有这个字段 */
  translation?: string
  /** 这一阶段要背的中文词义 id；不填就是默认全部中文词义 */
  translationIds?: string[]
  /** 这一阶段要背的释义 id；不填就是自动（中文 + 第一条英文释义） */
  senseIds?: string[]
  /** 开始学习的时间；没有这个字段说明还没进入复习计划 */
  startedAt?: number
  /** 已完成的复习轮次，0 表示开始了但还没复习过 */
  stage?: number
  /** 当前排期的兼容镜像，仅保留最近 40 条；完整时间永久保存在 SQLite 学习历史中 */
  reviewedAt?: number[]
  /** 当前列表的兼容镜像，仅保留最近 40 条；永久历史不截断 */
  marks?: StudyMark[]
  /** 累计打标次数，不随 marks 截断而丢失 */
  markCount?: number
  /** 累计复习打卡次数（done 与 again 各算一次） */
  reviewCount?: number
  /** 累计标记“会拼写”的次数；旧数据缺失时按 0 */
  spellingCount?: number
  /** 累计标记“记住了”的次数（只统计 done）；旧数据缺失时按 0 */
  rememberedCount?: number
  /** 累计标记“没记住”的次数；旧数据缺失时按 0 */
  forgottenCount?: number
  /** 已处理的复习任务幂等键；服务端保留最近一段，旧数据可没有 */
  processedReviewKeys?: string[]
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

// 永久学习记录（独立于学习列表）

/** 永久记录里的词义快照；当前界面不拆分展示，先保留数据契约供后续扩展。 */
export interface LearningMeaningSnapshot {
  translationIds?: string[]
  senseIds?: string[]
  translation?: string
  /** 稳定词义标识对应的可读内容；旧记录可能没有。 */
  meanings?: Array<{
    key: string
    kind?: 'translation' | 'sense' | 'legacy'
    text?: string
    pos?: string
  }>
}

/** 永久学习事件；删除学习列表中的单词不会删除这里的事件。 */
export interface LearningRecordEvent {
  id: string
  action: StudyMarkAction
  at: number
  /** 客户端复习任务标识，用于永久幂等；旧记录可能没有。 */
  requestId?: string
  scope?: StudyMarkScope
  stage?: number
  /** 一次操作可同时关联多个词义，但前端按事件只统计一次。 */
  meaningKeys?: string[]
  meaningSnapshot?: LearningMeaningSnapshot | string
}

/** 成果页按单词聚合后的永久统计。 */
export interface LearningAchievement {
  word: string
  sourceIds: string[]
  reviewCount: number
  spellingCount: number
  rememberedCount: number
  forgottenCount: number
  lastAt?: number
}

/** 记录管理页的一组单词及其完整事件时间线。 */
export interface LearningRecordGroup extends LearningAchievement {
  events: LearningRecordEvent[]
}

export interface LearningAchievementsResponse {
  items: LearningAchievement[]
}

export interface LearningHistoryResponse {
  items: LearningRecordGroup[]
  /** 当前筛选条件下的单词分组总数，用于分页。 */
  total: number
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
  /** start = 挑新词 / review = 复习计划 / custom = 自由挑选打印 */
  kind: 'start' | 'review' | 'custom'
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
