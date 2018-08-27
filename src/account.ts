import Web3 = require('web3')
const BtpPacket = require('btp-packet')
import BigNumber from 'bignumber.js'
import * as Minomy from 'minomy'
import { DataHandler, MoneyHandler } from './types'
import { BtpPacket, BtpPacketData, BtpSubProtocol } from 'ilp-plugin-btp'
import { ilpAndCustomToProtocolData } from 'ilp-plugin-btp/src/protocol-data-converter'
import * as IlpPacket from 'ilp-packet'
import EthereumPlugin = require('.')
import { randomBytes } from 'crypto'
import { promisify } from 'util'

BigNumber.config({ EXPONENTIAL_AT: 1e+9 }) // Almost never use exponential notation

enum Unit { Eth = 18, Gwei = 9, Wei = 0 }

enum SettleState {
  NotSettling,
  Settling,
  QueuedSettle // Already settling, but there was another attempt to settle simultaneously
}

const convert = (num: BigNumber.Value, from: Unit, to: Unit): BigNumber =>
  new BigNumber(num).shiftedBy(from - to)

const format = (num: BigNumber.Value, from: Unit) =>
  convert(num, from, Unit.Eth) + ' eth'

const getSubprotocol = (message: BtpPacket, name: string) =>
  message.data.protocolData.find((p: BtpSubProtocol) => p.protocolName === name)

export const requestId = async () =>
  (await promisify(randomBytes)(4)).readUInt32BE(0)

// FIXME make this configurable and put into master constructor? idk
export const OUTGOING_CHANNEL_AMOUNT = convert('0.001', Unit.Eth, Unit.Wei)

export default class EthereumAccount {
  private account: {
    // Is this instance in the process of sending a paychan update or completing an on-chain funding transaction?
    settling: SettleState
    // Is this account blocked/closed (unable to send money/access balance)?
    isBlocked: boolean
    // Hash/account identifier in ILP address
    accountName: string
    // Net amount in gwei the counterparty owes the this instance (positive), including secured paychan claims
    balance: BigNumber
    // Ethereum address counterparty should be paid at
    // - Does not pertain to address counterparty sends from
    // - Must be linked for the lifetime of the account
    ethereumAddress?: string
    // ID for paychan from this -> counterparty
    outgoingChannelId?: string
    // Greatest claim/payment from this -> counterparty
    bestOutgoingClaim?: Minomy.Claim
    // Greatest claim/payment from counterparty -> this
    // Used for channelId, since a paychan wouldn't be linked without a claim
    bestIncomingClaim?: Minomy.Claim
  }
  // FIXME explain rationale
  private master: EthereumPlugin
  // Send the given BTP packet message to this counterparty
  private sendMessage: (message: BtpPacket) => Promise<BtpPacketData>

  constructor (opts: {
    accountName: string,
    master: EthereumPlugin,
    // Wrap _call/expose method to send WS messages
    sendMessage: (message: BtpPacket) => Promise<BtpPacketData>
  }) {
    // No change detection after `connect` is called
    this.account = {
      settling: SettleState.NotSettling,
      isBlocked: false,
      accountName: opts.accountName,
      balance: new BigNumber(0)
    }

    this.master = opts.master

    this.sendMessage = opts.sendMessage
  }

  addBalance (amount: BigNumber) {
    const maximum = this.master._balance.maximum
    const newBalance = this.account.balance.plus(amount)

    if (newBalance.gt(maximum)) {
      throw new Error(`Cannot debit ${format(amount, Unit.Gwei)} from account ${this.account.accountName}, ` +
        `proposed balance of ${format(newBalance, Unit.Gwei)} exceeds maximum of ${format(maximum, Unit.Gwei)}`)
    }

    this.master._log.trace(`Debited ${format(amount, Unit.Gwei)} from account ${this.account.accountName}, new balance is ${format(newBalance, Unit.Gwei)}`)
    this.account.balance = newBalance
  }

  subBalance (amount: BigNumber) {
    const minimum = this.master._balance.minimum
    const newBalance = this.account.balance.minus(amount)

    if (newBalance.lt(minimum)) {
      throw new Error(`Cannot credit ${format(amount, Unit.Gwei)} to account ${this.account.accountName}, ` +
        `proposed balance of ${format(newBalance, Unit.Gwei)} is below minimum of ${format(minimum, Unit.Gwei)}`)
    }

    this.master._log.trace(`Credited ${format(amount, Unit.Gwei)} to account ${this.account.accountName}, new balance is ${format(newBalance, Unit.Gwei)}`)
    this.account.balance = newBalance
  }

