import { EventEmitter2 } from 'eventemitter2'
import { StoreWrapper, MemoryStore } from './utils/store'
import { Logger, PluginInstance, DataHandler, MoneyHandler, PluginServices } from './utils/types'
import Web3 = require('web3')
import { Provider } from 'web3/providers'
import BigNumber from 'bignumber.js'
import { Channel } from './utils/contract'
import { convert, Unit } from './account'
import { EthereumClientPlugin, EthereumServerPlugin } from './plugin'
import * as ethUtil from 'ethereumjs-util'
import * as debug from 'debug'
import createLogger from 'ilp-logger'

BigNumber.config({ EXPONENTIAL_AT: 1e+9 }) // Almost never use exponential notation

export interface EthereumPluginOpts {
  role: 'client' | 'server'
  // Private key of the Ethereum account used to send and receive
  // Corresponds to the address shared with peers
  ethereumPrivateKey: string
  // Provider to connect to a given Ethereum node
  // https://web3js.readthedocs.io/en/1.0/web3.html#providers
  ethereumProvider?: string | Provider
  // Should the plugin immediately attempt to settle with its peer on connect?
  // - Default for clients is `true`; default for servers and direct peers is `false`
  settleOnConnect?: boolean
  // Should incoming channels to all accounts on the plugin be claimed whenever disconnect is called on the plugin?
  // - Default for clients is `true`; default for servers and direct peers is `false`
  claimOnDisconnect?: boolean
  // Default amount to fund when opening a new channel or depositing to a depleted channel (gwei)
  outgoingChannelAmount?: BigNumber.Value
  // Fee collected whenever a new channel is first linked to an account
  // This may be necessary to cover the peer's tx fee to claim from a channel (gwei)
  incomingChannelFee?: BigNumber.Value
  // Minimum number of blocks for settlement period to accept a new incoming channel
  minIncomingSettlementPeriod?: BigNumber.Value
  // Number of blocks for settlement period used to create outgoing channels
  outgoingSettlementPeriod?: BigNumber.Value
  // Maximum allowed amount in gwei for incoming packets (gwei)
  maxPacketAmount?: BigNumber.Value
  // Balance (positive) is amount in gwei the counterparty owes this instance
  // (negative balance implies this instance owes the counterparty)
  // Debits add to the balance; credits subtract from the balance
  // maximum >= settleTo > settleThreshold >= minimum (gwei)
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
  },
  channelWatcherInterval?: BigNumber.Value
}

export default class EthereumPlugin extends EventEmitter2 implements PluginInstance {
  static readonly version = 2
  private readonly _role: 'client' | 'server'
  private readonly _plugin: EthereumClientPlugin | EthereumServerPlugin
  // Public so they're accessible to internal account class
  readonly _ethereumAddress: string
  readonly _web3: Web3
  readonly _settleOnConnect: boolean
  readonly _claimOnDisconnect: boolean
  readonly _outgoingChannelAmount: BigNumber // wei
  readonly _incomingChannelFee: BigNumber // wei
  readonly _outgoingSettlementPeriod: BigNumber // # of blocks
  readonly _minIncomingSettlementPeriod: BigNumber // # of blocks
  readonly _maxPacketAmount: BigNumber // gwei
  readonly _balance: { // gwei
    maximum: BigNumber
    settleTo: BigNumber
    settleThreshold?: BigNumber
    minimum: BigNumber
  }
  readonly _channels: Map<string, Channel> = new Map() // channelId -> cached channel
  readonly _channelWatcherInterval: BigNumber // ms
  readonly _store: StoreWrapper
  readonly _log: Logger

