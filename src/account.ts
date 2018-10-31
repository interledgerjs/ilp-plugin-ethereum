import Web3 = require('web3')
import { TransactionReceipt } from 'web3/types'
const BtpPacket = require('btp-packet')
import BigNumber from 'bignumber.js'
import { DataHandler, MoneyHandler } from './utils/types'
import { BtpPacket, BtpPacketData, BtpSubProtocol } from 'ilp-plugin-btp'
import * as IlpPacket from 'ilp-packet'
import EthereumPlugin from '.'
import { randomBytes } from 'crypto'
import { promisify } from 'util'
import {
  Claim,
  Channel,
  fetchChannel,
  getNetwork,
  getContract,
  generateChannelId,
  generateTx,
  isSettling
} from './utils/contract'
import Mutex from './utils/queue'

BigNumber.config({ EXPONENTIAL_AT: 1e+9 }) // Almost never use exponential notation

export enum Unit { Eth = 18, Gwei = 9, Wei = 0 }

export const convert = (num: BigNumber.Value, from: Unit, to: Unit): BigNumber =>
  new BigNumber(num).shiftedBy(from - to)

export const format = (num: BigNumber.Value, from: Unit) =>
  convert(num, from, Unit.Eth) + ' eth'

export const getSubprotocol = (message: BtpPacket, name: string) =>
  message.data.protocolData.find((p: BtpSubProtocol) => p.protocolName === name)

export const requestId = async () =>
  (await promisify(randomBytes)(4)).readUInt32BE(0)

export default class EthereumAccount {
  private account: {
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
    bestOutgoingClaim?: Claim
    // Greatest claim/payment from counterparty -> this
    // - Also used for channelId, since a paychan wouldn't be linked without a claim
    bestIncomingClaim?: Claim
  }
  // Expose access to common configuration across accounts
  private master: EthereumPlugin
  // Send the given BTP packet message to this counterparty
  private sendMessage: (message: BtpPacket) => Promise<BtpPacketData>
  // Data handler mapped from plugin
  private dataHandler: DataHandler
  // Money handler mapped from plugin
  private moneyHandler: MoneyHandler
  // Queue to handle all incoming settlements/BTP transfers
  private incomingSettlements = new Mutex()
  // Queue to handle all outgoing settlements
  // If a settlement is occuring, only a single settlement can be queued
  private outgoingSettlements = new Mutex(2)
  // Queue of (at most) a single transaction to claim the incoming channel
  private claimTransaction = new Mutex(1)
  // Timer/interval for channel watcher to claim incoming, settling channels
  private watcher?: NodeJS.Timer

