'use strict'

import { Units } from '@machinomy/contracts'
import BigNumber from 'bignumber.js'
import { randomBytes } from 'crypto'
import * as IlpPacket from 'ilp-packet'
import { BtpPacket, BtpSubProtocol } from 'ilp-plugin-btp'
import { Machinomy, Payment, PaymentChannel } from 'machinomy'
import { promisify } from 'util'
import * as Web3 from 'web3'
import StoreWrapper from './store-wrapper'
const MiniAccountsPlugin = require('ilp-plugin-mini-accounts')
import createLogger = require('ilp-logger')
const BtpPacket = require('btp-packet')

class Trace extends Error {}

interface Account {
  // Is the server currently opening a channel/depositing to the client?
  isFunding: boolean
  // Is this account blocked/closed (unable to send money)?
  isBlocked: boolean
  // Hash/account identifier in ILP address
  accountName: string
  // Net amount client owes the server, including secured paychan claims from client
  balance: BigNumber
  // Ethereum address client should be paid at (does not pertain to address client sends from)
  // Must be linked for the lifetime of the account
  ethereumAddress?: string
  // ID for paychan from server -> client
  outgoingChannelId?: string
  // ID for paychan from client -> server
  incomingChannelId?: string
}

interface Logger {
  info (...msg: any[]): void
  warn (...msg: any[]): void
  error (...msg: any[]): void
  debug (...msg: any[]): void
  trace (...msg: any[]): void
}

const DEBUG_NAMESPACE = 'ilp-plugin-ethereum-server'
const OUTGOING_CHANNEL_AMOUNT = Units.convert(new BigNumber(0.001), 'eth', 'gwei')

export const getSubprotocol = (message: BtpPacket, name: string) =>
  message.data.protocolData.find((p: BtpSubProtocol) => p.protocolName === name)

export const requestId = async () =>
  (await promisify(randomBytes)(4)).readUInt32BE(0)

export const formatAmount = (num: string | BigNumber, toUnit: string) =>
  Units.convert(new BigNumber(num), 'gwei', toUnit).toString() + ' ' + toUnit

export default class MachinomyServerPlugin extends MiniAccountsPlugin {
  static version: number = 2
  private _address: string
  private _provider: Web3.Provider | string
  private _web3: Web3
  private _machinomy: Machinomy
  private _databaseUrl: string
  private _minimumSettlementPeriod: number // Minimum number of blocks for a dispute
  private _minimumChannelAmount?: BigNumber | number
  private _maxPacketAmount: BigNumber
  private balance: {
    maximum: BigNumber
    settleThreshold: BigNumber
    settleTo: BigNumber
  }
  protected _store: any // Resolves incompatiblities with the older ilp-store-wrapper used by mini-accounts
  protected _log: Logger
  private _accounts: Map<string, Account>
  private _watcher: NodeJS.Timer

  constructor (opts: {
    address: string,
    provider?: Web3.Provider | string,
    databaseUrl?: string
    minimumChannelAmount?: BigNumber | number,
    maxPacketAmount?: BigNumber | string,
    // Balance (positive) is how much the client/counterparty owes the server
    // (negative balance implies the server owes the client)
    balance?: {
      // Maximum balance the client owes the server before incoming packets are rejected
      maximum: BigNumber | string
      // If a balance is below this amount, triggers settlement
      settleThreshold?: BigNumber | string
      // New balance after triggering settlement
      settleTo?: BigNumber | string
    }
    _store?: any // Resolves incompatiblities with the older ilp-store-wrapper used by mini-accounts
    _log?: Logger
  }) {
    super(opts)

    this._address = opts.address
    this._databaseUrl = opts.databaseUrl || 'nedb://machinomy_db'
    this._provider = opts.provider || 'http://localhost:8545'
    this._web3 = new Web3(typeof this._provider === 'string'
      ? new Web3.providers.HttpProvider(this._provider)
      : this._provider)

    // Sender can start a settling period at anytime (e.g., if receiver is unresponsive)
    // If the receiver doesn't claim funds within that period, sender gets entire channel value
    // Default Machinomy settlement period is 172,800 blocks, or greater than a month
    // That's too long, so use ~1 week instead (assuming block time of 15 seconds)
    const WEEK_IN_SECONDS = 7 * 24 * 60 * 60
    this._minimumSettlementPeriod = WEEK_IN_SECONDS / 15

    this._minimumChannelAmount = opts.minimumChannelAmount

    this._maxPacketAmount = new BigNumber(opts.maxPacketAmount || Infinity)

    this.balance = {
      maximum:         new BigNumber((opts.balance && opts.balance.maximum) || 0),
      settleThreshold: new BigNumber((opts.balance && opts.balance.settleThreshold) || 0),
      settleTo:        new BigNumber((opts.balance && opts.balance.settleTo) || 0)
    }

    this._store = new StoreWrapper(opts._store)
    this._log = opts._log || createLogger(DEBUG_NAMESPACE)
    this._accounts = new Map()
  }

