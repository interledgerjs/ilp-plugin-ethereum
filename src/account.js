'use strict'

const BigNumber = require('bignumber.js')

const BALANCE = a => a
const SECURED_BALANCE = a => a + ':secured_balance'
const IS_BLOCKED = a => a + ':block'
const CLIENT_CHANNEL = a => a + ':client_channel'

class Account {
  constructor ({ account, store, api }) {
    this._store = store
    this._account = account
  }

  getAccount () {
    return this._account
  }

  async connect () {
    await Promise.all([
      this._store.load(BALANCE(this._account)),
      this._store.load(IS_BLOCKED(this._account)),
      this._store.load(CLIENT_CHANNEL(this._account))
    ])
  }

  async disconnect () {
    this._store.unload(BALANCE(this._account))
    this._store.unload(IS_BLOCKED(this._account))
    this._store.unload(CLIENT_CHANNEL(this._account))
  }

  getBalance () {
    return new BigNumber(this._store.get(BALANCE(this._account)) || '0')
  }

  setBalance (balance) {
    return this._store.set(BALANCE(this._account), balance)
  }

  getSecuredBalance () {
    return new BigNumber(this._store.get(SECURED_BALANCE(this._account)) || '0')
  }

  setSecuredBalance (balance) {
    return this._store.set(SECURED_BALANCE(this._account), balance)
  }

  isBlocked () {
    return this._store.get(IS_BLOCKED(this._account))
  }

  getClientChannel () {
    return this._store.get(CLIENT_CHANNEL(this._account))
  }

  block (isBlocked = true) {
    return this._store.set(IS_BLOCKED(this._account), isBlocked)
  }

  setClientChannel (clientChannel) {
    return this._store.set(CLIENT_CHANNEL(this._account), clientChannel)
  }
}

module.exports = Account
