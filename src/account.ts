import Web3 = require('web3')
import { TransactionReceipt } from 'web3/types'
import {
  TYPE_MESSAGE,
  TYPE_TRANSFER,
  MIME_APPLICATION_JSON,
  MIME_APPLICATION_OCTET_STREAM,
  MIME_TEXT_PLAIN_UTF8
} from 'btp-packet'
import BigNumber from 'bignumber.js'
import { DataHandler, MoneyHandler } from './utils/types'
import { BtpPacket, BtpPacketData, BtpSubProtocol } from 'ilp-plugin-btp'
import {
  Type,
  IlpPrepare,
  IlpPacket,
  Errors,
  errorToReject,
  deserializeIlpPrepare
} from 'ilp-packet'
import EthereumPlugin from '.'
import { randomBytes } from 'crypto'
import { sign as ethSign, recover as ethRecover } from 'eth-crypto'
// @ts-ignore
import { SIGN_PREFIX } from 'eth-crypto/dist/lib/hash'
import { keccak256 } from 'js-sha3'
import { promisify } from 'util'
import {
  IClaim,
  IChannel,
  generateChannelId,
  generateTx,
  isSettling,
  fetchChannel
} from './utils/contract'
import Queue from 'p-queue'
import { EventEmitter2 } from 'eventemitter2'

BigNumber.config({ EXPONENTIAL_AT: 1e+9 }) // Almost never use exponential notation

enum TaskPriority {
  ClaimTx = 4,
  ChannelWatcher = 3,
  Incoming = 2,
  Outgoing = 1
}

export enum Unit {
  Eth = 18,
  Gwei = 9,
  Wei = 0
}

export const convert = (num: BigNumber.Value, from: Unit, to: Unit): BigNumber =>
  new BigNumber(num).shiftedBy(from - to)

export const format = (num: BigNumber.Value, from: Unit) =>
  convert(num, from, Unit.Eth) + ' eth'

export const getSubprotocol = (message: BtpPacket, name: string) =>
  message.data.protocolData.find((p: BtpSubProtocol) => p.protocolName === name)

export const requestId = async () =>
  (await promisify(randomBytes)(4)).readUInt32BE(0)

export interface AccountData {
  // Hash/account identifier in ILP address
  accountName: string
  // Net amount in gwei the counterparty owes the this instance, including secured paychan claims
  // - Negative implies this instance owes the counterparty
  balance: BigNumber
  // Sum of all fulfilled packets owed to the counterparty that have yet to be paid out (always >= 0)
  // - The balance limits when settlements happen, but this limits the settlement amount so we don't send
  //   all the clients' money directly back to them!
  payoutAmount: BigNumber
  // Ethereum address counterparty should be paid at
  // - Does not pertain to address counterparty sends from
  // - Must be linked for the lifetime of the account
  ethereumAddress?: string
  // ID for paychan from this -> counterparty
  outgoingChannelId?: string
  // Greatest claim/payment from this -> counterparty
  bestOutgoingClaim?: IClaim
  // Greatest claim/payment from counterparty -> this
  // - Also used for channelId, since a paychan wouldn't be linked without a claim
  bestIncomingClaim?: IClaim
}

export default class EthereumAccount {
  private account: AccountData
  // Cache for all channels (not persisted to store)
  private channelCache: {
    [channelId: string]: IChannel
  } = {}
  // Expose access to common configuration across accounts
  private master: EthereumPlugin
  // Send the given BTP packet message to this counterparty
  private sendMessage: (message: BtpPacket) => Promise<BtpPacketData>
  // Data handler from plugin for incoming ILP packets
  private dataHandler: DataHandler
  // Money handler from plugin for incoming money
  private moneyHandler: MoneyHandler
  // Priority FIFO queue for all incoming settlements, outgoing settlements, and channel claims
  // - Operations with greater priority will be scheduled first
  private queue = new Queue({
    concurrency: 1
  })
  // Timer/interval for channel watcher to claim incoming, settling channels
  private watcher: NodeJS.Timer | null