  // Calculate a transaction fee in gwei based on the operation and network gas price
  // FIX: convert gas price from wei to gwei
  // TODO should these be the gas limit?
  // TODO or could we use estimateGas?
  async _estimateFee (txType: 'open' | 'deposit' | 'claim') {
    const gasUsage = {
      open: 114676,
      deposit: 34412,
      claim: 40478
    }

    const getGasPrice = promisify(this._web3.eth.getGasPrice)
    const gasPriceInGwei = this._web3.fromWei(await getGasPrice(), 'gwei')
    return gasPriceInGwei.times(gasUsage[txType])
  }

  // FIX: anonymous function to fix `this` context, assign new value to obj
  // FIX: assign new property in set trap
  _getAccount (address: string) {
    const accountName = this.ilpAddressToAccount(address)
    let account = this._accounts.get(accountName)

    if (!account) {
      // Use a Proxy to persist to store when state updates occur
      account = new Proxy({
        isFunding: false,
        isBlocked: false,
        accountName,
        balance: new BigNumber(0)
      }, {
        set: (obj, prop, val) => {
          obj[prop] = val
          this._store.set(accountName, JSON.stringify(obj))
          return Reflect.set(obj, prop, val)
        }
      })
      this._accounts.set(accountName, account)
    }

    return account
  }

  // Called before starting WS server
  async _preConnect () {
    this._machinomy = new Machinomy(this._address, this._web3, {
      databaseUrl: this._databaseUrl,
      // Machinomy won't accept incoming channels with settling periods less than this
      minimumSettlementPeriod: this._minimumSettlementPeriod,
      minimumChannelAmount: this._minimumChannelAmount || (await this._estimateFee('claim')).times(5)
    })
    this._startWatcher()
  }

  // Called after BTP auth packet is received
  async _connect (address: string, message: BtpPacket) {
    let account: Account = this._getAccount(address)

    // Load all balance and channel information from store
    // Use a Proxy to automatically persist to store whenever state updates occur
    account = new Proxy({
      ...account,
      ...await this._store.loadObject(account.accountName)
    }, {
      set: (obj, prop, val) => {
        obj[prop] = val
        this._store.set(account.accountName, JSON.stringify(obj))
        return Reflect.set(obj, prop, val)
      }
    })

    this._accounts.set(account.accountName, account)

    if (account.isBlocked) {
      throw new Error(`Cannot connect to blocked account ${account.accountName}`)
    }

    // Only a single Ethereum address can be linked to an account, for the lifetime of the account
    // TODO a single payment channel at a given address?
    if (!account.ethereumAddress) {
      // Resolve the Ethereum address the client wants to be paid at
      const infoResponse = await this._call(address, {
        type: BtpPacket.TYPE_MESSAGE,
        requestId: await requestId(),
        data: {
          protocolData: [{
            protocolName: 'info',
            contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
            data: Buffer.from([2])
          }]
        }
      })

      const info = JSON.parse(infoResponse.protocolData[0].data.toString())

      if (this._web3.isAddress(info.ethereumAddress)) {
        account.ethereumAddress = info.ethereumAddress
      }
    }
  }

