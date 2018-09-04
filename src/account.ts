import Web3 = require('web3')
const BtpPacket = require('btp-packet')
import BigNumber from 'bignumber.js'
import { DataHandler, MoneyHandler } from './utils/types'
import { BtpPacket, BtpPacketData, BtpSubProtocol } from 'ilp-plugin-btp'
import { ilpAndCustomToProtocolData } from 'ilp-plugin-btp/src/protocol-data-converter'
import * as IlpPacket from 'ilp-packet'
import EthereumPlugin = require('.')
import { randomBytes } from 'crypto'
import { promisify } from 'util'
import {
  Claim,
  Channel,
  fetchChannel,
  getContract,
  getContractAddress,
  generateChannelId,
  generateTx,
  isSettling
} from './utils/contract'

BigNumber.config({ EXPONENTIAL_AT: 1e+9 }) // Almost never use exponential notation

// Is the plugin presently attempting to settle?
enum SettleState {
  NotSettling,
  Settling,
  QueuedSettle // Already settling, but there was another attempt to settle simultaneously
}

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
    bestOutgoingClaim?: Claim
    // Greatest claim/payment from counterparty -> this
    // Used for channelId, since a paychan wouldn't be linked without a claim
    bestIncomingClaim?: Claim
  }
  // Expose access to common configuration across accounts
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
    if (amount.isZero()) return

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
    if (amount.isZero()) return

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

    // TODO Add back channel watcher -- for individual accounts?
  }

  // Inform the peer what address this instance should be paid at
  // & request the Ethereum address the peer wants to be paid at
  async shareEthereumAddress (): Promise<void> {
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
      this.master._log.trace(`Failed to link Ethereum address: BTP packet did not include any 'info' subprotocol data`)
    }
  }

  linkEthereumAddress (info: BtpSubProtocol): void {
    // FIXME Catch error if this is invalid JSON
    // FIXME also validate that ethereumAddress is a string
    const { ethereumAddress } = JSON.parse(info.data.toString())

    if (this.account.ethereumAddress) {
      if (this.account.ethereumAddress.toLowerCase() === ethereumAddress.toLowerCase()) {
        return
      }

      return this.master._log.trace(`Cannot link Ethereum address ${ethereumAddress} to account ${this.account.accountName}: ` +
        `${this.account.ethereumAddress} is already linked for the lifetime of the account`)
    }

    if (Web3.utils.isAddress(ethereumAddress)) {
      this.account.ethereumAddress = ethereumAddress
      this.master._log.trace(`Successfully linked Ethereum address ${ethereumAddress} to account ${this.account.accountName}`)
    } else {
      this.master._log.trace(`Failed to link Ethereum address: ${ethereumAddress} is not a valid address`)
    }
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

      // This should never error, since settleTo < maximum
      let settlementBudget = this.master._balance.settleTo.minus(this.account.balance)
      this.addBalance(settlementBudget)

      // Convert gwei to wei
      settlementBudget = convert(settlementBudget, Unit.Gwei, Unit.Wei).dp(0, BigNumber.ROUND_FLOOR)
      this.master._log.trace(`Attempting to settle with account ${this.account.accountName} for maximum of ${format(settlementBudget, Unit.Wei)}`)

      try {
        // 1) Try to send a claim: spend the channel down entirely before funding it
        if (settlementBudget.lte(0)) throw settlementBudget
        amountLeftover = await this.sendClaim(settlementBudget)
        // 2) Open or deposit to a channel if it's necessary to send anything leftover
        if (amountLeftover.lte(0)) throw amountLeftover
        amountLeftover = await this.fundOutgoingChannel(amountLeftover)
        // 3) Try to send a claim again since we may have more funds in the channel
        if (amountLeftover.lte(0)) throw amountLeftover
        amountLeftover = await this.sendClaim(amountLeftover)
      } catch (leftover) {
        // If no money was sent, rejections should return the original amount
        if (BigNumber.isBigNumber(leftover)) {
          amountLeftover = leftover
        }
      }

      let amountSettled = settlementBudget.minus(amountLeftover)
      if (amountSettled.gt(0)) {
        this.master._log.trace(`Settle attempt complete: spent total of ${format(amountSettled, Unit.Wei)} settling, ` +
          `refunding ${format(amountLeftover, Unit.Wei)} back to balance for account ${this.account.accountName}`)
      } else if (amountSettled.isZero()) {
        this.master._log.trace(`Settle attempt complete: none of budget spent, ` +
          `refunding ${format(amountLeftover, Unit.Wei)} back to balance for account ${this.account.accountName}`)
      } else {
        this.master._log.error(`Critical settlement error: spent ${format(amountSettled, Unit.Wei)}, `
          + `more than budget of ${format(settlementBudget, Unit.Wei)} for account ${this.account.accountName}`)
      }
    } catch (err) {
      this.master._log.error(`Failed to settle: ${err.message}`)
    } finally {
      amountLeftover = convert(amountLeftover, Unit.Wei, Unit.Gwei).dp(0, BigNumber.ROUND_FLOOR)
      this.subBalance(amountLeftover)

      if (this.account.settling === SettleState.QueuedSettle as SettleState) {
        this.account.settling = SettleState.NotSettling

        return this.attemptSettle()
      } else {
        this.account.settling = SettleState.NotSettling
      }
    }
  }

  async fundOutgoingChannel (settlementBudget: BigNumber): Promise<BigNumber> {
    try {
      // Determine if an on-chain funding transaction needs to occur
      let requiresNewChannel = false
      let requiresDeposit = false
      let channel: Channel | null
      if (typeof this.account.outgoingChannelId === 'string') {
        // Update channel details and fetch latest state
        channel = await fetchChannel(this.master._web3, this.account.outgoingChannelId)
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
      // Only on-chain tx fees and payment channel claims should impact the settle amount
      const value = BigNumber.max(settlementBudget, this.master._outgoingChannelAmount)

      if (requiresNewChannel) {
        if (!this.account.ethereumAddress) {
          this.master._log.trace(`Failed to open channel: no Ethereum address is linked to account ${this.account.accountName}`)
          return Promise.reject(settlementBudget)
        }

        const contract = await getContract(this.master._web3)
        const channelId = await generateChannelId()
        const txObj = contract.methods.open(channelId, this.account.ethereumAddress, this.master._outgoingSettlementPeriod)
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
          // Reject the promise, since we shouldn't try to send a claim after this
          return Promise.reject(settlementBudget)
        }
        settlementBudget = settlementBudget.minus(txFee)

        this.master._log.trace(`Opening channel for ${format(value, Unit.Wei)} and fee of ${format(txFee, Unit.Wei)} with ${this.account.accountName}`)

        // For safety, if the tx is reverted, wasn't mined, or less gas was used, DO NOT credit the client's account
        const receipt = await this.master._web3.eth.sendTransaction(tx)

        if (!receipt.status) {
          this.master._log.error(`Failed to open channel: on-chain transaction reverted by the EVM`)
          throw settlementBudget
        } else {
          this.master._log.info(`Successfully opened new channel for ${format(value, Unit.Wei)} with account ${this.account.accountName}`)
        }

        this.account.outgoingChannelId = channelId
        this.master._log.trace(`Outgoing channel ${channelId} is now linked to account ${this.account.accountName}`)
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
          // Reject the promise, since we shouldn't try to send a claim after this
          return Promise.reject(settlementBudget)
        }
        settlementBudget = settlementBudget.minus(txFee)

        this.master._log.trace(`Depositing ${format(txFee, Unit.Wei)} to channel for fee of ${format(txFee, Unit.Wei)} with account ${this.account.accountName}`)

        // For safety, if the tx is reverted, wasn't mined, or less gas was used, DO NOT credit the client's account
        const receipt = await this.master._web3.eth.sendTransaction(tx)

        if (!receipt.status) {
          this.master._log.error(`Failed to deposit to channel: on-chain transaction reverted by the EVM`)
          throw settlementBudget
        } else {
          this.master._log.info(`Successfully deposited ${format(value, Unit.Wei)} to channel ${channelId} for account ${this.account.accountName}`)
        }
      } else {
        this.master._log.trace(`No on-chain funding transaction required to settle ${format(settlementBudget, Unit.Wei)} with account ${this.account.accountName}`)
      }

      return settlementBudget
    } catch (err) {
      this.master._log.error(`Failed to fund outgoing channel to ${this.account.accountName}: ${err.message}`)
      throw settlementBudget
    }
  }

  async sendClaim (settlementBudget: BigNumber): Promise<BigNumber> {
    try {
      if (!this.account.outgoingChannelId) {
        this.master._log.trace(`Cannot send claim to ${this.account.accountName}: no channel is linked`)
        return settlementBudget
      }

      // FIXME Is it possible this will error since the block hasn't propogated yet?

      const channel = await fetchChannel(this.master._web3, this.account.outgoingChannelId)
      if (!channel) {
        this.master._log.trace(`Cannot send claim to ${this.account.accountName}: linked channel doesn't exist or is settled`)
        return settlementBudget
      }

      // FIXME Even if we start settling the channel, claims can still be sent through. How should this be handled?

      // Greatest claim value/total amount we've sent the receiver
      const spent = new BigNumber(this.account.bestOutgoingClaim ? this.account.bestOutgoingClaim.value : 0)
      const remainingInChannel = channel.value.minus(spent)

      if (remainingInChannel.lte(0)) {
        this.master._log.trace(`Cannot send claim to ${this.account.accountName}: no remaining funds in outgoing channel`)
        return settlementBudget
      }

      if (settlementBudget.lte(0)) {
        this.master._log.trace(`Cannot send claim to ${this.account.accountName}: no remaining settlement budget`)
        return Promise.reject(settlementBudget)
      }

      // Ensures that the increment is greater than the previous claim
      // Since budget and remaining in channel must be positive, claim increment should always be positive
      const claimIncrement = BigNumber.min(remainingInChannel, settlementBudget)
      // Total value of new claim: value of old best claim + increment of new claim
      const value = spent.plus(claimIncrement)

      const channelId = channel.channelId
      const contract = await getContract(this.master._web3)
      const digest = await contract.methods.paymentDigest(channelId, value).call()
      const signature = await this.master._web3.eth.sign(digest, channel.sender)

      const claim = {
        channelId,
        signature,
        value: new BigNumber(value).toString()
      }

      this.master._log.trace(`Sending claim for total of ${format(value, Unit.Wei)}, incremented by ${format(claimIncrement, Unit.Wei)}, to ${this.account.accountName}`)
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
            protocolName: 'minomy',
            contentType: BtpPacket.MIME_APPLICATION_JSON,
            data: Buffer.from(JSON.stringify(claim))
          }]
        }
      }).catch(err => {
        // In any case, this isn't particularly important/actionable
        this.master._log.trace(`Error while sending claim to peer: ${err.message}`)
      })

      return settlementBudget
    } catch (err) {
      this.master._log.error(`Failed to send claim to ${this.account.accountName}: ${err.message}`)
      throw settlementBudget
    }
  }

  async handleData (message: BtpPacket, dataHandler?: DataHandler): Promise<BtpSubProtocol[]> {
    // FIXME just use ilp to custom? But I don't have access to that... can I import it?
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
    }

    return []
  }

  // FIXME Need a better to handle cases where the claim is invalid rather than throwing errors? What about non-intentional errors?
  async handleMoney (message: BtpPacket, moneyHandler?: MoneyHandler): Promise<BtpSubProtocol[]> {
    try {
      // FIXME can I use the ilpAndCustomToProtocolData instead?
      const minomy = getSubprotocol(message, 'minomy')

      if (minomy) {
        this.master._log.trace(`Handling Minomy claim for account ${this.account.accountName}`)

        const claim = JSON.parse(minomy.data.toString())

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
        const channel = await fetchChannel(this.master._web3, claim.channelId)
        if (!channel) {
          throw new Error(`channel is already settled or doesn't exist`)
        }

        // Even if the channel is settling, still accept the claim: we don't mind if they send us more money!

        // FIXME this could be dangerous if this is implemented even slightly differently from the contract call

        const contractAddress = await getContractAddress(this.master._web3)
        // @ts-ignore http://web3js.readthedocs.io/en/1.0/web3-utils.html#soliditysha3
        const paymentDigest = Web3.utils.soliditySha3(contractAddress, claim.channelId, claim.value)
        const senderAddress = this.master._web3.eth.accounts.recover(paymentDigest, claim.signature)
        const isValidSignature = senderAddress === channel.sender
        if (!isValidSignature) {
          throw new Error(`signature is invalid, or sender is using contracts on a different network`)
        }

        if (new BigNumber(claim.value).lte(0)) {
          throw new Error(`value of claim is 0 or negative`)
        }

        const oldClaimValue = new BigNumber(oldClaim ? oldClaim.value : 0)
        const claimIncrement = BigNumber.min(channel.value, claim.value).minus(oldClaimValue)
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

        const amount = convert(claimIncrement, Unit.Wei, Unit.Gwei).dp(0, BigNumber.ROUND_DOWN)

        this.subBalance(amount)

        if (typeof moneyHandler !== 'function') {
          throw new Error('no money handler registered')
        }

        moneyHandler(amount.toString())
      } else {
        throw new Error(`BTP TRANSFER packet did not include any 'minomy' subprotocol data`)
      }

      return []
    } catch (err) {
      this.master._log.trace(`Failed to validate claim: ${err.message}`)
      // Don't expose internal errors: this could be problematic if an error wasn't intentionally thrown
      // TODO why does this trigger a stack trace?
      throw new Error('Invalid claim')
    }
  }

  // FIXME need a better name -- explain why no balance is necessary
  beforeForward (preparePacket: IlpPacket.IlpPacket): void {
    if (this.account.isBlocked) {
      throw new IlpPacket.Errors.UnreachableError('Account has been closed')
    }

    // FIXME add a log
  }

  // FIXME think of a better name
  async afterForwardResponse (preparePacket: IlpPacket.IlpPacket, responsePacket: IlpPacket.IlpPacket): Promise<void> {
    if (responsePacket.type !== IlpPacket.Type.TYPE_ILP_FULFILL) {
      return
    }

    // FIXME is this text correct?
    this.master._log.trace(`Handling a FULFILL in response to the forwarded PREPARE, attempting settlement`)

    // Update balance to reflect that we owe them the amount of the FULFILL
    // Balance update will attempt settlement
    let amount = new BigNumber(preparePacket.data.amount)
    this.subBalance(amount)

    return this.attemptSettle()
  }

  // FIXME abstract into some kind of "claim if profitable" method? Could be called on client disconnect
  // add othere comments
  // make sure to run this on connect

  // startWatcher () {
  //   const interval = 30 * 60 * 1000 // Every 30 minutes
  //   const timer = setInterval(async () => {
  //     const bestClaim = this.account.bestIncomingClaim
  //     if (!bestClaim) {
  //       return
  //     }

  //     const channel = await Minomy.getChannel(this.master._web3, bestClaim.channelId)

  //     if (channel && Minomy.isSettling(channel)) {
  //       const tx = await Minomy.closeChannel(this.master._web3, bestClaim)

  //       const txFee = new BigNumber(tx.gasPrice).times(tx.gas)
  //       if (new BigNumber(bestClaim.value).gt(txFee)) {
  //         const receipt = await this.master._web3.eth.sendTransaction(tx)

  //         // FIXME subtract the tx fee from they're balance? Or does it already take that into account?

  //         if (!receipt.status) {
  //           this.master._log.error(`FIXME`)
  //         } else {
  //           this.master._log.info(`FIXME`)
  //         }
  //       }
  //     }
  //   }, interval)
  //   timer.unref() // Don't let the timer prevent the process from exiting
  //   this.watcher = timer // FIXME add this
  // }

  // FIXME IMPORTANT -- channel watcher should loop through all linked channels (e.g. in master, not only individual connected accounts!!!)

  // private _startWatcher () {
  //   const interval = 10 * 60 * 1000 // Every 10 minutes

  //   const timer = setInterval(async () => {
  //     // If sender starts settling and we don't claim the channel before the settling period ends,
  //     // all our money goes back to them! (bad)
  //     this._log.trace('Running channel watcher, checking for settling channels')

  //     // Block and claim any accounts that start settling
  //     for (let [channelId, accountName] of this._channels) {
  //       const account = this._accounts.get(accountName)

  //       if (!account) {
  //         this._log.error(`Internal database error: account ${accountName} linked to channel ${channelId} doesn't exist`)
  //         continue
  //       }

  //       await this._maybeClaim(channelId, account)
  //     }

  //     await this._persistChannels()
  //   }, interval)
  //   timer.unref() // Don't let timer prevent process from exiting
  //   this._watcher = timer
  // }

  // // Claim if the given channel <-> account pair is settling (if it's profitable)
  // private async _maybeClaim (channelId: string, account: Account) {
  //   const channel = await Minomy.getChannel(this._web3, channelId)

  //   // If the channel was claimed or settled, remove it from the db
  //   if (!channel) {
  //     this._channels.delete(channelId)
  //   // Check if the channel is settling
  //   } else if (Minomy.isSettling(channel)) {
  //     account.isBlocked = true
  //     this._log.info(`Blocked account ${account.accountName} for attempting to clear funds from channel ${channel.channelId}`)

  //     // Claim the channel, if it's profitable
  //     const claim = account.bestIncomingClaim
  //     if (claim && channel.receiver === this._address) {
  //       const tx = await Minomy.closeChannel(this._web3, { channelId, claim })

  //       const txFee = new BigNumber(tx.gasPrice).times(tx.gas)

  //       const isProfitable = new BigNumber(claim.value).gt(txFee)
  //       if (!isProfitable) {
  //         return this._log.trace(`Not profitable to claim channel ${channel.channelId}; will retry at the next interval`)
  //       }

  //       const receipt = await this._web3.eth.sendTransaction(tx)

  //       if (!receipt.status) {
  //         return this._log.error(`Failed to close settling channel ${channel.channelId}: EVM reverted transaction; will retry at the next interval`)
  //       }

  //       // The channel will be removed from the db at the next watch interval
  //       this._log.info(`Successfully claimed channel ${channel.channelId} to prevent funds reverting to sender`)
  //     }
  //   }
  // }

  // private async _persistChannels () {
  //   await this._store.set('channels', JSON.stringify([...this._channels]))
  // }

  // FIXME what should happen here?
  async disconnect (): Promise<void> {
    // try {
    //   // FIXME add naive claim on disconnect
    //   const claim = this.account.bestIncomingClaim
    //   if (claim) {
    //     const channelId = claim.channelId
    //     this.master._log.trace(`Attempting to claim channel ${channelId} for ${format(claim.value, Unit.Wei)}`)

    //     const tx = await Minomy.closeChannel(this.master._web3, { channelId, claim })

    //     const receipt = await this.master._web3.eth.sendTransaction(tx)

    //     if (!receipt.status) {
    //       this.master._log.trace(`Failed to claim channel ${channelId}: transaction reverted by EVM`)
    //     } else {
    //       this.master._log.trace(`Successfully claimed channel ${channelId} for account ${this.account.accountName}`)
    //     }
    //   }
    // } catch (err) {
    //   this.master._log.error(`Failed to claim channel: ${err.message}`)
    // }

    // clearInterval(this._watcher)

    // await this._persistChannels()

    // for (const accountName of this._accounts.keys()) {
      // this._store.unload(accountName)
    // }
    // await this._store.close()
  }
}