  constructor ({
    accountName,
    accountData,
    master,
    sendMessage,
    dataHandler,
    moneyHandler
  }: {
    accountName: string,
    accountData?: AccountData,
    master: EthereumPlugin,
    // Wrap _call/expose method to send WS messages
    sendMessage: (message: BtpPacket) => Promise<BtpPacketData>,
    dataHandler: DataHandler,
    moneyHandler: MoneyHandler
  }) {
    this.master = master
    this.sendMessage = sendMessage
    this.dataHandler = dataHandler
    this.moneyHandler = moneyHandler

    this.account = new Proxy({
      accountName,
      balance: new BigNumber(0),
      payoutAmount: this.master._balance.settleTo.gt(0)
        // If we're prefunding, we don't care about the total amount fulfilled
        // Since we take the min of this and the settleTo/settleThreshold delta, this
        // essentially disregards the payout amount
        ? new BigNumber(Infinity)
        // If we're settling up after fulfills, then we do care
        : new BigNumber(0),
      ...accountData
    }, {
      set: (account, key, val) => {
        // Commit the changes to the configured store
        this.master._store.set(`${accountName}:account`, {
          ...account,
          [key]: val
        })

        return Reflect.set(account, key, val)
      }
    })

    this.watcher = this.startChannelWatcher()
  }

  private async updateChannelCache (channelId: string): Promise<IChannel | undefined> {
    const channel = await fetchChannel(this.master._contract!, channelId)
    if (!channel) {
      delete this.channelCache[channelId]
    } else {
      this.channelCache[channelId] = channel
    }

    return channel
  }

  private addBalance (amount: BigNumber) {
    if (amount.isZero()) return

    const maximum = this.master._balance.maximum
    const newBalance = this.account.balance.plus(amount)

    if (newBalance.gt(maximum)) {
      throw new Error(`Cannot debit ${format(amount, Unit.Gwei)} from ${this.account.accountName}, ` +
        `proposed balance of ${format(newBalance, Unit.Gwei)} exceeds maximum of ${format(maximum, Unit.Gwei)}`)
    }

    this.master._log.trace(`Debited ${format(amount, Unit.Gwei)} from ${this.account.accountName}, new balance is ${format(newBalance, Unit.Gwei)}`)
    this.account.balance = newBalance
  }

  private subBalance (amount: BigNumber) {
    if (amount.isZero()) return

    const minimum = this.master._balance.minimum
    const newBalance = this.account.balance.minus(amount)

    if (newBalance.lt(minimum)) {
      throw new Error(`Cannot credit ${format(amount, Unit.Gwei)} to account ${this.account.accountName}, ` +
        `proposed balance of ${format(newBalance, Unit.Gwei)} is below minimum of ${format(minimum, Unit.Gwei)}`)
    }

    this.master._log.trace(`Credited ${format(amount, Unit.Gwei)} to ${this.account.accountName}, new balance is ${format(newBalance, Unit.Gwei)}`)
    this.account.balance = newBalance
  }

  async connect () {
    return this.attemptSettle().catch((err: Error) => {
      this.master._log.trace(`Error queueing an outgoing settlement: ${err.message}`)
    })
  }

  // Inform the peer what address this instance should be paid at
  // & request the Ethereum address the peer wants to be paid at
  // If we already know the peer's address, just return
  private async fetchEthereumAddress (): Promise<void> {
    if (typeof this.account.ethereumAddress === 'string') return
    try {
      const response = await this.sendMessage({
        type: TYPE_MESSAGE,
        requestId: await requestId(),
        data: {
          protocolData: [{
            protocolName: 'info',
            contentType: MIME_APPLICATION_JSON,
            data: Buffer.from(JSON.stringify({
              ethereumAddress: this.master._ethereumAddress
            }))
          }]
        }
      })

      const info = response.protocolData.find((p: BtpSubProtocol) => p.protocolName === 'info')

      if (info) {
        this.linkEthereumAddress(info)
      } else {
        this.master._log.trace(`Failed to link Ethereum address: BTP response did not include any 'info' subprotocol data`)
      }
    } catch (err) {
      this.master._log.trace(`Failed to exchange Ethereum addresses: ${err.message}`)
    }
  }

  private linkEthereumAddress (info: BtpSubProtocol): void {
    try {
      const { ethereumAddress } = JSON.parse(info.data.toString())

      if (typeof ethereumAddress !== 'string') {
        return this.master._log.trace(`Failed to link Ethereum address: invalid response, no address provided`)
      }

      if (!Web3.utils.isAddress(ethereumAddress)) {
        return this.master._log.trace(`Failed to link Ethereum address: ${ethereumAddress} is not a valid address`)
      }

      const currentAddress = this.account.ethereumAddress
      if (currentAddress) {
        // Don't log if it's the same address that's already linked...we don't care
        if (currentAddress.toLowerCase() === ethereumAddress.toLowerCase()) return

        return this.master._log.trace(`Cannot link Ethereum address ${ethereumAddress} to ${this.account.accountName}: ` +
          `${currentAddress} is already linked for the lifetime of the account`)
      }

      this.account.ethereumAddress = ethereumAddress
      this.master._log.trace(`Successfully linked Ethereum address ${ethereumAddress} to ${this.account.accountName}`)
    } catch (err) {
      this.master._log.trace(`Failed to link Ethereum address: ${err.message}`)
    }
  }