  // Called by ilp-plugin-btp when a type MESSAGE BTP packet is received
  // TODO no, it's called by mini accounts
  _handleCustomData = async (from: string, message: BtpPacket) => {
    const account = this._getAccount(from)

    const info = getSubprotocol(message, 'info')
    const ilp = getSubprotocol(message, 'ilp')

    // Tell client what Ethereum address the server wants to be paid at
    if (info) {
      return [{
        protocolName: 'info',
        contentType: BtpPacket.MIME_APPLICATION_JSON,
        data: Buffer.from(JSON.stringify({
          ethereumAddress: this._address
        }))
      }]
    }

    // Handle ILP PREPARE packets
    // Any response packets (FULFILL or REJECT) should come from data handler response,
    // not wrapped in a BTP message (connector/data handler would throw an error anyways?)
    // TODO check if payment channel exists? What if peer does not have
    // enough money in the channel? Or if there is no channel? Could employ
    // similar logic to xrp asym server. Deposit 10xrp, along with a channel
    // protocol transmitting channel details?
    if (ilp && ilp.data[0] === IlpPacket.Type.TYPE_ILP_PREPARE) {
      const { amount, expiresAt } = IlpPacket.deserializeIlpPrepare(ilp.data)
      if (account.isBlocked) {
        throw new IlpPacket.Errors.UnreachableError('Account has been closed.')
      }

      if (this._maxPacketAmount.lt(amount)) {
        throw new IlpPacket.Errors.AmountTooLargeError('Packet size is too large.', {
          receivedAmount: amount,
          maximumAmount: this._maxPacketAmount.toString()
        })
      }

      const newBalance = account.balance.plus(amount)

      if (newBalance.gt(this.balance.maximum)) {
        throw new IlpPacket.Errors.InsufficientLiquidityError(
          `Insufficient funds, prepared balance is ${formatAmount(newBalance, 'eth')}, above max of ${formatAmount(this.balance.maximum, 'eth')}`
        )
      }

      if (typeof this._dataHandler !== 'function') {
        throw new Error('no request handler registered')
      }

      // Everything checks out, update balance and proceed
      account.balance = newBalance
      this._log.trace(`account ${account.accountName} debited ${formatAmount(amount, 'eth')}, new balance ${formatAmount(newBalance, 'eth')}`)

      // Forward the packet to data handler, wait for response
      let response = await Promise.race([
        this._dataHandler(ilp.data),
        // Send reject if PREPARE expires before a response is received
        new Promise<Buffer>((resolve, reject) => {
          setTimeout(() => {
            reject(
              IlpPacket.errorToReject(this._prefix, {
                ilpErrorCode: 'R00',
                message: `Expired at ${new Date().toISOString()}`
              })
            )
          }, expiresAt.getTime() - Date.now())
        })
      ])

      // TODO allow negative payment?
      if (response[0] === IlpPacket.Type.TYPE_ILP_REJECT) {
        account.balance = account.balance.minus(amount)
        this._log.trace(`Account ${account.accountName} roll back ${formatAmount(amount, 'eth')}, new balance ${formatAmount(account.balance, 'eth')}`)
      } else if (response[0] === IlpPacket.Type.TYPE_ILP_FULFILL) {
        this._log.trace(`Received FULFILL in response to forwarded PREPARE`)

        if (typeof this._moneyHandler !== 'function') {
          throw new Error('no money handler registered')
        }

        if (new BigNumber(amount).gt(0)) {
          this._moneyHandler(amount)
        }
      }

      return this.ilpAndCustomToProtocolData({ ilp: response })
    }

    return []
  }

  // After calling sendData on the plugin, this is called first
  // Errors should throw ILP packets (prior to any await/Promise is returned)
  // TODO: again, should we be able to send a prepare without a payment channel?
  _sendPrepare (destination: string, preparePacket: IlpPacket.IlpPacket) {
    const account = this._getAccount(destination)

    if (account.isBlocked) {
      throw new IlpPacket.Errors.UnreachableError('Account has been closed')
    }

    if (!account.ethereumAddress) {
      throw new IlpPacket.Errors.UnreachableError('No Ethereum address linked with account, cannot forward PREPARE')
    }
  }