  async connect () {
    const accountName = this.account.accountName
    const savedAccount = await this.master._store.loadObject(`account:${accountName}`)

    this.account = new Proxy({
      ...this.account,
      ...savedAccount
    }, {
      set: (account, key, val) => {
        // Commit the changes to the configured store
        this.master._store.set(this.account.accountName, JSON.stringify({
          ...account,
          [key]: val
        }))

        return Reflect.set(account, key, val)
      }
    })

    // FIXME server _connect is triggered first!? How?
    if (this.master._role === 'server') {
      return
    }

    // Tell the peer what address this instance should be paid at
    // Also request the Ethereum address the peer wants to be paid at
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

    // FIXME make this validation more robust
    const { ethereumAddress } = JSON.parse(response.protocolData[0].data.toString())

    if (Web3.utils.isAddress(ethereumAddress)) {
      this.account.ethereumAddress = ethereumAddress
    }

    // FIXME Add back channel watcher for individual accounts
  }

  async attemptSettle (): Promise<void> {
    if (this.account.settling !== SettleState.NotSettling) {
      this.account.settling = SettleState.QueuedSettle
      return this.master._log.trace('Cannot settle: another settlement was occuring simultaneously')
    }
    this.account.settling = SettleState.Settling

    let amountLeftover = new BigNumber(0)
    const settleThreshold = this.master._balance.settleThreshold
    try {
      // Don't attempt settlement if there's no configured settle threshold ("receive only" mode)
      if (!settleThreshold) {
        return this.master._log.trace('Cannot settle: settle threshold must be configured for automated settlement')
      }

      const shouldSettle = settleThreshold.gt(this.account.balance)
      if (!shouldSettle) {
        return this.master._log.trace(`Cannot settle: balance of ${format(this.account.balance, Unit.Gwei)} is not below settle threshold of ${format(settleThreshold, Unit.Gwei)}`)
      }

      /**
       * How settlement works:
       * - Determine the maximum amount to settle for, and immediately add it to the balance
       * - Each settlement operation will "spend down" from this amount, subtracting sent claims and fees
       * - `sendClaim` and `fundOutgoingChannel` take the amount to settle, and return the amount leftover
       *    - e.g. if we couldn't open a channel because the fee > amountToSettle, it will error and just
       *      return the original amount
       *    - e.g. if it sent a claim for the entire amountToSettle, it will return 0 because there's
       *      nothing leftover
       * - This is really cool, because the amount to settle can "flow" from one settlement method to another,
       *   as each of them spend down from it!
       * - The catch: before updating the amountToSettle, the methods should always check that it wouldn't
       *   go below 0, otherwise it should reject the promise (spiking out of any futher settlement)
       *   and return the amount leftover before it tried to spend more
       * - After all settlement operations, we refund the amount leftover (e.g. not spent) to the balance
       * - Keeping the settlement methods "pure" with respect to the balance of the account greatly
       *   simplifies the balance logic (but does require committing the balance first, then refunding)
       * - Subtracting from the balance at the end also attempts settlement again, which is good:
       *   if we received money during this settlement, we blocked that settlement operation
       */

      let amountToSettle = this.master._balance.settleTo.minus(this.account.balance)

      // This should never error, since settleTo < maximum
      this.addBalance(amountToSettle)

      amountToSettle = convert(amountToSettle, Unit.Gwei, Unit.Wei).dp(0, BigNumber.ROUND_FLOOR)
      this.master._log.info(`Attempting to settle with account ${this.account.accountName} for maximum of ${format(amountToSettle, Unit.Wei)}`)

      // FIXME: check if amount leftover is 0 before calling the next method
      // 1) Try to send a claim: spend the channel down entirely before funding it
      amountLeftover = await this.sendClaim(amountToSettle)
        // 2) Check if it's necessary to open or deposit to a channel to send the remainder
        .then((leftover: BigNumber) => this.fundOutgoingChannel(leftover))
        // 3) Try to send a claim again, since the channel amount may have been updated
        .then((leftover: BigNumber) => this.sendClaim(leftover))
        // If no money was sent, rejections should return the original amount
        .catch(amount => amount as BigNumber)

      let amountSettled = amountToSettle.minus(amountLeftover)
      if (amountSettled.isPositive()) {
        this.master._log.info(`Spent total of ${format(amountSettled, Unit.Wei)} settling with ${this.account.accountName}`)
      }
    } catch (err) {
      this.master._log.error(`Failed to settle: ${err.message}`)
    } finally {
      this.subBalance(
        convert(amountLeftover, Unit.Wei, Unit.Gwei).dp(0, BigNumber.ROUND_FLOOR)
      )

      if (this.account.settling === SettleState.QueuedSettle as SettleState) {
        this.account.settling = SettleState.NotSettling

        this.attemptSettle()
      } else {
        this.account.settling = SettleState.NotSettling
      }
    }
  }

