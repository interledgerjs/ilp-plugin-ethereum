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

// FIXME confirm this actually works
BigNumber.config({ EXPONENTIAL_AT: 1e+9 }) // Almost never use exponential notation

enum Unit { Eth = 18, Gwei = 9, Wei = 0 }

const convert = (num: BigNumber.Value, from: Unit, to: Unit): BigNumber =>
  new BigNumber(num).shiftedBy(from - to)

const format = (num: BigNumber.Value, from: Unit = Unit.Gwei) =>
  convert(num, from, Unit.Eth) + ' eth'

const getSubprotocol = (message: BtpPacket, name: string) =>
  message.data.protocolData.find((p: BtpSubProtocol) => p.protocolName === name)

export const requestId = async () =>
  (await promisify(randomBytes)(4)).readUInt32BE(0)

// TODO make this configurable and put into master constructor? idk
export const OUTGOING_CHANNEL_AMOUNT = convert('0.001', Unit.Eth, Unit.Gwei)

interface EthereumAccountOpts {
  accountName: string,
  master: EthereumPlugin,
  // Expose method to send WS messages (_call is inaccessible/protected)
  sendMessage: (message: BtpPacket) => Promise<BtpPacketData>
}

export default class EthereumAccount {
  private account: {
    // Is the server currently opening a channel/depositing to the client?
    isFunding: boolean
    // Is this account blocked/closed (unable to send money/access balance)?
    isBlocked: boolean
    // Hash/account identifier in ILP address
    accountName: string,
    // Net amount client owes the server, including secured paychan claims from client (wei)
    balance: BigNumber
    // Ethereum address client should be paid at (does not pertain to address client sends from)
    // Must be linked for the lifetime of the account
    ethereumAddress?: string
    // ID for paychan from server -> client
    outgoingChannelId?: string
    // Greatest claim/payment from server -> client
    bestOutgoingClaim?: Minomy.Claim
    // Greatest claim/payment from client -> server
    // Used for channelId, since a paychan wouldn't be linked without a claim
    bestIncomingClaim?: Minomy.Claim
  }
  // FIXME explain
  private master: EthereumPlugin
  // Send the given BTP packet message to this counterparty
  private sendMessage: (message: BtpPacket) => Promise<BtpPacketData>

  constructor (opts: EthereumAccountOpts) {
    // No change detection until connect()
    this.account = {
      isFunding: false,
      isBlocked: false,
      accountName: opts.accountName,
      balance: new BigNumber(0)
    }

    this.sendMessage = opts.sendMessage

    this.master = opts.master
  }

  async connect () {
    const savedAccount = await this.master._store.loadObject(`account:${this.account.accountName}`)

    this.account = new Proxy({
      ...this.account,
      ...savedAccount
    }, {
      set: (account: Account, key, val) => {
        if (key === 'balance') {
          const newBalance = val as BigNumber
          const amount = val.minus(this.account.balance) as BigNumber

          if (newBalance.gt(this.master._balance.maximum)) {
            // Throw error if max balance is exceeded
            throw new Error(`Cannot ${amount.isNegative() ? 'credit' : 'debit'} ${format(amount)} to account ${
              this.account.accountName
            }, proposed balance of ${format(newBalance)} exceeds maximum of ${format(this.master._balance.maximum)}`)
          } else {
            // Log any other balance update
            this.master._log.trace(`${amount.isNegative() ? 'Credited' : 'Debited'} ${format(amount)} to account ${
              this.account.accountName
            }, new balance is ${format(newBalance)}`)
          }
        }

        // Commit the changes to the configured store
        this.master._store.set(this.account.accountName, JSON.stringify({
          ...account,
          [key]: val
        }))

        return Reflect.set(account, key, val)
      }
    })

    // TODO server _connect is triggered first!?
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

    // TODO start watcher for this individual account?
  }

  calculateTxFee (tx: Minomy.Tx): BigNumber {
    return convert(new BigNumber(tx.gasPrice).times(tx.gas), Unit.Wei, Unit.Gwei)
      .decimalPlaces(0, BigNumber.ROUND_CEIL)
  }

