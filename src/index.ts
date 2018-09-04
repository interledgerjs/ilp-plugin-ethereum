import { EventEmitter2 } from 'eventemitter2'
import StoreWrapper from './utils/store-wrapper'
import { Logger, PluginInstance, DataHandler, MoneyHandler } from './utils/types'
import Web3 = require('web3')
import BigNumber from 'bignumber.js'
import BtpPlugin, { BtpPacket, BtpSubProtocol } from 'ilp-plugin-btp'
import MiniAccountsPlugin from 'ilp-plugin-mini-accounts'
import EthereumAccount, { requestId, convert, Unit } from './account'
import * as IlpPacket from 'ilp-packet'
const BtpPacket = require('btp-packet')

import * as debug from 'debug'
import createLogger = require('ilp-logger')

BigNumber.config({ EXPONENTIAL_AT: 1e+9 }) // Almost never use exponential notation

interface EthereumPluginOpts {
  role: 'client' | 'server'
  // Ethereum address of this account to tell peers to pay this at
  ethereumAddress: string
  // Web3 1.0 instance with a default wallet account for signing transactions and messages
  web3: Web3
  // Default amount to fund when opening a new channel or depositing to a depleted channel
  // * gwei
  outgoingChannelAmount?: BigNumber.Value
  // Minimum number of blocks for settlement period to accept a new incoming channel
  minIncomingSettlementPeriod?: BigNumber.Value
  // Number of blocks for settlement period used to create outgoing channels
  outgoingSettlementPeriod?: BigNumber.Value
  // Maximum allowed amount in gwei for incoming packets
  // * gwei
  maxPacketAmount?: BigNumber.Value
  // Balance (positive) is amount in gwei the counterparty owes this instance
  // (negative balance implies this instance owes the counterparty)
  // Debits add to the balance; credits subtract from the balance
  // maximum >= settleTo > settleThreshold >= minimum
  // * gwei
  balance?: {
    // Maximum balance counterparty owes this instance before further balance additions are rejected
    // e.g. settlements and forwarding of PREPARE packets with debits that increase balance above maximum would be rejected
    maximum?: BigNumber.Value
    // New balance after settlement is triggered
    // Since the balance will never exceed this following a settlement, it's almost a "max balance for settlements"
    settleTo?: BigNumber.Value
    // Automatic settlement is triggered when balance goes below this threshold
    // If undefined, no automated settlement occurs
    settleThreshold?: BigNumber.Value
    // Maximum this instance owes the counterparty before further balance subtractions are rejected
    // e.g. incoming money/claims and forwarding of FULFILL packets with credits that reduce balance below minimum would be rejected
    minimum?: BigNumber.Value
  }
  _store?: any // FIXME: `any` resolves incompatiblities with the older ilp-store-wrapper used by mini-accounts
  _log?: Logger
}

class EthereumPlugin extends EventEmitter2 implements PluginInstance {
  static readonly version = 2
  private readonly _role: 'client' | 'server'
  private readonly _plugin: EthereumClientPlugin | EthereumServerPlugin
  // Public so they're accessible to internal account class
  readonly _ethereumAddress: string
  readonly _web3: Web3
  readonly _outgoingChannelAmount: BigNumber // wei
  readonly _outgoingSettlementPeriod: BigNumber // # of blocks
  readonly _minIncomingSettlementPeriod: BigNumber // # of blocks
  readonly _maxPacketAmount: BigNumber // gwei
  readonly _balance: { // gwei
    maximum: BigNumber
    settleTo: BigNumber
    settleThreshold?: BigNumber
    minimum: BigNumber
  }
  readonly _store: any // Resolves incompatiblities with the older ilp-store-wrapper used by mini-accounts
  readonly _log: Logger
  _channels: Map<string, string> // channelId -> accountName