  // Given an amount to settle/"budget" (wei) to fund a channel, check if opening a new channel
  // or depositing to a channel is necessary, and return the remaining "budget", less transaction fees
  async fundOutgoingChannel (amountToSettle: BigNumber): Promise<BigNumber> {
    let amountLeftover = new BigNumber(amountToSettle)
    try {
      // Determine if an on-chain funding transaction needs to occur
      let requiresNewChannel = false
      let requiresDeposit = false
      if (typeof this.account.outgoingChannelId === 'string') {
        // Update channel details and fetch latest state
        const channel = await Minomy.getChannel(this.master._web3, this.account.outgoingChannelId)
        if (!channel) {
          // Channel doesn't exist (or is settled), so attempt to create a new one
          requiresNewChannel = true
        } else {
          // If amount to settle is greater than amount in channel, try to deposit
          const outgoingClaimValue = this.account.bestOutgoingClaim ? this.account.bestOutgoingClaim.value : 0
          const remainingInChannel = channel.value.minus(outgoingClaimValue)
          requiresDeposit = amountToSettle.gt(remainingInChannel)
        }
      } else {
        requiresNewChannel = true
      }

      // Note: channel value should be based on the settle amount, but doesn't affect the settle amount!
      // Only on-chain tx fees and payment channel claims should impact the settle amount
      const value = BigNumber.max(amountToSettle, OUTGOING_CHANNEL_AMOUNT)

      // FIXME Ethereum address fetching? or only on connect?

      if (requiresNewChannel) {
        const address = this.account.ethereumAddress!
        const { tx, channelId } = await Minomy.openChannel(this.master._web3, { address, value })

        const txFee = new BigNumber(tx.gasPrice).times(tx.gas)
        amountLeftover = amountToSettle.minus(txFee)
        if (amountLeftover.isNegative()) {
          this.master._log.trace(`Insufficient funds to open a new channel: fee of ${format(txFee, Unit.Wei)} ` +
            `is greater than maximum amount to settle of ${format(amountToSettle, Unit.Wei)}`)
          // Return original amount before deducting tx fee, since transaction will never be sent
          return amountToSettle
        }

        // For safety, if the tx is reverted, wasn't mined, or less gas was used, DO NOT credit the client's account
        const receipt = await this.master._web3.eth.sendTransaction(tx)

        if (!receipt.status) {
          this.master._log.error(`Failed to open channel: on-chain transaction reverted by the EVM`)
          return Promise.reject(amountLeftover)
        } else {
          this.master._log.info(`Successfully open new channel for ${format(value, Unit.Wei)} with account ${this.account.accountName}`)
        }

        this.account.outgoingChannelId = channelId
        this.master._log.trace(`Outgoing channel ${channelId} is now linked to account ${this.account.accountName}`)
      } else if (requiresDeposit) {
        const channelId = this.account.outgoingChannelId!
        const tx = await Minomy.depositToChannel(this.master._web3, { channelId, value })

        const txFee = new BigNumber(tx.gasPrice).times(tx.gas)
        amountLeftover = amountToSettle.minus(txFee)
        if (amountLeftover.isNegative()) {
          this.master._log.trace(`Insufficient funds to deposit to channel: fee of ${format(txFee, Unit.Wei)} ` +
            `is greater than maximum amount to settle of ${format(amountToSettle, Unit.Wei)}`)
          // Return original amount before deducting tx fee, since transaction will never to sent
          return amountToSettle
        }

        // For safety, if the tx is reverted, wasn't mined, or less gas was used, DO NOT credit the client's account
        const receipt = await this.master._web3.eth.sendTransaction(tx)

        if (!receipt.status) {
          this.master._log.error(`Failed to deposit to channel: on-chain transaction reverted by the EVM`)
          return Promise.reject(amountLeftover)
        } else {
          this.master._log.info(`Successfully deposited ${format(value, Unit.Wei)} to channel ${channelId} for account ${this.account.accountName}`)
        }
      } else {
        this.master._log.trace(`No on-chain funding transaction required to settle ${format(amountToSettle, Unit.Wei)} with account ${this.account.accountName}`)
      }

      return amountLeftover
    } catch (err) {
      this.master._log.error(`Failed to settle with account ${this.account.accountName}: ${err.message}`)
      throw amountLeftover
    }
  }

