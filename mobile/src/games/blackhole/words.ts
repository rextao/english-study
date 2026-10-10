// 黑洞游戏道具附带的单词来源。
// 当前单词池写死为常量（const），仅作为「黑洞吞噬」小游戏吞噬道具时
// 附带单词的数据源 groundwork；后续会接入统一的单词数据源（接口 / 云端快照）。
// 届时只需改动 getWordPool —— 它是以后统一替换数据源的唯一入口，
// 其余调用方（如随机取词）都从它取数，不直接读 WORD_POOL。

/** 游戏里道具附带的单词 */
export interface GameWord {
  /** 英文单词 */
  word: string;
  /** 中文释义，预留（给以后「结合背单词」用） */
  meaning?: string;
}

/**
 * 单词池：约 80 个常见英文基础单词（CET4 / 日常高频）。
 * 全部小写、互不重复；每个带简短中文释义。
 */
export const WORD_POOL: GameWord[] = [
  { word: 'apple', meaning: '苹果' },
  { word: 'book', meaning: '书' },
  { word: 'cat', meaning: '猫' },
  { word: 'dog', meaning: '狗' },
  { word: 'water', meaning: '水' },
  { word: 'fire', meaning: '火' },
  { word: 'house', meaning: '房子' },
  { word: 'tree', meaning: '树' },
  { word: 'car', meaning: '汽车' },
  { word: 'love', meaning: '爱' },
  { word: 'time', meaning: '时间' },
  { word: 'music', meaning: '音乐' },
  { word: 'school', meaning: '学校' },
  { word: 'teacher', meaning: '老师' },
  { word: 'student', meaning: '学生' },
  { word: 'friend', meaning: '朋友' },
  { word: 'family', meaning: '家庭' },
  { word: 'happy', meaning: '快乐的' },
  { word: 'sad', meaning: '悲伤的' },
  { word: 'good', meaning: '好的' },
  { word: 'bad', meaning: '坏的' },
  { word: 'big', meaning: '大的' },
  { word: 'small', meaning: '小的' },
  { word: 'fast', meaning: '快的' },
  { word: 'slow', meaning: '慢的' },
  { word: 'hot', meaning: '热的' },
  { word: 'cold', meaning: '冷的' },
  { word: 'light', meaning: '光；轻的' },
  { word: 'dark', meaning: '黑暗的' },
  { word: 'money', meaning: '钱' },
  { word: 'food', meaning: '食物' },
  { word: 'rice', meaning: '米饭' },
  { word: 'bread', meaning: '面包' },
  { word: 'milk', meaning: '牛奶' },
  { word: 'coffee', meaning: '咖啡' },
  { word: 'tea', meaning: '茶' },
  { word: 'phone', meaning: '电话' },
  { word: 'computer', meaning: '电脑' },
  { word: 'window', meaning: '窗户' },
  { word: 'door', meaning: '门' },
  { word: 'table', meaning: '桌子' },
  { word: 'chair', meaning: '椅子' },
  { word: 'flower', meaning: '花' },
  { word: 'grass', meaning: '草' },
  { word: 'mountain', meaning: '山' },
  { word: 'river', meaning: '河' },
  { word: 'sea', meaning: '海' },
  { word: 'sky', meaning: '天空' },
  { word: 'sun', meaning: '太阳' },
  { word: 'moon', meaning: '月亮' },
  { word: 'star', meaning: '星星' },
  { word: 'cloud', meaning: '云' },
  { word: 'rain', meaning: '雨' },
  { word: 'snow', meaning: '雪' },
  { word: 'wind', meaning: '风' },
  { word: 'bird', meaning: '鸟' },
  { word: 'fish', meaning: '鱼' },
  { word: 'horse', meaning: '马' },
  { word: 'tiger', meaning: '老虎' },
  { word: 'lion', meaning: '狮子' },
  { word: 'color', meaning: '颜色' },
  { word: 'red', meaning: '红色' },
  { word: 'blue', meaning: '蓝色' },
  { word: 'green', meaning: '绿色' },
  { word: 'yellow', meaning: '黄色' },
  { word: 'black', meaning: '黑色' },
  { word: 'white', meaning: '白色' },
  { word: 'city', meaning: '城市' },
  { word: 'country', meaning: '国家' },
  { word: 'world', meaning: '世界' },
  { word: 'travel', meaning: '旅行' },
  { word: 'work', meaning: '工作' },
  { word: 'play', meaning: '玩' },
  { word: 'read', meaning: '阅读' },
  { word: 'write', meaning: '写' },
  { word: 'speak', meaning: '说' },
  { word: 'listen', meaning: '听' },
  { word: 'walk', meaning: '走' },
  { word: 'run', meaning: '跑' },
  { word: 'jump', meaning: '跳' },
  { word: 'sleep', meaning: '睡觉' },
  { word: 'dream', meaning: '梦' },
];

/**
 * 获取单词池。
 * 这里是「以后统一替换数据源的唯一位置」：
 * 将来接入接口 / 云端快照时，只改这个函数的实现即可，
 * 其余调用方无需改动。
 */
export function getWordPool(): GameWord[] {
  return WORD_POOL;
}

/** 从单词池里随机返回一个单词 */
export function pickWord(): GameWord {
  const pool = getWordPool();
  const index = Math.floor(Math.random() * pool.length);
  return pool[index];
}