  /**
   * How settlement works:
   * - Determine the maximum amount to settle, or settlement "budget", and immediately add it to the balance
   * - Each settlement operation will spend down from this amount, subtracting sent claims and fees
   * - `sendClaim` and `fundOutgoingChannel` take the settlement budget, and return the amount leftover
   *    - e.g. if we couldn't open a channel because the fee > amountToSettle, it will return the original amount
   *    - e.g. if it sent a claim for the entire amountToSettle, it will return 0 because there's
   *      nothing leftover
   * - This is really cool, because the amount to settle can "flow" from one settlement method to another,
   *   as each of them spend down from it!
   * - The catch: before updating the settlement budget, the methods should guard against it going below 0,
   *   or they should just return the original budget
   * - After all settlement operations, we refund the amount leftover (e.g. not spent) to the balance
   * - Keeping the settlement methods "pure" with respect to the balance of the account greatly
   *   simplifies the balance logic (but does require committing the balance first, then refunding)
   */
  async attemptSettle (): Promise<void> {
    return this.queue.add(async () => {
      // By default, the settleThreshold is -Infinity, so it will never settle (receive-only mode)
      const shouldSettle = this.master._balance.settleThreshold.gt(this.account.balance)
        && this.account.payoutAmount.gt(0)

      if (!shouldSettle) {
        return
      }

      // Determine the amount to settle for
      const settlementBudget = BigNumber.min(
        this.master._balance.settleTo.minus(this.account.balance),
        // If we're not prefunding, the amount should be limited by the total packets we've fulfilled
        // If we're prefunding, the payoutAmount is infinity, so it doesn't affect the amount to settle
        this.account.payoutAmount
      )

      // This should never error, since settleTo < maximum
      this.addBalance(settlementBudget)
      this.account.payoutAmount = this.account.payoutAmount.minus(settlementBudget)

      // Convert gwei -> wei
      const settlementBudgetWei = convert(settlementBudget, Unit.Gwei, Unit.Wei).dp(0, BigNumber.ROUND_FLOOR)

      const budget = format(settlementBudgetWei, Unit.Wei)
      const account = this.account.accountName
      this.master._log.info(`Settlement triggered with ${account} for maximum of ${budget}`)

      // If the the entire budget is spent, skip the subsequent settlement function
      const checkBudget = (f: (budget: BigNumber) => Promise<BigNumber>) =>
        (budget: BigNumber) =>
          budget.lte(0) ? budget : f(budget)

      const settle = (budget: BigNumber) =>
        // 1) Try to send a claim: spend the channel down entirely before funding it
        this.sendClaim(budget)
        // 2) Open or deposit to a channel if it's necessary to send anything leftover
        .then(checkBudget(leftover => this.fundOutgoingChannel(leftover)))
        // 3) Try to send a claim again since we may have more funds in the channel
        .then(checkBudget(leftover => this.sendClaim(leftover)))
        // Guard against the amount leftover (to be refunded!) going above the initial budget
        .then(leftover => BigNumber.min(leftover, budget))
        // If there's an error, assume the entire amount was spent
        .catch((err: Error) => {
          this.master._log.error(`Error during outgoing settlement: ${err.message}`)
          return new BigNumber(0)
        })

      // Perform the actual settlement
      const amountLeftoverWei = await settle(settlementBudgetWei)
      const amountSettledWei = settlementBudgetWei.minus(amountLeftoverWei)

      // Logging helpers
      const spent = format(amountSettledWei, Unit.Wei)
      const leftover = format(amountLeftoverWei, Unit.Wei)

      const spentPartialBudget = amountLeftoverWei.gt(0)
      if (spentPartialBudget) {
        this.master._log.trace(`Settlement with ${account} complete: spent ${spent} settling, refunding ${leftover}`)
      }

      const spentWholeBudget = amountLeftoverWei.isZero()
      if (spentWholeBudget) {
        this.master._log.trace(`Settlement with ${account} complete: spent entire budget of ${spent}`)
      }

      const spentTooMuch = amountLeftoverWei.lt(0)
      if (spentTooMuch) {
        this.master._log.error(`Critical settlement error: spent ${spent}, above budget of ${budget} with ${account}`)
      }

      // Convert wei -> gwei
      const amountLeftover = convert(amountLeftoverWei, Unit.Wei, Unit.Gwei).dp(0, BigNumber.ROUND_FLOOR)

      this.subBalance(amountLeftover)
      this.account.payoutAmount = this.account.payoutAmount.plus(amountLeftover)
    }, {
      priority: TaskPriority.Outgoing
    })
  }