  // Given an amount to settle/"budget" (wei) to send a claim, check if it's possible,
  // and return the amount leftover from the "budget", less the increment of new claims
  async sendClaim (settlementBudget: BigNumber): Promise<BigNumber> {
    let remainingBudget = new BigNumber(settlementBudget)
    try {
      if (!this.account.outgoingChannelId) {
        this.master._log.trace(`Cannot send claim to account ${this.account.accountName}: no channel is linked`)
        return remainingBudget
      }

      // FIXME Is it possible this will error since the block hasn't propogated yet?

      const channel = await Minomy.getChannel(this.master._web3, this.account.outgoingChannelId)
      if (!channel) {
        this.master._log.trace(`Cannot settle with account ${this.account.accountName}: linked channel doesn't exist or is settled`)
        return remainingBudget
      }

      // Greatest claim value/total amount we've sent the receiver
      const spent = new BigNumber(this.account.bestOutgoingClaim ? this.account.bestOutgoingClaim.value : 0)
      const remainingInChannel = channel.value.minus(spent)

      if (!remainingInChannel.isPositive()) {
        this.master._log.trace(`Cannot settle with account ${this.account.accountName}: no remaining funds in outgoing channel`)
        return remainingBudget
      }

      // Ensures that the increment is greater than the previous claim
      const claimIncrement = BigNumber.min(remainingInChannel, settlementBudget)
      // Total value of new claim: value of old best claim + increment of new claim
      const value = spent.plus(claimIncrement)

      // FIXME should we send claims equal to the last amount as a stop gap if clients get out of sync? (-> balance/settlement infinite loop?)

      if (claimIncrement.gt(settlementBudget)) {
        this.master._log.trace(`Insufficient funds to send claim increment of ${format(claimIncrement, Unit.Wei)}: ` +
          `greater than maximum amount to settle of ${format(settlementBudget, Unit.Wei)}`)
        // Return original amount, since payment will never be sent
        return remainingBudget
      }
      remainingBudget = settlementBudget.minus(claimIncrement)

      // FIXME Should we do this validation inline? I don't actually want to throw an error here! (And an unnecessary channel lookup!)
      // Minomy throws if:
      // - Claim is for 0 or negative amount
      // - Default Web3 account is not the sender for the channel
      // - Channel is not open (e.g. settling)
      // - Total spent from channel exceeds channel value
      const claim = await Minomy.createClaim(this.master._web3, { value, channelId: this.account.outgoingChannelId })

      this.master._log.trace(`Sending claim for ${format(value, Unit.Wei)} to account ${this.account.accountName}`)
      this.account.bestOutgoingClaim = claim

      // Send paychan claim to client, don't await a response
      this.sendMessage({
        type: BtpPacket.TYPE_TRANSFER,
        requestId: await requestId(),
        data: {
          amount: convert(value, Unit.Wei, Unit.Gwei).toFixed(0, BigNumber.ROUND_CEIL),
          protocolData: [{
            protocolName: 'minomy',
            contentType: BtpPacket.MIME_APPLICATION_JSON,
            data: Buffer.from(JSON.stringify(claim))
          }]
        }
      })

      return remainingBudget
    } catch (err) {
      this.master._log.error(`Failed to settle with account ${this.account.accountName}: ${err.message}`)
      throw remainingBudget
    }
  }

