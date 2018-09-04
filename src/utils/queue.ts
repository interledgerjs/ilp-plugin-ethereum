export type Task<T> = () => Promise<T>

export default class Mutex {
  private queue: Array<Task<any>> = []
  private locked = false

  async synchronize<T> (task: Task<T>): Promise<T> {
    return new Promise<T>(async (resolve, reject) => {
      this.queue.push(() => task().then(resolve).catch(reject))

      if (!this.locked) {
        await this.dequeue()
      }
    })
  }

  private async dequeue () {
    const next = this.queue.shift()

    if (!next) {
      this.locked = false
      return
    }

    this.locked = true
    try {
      await next()
    } finally {
      await this.dequeue()
    }
  }
}