  // Handler after response is received within sendData (called by mini-accounts)
  // Use an async function so it won't hold up passing response packet back to sender
  // If it's a FULFILL, the execution condition is already verified in mini-accounts
  _handlePrepareResponse = async (destination: string, parsedResponse: IlpPacket.IlpPacket, preparePacket: IlpPacket.IlpPacket) => {
    const responseType = Object.keys(IlpPacket.Type)[Object.values(IlpPacket.Type).indexOf(parsedResponse.type)].slice(5) // => e.g. 'ILP_FULFILL'
    this._log.trace(`Handling a ${responseType} in response to the forwarded ILP_PREPARE`)

    if (parsedResponse.type === IlpPacket.Type.TYPE_ILP_FULFILL) {
      const account = this._getAccount(destination)

      // Update balance to reflect that we owe them the amount of the FULFILL
      const amount = new BigNumber(preparePacket.data.amount)
      const newBalance = account.balance.minus(amount)
      this._log.trace(`Updated balance for account ${account.accountName} from ${account.balance} to ${newBalance}`)
      account.balance = newBalance

      try {
        let channel: PaymentChannel | null | undefined
        if (account.outgoingChannelId) {
          // Update channel details and fetch latest state
          channel = await this._machinomy.channelById(account.outgoingChannelId)

          if (channel && channel.receiver !== account.ethereumAddress) {
            throw new Error(`recipient of the outgoing channel is not the linked Ethereum address. ` +
              `This should never occur and be investigated further. ` +
              `channelId=${account.outgoingChannelId} channelAddress=${channel.receiver} accountAddress=${account.ethereumAddress}`)
          }
        }

        // isFunding should be toggled after all non-funding related aysnc operations have completed, but before any balance changes occur
        if (account.isFunding) {
          throw new Trace(`Failed to pay account ${account.accountName}: another funding event was occuring simultaneously.`)
        }
        account.isFunding = true

        // This try-catch block wraps all code where isFunding must be true, so if there's an error, it will be safely toggled back
        let amount = this.balance.settleTo.minus(account.balance)
        try {
          // Check if an on-chain funding tx is required
          let requiresNewChannel = !channel // If no channel exists
            || channel.state !== 1 // If existing channel is settling or settled
          let requiresDeposit = channel &&
            amount.gt(channel.value.minus(channel.spent)) // If amount to settle is greater than amount in channel

          // Update balance to account for an on-chain transaction fee
          let feeEstimate
          if (requiresNewChannel) {
            feeEstimate = await this._estimateFee('open')
            const newBalance = account.balance.plus(feeEstimate)

            if (newBalance.gt(this.balance.maximum)) {
              throw new Trace(`insufficient funds to open a new channel; funds will continue to accumulate.`)
            }

            account.balance = newBalance
          } else if (requiresDeposit) {
            feeEstimate = await this._estimateFee('deposit')
            const newBalance = account.balance.plus(feeEstimate)

            if (newBalance.gt(this.balance.maximum)) {
              this._log.trace(`Account ${account.accountName} has insufficient funds to cover an on-chain deposit to send full payment; sending partial payment.`)
              requiresDeposit = false
            } else {
              account.balance = newBalance
            }
          }

          if (this.balance.settleThreshold.lt(account.balance)) {
            throw new Trace(`below settle threshold; funds with continue to accumulate.`)
          }

          // Balance was updated, so update amount to send
          amount = this.balance.settleTo.minus(account.balance)

          const fundAmount = BigNumber.max(amount, OUTGOING_CHANNEL_AMOUNT)
          const fundAmountWei = Units.convert(fundAmount, 'gwei', 'wei')

          if (!channel || channel.state !== 1) {
            if (!account.ethereumAddress) {
              throw new Error(`no Ethereum address was linked.`)
            }

            // Machinomy opens a channel for 10x the deposit amount, so divide it by 10...
            channel = await this._machinomy.open(account.ethereumAddress, fundAmountWei.div(10))

            // Set the outgoing channel to the new channel
            account.outgoingChannelId = channel.channelId

            // Machinomy doesn't return a transaction receipt after opening channel, so can't determine actual fee
          } else if (requiresDeposit) {
            const { receipt, tx } = await this._machinomy.deposit(channel.channelId, fundAmountWei)

            // Refund fee estimate and update balance with actual tx fee (if tx is still pending, it fetches gas used from pending tx)
            const gasPrice = (await promisify(this._web3.eth.getTransaction)(tx)).gasPrice
            const actualFee = new BigNumber(receipt.gasUsed).times(gasPrice)
            const diff = actualFee.minus(feeEstimate as BigNumber)
            account.balance = account.balance.plus(diff)
            this._log.trace(`Updated balance for account ${account.accountName} to reflect difference of ${diff} gwei between actual and estimated transaction fees`)
          }
        } catch (err) {
          throw err
        } finally {
          account.isFunding = false
        }

        // Balance was updated, so updated, so update amount to send
        amount = this.balance.settleTo.minus(account.balance)

        // Don't send a paychan update for 0 or negative amounts; Machinomy won't throw an error
        if (amount.lte(0)) {
          throw new Trace(`Failed to pay account ${account.accountName}: insufficient balance to trigger settlement.`)
        }

        // Construct the payment for the given amount
        const { payment } = await this._machinomy.payment({
          receiver: channel.receiver,
          price: Units.convert(amount, 'gwei', 'wei')
        }) as { payment: { channelId: string } } // TODO: Pending PR to add type info to Machinomy

        // Confirm the payment used the correct channel (Machinomy selects one internally, no way to force which channel)
        if (payment.channelId !== account.outgoingChannelId) {
          throw new Error(`Machinomy selected the wrong payment channel for claim; database may need to be cleared.`)
        }

        // Update balance
        account.balance = account.balance.plus(amount)

        // Send paychan claim to client
        this._call(destination, {
          type: BtpPacket.TYPE_TRANSFER,
          requestId: await requestId(),
          data: {
            amount: amount.toString(),
            protocolData: [{
              protocolName: 'machinomy',
              contentType: BtpPacket.MIME_APPLICATION_JSON,
              data: Buffer.from(JSON.stringify(payment))
            }]
          }
        })
      } catch (err) {
        (err.name === 'Trace'
          ? this._log.trace
          : this._log.error
        )(`Failed to pay account ${account.accountName}: ${err}`)
      }
    }
  }