  private async fundOutgoingChannel (settlementBudget: BigNumber): Promise<BigNumber> {
    try {
      const channel = typeof this.account.outgoingChannelId !== 'string'
        ? this.account.outgoingChannelId
        : await this.updateChannelCache(this.account.outgoingChannelId)

      const requiresNewChannel = !channel

      const requiresDeposit = channel
        // Channel must be open and not settling to deposit
        && !isSettling(channel)
        // Amount to settle must be greater than amount in channel
        && (() => {
          const outgoingClaimValue = this.account.bestOutgoingClaim ? this.account.bestOutgoingClaim.value : 0
          const remainingInChannel = channel.value.minus(outgoingClaimValue)
          return settlementBudget.gt(remainingInChannel)
        })()

      // Note: channel value should be based on the settle amount, but doesn't affect the settle amount!
      // Only on-chain tx fees and outgoing payment channel claims should impact the settle amount
      const value = BigNumber.max(settlementBudget, this.master._outgoingChannelAmount)

      if (requiresNewChannel) {
        await this.fetchEthereumAddress()
        if (!this.account.ethereumAddress) {
          this.master._log.trace(`Failed to open channel: no Ethereum address is linked to account ${this.account.accountName}`)
          return settlementBudget
        }

        const channelId = await generateChannelId()
        const txObj = this.master._contract!.methods.open(
          channelId,
          this.account.ethereumAddress,
          this.master._outgoingSettlementPeriod.toString()
        )
        const tx = await generateTx({
          web3: this.master._web3,
          from: this.master._ethereumAddress,
          txObj, value
        })

        const txFee = new BigNumber(tx.gasPrice).times(tx.gas)
        if (txFee.gt(settlementBudget)) {
          this.master._log.trace(`Insufficient funds to open a new channel: fee of ${format(txFee, Unit.Wei)} ` +
            `is greater than maximum amount to settle of ${format(settlementBudget, Unit.Wei)}`)
          // Return original amount before deducting tx fee, since transaction will never be sent
          return settlementBudget
        }
        settlementBudget = settlementBudget.minus(txFee)

        this.master._log.trace(`Opening channel for ${format(value, Unit.Wei)} and fee of ${format(txFee, Unit.Wei)} with ${this.account.accountName}`)
        const emitter = this.master._web3.eth.sendTransaction(tx) as unknown as EventEmitter2

        await new Promise(resolve => {
          emitter.on('confirmation', (confNumber: number, receipt: TransactionReceipt) => {
            if (!receipt.status) {
              this.master._log.error(`Failed to open channel: on-chain transaction reverted by the EVM`)
              resolve()
            } else if (confNumber >= 1) {
              this.master._log.info(`Successfully opened new channel ${channelId} for ${format(value, Unit.Wei)} `
                + `and linked to account ${this.account.accountName}`)
              this.account.outgoingChannelId = channelId
              resolve()
            }
          })

          emitter.on('error', (err: Error) => {
            // For safety, if the tx is reverted, wasn't mined, or less gas was used, DO NOT credit the client's account
            this.master._log.error(`Failed to open channel: ${err.message}`)
            resolve()
          })
        })

        emitter.removeAllListeners()

        // Wait 2 seconds for block to propagate
        await new Promise(resolve => setTimeout(resolve, 2000))
      } else if (requiresDeposit) {
        const channelId = this.account.outgoingChannelId!
        const txObj = this.master._contract!.methods.deposit(channelId)
        const tx = await generateTx({
          web3: this.master._web3,
          from: channel!.sender,
          txObj, value
        })

        const txFee = new BigNumber(tx.gasPrice).times(tx.gas)
        if (txFee.gt(settlementBudget)) {
          this.master._log.trace(`Insufficient funds to deposit to channel: fee of ${format(txFee, Unit.Wei)} ` +
          `is greater than maximum amount to settle of ${format(settlementBudget, Unit.Wei)}`)
          // Return original amount before deducting tx fee, since transaction will never be sent
          return settlementBudget
        }
        settlementBudget = settlementBudget.minus(txFee)

        this.master._log.trace(`Depositing ${format(txFee, Unit.Wei)} to channel for fee of ${format(txFee, Unit.Wei)} with account ${this.account.accountName}`)
        const emitter = this.master._web3.eth.sendTransaction(tx) as unknown as EventEmitter2

        await new Promise(resolve => {
          emitter.on('confirmation', (confNumber: number, receipt: TransactionReceipt) => {
            if (!receipt.status) {
              this.master._log.error(`Failed to deposit to channel: on-chain transaction reverted by the EVM`)
              resolve()
            } else if (confNumber >= 1) {
              this.master._log.info(`Successfully deposited ${format(value, Unit.Wei)} to channel ${channelId} for account ${this.account.accountName}`)
              resolve()
            }
          })

          emitter.on('error', (err: Error) => {
            // For safety, if the tx is reverted, wasn't mined, or less gas was used, DO NOT credit the client's account
            this.master._log.error(`Failed to open channel: ${err.message}`)
            resolve()
          })
        })

        emitter.removeAllListeners()

        // Wait 2 seconds for block to propagate
        await new Promise(resolve => setTimeout(resolve, 2000))
      } else {
        this.master._log.trace(`No on-chain funding transaction required to settle ${format(settlementBudget, Unit.Wei)} with account ${this.account.accountName}`)
      }
    } catch (err) {
      this.master._log.error(`Failed to fund outgoing channel to ${this.account.accountName}: ${err.message}`)
    } finally {
      return settlementBudget
    }
  }