  async handleData (message: BtpPacket, dataHandler?: DataHandler): Promise<BtpSubProtocol[]> {
    // FIXME just use ilp to custom? But I don't have access to that... can I import it?
    const info = getSubprotocol(message, 'info')
    const ilp = getSubprotocol(message, 'ilp')

    // Tell client what Ethereum address the server wants to be paid at
    if (info) {
      const { ethereumAddress } = JSON.parse(info.data.toString())

      // Link the provided Ethereum address to the client
      if (Web3.utils.isAddress(ethereumAddress)) {
        this.account.ethereumAddress = ethereumAddress
      }

      return [{
        protocolName: 'info',
        contentType: BtpPacket.MIME_APPLICATION_JSON,
        data: Buffer.from(JSON.stringify({
          ethereumAddress: this.master._ethereumAddress
        }))
      }]
    }

    // Handle ILP PREPARE packets
    // Any response packets (FULFILL or REJECT) should come from data handler response,
    // not wrapped in a BTP message (connector/data handler would throw an error anyways?)
    if (ilp && ilp.data[0] === IlpPacket.Type.TYPE_ILP_PREPARE) {
      try {
        const { expiresAt, amount } = IlpPacket.deserializeIlpPrepare(ilp.data)
        const amountBN = new BigNumber(amount)

        if (this.account.isBlocked) {
          throw new IlpPacket.Errors.UnreachableError('Account has been closed.')
        }

        if (amountBN.gt(this.master._maxPacketAmount)) {
          throw new IlpPacket.Errors.AmountTooLargeError('Packet size is too large.', {
            receivedAmount: amount,
            maximumAmount: this.master._maxPacketAmount.toString()
          })
        }

        if (typeof dataHandler !== 'function') {
          throw new Error('no request handler registered')
        }

        try {
          this.addBalance(amountBN)
        } catch (err) {
          throw new IlpPacket.Errors.InsufficientLiquidityError(err.message)
        }

        let timer: NodeJS.Timer
        let response: Buffer = await Promise.race([
          // Send reject if PREPARE expires before a response is received
          new Promise<Buffer>(resolve => {
            timer = setTimeout(() => {
              resolve(
                // FIXME no access to _prefix right now -- but would that leak info anyways? do you want that? idk
                IlpPacket.errorToReject('', {
                  ilpErrorCode: 'R00',
                  message: `Expired at ${new Date().toISOString()}`
                })
              )
            }, expiresAt.getTime() - Date.now())
          }),
          // Forward the packet to data handler, wait for response
          dataHandler(ilp.data)
        ])
        // FIXME
        // @ts-ignore
        clearTimeout(timer)

        if (response[0] === IlpPacket.Type.TYPE_ILP_REJECT) {
          this.subBalance(amountBN)
        } else if (response[0] === IlpPacket.Type.TYPE_ILP_FULFILL) {
          this.master._log.trace(`Received FULFILL in response to forwarded PREPARE`)
        }

        return ilpAndCustomToProtocolData({ ilp: response })
      } catch (err) {
        // FIXME no access to _prefix -- should the ILP address be passed in? errorToReject(this._prefix, ...)
        return ilpAndCustomToProtocolData({ ilp: IlpPacket.errorToReject('', err) })
      }
    } else {
      return []
    }
  }

