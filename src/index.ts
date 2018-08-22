import { EventEmitter2 } from 'eventemitter2'
import StoreWrapper from './store-wrapper'
import createLogger = require('ilp-logger')
import { Logger, PluginInstance, DataHandler, MoneyHandler } from './types'
import EthereumClientPlugin from './client'
import EthereumServerPlugin from './server'
import Web3 = require('web3')
import BigNumber from 'bignumber.js'

// TODO add BigNumber exponentialAt config everywhere

interface EthereumPluginOpts {
  role: 'client' | 'server'
  // Ethereum address of this account (should be default Web3 account)
  // Also broadcast to peers of where to be paid at
  ethereumAddress: string
  // Web3 instance -- default wallet account should be same as address, used for signing transactions
  web3: Web3
  minIncomingSettlementPeriod?: BigNumber.Value
  outgoingSettlementPeriod?: BigNumber.Value
  maxPacketAmount?: BigNumber.Value // gwei
  // Balance (positive) is how much the counterparty owes this instance
  // (negative balance implies this instance owes the counterparty)
  balance?: {
    // Maximum balance counterparty owes this instance before incoming packets are rejected
    maximum: BigNumber.Value // gwei
  }
  receiveOnly: boolean
  _store?: any // Resolves incompatiblities with the older ilp-store-wrapper used by mini-accounts
  _log?: Logger
}

class EthereumPlugin extends EventEmitter2 implements PluginInstance {
  public static version = 2
  _role: 'client' | 'server' // TODO best practice, role and _plugin should be private in order to keep account agnostic to it
  private _plugin: EthereumClientPlugin | EthereumServerPlugin
  // Public so they're accessible to internal account class
  _ethereumAddress: string
  _web3: Web3
  _outgoingSettlementPeriod: BigNumber
  _minIncomingSettlementPeriod: BigNumber
  _maxPacketAmount: BigNumber
  _balance: {
    maximum: BigNumber
  }
  _receiveOnly: boolean // TODO all this means if it should pre-emptively open a paychan on connect
  _store: any // Resolves incompatiblities with the older ilp-store-wrapper used by mini-accounts
  _log: Logger
  _channels: Map<string, string> // channelId -> accountName

  constructor (opts: EthereumPluginOpts) {
    super()

    this._ethereumAddress = opts.ethereumAddress
    this._web3 = opts.web3

    // Sender can start a settling period at anytime (e.g., if receiver is unresponsive)
    // If the receiver doesn't claim funds within that period, sender gets entire channel value

    const INCOMING_SETTLEMENT_PERIOD = 7 * 24 * 60 * 60 / 15 // ~1 week, asuming, 15 sec block times
    this._minIncomingSettlementPeriod = new BigNumber(opts.minIncomingSettlementPeriod || INCOMING_SETTLEMENT_PERIOD)
      .absoluteValue().decimalPlaces(0, BigNumber.ROUND_CEIL)

    const OUTGOING_SETTLEMENT_PERIOD = 2 * INCOMING_SETTLEMENT_PERIOD
    this._outgoingSettlementPeriod = new BigNumber(opts.outgoingSettlementPeriod || OUTGOING_SETTLEMENT_PERIOD)
      .absoluteValue().decimalPlaces(0, BigNumber.ROUND_DOWN)

    this._maxPacketAmount = new BigNumber(opts.maxPacketAmount || Infinity)
      .absoluteValue().decimalPlaces(0, BigNumber.ROUND_DOWN)

    this._balance = {
      // TODO add back other config options here
      // TODO should default max balance be infinity or 0?
      maximum: new BigNumber((opts.balance && opts.balance.maximum) || Infinity)
        .decimalPlaces(0, BigNumber.ROUND_FLOOR)
    }

    // TODO fix this
    this._receiveOnly = opts.receiveOnly || false

    this._store = new StoreWrapper(opts._store)
    // TODO is there a better way to do this?
    this._log = opts._log || createLogger(`ilp-plugin-ethereum-${this._role}`)
    /* tslint:disable-next-line:no-empty */
    this._log.trace = this._log.trace || ((...msg: any[]) => {})

    this._role = opts.role || 'client'
    const InternalPlugin = this._role === 'client' ? EthereumClientPlugin : EthereumServerPlugin

    this._plugin = new InternalPlugin({
      ...opts,
      master: this
    })

    this._plugin.on('connect', () => this.emitAsync('connect'))
    this._plugin.on('disconnect', () => this.emitAsync('disconnect'))
    this._plugin.on('error', e => this.emitAsync('error', e))
  }

  async connect () {
    this._channels = new Map(await this._store.loadObject('channels'))
    this._plugin.connect()
  }

  async disconnect () {
    return this._plugin.disconnect()
  }

  isConnected () {
    return this._plugin.isConnected()
  }

  async sendData (data: Buffer) {
    return this._plugin.sendData(data)
  }

  async sendMoney (amount: string) {
    this._log.error('sendMoney is not supported: use plugin balance configuration instead of connector balance for settlement')
  }

  registerDataHandler (dataHandler: DataHandler) {
    return this._plugin.registerDataHandler(dataHandler)
  }

  deregisterDataHandler () {
    return this._plugin.deregisterDataHandler()
  }

  registerMoneyHandler (moneyHandler: MoneyHandler) {
    return this._plugin.registerMoneyHandler(moneyHandler)
  }

  deregisterMoneyHandler () {
    return this._plugin.deregisterMoneyHandler()
  }
}

export = EthereumPlugin