  private async sendClaim (settlementBudget: BigNumber): Promise<BigNumber> {
    try {
      if (!this.account.outgoingChannelId) {
        this.master._log.trace(`Cannot send claim to ${this.account.accountName}: no channel is linked`)
        return settlementBudget
      }

      // If the channel doesn't exist, try fetching state from network
      const channelId = this.account.outgoingChannelId
      const channel = this.channelCache[channelId]
        || await this.updateChannelCache(channelId)
      if (!channel) {
        this.master._log.trace(`Cannot send claim to ${this.account.accountName}: linked channel doesn't exist or is settled`)
        return settlementBudget
      }

      // Even if the channel is settling, continue to send claims: assuming this plugin is not malicious,
      // sending a better claim is good, because it may incentivize the receiver to claim the channel

      // Greatest claim value/total amount we've sent the receiver
      const spent = new BigNumber(this.account.bestOutgoingClaim ? this.account.bestOutgoingClaim.value : 0)
      const remainingInChannel = channel.value.minus(spent)

      // Ensure the claim increment is always > 0
      if (remainingInChannel.lte(0)) {
        this.master._log.trace(`Cannot send claim to ${this.account.accountName}: no remaining funds in outgoing channel`)
        return settlementBudget
      }
      if (settlementBudget.lte(0)) {
        this.master._log.trace(`Cannot send claim to ${this.account.accountName}: no remaining settlement budget`)
        return settlementBudget
      }

      // Ensures that the increment is greater than the previous claim
      // Since budget and remaining in channel must be positive, claim increment should always be positive
      const claimIncrement = BigNumber.min(remainingInChannel, settlementBudget)
      // Total value of new claim: value of old best claim + increment of new claim
      const value = spent.plus(claimIncrement)

      const contractAddress = this.master._network!.unidirectional.address
      const paymentDigest = Web3.utils.soliditySha3(contractAddress, channelId, value.toString())
      const paymentDigestBuffer = Buffer.from(Web3.utils.hexToBytes(paymentDigest))
      const ethPaymentDigest = Buffer.concat([
        Buffer.from(SIGN_PREFIX), paymentDigestBuffer
      ])
      const signature = ethSign(this.master._privateKey, keccak256(ethPaymentDigest))
      const claim = {
        channelId,
        signature,
        value: new BigNumber(value).toString()
      }

      this.master._log.trace(`Sending claim for total of ${format(value, Unit.Wei)}, ` +
        `incremented by ${format(claimIncrement, Unit.Wei)}, to ${this.account.accountName}`)
      this.account.bestOutgoingClaim = claim

      // Since claimIncrement <= settlementBudget, new budget should always be >= 0
      settlementBudget = settlementBudget.minus(claimIncrement)

      // Send paychan claim to client, don't await a response
      this.sendMessage({
        type: TYPE_TRANSFER,
        requestId: await requestId(),
        data: {
          amount: convert(value, Unit.Wei, Unit.Gwei).toFixed(0, BigNumber.ROUND_CEIL),
          protocolData: [{
            protocolName: 'machinomy',
            contentType: MIME_APPLICATION_JSON,
            data: Buffer.from(JSON.stringify(claim))
          }]
        }
      }).catch(err =>
        // In any case, this isn't particularly important/actionable
        this.master._log.trace(`Error while sending claim to peer: ${err.message}`)
      )
    } catch (err) {
      this.master._log.error(`Failed to send claim to ${this.account.accountName}: ${err.message}`)
    } finally {
      return settlementBudget
    }
  }