  constructor (opts: EthereumPluginOpts) {
    super()

    this._store = new StoreWrapper(opts._store)

    // TODO Is this unclear? Should it be `server` | `client` OR `parent` | `child`? Should `peer` be an alias for child?
    this._role = opts.role || 'client'

    this._log = opts._log || createLogger(`ilp-plugin-ethereum-${this._role}`)
    this._log.trace = this._log.trace || debug(`ilp-plugin-ethereum-${this._role}:trace`)

    const InternalPlugin = this._role === 'client' ? EthereumClientPlugin : EthereumServerPlugin
    this._plugin = new InternalPlugin({
      ...opts,
      master: this
    })

    this._plugin.on('connect', () => this.emitAsync('connect'))
    this._plugin.on('disconnect', () => this.emitAsync('disconnect'))
    this._plugin.on('error', e => this.emitAsync('error', e))

    // TODO If no Web3 default account is set by default, maybe it should TRY to use that... (which would allow arbitrarily switching accounts if a connector wanted to) but default to ethereumAddress if one isn't set
    // TODO How should address management work? Should we infer it from the web3 instance?
    this._ethereumAddress = opts.ethereumAddress
    this._web3 = opts.web3

    this._outgoingChannelAmount =
      opts.outgoingChannelAmount
        ? convert(opts.outgoingChannelAmount, Unit.Gwei, Unit.Wei)
        : convert('0.04', Unit.Eth, Unit.Wei)
      .abs().dp(0, BigNumber.ROUND_DOWN)

    // Sender can start a settling period at anytime (e.g., if receiver is unresponsive)
    // If the receiver doesn't claim funds within that period, sender gets entire channel value

    const INCOMING_SETTLEMENT_PERIOD = 7 * 24 * 60 * 60 / 15 // ~1 week, asuming, 15 sec block times
    this._minIncomingSettlementPeriod = new BigNumber(opts.minIncomingSettlementPeriod || INCOMING_SETTLEMENT_PERIOD)
      .abs().dp(0, BigNumber.ROUND_CEIL)

    const OUTGOING_SETTLEMENT_PERIOD = 1.25 * INCOMING_SETTLEMENT_PERIOD
    this._outgoingSettlementPeriod = new BigNumber(opts.outgoingSettlementPeriod || OUTGOING_SETTLEMENT_PERIOD)
      .abs().dp(0, BigNumber.ROUND_DOWN)

    this._maxPacketAmount = new BigNumber(opts.maxPacketAmount || Infinity)
      .abs().dp(0, BigNumber.ROUND_DOWN)

    this._balance = {
      maximum: new BigNumber((opts.balance && opts.balance.maximum) || Infinity)
        .dp(0, BigNumber.ROUND_FLOOR),
      settleTo: new BigNumber((opts.balance && opts.balance.settleTo) || 0)
        .dp(0, BigNumber.ROUND_FLOOR),
      settleThreshold: opts.balance && opts.balance.settleThreshold
        ? new BigNumber(opts.balance.settleThreshold)
            .dp(0, BigNumber.ROUND_FLOOR)
        : undefined,
      minimum: new BigNumber((opts.balance && opts.balance.minimum) || -Infinity)
        .dp(0, BigNumber.ROUND_CEIL)
    }

    // Validate balance configuration: max >= settleTo > settleThreshold >= min
    // TODO this is bad if maximum is less than 0, since that's the default settleTo!
    if (!this._balance.maximum.gte(this._balance.settleTo)) {
      throw new Error('Invalid balance configuration: maximum balance must be greater than or equal to settleTo')
    }
    if (this._balance.settleThreshold && !this._balance.settleTo.gt(this._balance.settleThreshold)) {
      throw new Error('Invalid balance configuration: settleTo must be greater than settleThreshold')
    }
    if (this._balance.settleThreshold && !this._balance.settleThreshold.gte(this._balance.minimum)) {
      throw new Error('Invalid balance configuration: settleThreshold must be greater than minimum balance')
    }

    if (!this._balance.settleThreshold) {
      this._log.trace(`Auto-settlement disabled: plugin is in receive-only mode since no settleThreshold was configured`)
    }
  }

