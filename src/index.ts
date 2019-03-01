import { convert, eth, gwei, wei } from '@kava-labs/crypto-rate-utils'
import BigNumber from 'bignumber.js'
import { registerProtocolNames } from 'btp-packet'
import debug from 'debug'
import { isValidPrivate, toBuffer } from 'ethereumjs-util'
import { EventEmitter2 } from 'eventemitter2'
import createLogger from 'ilp-logger'
import { BtpPacket, IlpPluginBtpConstructorOptions } from 'ilp-plugin-btp'
import Web3 from 'web3'
import Contract from 'web3/eth/contract'
import { Provider as EthereumProvider } from 'web3/providers'
import EthereumAccount, { SerializedAccountData } from './account'
import { EthereumClientPlugin } from './plugins/client'
import { EthereumServerPlugin, MiniAccountsOpts } from './plugins/server'
import {
  DataHandler,
  Logger,
  MoneyHandler,
  PluginInstance,
  PluginServices
} from './types/plugin'
import {
  getContract,
  updateChannel,
  remainingInChannel,
  spentFromChannel,
  PaymentChannel,
  ClaimablePaymentChannel,
  deserializePaymentChannel
} from './utils/contract'
import ReducerQueue from './utils/queue'
import { MemoryStore, StoreWrapper } from './utils/store'

registerProtocolNames(['machinomy', 'requestClose'])

// Almost never use exponential notation
BigNumber.config({ EXPONENTIAL_AT: 1e9 })

// TODO Should the default handlers return ILP reject packets? Should they error period?

const defaultDataHandler: DataHandler = () => {
  throw new Error('no request handler registered')
}

const defaultMoneyHandler: MoneyHandler = () => {
  throw new Error('no money handler registered')
}

export {
  EthereumAccount,
  remainingInChannel,
  spentFromChannel,
  PaymentChannel,
  ClaimablePaymentChannel
}

export interface EthereumPluginOpts
  extends MiniAccountsOpts,
    IlpPluginBtpConstructorOptions {
  /**
   * "client" to connect to a single peer or parent server that is explicity specified
   * "server" to enable multiple clients to openly connect to the plugin
   */
  role: 'client' | 'server'

  /**
   * Private key of the Ethereum account used to send and receive
   * - Corresponds to the Ethereum address shared with peers
   */
  ethereumPrivateKey: string

  /** Connection to an Ethereum node to query the network */
  ethereumProvider?: string | EthereumProvider

  /** Default amount to fund when opening a new channel or depositing to a depleted channel (gwei) */
  outgoingChannelAmount?: BigNumber.Value

  /**
   * Minimum value of incoming channel in order to _automatically_ fund an outgoing channel to peer (gwei)
   * - Defaults to infinity, which never automatically opens a channel
   * - Will also automatically top-up outgoing channels to the outgoing amount when they
   *   get depleted more than halfway
   */
  minIncomingChannelAmount?: BigNumber.Value

  /** Minimum number of blocks for settlement period to accept a new incoming channel */
  minIncomingDisputePeriod?: BigNumber.Value

  /** Number of blocks for dispute period used to create outgoing channels */
  outgoingDisputePeriod?: BigNumber.Value

  /** Maximum allowed amount in gwei for incoming packets (gwei) */
  maxPacketAmount?: BigNumber.Value

  /** Number of ms between runs of the channel watcher to check if a dispute was started */
  channelWatcherInterval?: BigNumber.Value

  /** Query the currenct gas price, if it was supplied */
  getGasPrice?: () => Promise<number>
}