  async handleMoney (message: BtpPacket, moneyHandler?: MoneyHandler): Promise<BtpSubProtocol[]> {
    try {
      // FIXME can I use the ilpAndCustomToProtocolData instead?
      const minomy = getSubprotocol(message, 'minomy')

      if (minomy) {
        this.master._log.trace(`Handling Minomy claim for account ${this.account.accountName}`)

        const claim: {
          signature: string
          channelId: string
          value: string
        } = JSON.parse(minomy.data.toString())

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

        // Always fetch updated channel state from network
        const channel = await Minomy.getChannel(this.master._web3, claim.channelId)

        // FIXME this depends on the whether getChannel returns null or not -- decide on that
        if (!channel) {
          throw new Error(`channel is already settled or doesn't exist`)
        }

        // Even if the channel, is settling, still accept the claim: we don't mind if they send us more money!

        // FIXME this could be dangerous if web3 solidity sha3 is implemented even slightly differently from EVM

        const contractAddress = await Minomy.getContractAddress(this.master._web3)
        // @ts-ignore http://web3js.readthedocs.io/en/1.0/web3-utils.html#soliditysha3
        const paymentDigest = Web3.utils.soliditySha3(contractAddress, claim.channelId, claim.value)
        const senderAddress = this.master._web3.eth.accounts.recover(paymentDigest, claim.signature)
        const isValidSignature = senderAddress === channel.sender
        if (!isValidSignature) {
          throw new Error(`signature is invalid, or sender is using contracts on a different network`)
        }

        if (!new BigNumber(claim.value).isPositive()) {
          throw new Error(`claim is zero or negative`)
        }

        const oldClaimValue = oldClaim ? oldClaim.value : 0
        const claimIncrement = new BigNumber(claim.value).minus(oldClaimValue)
        const isBestClaim = claimIncrement.isPositive()
        if (!isBestClaim) {
          throw new Error(`claim value of ${format(claim.value, Unit.Wei)} is less than a previous claim for ${format(oldClaimValue, Unit.Wei)}`)
        }

        const isValidValue = new BigNumber(claim.value).lte(channel.value)
        if (!isValidValue) {
          /* FIXME still log the claim in db, just in case, just don't credit it? credit partial value? or reject outright?
          this is kinda like throwing away money, and the client may think they paid us
          I suppose it's possible an on-chain deposit hasn't gone through yet? */
          // FIXME maybe the solution is the ability to send a claim for an equal value again to prevent potential deadlocks?
          throw new Error(`claim value is greater than amount in channel`)
        }

        // If no channel is linked to this account, perform additional validation
        if (!oldClaim) {
          const isLinked = this.master._channels.has(claim.channelId)
          if (isLinked) {
            throw new Error(`channel ${claim.channelId} is already linked to a different account`)
          }

          // Check the channel is to the server's address
          // (only check for new channels, not per claim, in case the server restarts and changes config)
          const amReceiver = channel.receiver.toLowerCase() === this.master._ethereumAddress.toLowerCase()
          if (!amReceiver) {
            throw new Error(`channel ${claim.channelId} is not to the server address ${this.master._ethereumAddress}`)
          }

          // Confirm the settling period for the channel is above the minimum
          const isAboveMinSettlementPeriod = channel.settlingPeriod.gte(this.master._minIncomingSettlementPeriod)
          if (!isAboveMinSettlementPeriod) {
            throw new Error(`channel ${channel.channelId} has settling period of ${channel.settlingPeriod} blocks,`
              + `below floor of ${this.master._minIncomingSettlementPeriod} blocks`)
          }

          this.master._channels.set(claim.channelId, this.account.accountName)
          this.master._log.trace(`Incoming channel ${claim.channelId} is now linked to account ${this.account.accountName}`)
        }

        this.account.bestIncomingClaim = claim
        this.master._log.info(`Accepted incoming claim from account ${this.account.accountName} for ${format(claimIncrement, Unit.Wei)}`)

        const amount = convert(claimIncrement, Unit.Wei, Unit.Gwei).dp(0, BigNumber.ROUND_CEIL)

        this.subBalance(amount)

        if (typeof moneyHandler !== 'function') {
          throw new Error('no money handler registered')
        }

        await moneyHandler(amount.toString())
      } else {
        throw new Error(`BTP TRANSFER packet did not include any Minomy subprotocol data`)
      }

      return []
    } catch (err) {
      this.master._log.trace(`Invalid claim: ${err.message}`)
      // Don't expose internal errors: this could be problematic if an error wasn't intentionally thrown
      throw new Error('Invalid claim')
    }
  }

  // FIXME need a better name
  // FIXME explain why no balance is necessary
  beforeForward (preparePacket: IlpPacket.IlpPacket): void {
    if (this.account.isBlocked) {
      throw new IlpPacket.Errors.UnreachableError('Account has been closed')
    }
  }

  // FIXME think of a better name
  async afterForwardResponse (preparePacket: IlpPacket.IlpPacket, responsePacket: IlpPacket.IlpPacket): Promise<void> {
    if (responsePacket.type !== IlpPacket.Type.TYPE_ILP_FULFILL) {
      return
    }

    this.master._log.trace(`Handling a FULFILL in response to the forwarded PREPARE, attempting settlement`)

    // Update balance to reflect that we owe them the amount of the FULFILL
    // Balance update will attempt settlement
    let amount = new BigNumber(preparePacket.data.amount)
    this.subBalance(amount)

    return this.attemptSettle()
  }

  // FIXME what should happen here?
  async disconnect (): Promise<void> {
    // FIXME add naive claim on disconnect
    const claim = this.account.bestIncomingClaim
    if (claim) {
      const channelId = claim.channelId
      this.master._log.trace(`Attempting to claim channel ${channelId} for ${format(claim.value, Unit.Wei)}`)

      const tx = await Minomy.closeChannel(this.master._web3, { channelId, claim })

      const receipt = await this.master._web3.eth.sendTransaction(tx)

      if (!receipt.status) {
        this.master._log.trace(`Failed to claim channel ${channelId}: transaction reverted by EVM`)
      } else {
        this.master._log.trace(`Successfully claimed channel ${channelId} for account ${this.account.accountName}`)
      }
    }

    // clearInterval(this._watcher)

    // await this._persistChannels()

    // for (const accountName of this._accounts.keys()) {
      // this._store.unload(accountName)
    // }
    // await this._store.close()
  }
}
