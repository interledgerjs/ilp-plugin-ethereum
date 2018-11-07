enum QueueState {
  /** Not running any tasks; immediately ready to start a new task */
  IDLE,
  /** Running a task */
  BUSY
}

export default class Mutex {
  private state = QueueState.IDLE
  private queue: Array<{
    task: () => Promise<any>,
    priority: number
  }> = []

  /**
   * Add a new task to the queue with the given priority
   * @param priority greater numbers represent tasks that will run sooner than lesser numbers
   * @param task the job to be completed in the future
   */
  synchronize<T> (priority: number, task: () => Promise<T>): Promise<T> {
    const done = new Promise<T>((resolve, reject) => {
      this.queue.push({
        task: () => task().then(resolve, reject),
        priority
      })
    })

    if (this.state === QueueState.IDLE) {
      /* tslint:disable-next-line:no-floating-promises */
      this.dequeue()
    }

    return done
  }

  /**
   * Run tasks on the queue, by priority
   * - Queue state **must** be idle in order to invoke this
   */
  private async dequeue () {
    this.state = QueueState.BUSY

    this.queue = this.queue.sort((a, b) => b.priority - a.priority)
    const next = this.queue.shift()

    if (!next) {
      this.state = QueueState.IDLE
      return
    }

    try {
      await next.task()
    } finally {
      await this.dequeue()
    }
  }
}