export default class EthereumPlugin extends EventEmitter2
  implements PluginInstance {
  static readonly version = 2
  readonly _plugin: EthereumClientPlugin | EthereumServerPlugin
  readonly _accounts = new Map<string, EthereumAccount>() // accountName -> account
  readonly _ethereumAddress: string
  readonly _privateKey: string
  readonly _web3: Web3
  readonly _getGasPrice: () => Promise<number> // wei
  readonly _outgoingChannelAmount: BigNumber // wei
  readonly _minIncomingChannelAmount: BigNumber // wei
  readonly _outgoingDisputePeriod: BigNumber // # of blocks
  readonly _minIncomingDisputePeriod: BigNumber // # of blocks
  readonly _maxPacketAmount: BigNumber // gwei
  readonly _maxBalance: BigNumber // gwei
  readonly _channelWatcherInterval: BigNumber // ms
  readonly _store: StoreWrapper
  readonly _log: Logger
  _txPipeline: Promise<void> = Promise.resolve()
  _contract: Promise<Contract>
  _dataHandler: DataHandler = defaultDataHandler
  _moneyHandler: MoneyHandler = defaultMoneyHandler

  constructor(
    {
      role = 'client',
      ethereumPrivateKey,
      ethereumProvider = 'wss://mainnet.infura.io/ws',
      getGasPrice,
      outgoingChannelAmount = convert(eth('0.05'), gwei()),
      minIncomingChannelAmount = Infinity,
      outgoingDisputePeriod = (6 * (24 * 60 * 60)) /
        15 /** ~ 6 days @ 15 sec block time */,
      minIncomingDisputePeriod = (3 * (24 * 60 * 60)) /
        15 /** ~ 3 days @ 15 sec block time */,
      maxPacketAmount = Infinity,
      channelWatcherInterval = new BigNumber(60 * 1000), // By default, every 60 seconds
      // All remaining params are passed to mini-accounts/plugin-btp
      ...opts
    }: EthereumPluginOpts,
    { log, store = new MemoryStore() }: PluginServices = {}
  ) {
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

    this._store = new StoreWrapper(store)

    this._log = log || createLogger(`ilp-plugin-ethereum-${role}`)
    this._log.trace =
      this._log.trace || debug(`ilp-plugin-ethereum-${role}:trace`)

    this._web3 = new Web3(ethereumProvider)
    this._ethereumAddress = this._web3.eth.accounts.wallet.add(
      ethereumPrivateKey
    ).address
    this._privateKey = ethereumPrivateKey.slice(2)
    this._getGasPrice = getGasPrice || (() => this._web3.eth.getGasPrice())

    // Cache the ABI/address of the contract corresponding to the chain we're connected to
    // If this promise rejects, connect() will also reject since loading accounts await this
    this._contract = getContract(this._web3).catch(err => {
      this._log.error('Failed to load contract ABI and address:', err)
      throw err
    })

    this._outgoingChannelAmount = convert(gwei(outgoingChannelAmount), wei())
      .abs()
      .dp(0, BigNumber.ROUND_DOWN)

    this._minIncomingChannelAmount = convert(
      gwei(minIncomingChannelAmount),
      wei()
    )
      .abs()
      .dp(0, BigNumber.ROUND_DOWN)

    // Sender can start a dispute period at anytime (e.g., if receiver is unresponsive)
    // If the receiver doesn't claim funds within that period, sender gets entire channel value

    this._minIncomingDisputePeriod = new BigNumber(minIncomingDisputePeriod)
      .abs()
      .dp(0, BigNumber.ROUND_CEIL)

    this._outgoingDisputePeriod = new BigNumber(outgoingDisputePeriod)
      .abs()
      .dp(0, BigNumber.ROUND_DOWN)

    this._maxPacketAmount = new BigNumber(maxPacketAmount)
      .abs()
      .dp(0, BigNumber.ROUND_DOWN)

    this._maxBalance = new BigNumber(role === 'client' ? Infinity : 0).dp(
      0,
      BigNumber.ROUND_FLOOR
    )

    this._channelWatcherInterval = new BigNumber(channelWatcherInterval)
      .abs()
      .dp(0, BigNumber.ROUND_DOWN)

    const loadAccount = (accountName: string) => this._loadAccount(accountName)
    const getAccount = (accountName: string) => {
      const account = this._accounts.get(accountName)
      if (!account) {
        throw new Error(`Account ${accountName} is not yet loaded`)
      }

      return account
    }

    this._plugin =
      role === 'server'
        ? new EthereumServerPlugin(
            { getAccount, loadAccount, ...opts },
            { store, log }
          )
        : new EthereumClientPlugin(
            { getAccount, loadAccount, ...opts },
            { store, log }
          )

    this._plugin.on('connect', () => this.emitAsync('connect'))
    this._plugin.on('disconnect', () => this.emitAsync('disconnect'))
    this._plugin.on('error', e => this.emitAsync('error', e))
  }

  async _loadAccount(accountName: string): Promise<EthereumAccount> {
    const accountKey = `${accountName}:account`
    await this._store.loadObject(accountKey)

    // TODO Add much more robust deserialization from store
    const accountData = this._store.getObject(accountKey) as (
      | SerializedAccountData
      | undefined)

    // Account data must always be loaded from store before it's in the map
    if (!this._accounts.has(accountName)) {
      const account = new EthereumAccount({
        sendMessage: (message: BtpPacket) =>
          this._plugin._sendMessage(accountName, message),
        dataHandler: (data: Buffer) => this._dataHandler(data),
        moneyHandler: (amount: string) => this._moneyHandler(amount),
        accountName,
        accountData: {
          ...accountData,
          accountName,
          receivableBalance: new BigNumber(
            accountData ? accountData.receivableBalance : 0
          ),
          payableBalance: new BigNumber(
            accountData ? accountData.payableBalance : 0
          ),
          payoutAmount: new BigNumber(
            accountData ? accountData.payoutAmount : 0
          ),
          incoming: new ReducerQueue(
            accountData && accountData.incoming
              ? await updateChannel(
                  await this._contract,
                  deserializePaymentChannel(accountData.incoming)
                )
              : undefined
          ),
          outgoing: new ReducerQueue(
            accountData && accountData.outgoing
              ? await updateChannel(
                  await this._contract,
                  deserializePaymentChannel(accountData.outgoing)
                )
              : undefined
          )
        },
        master: this
      })

      // Since this account didn't previosuly exist, save it in the store
      this._accounts.set(accountName, account)
      this._store.set('accounts', [...this._accounts.keys()])
    }

    return this._accounts.get(accountName)!
  }

  async _queueTransaction(sendTransaction: () => Promise<void>) {
    await new Promise<void>((resolve, reject) => {
      this._txPipeline = this._txPipeline
        .then(sendTransaction)
        .then(resolve, reject)
    })
  }

  async connect() {
    // Load all accounts from the store
    await this._store.loadObject('accounts')
    const accounts =
      (this._store.getObject('accounts') as string[] | void) || []

    for (const accountName of accounts) {
      this._log.trace(`Loading account ${accountName} from store`)
      await this._loadAccount(accountName)

      // Throttle loading accounts to ~100 per second
      // Most accounts should shut themselves down shortly after they're loaded
      await new Promise(r => setTimeout(r, 10))
    }

    // Don't allow any incoming messages to accounts until all initial loading is complete
    // (this might create an issue, if an account requires _prefix to be known prior)
    return this._plugin.connect()
  }

  async disconnect() {
    // Triggers claiming of channels on client
    await this._plugin.disconnect()

    // Unload all accounts: stop channel watcher and perform garbage collection
    for (const account of this._accounts.values()) {
      account.unload()
    }

    // Persist store if there are any pending write operations
    await this._store.close()
  }

  isConnected() {
    return this._plugin.isConnected()
  }

  async sendData(data: Buffer) {
    return this._plugin.sendData(data)
  }

  async sendMoney(amount: string) {
    const peerAccount = this._accounts.get('peer')
    if (peerAccount) {
      // If the plugin is acting as a client, enable sendMoney (required for prefunding)
      await peerAccount.sendMoney(amount)
    } else {
      this._log.error(
        'sendMoney is not supported: use plugin balance configuration instead of connector balance for settlement'
      )
    }
  }

  registerDataHandler(dataHandler: DataHandler) {
    if (this._dataHandler !== defaultDataHandler) {
      throw new Error('request handler already registered')
    }

    this._dataHandler = dataHandler
    return this._plugin.registerDataHandler(dataHandler)
  }

  deregisterDataHandler() {
    this._dataHandler = defaultDataHandler
    return this._plugin.deregisterDataHandler()
  }

  registerMoneyHandler(moneyHandler: MoneyHandler) {
    if (this._moneyHandler !== defaultMoneyHandler) {
      throw new Error('money handler already registered')
    }

    this._moneyHandler = moneyHandler
    return this._plugin.registerMoneyHandler(moneyHandler)
  }

  deregisterMoneyHandler() {
    this._moneyHandler = defaultMoneyHandler
    return this._plugin.deregisterMoneyHandler()
  }
}
