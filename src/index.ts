import { EventEmitter2 } from 'eventemitter2'
import { StoreWrapper, MemoryStore } from './utils/store'
import { Logger, PluginInstance, DataHandler, MoneyHandler, PluginServices } from './utils/types'
import Web3 from 'web3'
import IContract from 'web3/eth/contract'
import { Provider as IProvider } from 'web3/providers'
import BigNumber from 'bignumber.js'
import EthereumAccount, { convert, Unit, AccountData } from './account'
import { EthereumClientPlugin } from './plugin/client'
import { EthereumServerPlugin, MiniAccountsOpts } from './plugin/server'
import { isValidPrivate, toBuffer } from 'ethereumjs-util'
import debug from 'debug'
import createLogger from 'ilp-logger'
import { INetwork, getNetwork, getContract } from './utils/contract'
import { BtpPacket, IlpPluginBtpConstructorOptions } from 'ilp-plugin-btp'
import { registerProtocolNames } from 'btp-packet'

registerProtocolNames([
  'machinomy',
  'requestClose'
])

BigNumber.config({ EXPONENTIAL_AT: 1e+9 }) // Almost never use exponential notation

// TODO Should the default handlers return ILP reject packets?

const defaultDataHandler: DataHandler = () => {
  throw new Error('no request handler registered')
}

const defaultMoneyHandler: MoneyHandler = () => {
  throw new Error('no money handler registered')
}

export interface EthereumPluginOpts extends MiniAccountsOpts, IlpPluginBtpConstructorOptions {
  role: 'client' | 'server'
  // Private key of the Ethereum account used to send and receive
  // Corresponds to the address shared with peers
  ethereumPrivateKey: string
  // Provider to connect to a given Ethereum node
  // https://web3js.readthedocs.io/en/1.0/web3.html#providers
  ethereumProvider?: string | IProvider
  // Should incoming channels to all accounts on the plugin be claimed whenever disconnect is called on the plugin?
  // - Default for clients is `true`; default for servers and direct peers is `false`
  closeOnDisconnect?: boolean
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
  // Number of ms between runs of the channel watcher to check if a dispute was started
  channelWatcherInterval?: BigNumber.Value,
  // Function to query the currenct gas price, if it was supplied
  getGasPrice?: () => Promise<number>
}

export default class EthereumPlugin extends EventEmitter2 implements PluginInstance {
  static readonly version = 2
  private readonly _plugin: EthereumClientPlugin | EthereumServerPlugin
  // Public so they're accessible to internal account class
  readonly _ethereumAddress: string
  readonly _privateKey: string
  readonly _web3: Web3
  readonly _getGasPrice: () => Promise<number> // wei
  readonly _closeOnDisconnect: boolean
  readonly _outgoingChannelAmount: BigNumber // wei
  readonly _incomingChannelFee: BigNumber // wei
  readonly _outgoingSettlementPeriod: BigNumber // # of blocks
  readonly _minIncomingSettlementPeriod: BigNumber // # of blocks
  readonly _maxPacketAmount: BigNumber // gwei
  readonly _balance: { // gwei
    maximum: BigNumber
    settleTo: BigNumber
    settleThreshold: BigNumber
    minimum: BigNumber
  }
  readonly _accounts = new Map<string, EthereumAccount>() // accountName -> account
  readonly _channelWatcherInterval: BigNumber // ms
  readonly _store: StoreWrapper
  readonly _log: Logger
  _network?: INetwork // ABI and address of the contract on the chain of provider
  _contract?: IContract // Web3 contract object
  _dataHandler: DataHandler = defaultDataHandler
  _moneyHandler: MoneyHandler = defaultMoneyHandler