  async fundOutgoingChannel () {
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
        const remainingInChannel = channel.value.minus(this.account.bestOutgoingClaim ? this.account.bestOutgoingClaim.value : 0)
        requiresDeposit = this.account.balance.negated().gt(remainingInChannel) // Negative balance => amount we owe the counterparty
      }
    } else {
      requiresNewChannel = true
    }

    const amount = BigNumber.max(this.account.balance.negated(), OUTGOING_CHANNEL_AMOUNT)

    // TODO Add an Ethereum address check to send BTP message?

    if (requiresNewChannel) {
      const { tx, channelId } = await Minomy.openChannel(this.master._web3, {
        address: this.account.ethereumAddress!,
        value: convert(amount, Unit.Gwei, Unit.Wei).decimalPlaces(0, BigNumber.ROUND_CEIL) // TODO round up? round down?
      })

      try {
        this.account.balance = this.account.balance.plus(this.calculateTxFee(tx))
      } catch (err) {
        this.master._log.trace(`Insufficient funds to create channel: `, err.message)
        return
      }

      // For safety, if the tx is reverted, wasn't mined, or less gas was used, don't credit the client's account
      const receipt = await this.master._web3.eth.sendTransaction(tx)

      if (!receipt.status) {
        throw new Error(`on-chain transaction reverted by the EVM`)
      } else {
        this.master._log.info(`Successfully opened new channel for ${format(amount)} for account ${this.account.accountName}`)
      }

      this.account.outgoingChannelId = channelId
      this.master._log.trace(`Outgoing channel ${channelId} is now linked to account ${this.account.accountName}`)
    } else if (requiresDeposit) {
      const channelId = this.account.outgoingChannelId!
      const tx = await Minomy.depositToChannel(this.master._web3, {
        channelId,
        value: convert(amount, Unit.Gwei, Unit.Wei).decimalPlaces(0, BigNumber.ROUND_CEIL)
      })

      try {
        this.account.balance = this.account.balance.plus(this.calculateTxFee(tx))
      } catch (err) {
        return this.master._log.trace(`Insufficient funds for on-chain deposit to send full payment: ${err.message}`)
      }

      // For safety, if the tx is reverted, wasn't mined, or less gas was used, don't credit the client's account
      const receipt = await this.master._web3.eth.sendTransaction(tx)

      if (!receipt.status) {
        throw new Error(`on-chain transaction reverted by the EVM`)
      } else {
        this.master._log.info(`Successfully deposited ${format(amount)} to channel ${channelId} for account ${this.account.accountName}`)
      }
    }
  }

  async sendClaim () {
    try {
      if (!this.account.outgoingChannelId) {
        throw new Error(`no linked channel`)
      }

      // FIXME Is it possible this will error since the block hasn't propogated yet?

      const channel = await Minomy.getChannel(this.master._web3, this.account.outgoingChannelId)
      if (!channel) {
        throw new Error(`failed to lookup linked channel ${this.account.outgoingChannelId}`)
      }

      // Greatest claim/total amount we've sent the receiver
      const spent = new BigNumber(this.account.bestOutgoingClaim ? this.account.bestOutgoingClaim.value : 0)

      if (spent.gte(channel.value)) {
        return this.master._log.trace(`Cannot settle with account ${this.account.accountName}: no remaining funds in outgoing channel`)
      }

      // Total claim value to send should be the minimum of:
      // 1) total amount in channel
      // 2) spent amount + what we owe them (negative balance)
      const amount = BigNumber.min(
        spent.minus(convert(this.account.balance, Unit.Gwei, Unit.Wei)),
        channel.value
      ).decimalPlaces(0, BigNumber.ROUND_DOWN)

      // Don't send an update for less than (or equal to) the previous claim (or 0, if there wasn't a previous claim)
      // FIXME should we send claims equal to the last amount as a stop gap if clients get out of sync?
      if (amount.isNegative() || amount.lte(spent)) {
        return this.master._log.trace(`Cannot settle with account ${this.account.accountName}: we don't owe them`)
      }

      // FIXME Should we do these checks right here?
      // Minomy throws if:
      // - Claim is for 0 or negative amount
      // - Default Web3 account is not the sender for the channel
      // - Channel is not open
      // - Total spent from channel exceeds channel value
      const claim = await Minomy.createClaim(this.master._web3, {
        channelId: this.account.outgoingChannelId,
        value: amount
      })

      // Update balance to reflect settlement
      // Since we've advanced this far, this shouldn't exceed the max balance... let it error if it does
      this.account.balance = this.account.balance.plus(amount)

      this.master._log.trace(`Sending claim for ${format(amount)} to account ${this.account.accountName}`)

      // Send paychan claim to client
      // TODO how will this be exposed/how can it do this?
      return this.sendMessage({
        type: BtpPacket.TYPE_TRANSFER,
        requestId: await requestId(),
        data: {
          amount: convert(amount, Unit.Wei, Unit.Gwei).toFixed(0, BigNumber.ROUND_DOWN),
          protocolData: [{
            protocolName: 'minomy',
            contentType: BtpPacket.MIME_APPLICATION_JSON,
            data: Buffer.from(JSON.stringify(claim))
          }]
        }
      })
    } catch (err) {
      this.master._log.error(`Failed to pay account ${this.account.accountName}: ${err.message}`)
    }
  }

  async handleData (message: BtpPacket, dataHandler?: DataHandler): Promise<BtpSubProtocol[]> {
    // FIXME just use ilp to custom? But I don't have access to that...
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
          this.account.balance = this.account.balance.plus(amountBN)
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
          this.account.balance = this.account.balance.minus(amountBN)
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
      // TODO can I use the ilpAndCustomToProtocolData instead?
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

        const oldBestClaimValue = new BigNumber(oldClaim ? oldClaim.value : 0)
        const claimIncrement = new BigNumber(claim.value).minus(oldBestClaimValue)
        const isBestClaim = claimIncrement.isPositive()
        if (!isBestClaim) {
          // TODO change format to also allow for wei
          throw new Error(`claim value of ${format(claim.value)} is less than a previous claim for ${format(oldBestClaimValue)}`)
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

        this.account.bestIncomingClaim = claim // TODO claimIncrement is in wei
        this.master._log.info(`Accepted incoming claim from account ${this.account.accountName} for ${format(claimIncrement)}`)

        this.account.balance = this.account.balance.minus(convert(claimIncrement, Unit.Gwei, Unit.Wei))

        if (typeof moneyHandler !== 'function') {
          throw new Error('no money handler registered')
        }

        await moneyHandler(claimIncrement.toString())
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

  // TODO need a better name
  beforeForward (preparePacket: IlpPacket.IlpPacket): void {
    // TODO should there be any kind of balance check here? what about from the client's perspective?

    // TODO fix this ?
    if (this.account.isBlocked) {
      throw new IlpPacket.Errors.UnreachableError('Account has been closed')
    }
  }

  // TODO think of a better name
  async afterForwardResponse (preparePacket: IlpPacket.IlpPacket, responsePacket: IlpPacket.IlpPacket): Promise<void> {
    if (responsePacket.type !== IlpPacket.Type.TYPE_ILP_FULFILL) {
      return
    }

    this.master._log.trace(`Handling a FULFILL in response to the forwarded PREPARE, attempting settlement`)

    // Update balance to reflect that we owe them the amount of the FULFILL
    let amount = new BigNumber(preparePacket.data.amount)
    this.account.balance = this.account.balance.minus(amount)

    // Attempt to settle
    await this.fundOutgoingChannel()
    await this.sendClaim()
  }

  // TODO what should happen here?
  async disconnect (): Promise<void> {
    // clearInterval(this._watcher)

    // await this._persistChannels()

    // for (const accountName of this._accounts.keys()) {
      // this._store.unload(accountName)
    // }
    // await this._store.close()
  }

  // TODO add the watcher! it should run on a per-account basis?!?!?
}
