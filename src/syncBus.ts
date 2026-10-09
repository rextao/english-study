/**
 * syncBus — 本地数据变动的轻量通知通道
 *
 * 同步只在「用户点了按钮」时才执行，但提示要及时：任意一处写操作改了本地库
 * （加词、打卡、改标签、改目标、记打印批次……）都要让顶部的同步提示条重新查一次差异。
 * 这里用一个进程内 pub/sub 把「数据变了」这件事广播出去，useSync 订阅后防抖重查，
 * 各个数据 hook 只管在写成功后调一句 notifyLocalDataChanged()，互相不耦合。
 */

type Listener = () => void

const listeners = new Set<Listener>()

/** 订阅本地数据变动；返回取消订阅的函数 */
export function subscribeLocalChanges(cb: Listener): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** 本地库被写操作改过后调用，通知同步提示条重新查差异 */
export function notifyLocalDataChanged(): void {
  for (const cb of listeners) {
    try { cb() } catch {
      // 单个订阅者出错不影响其他订阅者和这次写操作本身
    }
  }
}