  constructor ({
    role = 'client',
    ethereumPrivateKey,
    ethereumProvider = 'wss://mainnet.infura.io/ws',
    getGasPrice,
    closeOnDisconnect = role === 'client',
    outgoingChannelAmount = convert('0.04', Unit.Eth, Unit.Gwei),
    incomingChannelFee = 0,
    outgoingSettlementPeriod = role === 'client'
      ? 2 * (24 * 60 * 60) / 15  // ~ 2 days @ 15 sec block time
      : 6 * (24 * 60 * 60) / 15, // ~ 6 days @ 15 sec block time
    minIncomingSettlementPeriod = role === 'client'
      ? 3 * (24 * 60 * 60) / 15 // ~ 3 days @ 15 sec block time
      : (24 * 60 * 60) / 15, // ~ 1 day @ 15 sec block time
    maxPacketAmount = Infinity,
    balance: {
      maximum = Infinity,
      settleTo = 0,
      settleThreshold = -Infinity,
      minimum = -Infinity
    } = {},
    channelWatcherInterval = new BigNumber(60 * 1000), // By default, every 60 seconds
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

    // Web3 requires a 0x in front, so prepend it if it's missing
    if (ethereumPrivateKey.indexOf('0x') !== 0) {
      ethereumPrivateKey = '0x' + ethereumPrivateKey
    }

    if (!isValidPrivate(toBuffer(ethereumPrivateKey))) {
      throw new Error('Invalid Ethereum private key')
    }

    this._web3 = new Web3(ethereumProvider)
    this._ethereumAddress = this._web3.eth.accounts.wallet.add(ethereumPrivateKey).address
    this._privateKey = ethereumPrivateKey.slice(2)
    this._getGasPrice = getGasPrice || (() => this._web3.eth.getGasPrice())

    this._store = new StoreWrapper(store)

    this._log = log || createLogger(`ilp-plugin-ethereum-${role}`)
    this._log.trace = this._log.trace || debug(`ilp-plugin-ethereum-${role}:trace`)

    this._closeOnDisconnect = closeOnDisconnect

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
      settleThreshold: new BigNumber(settleThreshold)
        .dp(0, BigNumber.ROUND_FLOOR),
      minimum: new BigNumber(minimum)
        .dp(0, BigNumber.ROUND_CEIL)
    }

    if (this._balance.settleThreshold.eq(this._balance.minimum)) {
      this._log.trace(`Auto-settlement disabled: plugin is in receive-only mode`)
    }

    // Validate balance configuration: max >= settleTo >= settleThreshold >= min
    if (!this._balance.maximum.gte(this._balance.settleTo)) {
      throw new Error('Invalid balance configuration: maximum balance must be greater than or equal to settleTo')
    }
    if (!this._balance.settleTo.gte(this._balance.settleThreshold)) {
      throw new Error('Invalid balance configuration: settleTo must be greater than or equal to settleThreshold')
    }
    if (!this._balance.settleThreshold.gte(this._balance.minimum)) {
      throw new Error('Invalid balance configuration: settleThreshold must be greater than or equal to the minimum balance')
    }
    if (!this._balance.maximum.gt(this._balance.minimum)) {
      throw new Error('Invalid balance configuration: maximum balance should be greater than minimum balance')
    }

    this._channelWatcherInterval = new BigNumber(channelWatcherInterval)
      .abs().dp(0, BigNumber.ROUND_DOWN)

    const loadAccount = (accountName: string) => this.loadAccount(accountName)
    const getAccount = (accountName: string) => {
      const account = this._accounts.get(accountName)
      if (!account) {
        throw new Error(`Account ${accountName} is not yet loaded`)
      }

      return account
    }

    this._plugin = role === 'server'
      ? new EthereumServerPlugin({ getAccount, loadAccount, ...opts }, { store, log })
      : new EthereumClientPlugin({ getAccount, loadAccount, ...opts }, { store, log })

    this._plugin.on('connect', () => this.emitAsync('connect'))
    this._plugin.on('disconnect', () => this.emitAsync('disconnect'))
    this._plugin.on('error', e => this.emitAsync('error', e))
  }

  private async loadAccount (accountName: string): Promise<EthereumAccount> {
    const accountKey = `${accountName}:account`
    await this._store.loadObject(accountKey)
    const accountData = this._store.getObject(accountKey) as (AccountData | undefined)

    // Parse balances, since they're non-primitives
    // (otherwise the defaults from the constructor are used)
    if (accountData && 'balance' in accountData) {
      accountData.balance = new BigNumber(accountData.balance)
    }
    if (accountData && 'payoutAmount' in accountData) {
      accountData.payoutAmount = new BigNumber(accountData.payoutAmount)
    }

    // Account data must always be loaded from store before it's in the map
    if (!this._accounts.has(accountName)) {
      const account = new EthereumAccount({
        sendMessage: (message: BtpPacket) =>
          this._plugin._sendMessage(accountName, message),
        dataHandler: (data: Buffer) =>
          this._dataHandler(data),
        moneyHandler: (amount: string) =>
          this._moneyHandler(amount),
        accountName,
        accountData,
        master: this
      })

      // Since this account didn't previosuly exist, save it in the store
      this._accounts.set(accountName, account)
      this._store.set('accounts', [...this._accounts.keys()])
    }

    return this._accounts.get(accountName)!
  }

  async connect () {
    // Cache the ID of the chain, and corresponding ABI/address of the contract
    this._network = await getNetwork(this._web3)
    this._contract = getContract(this._web3, this._network)

    // Load all accounts from the store
    await this._store.loadObject('accounts')
    const accounts = (this._store.getObject('accounts') as string[] | void) || []

    for (const accountName of accounts) {
      this._log.trace(`Loading account ${accountName} from store`)
      await this.loadAccount(accountName)

      // Throttle loading accounts to ~100 per second
      // Most accounts should shut themselves down shortly after they're loaded
      await new Promise(r => setTimeout(r, 10))
    }

    // Don't allow any incoming messages to accounts until all initial loading is complete
    // (this might create an issue, if an account requires _prefix to be known prior)
    return this._plugin.connect()
  }

  async disconnect () {
    // Triggers claiming of channels on client
    await this._plugin.disconnect()

    // Unload all accounts: stop channel watcher and perform garbage collection
    for (const account of this._accounts.values()) {
      account.unload()
    }

    // Persist store if there are any pending write operations
    await this._store.close()
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
    if (this._dataHandler !== defaultDataHandler) {
      throw new Error('request handler already registered')
    }

    this._dataHandler = dataHandler
    return this._plugin.registerDataHandler(dataHandler)
  }

  deregisterDataHandler () {
    this._dataHandler = defaultDataHandler
    return this._plugin.deregisterDataHandler()
  }

  registerMoneyHandler (moneyHandler: MoneyHandler) {
    if (this._moneyHandler !== defaultMoneyHandler) {
      throw new Error('money handler already registered')
    }

    this._moneyHandler = moneyHandler
    return this._plugin.registerMoneyHandler(moneyHandler)
  }

  deregisterMoneyHandler () {
    this._moneyHandler = defaultMoneyHandler
    return this._plugin.deregisterMoneyHandler()
  }
}