  async handleData (message: BtpPacket): Promise<BtpSubProtocol[]> {
    const info = getSubprotocol(message, 'info')
    const requestClose = getSubprotocol(message, 'requestClose')
    const ilp = getSubprotocol(message, 'ilp')

    // Link the given Ethereum address & inform counterparty what address this wants to be paid at
    if (info) {
      this.linkEthereumAddress(info)

      return [{
        protocolName: 'info',
        contentType: MIME_APPLICATION_JSON,
        data: Buffer.from(JSON.stringify({
          ethereumAddress: this.master._ethereumAddress
        }))
      }]
    }

    // If the peer requests to close a channel, try to close it, if it's profitable
    if (requestClose) {
      this.master._log.info(`Channel close requested for account ${this.account.accountName}`)

      this.claimIfProfitable().catch(err => {
        this.master._log.error(`Error attempting to claim channel: ${err.message}`)
      })

      return [{
        protocolName: 'requestClose',
        contentType: MIME_TEXT_PLAIN_UTF8,
        data: Buffer.alloc(0)
      }]
    }

    // Handle incoming ILP PREPARE packets from peer
    // plugin-btp handles correlating the response packets for the dataHandler
    if (ilp && ilp.data[0] === Type.TYPE_ILP_PREPARE) {
      try {
        const { amount } = deserializeIlpPrepare(ilp.data)
        const amountBN = new BigNumber(amount)

        if (amountBN.gt(this.master._maxPacketAmount)) {
          throw new Errors.AmountTooLargeError('Packet size is too large.', {
            receivedAmount: amount,
            maximumAmount: this.master._maxPacketAmount.toString()
          })
        }

        try {
          this.addBalance(amountBN)
        } catch (err) {
          this.master._log.trace(`Failed to forward PREPARE: ${err.message}`)
          throw new Errors.InsufficientLiquidityError(err.message)
        }

        const response = await this.dataHandler(ilp.data)

        if (response[0] === Type.TYPE_ILP_REJECT) {
          this.subBalance(amountBN)
        } else if (response[0] === Type.TYPE_ILP_FULFILL) {
          this.master._log.trace(`Received FULFILL from data handler in response to forwarded PREPARE`)
        }

        return [{
          protocolName: 'ilp',
          contentType: MIME_APPLICATION_OCTET_STREAM,
          data: response
        }]
      } catch (err) {
        return [{
          protocolName: 'ilp',
          contentType: MIME_APPLICATION_OCTET_STREAM,
          data: errorToReject('', err)
        }]
      }
    }

    return []
  }