  constructor ({
    role = 'client',
    ethereumPrivateKey,
    ethereumProvider = 'wss://mainnet.infura.io/ws',
    settleOnConnect = role === 'client', // By default, if client, settle initially & claim on disconnect
    claimOnDisconnect = role === 'client',
    outgoingChannelAmount = convert('0.04', Unit.Eth, Unit.Gwei),
    incomingChannelFee = 0,
    outgoingSettlementPeriod = 6 * (24 * 60 * 60) / 15, // ~ 6 days @ 15 sec block time
    minIncomingSettlementPeriod = 3 * (24 * 60 * 60) / 15, // ~ 3 days @ 15 sec block time
    maxPacketAmount = Infinity,
    balance: {
      maximum = Infinity,
      settleTo = 0,
      settleThreshold = undefined,
      minimum = -Infinity
    } = {},
    // For watcher interval, defaults to minimum of ~1000 cycles with min settlement period
    channelWatcherInterval =
      new BigNumber(minIncomingSettlementPeriod).times(15).div(1000),
    // All remaining params are passed to mini-accounts/plugin-btp
    ...opts
  }: EthereumPluginOpts, {
    log,
    store = new MemoryStore()
  }: PluginServices = {}) {
    super()

    // Web3 errors are unclear if no key was provided
    // tslint:disable-next-line:strict-type-predicates
    if (typeof ethereumPrivateKey !== 'string') {
      throw new Error('Ethereum private key is required')
    }

    // Web3 requires a 0x in front; prepend it if it's missing
    if (ethereumPrivateKey.indexOf('0x') !== 0) {
      ethereumPrivateKey = '0x' + ethereumPrivateKey
    }

    if (!ethUtil.isValidPrivate(ethUtil.toBuffer(ethereumPrivateKey))) {
      throw new Error('Invalid Ethereum private key')
    }

    this._web3 = new Web3(ethereumProvider)
    this._ethereumAddress = this._web3.eth.accounts.wallet.add(ethereumPrivateKey).address

    this._role = role

    this._store = new StoreWrapper(store)

    this._log = log || createLogger(`ilp-plugin-ethereum-${role}`)
    this._log.trace = this._log.trace || debug(`ilp-plugin-ethereum-${role}:trace`)

    this._settleOnConnect = settleOnConnect
    this._claimOnDisconnect = claimOnDisconnect

    this._outgoingChannelAmount = convert(outgoingChannelAmount, Unit.Gwei, Unit.Wei)
      .abs().dp(0, BigNumber.ROUND_DOWN)

    this._incomingChannelFee = convert(incomingChannelFee, Unit.Gwei, Unit.Wei)
      .abs().dp(0, BigNumber.ROUND_DOWN)

    // Sender can start a settling period at anytime (e.g., if receiver is unresponsive)
    // If the receiver doesn't claim funds within that period, sender gets entire channel value

    this._minIncomingSettlementPeriod = new BigNumber(minIncomingSettlementPeriod)
      .abs().dp(0, BigNumber.ROUND_CEIL)

    this._outgoingSettlementPeriod = new BigNumber(outgoingSettlementPeriod)
      .abs().dp(0, BigNumber.ROUND_DOWN)

    this._maxPacketAmount = new BigNumber(maxPacketAmount)
      .abs().dp(0, BigNumber.ROUND_DOWN)

    this._balance = {
      maximum: new BigNumber(maximum)
        .dp(0, BigNumber.ROUND_FLOOR),
      settleTo: new BigNumber(settleTo)
        .dp(0, BigNumber.ROUND_FLOOR),
      settleThreshold: settleThreshold
        ? new BigNumber(settleThreshold)
          .dp(0, BigNumber.ROUND_FLOOR)
        : undefined,
      minimum: new BigNumber(minimum)
        .dp(0, BigNumber.ROUND_CEIL)
    }

    this._channelWatcherInterval = new BigNumber(channelWatcherInterval)
      .abs().dp(0, BigNumber.ROUND_DOWN)

    // Validate balance configuration: max >= settleTo >= settleThreshold >= min
    if (this._balance.settleThreshold) {
      if (!this._balance.maximum.gte(this._balance.settleTo)) {
        throw new Error('Invalid balance configuration: maximum balance must be greater than or equal to settleTo')
      }
      if (!this._balance.settleTo.gte(this._balance.settleThreshold)) {
        throw new Error('Invalid balance configuration: settleTo must be greater than or equal to settleThreshold')
      }
      if (!this._balance.settleThreshold.gte(this._balance.minimum)) {
        throw new Error('Invalid balance configuration: settleThreshold must be greater than or equal to minimum balance')
      }
    } else {
      if (!this._balance.maximum.gt(this._balance.minimum)) {
        throw new Error('Invalid balance configuration: maximum balance must be greater than minimum balance')
      }

      this._log.trace(`Auto-settlement disabled: plugin is in receive-only mode since no settleThreshold was configured`)
    }

    const InternalPlugin = this._role === 'server' ? EthereumServerPlugin : EthereumClientPlugin
    this._plugin = new InternalPlugin({
      ...opts,
      master: this
    }, { store, log })

    this._plugin.on('connect', () => this.emitAsync('connect'))
    this._plugin.on('disconnect', () => this.emitAsync('disconnect'))
    this._plugin.on('error', e => this.emitAsync('error', e))
  }

  async connect () {
    return this._plugin.connect()
  }

  async disconnect () {
    // Persist store if there are any pending write operations
    await this._store.close()
    return this._plugin.disconnect()
  }

  isConnected () {
    return this._plugin.isConnected()
  }

  async sendData (data: Buffer) {
    return this._plugin.sendData(data)
  }

  async sendMoney () {
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
