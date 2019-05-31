import { convert, eth, gwei, wei } from '@kava-labs/crypto-rate-utils'
import BigNumber from 'bignumber.js'
import { instantiateSecp256k1, Secp256k1 } from 'bitcoin-ts'
import { registerProtocolNames } from 'btp-packet'
import { ethers } from 'ethers'
import { EventEmitter2 } from 'eventemitter2'
import createLogger from 'ilp-logger'
import { BtpPacket, IlpPluginBtpConstructorOptions } from 'ilp-plugin-btp'
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
  ClaimablePaymentChannel,
  deserializePaymentChannel,
  getContract,
  PaymentChannel,
  remainingInChannel,
  spentFromChannel,
  updateChannel
} from './utils/channel'
import ReducerQueue from './utils/queue'
import { MemoryStore, StoreWrapper } from './utils/store'
import ERC20_ARTIFACT from 'openzeppelin-solidity/build/contracts/ERC20Detailed.json'

registerProtocolNames(['machinomy', 'requestClose', 'channelDeposit'])

// Almost never use exponential notation
BigNumber.config({ EXPONENTIAL_AT: 1e9 })

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
  ethereumPrivateKey?: string

  /**
   * Name of an Ethereum chain to create an Infura provider with Etherscan fallback,
   * or a custom Ethers Ethereum provider to query the network
   */
  ethereumProvider?:
    | 'homestead'
    | 'kovan'
    | 'ropsten'
    | 'rinkeby'
    | ethers.providers.Provider

  /**
   * Ethers wallet used to sign transactions and provider to query the network
   * - Supercedes any private key or provider name config
   */
  ethereumWallet?: ethers.Wallet

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

  /**
   * Callback for fetching the currenct gas price
   * - Defaults to using the eth_estimateGas RPC with the connected Ethereum node
   */
  getGasPrice?: () => Promise<BigNumber.Value>

  /** Custom address for the Machinomy contract used */
  contractAddress?: string

  /** Address of the ERC-20 token contract to use for the token in the payment channel */
  tokenAddress?: string
}

const OUTGOING_CHANNEL_AMOUNT_GWEI = convert(eth('0.05'), gwei())

const BLOCKS_PER_DAY = (24 * 60 * 60) / 15 // Assuming 1 block / 15 seconds
const OUTGOING_DISPUTE_PERIOD_BLOCKS = 6 * BLOCKS_PER_DAY // 6 days
const MIN_INCOMING_DISPUTE_PERIOD_BLOCKS = 3 * BLOCKS_PER_DAY // 3 days

const CHANNEL_WATCHER_INTERVAL_MS = new BigNumber(60 * 1000)

