export type Task<T> = () => Promise<T>

export default class Mutex {
  private queue: Array<Task<any>> = []
  private isBusy = false
  private limit: number
  private completed: Promise<any> = Promise.resolve()

  constructor (limit: number = Infinity) {
    this.limit = limit
  }

  async runExclusive<T> (task: Task<T>): Promise<T> {
    // Only add another item to the queue if it's below the limit
    if (this.limit >= this.queue.length + 1) {
      this.completed = new Promise<T>(async (resolve, reject) => {
        this.queue.push(() => task().then(resolve).catch(reject))

        if (!this.isBusy) {
          await this.dequeue()
        }
      })
    }

    return this.completed
  }

  private async dequeue () {
    const next = this.queue.shift()

    if (!next) {
      this.isBusy = false
      return
    }

    this.isBusy = true
    try {
      await next()
    } finally {
      await this.dequeue()
    }
  }
}