  async handleMoney (message: BtpPacket): Promise<BtpSubProtocol[]> {
    return this.queue.add(async () => {
      try {
        const machinomy = getSubprotocol(message, 'machinomy')

        if (machinomy) {
          this.master._log.trace(`Handling Machinomy claim for account ${this.account.accountName}`)

          const claim = JSON.parse(machinomy.data.toString())

          const hasValidSchema = (o: any): o is IClaim =>
            typeof o.value === 'string'
              && typeof o.channelId === 'string'
              && typeof o.signature === 'string'
          if (!hasValidSchema(claim)) {
            throw new Error(`claim schema is malformed`)
          }

          const oldClaim = this.account.bestIncomingClaim
          const wrongChannel = oldClaim
            // New claim is using different channel from the old claim
            && oldClaim.channelId !== claim.channelId
            // Old channel is still open (if it was closed, a new claim is acceptable)
            && (await this.updateChannelCache(oldClaim.channelId))
          if (wrongChannel) {
            throw new Error(`account ${this.account.accountName} must use channel ${oldClaim!.channelId}`)
          }

          let channel: IChannel | undefined = this.channelCache[claim.channelId]
          // Fetch channel state from network if:
          // 1) No claim/channel is linked to the account
          // 2) The channel isn't cached
          // 3) Claim value is greater than cached channel value (e.g. possible on-chain deposit)
          const shouldFetchChannel = !oldClaim || !channel
            || new BigNumber(claim.value).gt(channel.value)
          if (shouldFetchChannel) {
            channel = await this.updateChannelCache(claim.channelId)
          }

          if (!channel) {
            throw new Error(`channel ${claim.channelId} is already closed or doesn't exist`)
          }

          if (new BigNumber(claim.value).lte(0)) {
            throw new Error(`value of claim is 0 or negative`)
          }

          const contractAddress = this.master._network!.unidirectional.address
          const paymentDigest = Web3.utils.soliditySha3(contractAddress, claim.channelId, claim.value)
          const paymentDigestBuffer = Buffer.from(Web3.utils.hexToBytes(paymentDigest))
          const ethPaymentDigest = Buffer.concat([
            Buffer.from(SIGN_PREFIX), paymentDigestBuffer
          ])
          const senderAddress = ethRecover(claim.signature, keccak256(ethPaymentDigest))
          const isValidSignature = senderAddress === channel.sender
          if (!isValidSignature) {
            throw new Error(`signature is invalid, or sender is using contracts on a different network`)
          }

          const oldClaimValue = new BigNumber(oldClaim ? oldClaim.value : 0)
          const newClaimValue = BigNumber.min(channel.value, claim.value)
          let claimIncrement = newClaimValue.minus(oldClaimValue)
          if (claimIncrement.eq(0)) {
            this.master._log.trace(`Disregarding incoming claim: value of ${format(claim.value, Unit.Wei)} is same as previous claim`)
            // Respond to the request normally, not with an error:
            // Peer may have deposited to the channel and think it's confirmed, but we don't see it yet, causing them to send
            // a claim value greater than the amount that's in the channel
            return []
          } else if (claimIncrement.lt(0)) {
            throw new Error(`claim value of ${format(claim.value, Unit.Wei)} is less than previous claim for ${format(oldClaimValue, Unit.Wei)}`)
          }

          // If a new channel is being linked to the account, perform additional validation
          const linkNewChannel = !oldClaim || claim.channelId !== oldClaim.channelId
          if (linkNewChannel) {
            // Each channel key is a mapping of channelId -> accountName to ensure no channel can be linked to multiple accounts
            // No race condition: a new linked channel will be cached at the end of this closure
            const channelKey = `${claim.channelId}:incoming-channel`
            await this.master._store.load(channelKey)
            const linkedAccount = this.master._store.get(channelKey)
            const canLinkChannel = !linkedAccount || linkedAccount === this.account.accountName
            if (!canLinkChannel) {
              throw new Error(`channel ${claim.channelId} is already linked to a different account`)
            }

            // Check the channel is to the server's address
            // (only check for new channels, not per claim, in case the server restarts and changes config)
            const amReceiver = channel.receiver.toLowerCase() === this.master._ethereumAddress.toLowerCase()
            if (!amReceiver) {
              throw new Error(`the recipient for incoming channel ${claim.channelId} is not ${this.master._ethereumAddress}`)
            }

            // Confirm the settling period for the channel is above the minimum
            const isAboveMinSettlementPeriod = channel.settlingPeriod.gte(this.master._minIncomingSettlementPeriod)
            if (!isAboveMinSettlementPeriod) {
              throw new Error(`channel ${channel.channelId} has settling period of ${channel.settlingPeriod} blocks,`
                + `below floor of ${this.master._minIncomingSettlementPeriod} blocks`)
            }

            // Deduct the initiation fee (e.g. this could be used to cover the cost of the claim tx to close the channel)
            claimIncrement = claimIncrement.minus(this.master._incomingChannelFee)
            if (claimIncrement.lt(0)) {
              throw new Error(`claim value of ${format(newClaimValue, Unit.Wei)} is insufficient to cover the initiation fee of ` +
                `${format(this.master._incomingChannelFee, Unit.Wei)}`)
            }

            this.master._store.set(channelKey, this.account.accountName)
            this.master._log.trace(`Incoming channel ${claim.channelId} is now linked to account ${this.account.accountName}`)
          }

          this.account.bestIncomingClaim = claim
          this.master._log.info(`Accepted incoming claim from account ${this.account.accountName} for ${format(claimIncrement, Unit.Wei)}`)

          // Start the channel watcher if it wasn't running
          if (!this.watcher) {
            this.watcher = this.startChannelWatcher()
          }

          const amount = convert(claimIncrement, Unit.Wei, Unit.Gwei).dp(0, BigNumber.ROUND_DOWN)
          this.subBalance(amount)

          await this.moneyHandler(amount.toString())
        } else {
          throw new Error(`BTP TRANSFER packet did not include any 'machinomy' subprotocol data`)
        }

        return []
      } catch (err) {
        this.master._log.trace(`Failed to validate claim: ${err.message}`)
        // Don't expose internal errors: this could be problematic if an error wasn't intentionally thrown
        throw new Error('Invalid claim')
      }
    }, {
      priority: TaskPriority.Incoming
    })
  }