export default class EthereumPlugin extends EventEmitter2
  implements PluginInstance {
  static readonly version = 2
  readonly _plugin: EthereumClientPlugin | EthereumServerPlugin
  readonly _accounts = new Map<string, EthereumAccount>() // accountName -> account
  readonly _wallet: ethers.Wallet
  readonly _getGasPrice: () => Promise<BigNumber> // wei
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
  _secp256k1?: Secp256k1
  _contract: Promise<ethers.Contract>
  _dataHandler: DataHandler = defaultDataHandler
  _moneyHandler: MoneyHandler = defaultMoneyHandler
  _tokenContract?: ethers.Contract

  /**
   * Orders of magnitude between the base unit, or smallest on-ledger denomination (e.g. wei)
   * and the unit used for accounting and in ILP packets (e.g. gwei)
   */
  _accountingScale = 9

  /**
   * Orders of magnitude between the base unit, or smallest on-ledger denomination (e.g. wei),
   * and the unit of exchange (e.g. ether)
   */
  _assetScale = 18

  /** Symbol of the asset exchanged */
  _assetCode = 'ETH'

  constructor(
    {
      role = 'client',
      ethereumPrivateKey,
      ethereumProvider = 'homestead',
      ethereumWallet,
      getGasPrice,
      outgoingChannelAmount = OUTGOING_CHANNEL_AMOUNT_GWEI,
      minIncomingChannelAmount = Infinity,
      outgoingDisputePeriod = OUTGOING_DISPUTE_PERIOD_BLOCKS,
      minIncomingDisputePeriod = MIN_INCOMING_DISPUTE_PERIOD_BLOCKS,
      maxPacketAmount = Infinity,
      channelWatcherInterval = CHANNEL_WATCHER_INTERVAL_MS,
      contractAddress,
      tokenAddress,
      // All remaining params are passed to mini-accounts/plugin-btp
      ...opts
    }: EthereumPluginOpts,
    { log, store = new MemoryStore() }: PluginServices = {}
  ) {
    super()

    if (ethereumWallet) {
      this._wallet = ethereumWallet
    } else if (ethereumPrivateKey) {
      const provider =
        typeof ethereumProvider === 'string'
          ? ethers.getDefaultProvider(ethereumProvider)
          : ethereumProvider

      this._wallet = new ethers.Wallet(ethereumPrivateKey, provider)
    } else {
      throw new Error('Private key or Ethers wallet must be configured')
    }

    this._store = new StoreWrapper(store)
    this._log = log || createLogger(`ilp-plugin-ethereum-${role}`)

    this._getGasPrice = async () =>
      new BigNumber(
        getGasPrice
          ? await getGasPrice()
          : await this._wallet.provider
              .getGasPrice()
              .then(gasPrice => gasPrice.toString())
      )

    // Cache the ABI/address of the contract corresponding to the chain we're connected to
    // If this promise rejects, connect() will also reject since loading accounts await this
    this._contract = getContract(
      this._wallet,
      !!tokenAddress,
      contractAddress
    ).catch(err => {
      this._log.error('Failed to load contract ABI and address:', err)
      throw err
    })

    if (tokenAddress) {
      this._tokenContract = new ethers.Contract(
        tokenAddress,
        ERC20_ARTIFACT.abi,
        this._wallet
      )
    }

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
                  deserializePaymentChannel(
                    accountData.incoming
                  ) as ClaimablePaymentChannel
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

  _queueTransaction<T>(sendTransaction: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this._txPipeline = this._txPipeline
        .then(sendTransaction)
        .then(resolve, reject)
    })
  }

  async connect() {
    this._secp256k1 = await instantiateSecp256k1()

    // Load asset scale and symbol from ERC-20 contract
    if (this._tokenContract) {
      this._assetCode = await this._tokenContract.functions
        .symbol()
        .catch(err => {
          // DAI incorrectly implements 'symbol' as bytes32, not a string, which throws
          if (typeof err.value === 'string') {
            return ethers.utils.parseBytes32String(err.value)
          } else {
            return 'tokens'
          }
        })

      this._assetScale = await this._tokenContract.functions
        .decimals()
        .catch(() => {
          this._log.info(
            `Configured ERC-20 doesn't have decimal place metadata; defaulting to 18 decimal places`
          )
          return 18
        })
    }

    // Load all accounts from the store
    await this._store.loadObject('accounts')
    const accounts =
      (this._store.getObject('accounts') as string[] | void) || []

    for (const accountName of accounts) {
      this._log.debug(`Loading account ${accountName} from store`)
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
    return this._plugin.sendMoney(amount)
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

  _format(num: BigNumber.Value, unit: 'base' | 'account') {
    const scale =
      (unit === 'base' ? 0 : this._accountingScale) - this._assetScale
    const amountInExchangeUnits = new BigNumber(num).shiftedBy(scale)

    return amountInExchangeUnits + ' ' + this._assetCode
  }

  _convertToBaseUnit(num: BigNumber) {
    return num
      .shiftedBy(this._assetScale - this._accountingScale)
      .decimalPlaces(0, BigNumber.ROUND_DOWN)
  }

  _convertFromBaseUnit(num: BigNumber) {
    return num
      .shiftedBy(this._accountingScale - this._assetScale)
      .decimalPlaces(0, BigNumber.ROUND_DOWN)
  }
}
