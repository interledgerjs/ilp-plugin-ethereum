'use strict'

class MemStore {
  constructor () {
    this.store = {}
  }

  async get (key) {
    return this.store[key]
  }

  async put (key, value) {
    this.store[key] = value 
  }

  async del (key) {
    delete this.store[key] 
  }
}

module.exports = MemStore