  // Called by ilp-plugin-btp when a type TRANSFER BTP packet is received
  // ilp-plugin-btp should handle errors and return a BTP ERROR response packet
  async _handleMoney (from: string, message: BtpPacket) {
    const account = this._getAccount(from)
    const machinomy = getSubprotocol(message, 'machinomy')

    if (machinomy) {
      const payment: Payment = JSON.parse(machinomy.data.toString())
      this._log.trace(`Handling Machinomy payment for account ${account.accountName}`)

      // If the account already has a channel, client must be using that channel
      // We don't want to track claims and calculate profitability across multiple incoming channels
      if (account.incomingChannelId && payment.channelId !== account.incomingChannelId) {
        throw new Error(`Account ${account.accountName} must use channel ${account.incomingChannelId}`)
      }

      // Machinomy will verify:
      // - Payment is signed and to the server's address
      // - The channel is open and has sufficient balance
      // - This claim is greater than any previous claim it has received
      // - The same paychan update cannot be submitted more than once,
      //   so multiple different accounts cannot submit the same claim and
      //   a single paychan therefore cannot be associated with more than one account
      // Also fetches updated paychan state from the network
      // Otherwise, it throws an error
      await this._machinomy.acceptPayment({ payment })
      this._log.trace('Accepted Machinomy payment', payment)

      // Lookup the channel details
      const channel = await this._machinomy.channelById(payment.channelId)

      if (!channel) {
        throw new Error(`Channel from payment could not be fetched`)
      }

      // If the payment is valid and no channel is already associated with the account, use this one
      if (!account.incomingChannelId) {
        account.incomingChannelId = payment.channelId
        this._log.trace(`Channel ${account.incomingChannelId} is now linked to account ${account.accountName}`)
      }

      // Machinomy doesn't verify price adds up, so calculate amount to credit ourselves
      const amount = Units.convert(channel.spent.minus(payment.value), 'wei', 'gwei')
      account.balance = account.balance.minus(amount)
      this._log.trace(`Updated balance for account ${account.accountName} to ${formatAmount(account.balance, 'eth')}`)
    } else {
      throw new Error(`BTP TRANSFER packet did not include any Machinomy subprotocol data`)
    }

    return []
  }

  private _startWatcher () {
    // Average block time of 15s => ~200 polls would occur during a settlement period
    // With the default settlement period of ~1 week, default polling interval is every ~50 min
    const interval = (this._minimumSettlementPeriod * 15) / 200
    const timer = setInterval(async () => {
      // If sender starts settling and we don't claim the channel before the settling period ends,
      // all our money goes back to them! (bad)
      const channels = await this._machinomy.settlingChannels()
      // Block any accounts that start settling
      for (let c of channels) {
        for (let [, account] of this._accounts) {
          if (c.channelId === account.incomingChannelId) {
            // TODO account not actually being blocked?
            this._log.info(`Account ${account.accountName} is now blocked for attempting to clear our funds from channel.`)
          }
        }
      }
      // Claim any settling channels, if it's profitable
      channels
        .filter(c => c.receiver === this._address)
        .forEach(async c => {
          const fee = await this._estimateFee('claim')
          if (c.spent.gt(fee)) {
            try {
              await this._machinomy.close(c.channelId)
              this._log.info(`Successfully claimed channel ${c.channelId} to prevent funds reverting to sender.`)
            } catch (err) {
              this._log.error(`Failed to close settling channel ${c.channelId}. Will re-try at the next interval.`)
            }
          }
        })
    }, interval)
    timer.unref() // Don't let timer prevent process from exiting
    this._watcher = timer
  }

  async _disconnect () {
    clearInterval(this._watcher)

    for (const accountName of this._accounts.keys()) {
      this._store.unload(accountName)
    }
    await this._store.close()
  }
}