  // Handle the response from a forwarded ILP PREPARE
  handlePrepareResponse (preparePacket: {
    type: Type.TYPE_ILP_PREPARE,
    typeString?: 'ilp_prepare',
    data: IlpPrepare
  }, responsePacket: IlpPacket): void {
    const isFulfill = responsePacket.type === Type.TYPE_ILP_FULFILL
    if (isFulfill) {
      this.master._log.trace(`Received a FULFILL in response to the forwarded PREPARE from sendData`)

      // Update balance to reflect that we owe them the amount of the FULFILL
      let amount = new BigNumber(preparePacket.data.amount)
      try {
        this.subBalance(amount)
        this.account.payoutAmount = this.account.payoutAmount.plus(amount)
      } catch (err) {
        // Balance update likely dropped below the minimum, so throw an internal error
        this.master._log.trace(`Failed to fulfill response to PREPARE: ${err.message}`)
        throw new Errors.InternalError(err.message)
      }
    }

    // Attempt to settle on fulfills and* T04s (to resolve stalemates)
    const shouldSettle = isFulfill ||
      (responsePacket.type === Type.TYPE_ILP_REJECT && responsePacket.data.code === 'T04')
    if (shouldSettle) {
      this.attemptSettle().catch((err: Error) => {
        this.master._log.trace(`Error queueing an outgoing settlement: ${err.message}`)
      })
    }
  }

  private startChannelWatcher () {
    const timer: NodeJS.Timeout = setInterval(
      () => this.queue.add(async () => {
        const claim = this.account.bestIncomingClaim
        if (!claim) {
          // No claim is linked: stop the channel watcher
          this.watcher = null
          return clearInterval(timer)
        }

        const channel = await this.updateChannelCache(claim.channelId)
        if (!channel) {
          // Channel is closed: stop the channel watcher
          this.watcher = null
          return clearInterval(timer)
        }

        if (isSettling(channel)) {
          this.claimIfProfitable(true).catch((err: Error) => {
            this.master._log.trace(`Error attempting to claim channel: ${err.message}`)
          })
        }
      }, {
        priority: TaskPriority.ChannelWatcher
      }),
      this.master._channelWatcherInterval.toNumber()
    )

    return timer
  }

  private claimIfProfitable (requireSettling = false): Promise<void> {
    return this.queue.add(async () => {
      const claim = this.account.bestIncomingClaim
      if (!claim) {
        return
      }

      const channel = await this.updateChannelCache(claim.channelId)
      if (!channel) {
        return this.master._log.trace(`Cannot claim channel ${claim.channelId} with ${this.account.accountName}: linked channel doesn't exist or is settled`)
      }

      if (requireSettling && !isSettling(channel)) {
        return this.master._log.trace(`Cannot claim channel ${claim.channelId} with ${this.account.accountName}: channel is not settling`)
      }

      this.master._log.trace(`Attempting to claim channel ${claim.channelId} for ${format(claim.value, Unit.Wei)}`)

      const txObj = this.master._contract!.methods.claim(claim.channelId, claim.value, claim.signature)
      const tx = await generateTx({
        txObj,
        from: channel.receiver,
        web3: this.master._web3
      })

      // Check to verify it's profitable first
      // This fee should already be accounted for in balance as a part of the initiation fee
      const txFee = new BigNumber(tx.gasPrice).times(tx.gas)
      if (txFee.gte(claim.value)) {
        return this.master._log.trace(`Not profitable to claim incoming settling channel ${claim.channelId} with ${this.account.accountName}: ` +
          `fee of ${format(txFee, Unit.Wei)} is greater than value of ${format(claim.value, Unit.Wei)}`)
      }

      const receipt = await this.master._web3.eth.sendTransaction(tx)

      if (!receipt.status) {
        this.master._log.trace(`Failed to claim channel ${claim.channelId}: transaction reverted by EVM`)
      } else {
        this.master._log.trace(`Successfully claimed channel ${claim.channelId} for account ${this.account.accountName}`)
      }
    }, {
      priority: TaskPriority.ClaimTx
    })
  }

  // From mini-accounts: invoked on a websocket close or error event
  // From plugin-btp: invoked *only* when `disconnect` is called on plugin
  async disconnect (): Promise<void> {
    if (this.master._closeOnDisconnect) {
      await Promise.all([
        // Request the peer to claim the outgoing channel
        this.sendMessage({
          requestId: await requestId(),
          type: TYPE_MESSAGE,
          data: {
            protocolData: [{
              protocolName: 'requestClose',
              contentType: MIME_TEXT_PLAIN_UTF8,
              data: Buffer.alloc(0)
            }]
          }
        }).catch(err =>
          this.master._log.trace(`Error while requesting peer to claim channel: ${err.message}`)
        ),
        // Claim the incoming channel
        this.claimIfProfitable()
      ])

      // Only stop the channel watcher if the channels were attempted to be closed
      if (this.watcher) {
        clearInterval(this.watcher)
      }
    }
  }

  unload (): void {
    // Stop the channel watcher
    if (this.watcher) {
      clearInterval(this.watcher)
    }

    // Remove account from store cache
    this.master._store.unload(`${this.account.accountName}:account`)

    // Garbage collect the account at the top-level
    this.master._accounts.delete(this.account.accountName)
  }
}