  constructor (opts: {
    accountName: string,
    master: EthereumPlugin,
    // Wrap _call/expose method to send WS messages
    sendMessage: (message: BtpPacket) => Promise<BtpPacketData>,
    dataHandler: DataHandler,
    moneyHandler: MoneyHandler
  }) {
    this.master = opts.master
    this.sendMessage = opts.sendMessage
    this.dataHandler = opts.dataHandler
    this.moneyHandler = opts.moneyHandler

    // No change detection until after `connect` is called
    this.account = {
      accountName: opts.accountName,
      balance: new BigNumber(0),
      payoutAmount: this.master._balance.settleTo.gt(0)
        // If we're prefunding, we don't care about total fulfills
        // Since we take the min of this and the settleTo/settleThreshold delta, this
        // essentially disregards the payout amount
        ? new BigNumber(Infinity)
        // If we're settling up after fulfills, then we do care
        : new BigNumber(0)
    }
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

  private async updateChannel (channelId: string): Promise<Channel | undefined> {
    const channel = await fetchChannel(this.master._web3, channelId)

    if (!channel) {
      this.master._channels.delete(channelId)
    } else {
      this.master._channels.set(channelId, channel)
    }

    return this.master._channels.get(channelId)
  }

  async connect () {
    const accountKey = `${this.account.accountName}:account`
    await this.master._store.loadObject(accountKey)
    const savedAccount: any = this.master._store.getObject(accountKey) || {}

    // Parse balances, since they're non-primitives
    // (otherwise the defaults from the constructor are used)
    if (typeof savedAccount.balance === 'string') {
      savedAccount.balance = new BigNumber(savedAccount.balance)
    }
    if (typeof savedAccount.payoutAmount === 'string') {
      savedAccount.payoutAmount = new BigNumber(savedAccount.payoutAmount)
    }

    this.account = new Proxy({
      ...this.account,
      ...savedAccount
    }, {
      set: (account, key, val) => {
        // Commit the changes to the configured store
        this.master._store.set(accountKey, JSON.stringify({
          ...account,
          [key]: val
        }))

        return Reflect.set(account, key, val)
      }
    })

    // Fetch the state of the incoming channel
    const incomingChannelId = this.account.bestIncomingClaim &&
      this.account.bestIncomingClaim.channelId
    if (incomingChannelId) {
      await this.updateChannel(incomingChannelId)
    }

    // Fetch the state of the outgoing channel
    const outgoingChannelId = this.account.outgoingChannelId
    if (outgoingChannelId) {
      await this.updateChannel(outgoingChannelId)
    }

    this.startChannelWatcher()

    if (this.master._settleOnConnect) {
      return this.outgoingSettlements.runExclusive(() => this.attemptSettle())
    }
  }

  // Inform the peer what address this instance should be paid at
  // & request the Ethereum address the peer wants to be paid at
  // If we already know the peer's address, just return
  private async fetchEthereumAddress (): Promise<void> {
    if (typeof this.account.ethereumAddress === 'string') return
    try {
      const response = await this.sendMessage({
        type: BtpPacket.TYPE_MESSAGE,
        requestId: await requestId(),
        data: {
          protocolData: [{
            protocolName: 'info',
            contentType: BtpPacket.MIME_APPLICATION_JSON,
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
   *    - e.g. if we couldn't open a channel because the fee > amountToSettle, it will error and just
   *      return the original amount
   *    - e.g. if it sent a claim for the entire amountToSettle, it will return 0 because there's
   *      nothing leftover
   * - This is really cool, because the amount to settle can "flow" from one settlement method to another,
   *   as each of them spend down from it!
   * - The catch: before updating the settlement budget, the methods should guard against it going below 0.
   *   Otherwise, they should just return the original budget and reject the promise (spiking out of
   *   any further settlement)
   * - After all settlement operations, we refund the amount leftover (e.g. not spent) to the balance
   * - Keeping the settlement methods "pure" with respect to the balance of the account greatly
   *   simplifies the balance logic (but does require committing the balance first, then refunding)
   */
  async attemptSettle (): Promise<void> {
    let settlementBudget = new BigNumber(0)
    let amountLeftover = new BigNumber(0)

    try {
      // Don't attempt settlement if there's no configured settle threshold ("receive only" mode)
      const settleThreshold = this.master._balance.settleThreshold
      if (!settleThreshold) {
        return this.master._log.trace('Cannot settle: settle threshold must be configured for automated settlement')
      }

      const shouldSettle = settleThreshold.gt(this.account.balance)
      if (!shouldSettle) {
        return this.master._log.trace(`Cannot settle: balance of ${format(this.account.balance, Unit.Gwei)} ` +
          `is not below settle threshold of ${format(settleThreshold, Unit.Gwei)}`)
      }

      settlementBudget = this.master._balance.settleTo.minus(this.account.balance)
      if (settlementBudget.lte(0)) {
        // This *should* never happen, since the master constructor verifies that settleTo >= settleThreshold
        return this.master._log.error(`Critical settlement error: settlement threshold triggered, but settle amount of ` +
          `${format(settlementBudget, Unit.Gwei)} is 0 or negative`)
      }

      // If we're not prefunding, the amount should be limited by the total packets we've fulfilled
      // If we're prefunding, the payoutAmount is infinity, so it doesn't affect the amount to settle
      settlementBudget = BigNumber.min(settlementBudget, this.account.payoutAmount)
      if (settlementBudget.lte(0)) {
        return this.master._log.trace(`Cannot settle: no fulfilled packets have yet to be settled, ` +
          `payout amount is ${format(this.account.payoutAmount, Unit.Gwei)}`)
      }

      // This should never error, since settleTo < maximum
      this.addBalance(settlementBudget)
      this.account.payoutAmount = this.account.payoutAmount.minus(settlementBudget)

      // Convert gwei to wei
      settlementBudget = convert(settlementBudget, Unit.Gwei, Unit.Wei).dp(0, BigNumber.ROUND_FLOOR)
      this.master._log.trace(`Attempting to settle with account ${this.account.accountName} for maximum of ${format(settlementBudget, Unit.Wei)}`)

      type SettleTask = (budget: BigNumber) => Promise<BigNumber>
      const tasks: SettleTask[] = [
        // 1) Try to send a claim: spend the channel down entirely before funding it
        b => this.sendClaim(b),
        // 2) Open or deposit to a channel if it's necessary to send anything leftover
        b => this.fundOutgoingChannel(b),
        // 3) Try to send a claim again since we may have more funds in the channel
        b => this.sendClaim(b)
      ]

      // Run each settle task sequentially, spending down from the budget
      amountLeftover = await tasks.reduce(async (leftover: Promise<BigNumber>, task: SettleTask) => {
        const budget = await leftover
        return budget.lte(0) ? budget : task(budget)
      }, Promise.resolve(settlementBudget))
    } catch (err) {
      this.master._log.error(`Error during settlement: ${err.message}`)
    } finally {
      const amountSettled = settlementBudget.minus(amountLeftover)

      if (amountSettled.gt(0)) {
        this.master._log.trace(`Settle attempt complete: spent total of ${format(amountSettled, Unit.Wei)} settling, ` +
          `refunding ${format(amountLeftover, Unit.Wei)} back to balance with ${this.account.accountName}`)
      } else if (amountSettled.isZero()) {
        this.master._log.trace(`Settle attempt complete: none of budget spent, ` +
          `refunding ${format(amountLeftover, Unit.Wei)} back to balance with ${this.account.accountName}`)
      } else {
        this.master._log.error(`Critical settlement error: spent ${format(amountSettled, Unit.Wei)}, ` +
          `more than budget of ${format(settlementBudget, Unit.Wei)} with ${this.account.accountName}`)
      }

      amountLeftover = convert(amountLeftover, Unit.Wei, Unit.Gwei).dp(0, BigNumber.ROUND_FLOOR)

      this.subBalance(amountLeftover)
      this.account.payoutAmount = this.account.payoutAmount.plus(amountLeftover)
    }
  }

  private async fundOutgoingChannel (settlementBudget: BigNumber): Promise<BigNumber> {
    try {
      // Determine if an on-chain funding transaction needs to occur
      let requiresNewChannel = false
      let requiresDeposit = false
      let channel: Channel | undefined
      if (typeof this.account.outgoingChannelId === 'string') {
        // Update channel details and fetch latest state
        channel = await this.updateChannel(this.account.outgoingChannelId)
        if (!channel) {
          // Channel doesn't exist (or is settled), so attempt to create a new one
          requiresNewChannel = true
        } else {
          // If amount to settle is greater than amount in channel, try to deposit
          const outgoingClaimValue = this.account.bestOutgoingClaim ? this.account.bestOutgoingClaim.value : 0
          const remainingInChannel = channel.value.minus(outgoingClaimValue)
          requiresDeposit = settlementBudget.gt(remainingInChannel)

          if (requiresDeposit && isSettling(channel)) {
            this.master._log.trace(`Cannot deposit to channel: ${channel.channelId} is settling`)
            return settlementBudget
          }
        }
      } else {
        requiresNewChannel = true
      }

      // Note: channel value should be based on the settle amount, but doesn't affect the settle amount!
      // Only on-chain tx fees and outgoing payment channel claims should impact the settle amount
      const value = BigNumber.max(settlementBudget, this.master._outgoingChannelAmount)

      if (requiresNewChannel) {
        await this.fetchEthereumAddress()
        if (!this.account.ethereumAddress) {
          this.master._log.trace(`Failed to open channel: no Ethereum address is linked to account ${this.account.accountName}`)
          return settlementBudget
        }

        const contract = await getContract(this.master._web3)
        const channelId = await generateChannelId()
        const txObj = contract.methods.open(channelId, this.account.ethereumAddress, this.master._outgoingSettlementPeriod.toString())
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
        const emitter = this.master._web3.eth.sendTransaction(tx)

        let confHandler: (confNumber: number, receipt: TransactionReceipt) => void
        let errorHandler: (err: Error) => void

        await new Promise(resolve => {
          confHandler = (confNumber: number, receipt: TransactionReceipt) => {
            if (!receipt.status) {
              this.master._log.error(`Failed to open channel: on-chain transaction reverted by the EVM`)
              resolve()
            } else if (confNumber >= 1) {
              this.master._log.info(`Successfully opened new channel for ${format(value, Unit.Wei)} with account ${this.account.accountName}`)
              this.account.outgoingChannelId = channelId
              this.master._log.trace(`Outgoing channel ${channelId} is now linked to account ${this.account.accountName}`)
              resolve()
            }
          }

          errorHandler = (err: Error) => {
            // For safety, if the tx is reverted, wasn't mined, or less gas was used, DO NOT credit the client's account
            this.master._log.error(`Failed to open channel: ${err.message}`)
            resolve()
          }

          emitter.on('confirmation', confHandler).on('error', errorHandler)
        })

        // @ts-ignore -- DefinitelyTyped is incorrect
        emitter.off('confirmation', confHandler).off('error', errorHandler)

        // Wait 2 seconds for block to propagate
        await new Promise(resolve => setTimeout(resolve, 2000))
      } else if (requiresDeposit) {
        const contract = await getContract(this.master._web3)
        const channelId = this.account.outgoingChannelId!
        const txObj = contract.methods.deposit(channelId)
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
        const emitter = this.master._web3.eth.sendTransaction(tx)

        let confHandler: (confNumber: number, receipt: TransactionReceipt) => void
        let errorHandler: (err: Error) => void

        await new Promise(resolve => {
          confHandler = (confNumber: number, receipt: TransactionReceipt) => {
            if (!receipt.status) {
              this.master._log.error(`Failed to deposit to channel: on-chain transaction reverted by the EVM`)
              resolve()
            } else if (confNumber >= 1) {
              this.master._log.info(`Successfully deposited ${format(value, Unit.Wei)} to channel ${channelId} for account ${this.account.accountName}`)
              resolve()
            }
          }

          errorHandler = (err: Error) => {
            // For safety, if the tx is reverted, wasn't mined, or less gas was used, DO NOT credit the client's account
            this.master._log.error(`Failed to open channel: ${err.message}`)
            resolve()
          }

          emitter.on('confirmation', confHandler).on('error', errorHandler)
        })

        // @ts-ignore -- DefinitelyTyped is incorrect
        emitter.off('confirmation', confHandler).off('error', errorHandler)

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

      let channel = this.master._channels.get(this.account.outgoingChannelId)

      // If the channel doesn't exist, try fetching state from network
      if (!channel) {
        channel = await this.updateChannel(this.account.outgoingChannelId)
      }

      // If the channel still doesn't exist, that's not good
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

      const channelId = channel.channelId
      const contract = await getContract(this.master._web3)
      const digest = await contract.methods.paymentDigest(channelId, value.toString()).call()
      const signature = await this.master._web3.eth.sign(digest, channel.sender)

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
        type: BtpPacket.TYPE_TRANSFER,
        requestId: await requestId(),
        data: {
          amount: convert(value, Unit.Wei, Unit.Gwei).toFixed(0, BigNumber.ROUND_CEIL),
          protocolData: [{
            protocolName: 'machinomy',
            contentType: BtpPacket.MIME_APPLICATION_JSON,
            data: Buffer.from(JSON.stringify(claim))
          }]
        }
      }).catch(err => {
        // In any case, this isn't particularly important/actionable
        this.master._log.trace(`Error while sending claim to peer: ${err.message}`)
      })
    } catch (err) {
      this.master._log.error(`Failed to send claim to ${this.account.accountName}: ${err.message}`)
    } finally {
      return settlementBudget
    }
  }

  async handleData (message: BtpPacket): Promise<BtpSubProtocol[]> {
    const info = getSubprotocol(message, 'info')
    const ilp = getSubprotocol(message, 'ilp')

    // Link the given Ethereum address & inform counterparty what address this wants to be paid at
    if (info) {
      this.linkEthereumAddress(info)

      return [{
        protocolName: 'info',
        contentType: BtpPacket.MIME_APPLICATION_JSON,
        data: Buffer.from(JSON.stringify({
          ethereumAddress: this.master._ethereumAddress
        }))
      }]
    }

    // Handle incoming ILP PREPARE packets from peer
    // plugin-btp handles correlating the response packets for the dataHandler
    if (ilp && ilp.data[0] === IlpPacket.Type.TYPE_ILP_PREPARE) {
      try {
        const { expiresAt, amount } = IlpPacket.deserializeIlpPrepare(ilp.data)
        const amountBN = new BigNumber(amount)

        if (amountBN.gt(this.master._maxPacketAmount)) {
          throw new IlpPacket.Errors.AmountTooLargeError('Packet size is too large.', {
            receivedAmount: amount,
            maximumAmount: this.master._maxPacketAmount.toString()
          })
        }

        try {
          this.addBalance(amountBN)
        } catch (err) {
          this.master._log.trace(`Failed to forward PREPARE: ${err.message}`)
          throw new IlpPacket.Errors.InsufficientLiquidityError(err.message)
        }

        let timer: NodeJS.Timer
        let response: Buffer = await Promise.race([
          // Send reject if PREPARE expires before a response is received
          new Promise<Buffer>(resolve => {
            timer = setTimeout(() => {
              resolve(
                // Opinion: the triggeredBy address isn't useful because upstream connectors can modify
                // it without any way for downstream nodes to know (even if we trust our direct peers)
                IlpPacket.errorToReject('', {
                  ilpErrorCode: 'R00',
                  message: `Expired at ${new Date().toISOString()}`
                })
              )
            }, expiresAt.getTime() - Date.now())
          }),
          // Forward the packet to data handler, wait for response
          this.dataHandler(ilp.data)
        ])
        // tslint:disable-next-line:no-unnecessary-type-assertion
        clearTimeout(timer!)

        if (response[0] === IlpPacket.Type.TYPE_ILP_REJECT) {
          this.subBalance(amountBN)
        } else if (response[0] === IlpPacket.Type.TYPE_ILP_FULFILL) {
          this.master._log.trace(`Received FULFILL from data handler in response to forwarded PREPARE`)
        }

        return [{
          protocolName: 'ilp',
          contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
          data: response
        }]
      } catch (err) {
        return [{
          protocolName: 'ilp',
          contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
          data: IlpPacket.errorToReject('', err)
        }]
      }
    }

    return []
  }

  async handleMoney (message: BtpPacket): Promise<BtpSubProtocol[]> {
    return this.incomingSettlements.runExclusive(async () => {
      try {
        const machinomy = getSubprotocol(message, 'machinomy')

        if (machinomy) {
          this.master._log.trace(`Handling Machinomy claim for account ${this.account.accountName}`)

          const claim = JSON.parse(machinomy.data.toString())

          const hasValidSchema = claim
            && typeof claim.value === 'string'
            && typeof claim.channelId === 'string'
            && typeof claim.signature === 'string'
          if (!hasValidSchema) {
            throw new Error(`claim schema is malformed`)
          }

          const oldClaim = this.account.bestIncomingClaim

          // If the account already has a channel, client must be using that channel
          // Calculating profitability across multiple incoming channels sounds like a receipe for disaster
          if (oldClaim && oldClaim.channelId !== claim.channelId) {
            throw new Error(`account ${this.account.accountName} must use channel ${oldClaim.channelId}`)
          }

          let channel = this.master._channels.get(claim.channelId)
          // Fetch channel state from network if:
          // 1) No claim/channel is linked to the account
          // 2) The channel isn't cached
          // 3) Claim value is greater than cached channel value (e.g. possible on-chain deposit)
          const shouldFetchChannel = !oldClaim || !channel
            || new BigNumber(claim.value).gt(channel.value)
          if (shouldFetchChannel) {
            channel = await this.updateChannel(claim.channelId)
          }

          if (!channel) {
            throw new Error(`channel is already settled or doesn't exist`)
          }

          // Even if the sender started settling, still accept the claim: we don't mind if they send us more money!

          if (new BigNumber(claim.value).lte(0)) {
            throw new Error(`value of claim is 0 or negative`)
          }

          const contractAddress = (await getNetwork(this.master._web3)).unidirectional.address
          // @ts-ignore http://web3js.readthedocs.io/en/1.0/web3-utils.html#soliditysha3
          const paymentDigest = Web3.utils.soliditySha3(contractAddress, claim.channelId, claim.value)
          const senderAddress = this.master._web3.eth.accounts.recover(paymentDigest, claim.signature)
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

          // If no channel is linked to this account, perform additional validation
          if (!oldClaim) {
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

            // TODO web3.js beta 36 event bugs: https://github.com/ethereum/web3.js/issues/1916
            // Subscribe to settling events for the new linked channel
            // const contract = await getContract(this.master._web3)
            // contract.events.DidStartSettling({
            //   filter: {
            //     fromBlock: 'latest',
            //     channelId: claim.channelId
            //   }
            // }).on('data', event => {
            //   // If the settling transaction was mined, attempt to claim
            //   if (event.blockNumber) {
            //     this.claimIfProfitable(true)
            //   }
            // })
          }

          this.account.bestIncomingClaim = claim
          this.master._log.info(`Accepted incoming claim from account ${this.account.accountName} for ${format(claimIncrement, Unit.Wei)}`)

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
    })
  }

  // Handle the response from a forwarded ILP PREPARE
  handlePrepareResponse (preparePacket: IlpPacket.IlpPacket, responsePacket: IlpPacket.IlpPacket): void {
    const isFulfill = responsePacket.type === IlpPacket.Type.TYPE_ILP_FULFILL
    const isReject = responsePacket.type === IlpPacket.Type.TYPE_ILP_REJECT

    // Attempt to settle on fulfills and* T04s (to resolve stalemates)
    const attemptSettle = isFulfill || (isReject && responsePacket.data.code === 'T04')

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
        throw new IlpPacket.Errors.InternalError(err.message)
      }
    }

    if (attemptSettle) {
      this.outgoingSettlements.runExclusive(() => this.attemptSettle())
        .catch(err => {
          this.master._log.trace(`Error queueing an outgoing settlement: ${err.message}`)
        })
    }
  }

  private startChannelWatcher (): void {
    const interval = this.master._channelWatcherInterval.toNumber()
    const timer: NodeJS.Timer = setInterval(async () => {
      try {
        const claim = this.account.bestIncomingClaim
        if (!claim) return

        const channel = await this.updateChannel(claim.channelId)

        if (channel && isSettling(channel)) {
          await this.claimIfProfitable(true)
        }
      } catch (err) {
        this.master._log.trace(`Error while running channel watcher: ${err.message}`)
      }
    }, interval)

    // Check if we're in a Node.js environment
    // tslint:disable-next-line:strict-type-predicates
    if (typeof timer.unref === 'function') {
      // Don't let timer prevent process from exiting
      timer.unref()
    }

    this.watcher = timer
  }

  public claimIfProfitable (requireSettling = false): Promise<void> {
    return this.claimTransaction.runExclusive(async () => {
      try {
        const claim = this.account.bestIncomingClaim
        if (!claim) return

        const channel = await this.updateChannel(claim.channelId)
        if (!channel) {
          return this.master._log.trace(`Cannot claim channel ${claim.channelId} with ${this.account.accountName}: linked channel doesn't exist or is settled`)
        }

        if (requireSettling && !isSettling(channel)) {
          return this.master._log.trace(`Cannot claim channel ${claim.channelId} with ${this.account.accountName}: channel is not settling`)
        }

        this.master._log.trace(`Attempting to claim channel ${claim.channelId} for ${format(claim.value, Unit.Wei)}`)

        const contract = await getContract(this.master._web3)
        const txObj = contract.methods.claim(claim.channelId, claim.value, claim.signature)
        const tx = await generateTx({
          txObj,
          from: channel.receiver,
          web3: this.master._web3
        })

        // Check to verify it's profitable first
        // This fee should already be accounted for in balance as apart of the initiation fee
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
      } catch (err) {
        this.master._log.error(`Failed to claim channel: ${err.message}`)
      }
    })
  }

  async disconnect (): Promise<void> {
    if (this.watcher) {
      clearInterval(this.watcher)
    }

    // Finish processing all incoming settlements before claiming & disconnecting
    await Promise.all([
      this.incomingSettlements.runExclusive(() => Promise.resolve()),
      this.outgoingSettlements.runExclusive(() => Promise.resolve())
    ])

    if (this.master._claimOnDisconnect) {
      await this.claimIfProfitable()
    }

    // Remove account from store cache
    return this.master._store.unload(`${this.account.accountName}:account`)
  }
}