  async connect () {
    this._channels = new Map(await this._store.loadObject('channels'))
    return this._plugin.connect()
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

class EthereumClientPlugin extends BtpPlugin implements PluginInstance {
  private _account: EthereumAccount
  private _master: EthereumPlugin // FIXME remove?

  // FIXME Add type info for opts
  constructor (opts: any) {
    super({
      responseTimeout: 3500000, // FIXME what is reasonable?
      ...opts
    })

    this._master = opts.master

    this._account = new EthereumAccount({
      master: opts.master,
      accountName: 'server', // FIXME what is the name of the server?
      sendMessage: (message: BtpPacket) =>
        this._call('', message)
    })
  }

  async _connect (): Promise<void> {
    await this._account.connect()
    await this._account.shareEthereumAddress()
    return this._account.attemptSettle()
  }

  _handleData (from: string, message: BtpPacket): Promise<BtpSubProtocol[]> {
    return this._account.handleData(message, this._dataHandler)
  }

  _handleMoney (from: string, message: BtpPacket): Promise<BtpSubProtocol[]> {
    return this._account.handleMoney(message, this._moneyHandler)
  }

  // FIXME Add error handling to catch ILP error packets in the response
  // Add hooks into sendData before and after sending a packet for balance updates and settlement, akin to mini-accounts
  async sendData (buffer: Buffer): Promise<Buffer> {
    const preparePacket = IlpPacket.deserializeIlpPacket(buffer)
    this._account.beforeForward(preparePacket)

    const response = await this._call('', {
      type: BtpPacket.TYPE_MESSAGE,
      requestId: await requestId(),
      data: {
        protocolData: [{
          protocolName: 'ilp',
          contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
          data: buffer
        }]
      }
    })

    // FIXME What if there isn't an ILP response?
    const ilpResponse = response.protocolData
      .filter(p => p.protocolName === 'ilp')[0]
    const responsePacket = IlpPacket.deserializeIlpPacket(ilpResponse.data)

    await this._account.afterForwardResponse(preparePacket, responsePacket)

    return ilpResponse
      ? ilpResponse.data
      : Buffer.alloc(0)
  }

  _disconnect (): Promise<void> {
    return this._account.disconnect()
  }
}

class EthereumServerPlugin extends MiniAccountsPlugin implements PluginInstance {
  private _accounts: Map<string, EthereumAccount> // accountName -> account
  private _master: EthereumPlugin

  // FIXME add type info for options
  constructor (opts: any) {
    super(opts)

    this._master = opts.master
    this._accounts = new Map()
  }

  _getAccount (address: string) {
    const accountName = this.ilpAddressToAccount(address)
    let account = this._accounts.get(accountName)

    if (!account) {
      account = new EthereumAccount({
        accountName,
        master: this._master,
        sendMessage: (message: BtpPacket) =>
          this._call(address, message)
      })

      this._accounts.set(accountName, account)
    }

    return account
  }

  _connect (address: string, message: BtpPacket): Promise<void> {
    return this._getAccount(address).connect()
  }

  _handleCustomData = async (from: string, message: BtpPacket): Promise<BtpSubProtocol[]> =>
    this._getAccount(from).handleData(message, this._dataHandler)

  _handleMoney (from: string, message: BtpPacket): Promise<BtpSubProtocol[]> {
    return this._getAccount(from).handleMoney(message, this._moneyHandler)
  }

  // TODO This causes an error when Stream sends an ILDCP request via sendData on the server:
  // sendPrepare is called before mini-accounts handles ILDCP requests,
  // and peer.config fails to resolve an account
  _sendPrepare (destination: string, preparePacket: IlpPacket.IlpPacket) {
    // return this._getAccount(destination).beforeForward(preparePacket)
  }

  _handlePrepareResponse = async (
    destination: string,
    responsePacket: IlpPacket.IlpPacket,
    preparePacket: IlpPacket.IlpPacket
  ): Promise<void> =>
    this._getAccount(destination).afterForwardResponse(preparePacket, responsePacket)

  _close (from: string): Promise<void> {
    return this._getAccount(from).disconnect()
  }

  // FIXME Add _disconnect (handler for when the plugin disconnects)
}

export = EthereumPlugin
