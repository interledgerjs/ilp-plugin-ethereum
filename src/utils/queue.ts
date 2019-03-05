import { EventEmitter2 } from 'eventemitter2'

export default class ReducerQueue<T> extends EventEmitter2 {
  private cache: T
  private waterfall: Promise<T>
  private queue: {
    run: (state: T) => Promise<T>
    priority: number
  }[] = []

  constructor(initialState: T) {
    super()

    this.cache = initialState
    this.waterfall = Promise.resolve(initialState)

    this.emit('data', initialState)
  }

  add(task: (state: T) => Promise<T>, priority = 0): Promise<T> {
    const done = new Promise<T>((resolve, reject) => {
      const run = (state: T) =>
        task(state)
          .then(state => {
            resolve(state)
            return state
          })
          .catch(err => {
            reject(err)
            return state // Return the original state
          })

      const element = { run, priority }
      const index = lowerBound(
        this.queue,
        element,
        (a, b) => b.priority - a.priority
      )
      this.queue.splice(index, 0, element)
    })

    // Since we added a task to the queue, chain .then() to eventually run another task
    // (although not necessarily this task, since it's a priority queue)
    this.waterfall = this.waterfall.then(state => this.tryToRunAnother(state))

    return done
  }

  clear(): Promise<T> {
    this.queue = []
    return this.waterfall
  }

  get state(): T {
    return this.cache
  }

  toJSON(): T {
    return this.cache
  }

  private async tryToRunAnother(state: T): Promise<T> {
    const next = this.queue.shift()
    if (!next) {
      return state
    }

    // Running the task is guranteed not to reject, since they're already caught when enqueued
    // Another task will be queued after this async function resolves, so await the current task
    const newState = await next.run(state)

    this.cache = newState
    this.emit('data', newState)

    return newState
  }
}

/**
 * Copied from p-queue: https://github.com/sindresorhus/p-queue/blob/master/index.js
 *
 * MIT License
 *
 * Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com)
 *
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
 * LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
 * OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
 * WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
const lowerBound = <T>(array: T[], value: T, comp: (a: T, b: T) => number) => {
  let first = 0
  let count = array.length

  while (count > 0) {
    const step = (count / 2) | 0
    let it = first + step

    if (comp(array[it], value) <= 0) {
      first = ++it
      count -= step + 1
    } else {
      count = step
    }
  }

  return first
}
