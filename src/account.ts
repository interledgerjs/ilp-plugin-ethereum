import BigNumber from 'bignumber.js'
import {
  MIME_APPLICATION_JSON,
  MIME_APPLICATION_OCTET_STREAM,
  MIME_TEXT_PLAIN_UTF8,
  TYPE_MESSAGE
} from 'btp-packet'
import { randomBytes } from 'crypto'
import { ethers } from 'ethers'
import { TransactionReceipt } from 'ethers/providers'
import {
  deserializeIlpPrepare,
  deserializeIlpReply,
  Errors,
  errorToReject,
  IlpPrepare,
  IlpReply,
  isFulfill,
  isReject
} from 'ilp-packet'
import { BtpPacket, BtpPacketData, BtpSubProtocol } from 'ilp-plugin-btp'
import { promisify } from 'util'
import EthereumPlugin from '.'
import { DataHandler, MoneyHandler } from './types/plugin'
import {
  ClaimablePaymentChannel,
  createPaymentDigest,
  fetchChannelById,
  generateChannelId,
  hasClaim,
  hasEvent,
  hexToBuffer,
  isDisputed,
  isValidClaimSignature,
  PaymentChannel,
  prepareTransaction,
  remainingInChannel,
  SerializedClaim,
  SerializedClaimablePaymentChannel,
  SerializedPaymentChannel,
  spentFromChannel,
  updateChannel
} from './utils/channel'
import ReducerQueue from './utils/queue'

// Almost never use exponential notation
BigNumber.config({ EXPONENTIAL_AT: 1e9 })

/**
 * - approve() using OpenZeppelin's MintableToken => 47146
 * - open() using TokenUnidirectional => 173825
 * Total: 220971
 *
 * - Allow wiggle room in case the ERC-20 implementation needs additional gas
 */
const APPROVE_AND_OPEN_GAS_LIMIT = new BigNumber(300000)

/**
 * - approve() using OpenZeppelin's MintableToken => 47358
 * - deposit() using TokenUnidirectional => 55192
 * Total: 102550
 *
 * - Allow wiggle room in case the ERC-20 implementation needs additional gas
 */
const APPROVE_AND_DEPOSIT_GAS_LIMIT = new BigNumber(150000)

const delay = (timeout: number) => new Promise(r => setTimeout(r, timeout))

const getBtpSubprotocol = (message: BtpPacket, name: string) =>
  message.data.protocolData.find((p: BtpSubProtocol) => p.protocolName === name)

export const generateBtpRequestId = async () =>
  (await promisify(randomBytes)(4)).readUInt32BE(0)

export interface SerializedAccountData {
  accountName: string
  receivableBalance: string
  payableBalance: string
  payoutAmount: string
  ethereumAddress?: string
  incoming?: SerializedClaimablePaymentChannel
  outgoing?: SerializedPaymentChannel
}

export interface AccountData {
  /** Hash/account identifier in ILP address */
  accountName: string

  /** Incoming amount owed to us by our peer for their packets we've forwarded */
  receivableBalance: BigNumber

  /** Outgoing amount owed by us to our peer for packets we've sent to them */
  payableBalance: BigNumber

  /**
   * Amount of failed outgoing settlements that is owed to the peer, but not reflected
   * in the payableBalance (e.g. due to sendMoney calls on client)
   */
  payoutAmount: BigNumber

  /**
   * Ethereum address counterparty should be paid at
   * - Does not pertain to address counterparty sends from
   * - Must be linked for the lifetime of the account
   */
  ethereumAddress?: string

  /**
   * Priority FIFO queue for incoming channel state updates:
   * - Validating claims
   * - Watching channels
   * - Claiming chanenls
   */
  incoming: ReducerQueue<ClaimablePaymentChannel | undefined>

  /**
   * Priority FIFO queue for outgoing channel state updates:
   * - Signing claims
   * - Refreshing state after funding transactions
   */
  outgoing: ReducerQueue<PaymentChannel | undefined>
}

enum IncomingTaskPriority {
  ClaimChannel = 1,
  ValidateClaim = 0
}

export default class EthereumAccount {
  /** Metadata specific to this account to persist (claims, channels, balances) */
  account: AccountData

  /** Expose access to common configuration across accounts */
  private master: EthereumPlugin

  /**
   * Queue for channel state/signing outgoing claims ONLY while a deposit is occuring,
   * enabling them to happen in parallel
   */
  private depositQueue?: ReducerQueue<PaymentChannel | undefined>

  /**
   * Send the given BTP packet message to the counterparty for this account
   * (wraps _call on internal plugin)
   */
  private sendMessage: (message: BtpPacket) => Promise<BtpPacketData>

  /** Data handler from plugin for incoming ILP packets */
  private dataHandler: DataHandler

  /** Money handler from plugin for incoming money */
  private moneyHandler: MoneyHandler

  /** Timer/interval for channel watcher to claim incoming, disputed channels */
  private watcher: NodeJS.Timer | null

  constructor({
    accountData,
    master,
    sendMessage,
    dataHandler,
    moneyHandler
  }: {
    accountName: string
    accountData: AccountData
    master: EthereumPlugin
    sendMessage: (message: BtpPacket) => Promise<BtpPacketData>
    dataHandler: DataHandler
    moneyHandler: MoneyHandler
  }) {
    this.master = master
    this.sendMessage = sendMessage
    this.dataHandler = dataHandler
    this.moneyHandler = moneyHandler

    this.account = new Proxy(accountData, {
      set: (account, key, val) => {
        this.persistAccountData()
        return Reflect.set(account, key, val)
      }
    })

    // Automatically persist cached channels/claims to the store
    this.account.incoming.on('data', () => this.persistAccountData())
    this.account.outgoing.on('data', () => this.persistAccountData())

    this.watcher = this.startChannelWatcher()

    this.autoFundOutgoingChannel().catch(err => {
      this.master._log.error(
        'Error attempting to auto fund outgoing channel: ',
        err
      )
    })
  }

  private persistAccountData(): void {
    this.master._store.set(`${this.account.accountName}:account`, this.account)
  }

  /**
   * Inform the peer what address this instance should be paid at and
   * request the Ethereum address the peer wants to be paid at
   * - No-op if we already know the peer's address
   */
  private async fetchEthereumAddress(): Promise<void> {
    if (typeof this.account.ethereumAddress === 'string') return
    try {
      const response = await this.sendMessage({
        type: TYPE_MESSAGE,
        requestId: await generateBtpRequestId(),
        data: {
          protocolData: [
            {
              protocolName: 'info',
              contentType: MIME_APPLICATION_JSON,
              data: Buffer.from(
                JSON.stringify({
                  ethereumAddress: this.master._wallet.address
                })
              )
            }
          ]
        }
      })

      const info = response.protocolData.find(
        (p: BtpSubProtocol) => p.protocolName === 'info'
      )

      if (info) {
        this.linkEthereumAddress(info)
      } else {
        this.master._log.debug(
          `Failed to link Ethereum address: BTP response did not include any 'info' subprotocol data`
        )
      }
    } catch (err) {
      this.master._log.debug(
        `Failed to exchange Ethereum addresses: ${err.message}`
      )
    }
  }

  /**
   * Validate the response to an `info` request and link
   * the provided Ethereum address to the account, if it's valid
   */
  private linkEthereumAddress(info: BtpSubProtocol): void {
    try {
      const { ethereumAddress } = JSON.parse(info.data.toString())

      if (typeof ethereumAddress !== 'string') {
        return this.master._log.debug(
          `Failed to link Ethereum address: invalid response, no address provided`
        )
      }

      if (!ethers.utils.getAddress(ethereumAddress)) {
        return this.master._log.debug(
          `Failed to link Ethereum address: not a valid address`
        )
      }

      const currentAddress = this.account.ethereumAddress
      if (currentAddress) {
        // Don't log if it's the same address that's already linked...we don't care
        if (currentAddress.toLowerCase() === ethereumAddress.toLowerCase()) {
          return
        }

        return this.master._log.debug(
          `Cannot link Ethereum address ${ethereumAddress} to ${
            this.account.accountName
          }: ${currentAddress} is already linked for the lifetime of the account`
        )
      }

      this.account.ethereumAddress = ethereumAddress
      this.master._log.debug(
        `Successfully linked Ethereum address ${ethereumAddress} to ${
          this.account.accountName
        }`
      )
    } catch (err) {
      this.master._log.debug(`Failed to link Ethereum address: ${err.message}`)
    }
  }

  /**
   * Create a channel with the given amount or deposit the given amount to an existing outgoing channel,
   * invoking the authorize callback to confirm the transaction fee
   * - Fund amount is in units of wei
   */
  async fundOutgoingChannel(
    value: BigNumber,
    authorize: (fee: BigNumber) => Promise<void> = () => Promise.resolve()
  ) {
    return this.account.outgoing.add(cachedChannel =>
      cachedChannel
        ? this.depositToChannel(cachedChannel, value, authorize)
        : this.openChannel(value, authorize)
    )
  }

  /**
   * Automatically fund a new outgoing channel or topup an existing channel
   * - When over 50% of the capacity has been spent/sent to the receiver,
   *   add the outgoing channel amount to the channel
   */
  private async autoFundOutgoingChannel() {
    await this.account.outgoing.add(async cachedChannel => {
      const requiresTopUp =
        !cachedChannel ||
        remainingInChannel(cachedChannel).isLessThan(
          this.master._outgoingChannelAmount.dividedBy(2)
        )

      const incomingChannel = this.account.incoming.state
      const sufficientIncoming = (incomingChannel
        ? incomingChannel.value
        : new BigNumber(0)
      ).isGreaterThanOrEqualTo(this.master._minIncomingChannelAmount)

      if (requiresTopUp && sufficientIncoming) {
        return cachedChannel
          ? this.depositToChannel(
              cachedChannel,
              this.master._outgoingChannelAmount
            )
          : this.openChannel(this.master._outgoingChannelAmount)
      }

      return cachedChannel
    })
  }

  /**
   * Open a channel for the given amount in units of wei
   * - Must always be called from a task in the outgoing queue
   */
  private async openChannel(
    value: BigNumber,
    authorize: (fee: BigNumber) => Promise<void> = () => Promise.resolve()
  ): Promise<PaymentChannel | undefined> {
    await this.fetchEthereumAddress()
    if (!this.account.ethereumAddress) {
      this.master._log.debug(
        'Failed to open channel: no Ethereum address is linked'
      )
      return
    }

    const channelId = await generateChannelId()
    const sender = this.master._wallet.address
    const receiver = this.account.ethereumAddress
    const disputePeriod = this.master._outgoingDisputePeriod
    const tokenContract =
      this.master._tokenContract && this.master._tokenContract.address

    const contract = await this.master._contract
    const gasPrice = await this.master._getGasPrice()

    const txObj = !tokenContract
      ? {
          methodName: 'open',
          params: [channelId, receiver, disputePeriod.toString()],
          contract,
          gasPrice,
          value
        }
      : {
          methodName: 'open',
          params: [
            channelId,
            receiver,
            disputePeriod.toString(),
            tokenContract,
            value.toString()
          ],
          contract,
          gasPrice
        }

    const {
      sendTransaction,
      txFee
    }: {
      sendTransaction: () => Promise<TransactionReceipt>
      txFee: BigNumber
    } = await this.checkIfApproved(value).then(async requiresApproval => {
      /** For ETH or unlocked ERC-20s, accurately estimate the gas */
      if (!requiresApproval) {
        const { txFee, sendTransaction } = await prepareTransaction(txObj)

        const hasSufficientBalance = await this.checkIfSufficientBalance(
          value,
          txFee
        )
        if (!hasSufficientBalance) {
          throw new Error('ETH balance is insufficient to open channel')
        }

        await authorize(txFee)
        return { txFee, sendTransaction }
      } else {
        /**
         * If approving ERC-20 token transfers is required, overestimate the gas,
         * using a combined upperbound for both transactions
         */
        const gasLimit = APPROVE_AND_OPEN_GAS_LIMIT

        const gasPrice = await this.master._getGasPrice()
        const txFee = gasLimit.times(gasPrice)

        const hasSufficientBalance = await this.checkIfSufficientBalance(
          value,
          txFee
        )
        if (!hasSufficientBalance) {
          throw new Error(
            'ERC-20 balance or ETH balance is insufficient to open channel'
          )
        }

        await authorize(txFee)

        const remainingGasLimit = await this.secureAllowance(gasLimit)

        return prepareTransaction({
          ...txObj,
          gasLimit: remainingGasLimit
        })
      }
    })

    this.master._log.debug(
      `Opening channel for ${this.master._format(
        value,
        'base'
      )} and fee of ${this.master._format(txFee, 'base')}`
    )

    const receipt = await this.master
      ._queueTransaction(sendTransaction)
      .catch(err => {
        this.master._log.error(`Failed to open channel:`, err)
        throw err
      })

    const didOpen = hasEvent(receipt, 'DidOpen')
    if (!didOpen) {
      throw new Error('Failed to open new channel')
    }

    // Construct the known initial channel state
    const signedChannel = this.signClaim({
      lastUpdated: Date.now(),
      contractAddress: contract.address,
      channelId,
      receiver,
      sender,
      disputePeriod,
      value,
      spent: new BigNumber(0),
      tokenContract
    })

    // Send a zero amount claim to the peer so they'll link the channel
    this.sendClaim(signedChannel).catch(err =>
      this.master._log.error('Error sending proof-of-channel to peer: ', err)
    )

    this.master._log.debug(
      `Successfully opened channel ${channelId} for ${this.master._format(
        value,
        'base'
      )}`
    )

    return signedChannel
  }

  /**
   * Deposit the given amount in units of wei to the given channel
   * - Must always be called from a task in the outgoing queue
   */
  private async depositToChannel(
    channel: PaymentChannel,
    value: BigNumber,
    authorize: (fee: BigNumber) => Promise<void> = () => Promise.resolve()
  ): Promise<PaymentChannel | undefined> {
    // To simultaneously send payment channel claims, create a "side queue" only for the duration of the deposit
    this.depositQueue = new ReducerQueue<PaymentChannel | undefined>(channel)

    // In case there were pending tasks to send claims in the main queue, try to send a claim
    this.depositQueue
      .add(this.createClaim.bind(this))
      .catch(err =>
        this.master._log.error('Error queuing task to create new claim:', err)
      )

    const totalNewValue = channel.value.plus(value)
    const channelId = channel.channelId

    try {
      const tokenContract = this.master._tokenContract
      const txObj = !tokenContract
        ? {
            methodName: 'deposit',
            params: [channelId],
            contract: await this.master._contract,
            gasPrice: await this.master._getGasPrice(),
            value
          }
        : {
            methodName: 'deposit',
            params: [channelId, value.toString()],
            contract: await this.master._contract,
            gasPrice: await this.master._getGasPrice()
          }

      const {
        sendTransaction,
        txFee
      }: {
        sendTransaction: () => Promise<TransactionReceipt>
        txFee: BigNumber
      } = await this.checkIfApproved(value).then(async requiresApproval => {
        /** For ETH or unlocked ERC-20s, accurately estimate the gas */
        if (!requiresApproval) {
          const { txFee, sendTransaction } = await prepareTransaction(txObj)

          const hasSufficientBalance = await this.checkIfSufficientBalance(
            value,
            txFee
          )
          if (!hasSufficientBalance) {
            throw new Error('ETH balance is insufficient for deposit')
          }

          await authorize(txFee)
          return { txFee, sendTransaction }
        } else {
          /**
           * If approving ERC-20 token transfers is required, overestimate the gas,
           * using a combined upperbound for both transactions
           */
          const gasLimit = APPROVE_AND_DEPOSIT_GAS_LIMIT

          const gasPrice = await this.master._getGasPrice()
          const txFee = gasLimit.times(gasPrice)

          const hasSufficientBalance = await this.checkIfSufficientBalance(
            value,
            txFee
          )
          if (!hasSufficientBalance) {
            throw new Error(
              'ERC-20 balance or ETH balance is insufficient for deposit'
            )
          }

          await authorize(txFee)

          const remainingGasLimit = await this.secureAllowance(gasLimit)

          return prepareTransaction({
            ...txObj,
            gasLimit: remainingGasLimit
          })
        }
      })

      this.master._log.debug(
        `Depositing ${this.master._format(
          value,
          'base'
        )} to channel for fee of ${this.master._format(txFee, 'base')}`
      )

      const receipt = await this.master._queueTransaction(sendTransaction)

      const didDeposit = hasEvent(receipt, 'DidDeposit')
      if (!didDeposit) {
        throw new Error(`Failed to deposit to channel ${channelId}`)
      }

      const updatedChannel = {
        ...channel,
        value: totalNewValue
      }

      this.master._log.debug('Informing peer of channel top-up')
      this.sendMessage({
        type: TYPE_MESSAGE,
        requestId: await generateBtpRequestId(),
        data: {
          protocolData: [
            {
              protocolName: 'channelDeposit',
              contentType: MIME_APPLICATION_OCTET_STREAM,
              data: Buffer.alloc(0)
            }
          ]
        }
      }).catch(err => {
        this.master._log.error('Error informing peer of channel deposit:', err)
      })

      this.master._log.debug(
        `Successfully deposited ${this.master._format(
          value,
          'base'
        )} to channel ${channelId} for total value of ${this.master._format(
          totalNewValue,
          'base'
        )}`
      )

      const bestClaim = this.depositQueue.clear()
      delete this.depositQueue // Don't await the promise so no new tasks are added to the queue

      // Merge the updated channel state with any claims sent in the side queue
      const forkedState = await bestClaim
      return forkedState
        ? {
            ...updatedChannel,
            signature: forkedState.signature,
            spent: forkedState.spent
          }
        : updatedChannel
    } catch (err) {
      this.master._log.error(`Failed to deposit to channel:`, err)

      // Since there's no updated state from the deposit, just use the state from the side queue
      const bestClaim = this.depositQueue!.clear()
      delete this.depositQueue // Don't await the promise so no new tasks are added to the queue

      return bestClaim
    }
  }

  /**
   * Check that the Ethereum account has sufficient ether and token balances to complete the transaction
   * @param value Amount to be sent to contract, in either ETH (units of wei) or the configured ERC-20 (denominated in its base unit)
   * @param fee Transaction fee in ETH, always denominated in units of wei
   */
  async checkIfSufficientBalance(
    value: BigNumber,
    fee: BigNumber
  ): Promise<boolean> {
    const etherBalance = new BigNumber(
      (await this.master._wallet.getBalance()).toString()
    )

    if (!this.master._tokenContract) {
      return etherBalance.isGreaterThanOrEqualTo(value.plus(fee))
    } else {
      const tokenBalance = new BigNumber(
        (await this.master._tokenContract.functions.balanceOf(
          this.master._wallet.address
        )).toString()
      )

      return (
        tokenBalance.isGreaterThanOrEqualTo(value) &&
        etherBalance.isGreaterThanOrEqualTo(fee)
      )
    }
  }

  /**
   * Check if the Machinomy contract is approved to send the configured ERC-20 token
   * from the configured Ethereum account
   * @param minimumAllowance Minimum amount the contract must be approved to transfer into it
   */
  async checkIfApproved(minimumAllowance: BigNumber): Promise<boolean> {
    if (!this.master._tokenContract) {
      return false
    }

    const ownerAddress = this.master._wallet.address
    const spenderAddress = (await this.master._contract).address

    const allowance = await this.master._tokenContract.functions.allowance(
      ownerAddress,
      spenderAddress
    )

    return allowance.lt(minimumAllowance.toString())
  }

  /**
   * Authorize the Machinomy token contract to send the configured ERC-20 token from the configured Ethereum account
   * - Only needs to happen once, since we're authorizing for the largest possible value
   * - Secure since all transfers to the Machinomy contract still require transactions from user
   * @param gasLimit Total gas limit for the approve transaction and subsequent operations
   * @returns Remaining gas available to spend from the given gas limit, after the approve transaction
   */
  async secureAllowance(gasLimit: BigNumber): Promise<BigNumber> {
    if (!this.master._tokenContract) {
      return gasLimit
    }

    const spenderAddress = (await this.master._contract).address

    const { sendTransaction } = await prepareTransaction({
      methodName: 'approve',
      params: [spenderAddress, ethers.constants.MaxUint256],
      contract: this.master._tokenContract,
      gasPrice: await this.master._getGasPrice(),
      gasLimit
    })

    this.master._log.debug(
      `Unlocking transfers for ${this.master._assetCode} for account ${
        this.account.ethereumAddress
      }`
    )

    const receipt = await this.master._queueTransaction(sendTransaction)

    const didApprove =
      receipt.events && receipt.events.map(o => o.event).includes('Approval')
    if (!didApprove) {
      throw new Error(
        `Failed to unlock transfers for ${this.master._assetCode}`
      )
    }

    return receipt.gasUsed
      ? gasLimit.minus(receipt.gasUsed.toString())
      : new BigNumber(0)
  }

  /**
   * Send a settlement/payment channel claim to the peer
   *
   * If an amount is specified (e.g. role=client), try to send that amount, plus the amount of
   * settlements that have previously failed.
   *
   * If no amount is specified (e.g. role=server), settle such that 0 is owed to the peer.
   */
  async sendMoney(amount?: string) {
    const amountToSend = amount || BigNumber.max(0, this.account.payableBalance)
    this.account.payoutAmount = this.account.payoutAmount.plus(amountToSend)

    this.depositQueue
      ? await this.depositQueue.add(this.createClaim.bind(this))
      : await this.account.outgoing.add(this.createClaim.bind(this))
  }

  async createClaim(
    cachedChannel: PaymentChannel | undefined
  ): Promise<PaymentChannel | undefined> {
    this.autoFundOutgoingChannel().catch(err =>
      this.master._log.error(
        'Error attempting to auto fund outgoing channel: ',
        err
      )
    )

    const settlementBudget = this.master._convertToBaseUnit(
      this.account.payoutAmount
    )
    if (settlementBudget.isLessThanOrEqualTo(0)) {
      return cachedChannel
    }

    if (!cachedChannel) {
      this.master._log.debug(`Cannot send claim: no channel is open`)
      return cachedChannel
    }

    // Used to ensure the claim increment is always > 0
    if (!remainingInChannel(cachedChannel).isGreaterThan(0)) {
      this.master._log.debug(
        `Cannot send claim to: no remaining funds in outgoing channel`
      )
      return cachedChannel
    }

    // Ensures that the increment is greater than the previous claim
    // Since budget and remaining in channel must be positive, claim increment should always be positive
    const claimIncrement = BigNumber.min(
      remainingInChannel(cachedChannel),
      settlementBudget
    )

    this.master._log.info(
      `Settlement attempt triggered with ${this.account.accountName}`
    )

    // Total value of new claim: value of old best claim + increment of new claim
    const value = spentFromChannel(cachedChannel).plus(claimIncrement)

    const updatedChannel = this.signClaim({
      ...cachedChannel,
      spent: value
    })

    this.master._log.debug(
      `Sending claim for total of ${this.master._format(
        value,
        'base'
      )}, incremented by ${this.master._format(claimIncrement, 'base')}`
    )

    // Send paychan claim to client, don't await a response
    this.sendClaim(updatedChannel).catch(err =>
      // If they reject the claim, it's not particularly actionable
      this.master._log.debug(
        `Error while sending claim to peer: ${err.message}`
      )
    )

    const claimIncrementGwei = this.master._convertFromBaseUnit(claimIncrement)

    this.account.payableBalance = this.account.payableBalance.minus(
      claimIncrementGwei
    )

    this.account.payoutAmount = BigNumber.min(
      0,
      this.account.payoutAmount.minus(claimIncrementGwei)
    )

    return updatedChannel
  }

  signClaim(channel: PaymentChannel): ClaimablePaymentChannel {
    const secp256k1 = this.master._secp256k1!

    const {
      signature,
      recoveryId
    } = secp256k1.signMessageHashRecoverableCompact(
      hexToBuffer(this.master._wallet.privateKey),
      createPaymentDigest(
        channel.contractAddress,
        channel.channelId,
        channel.spent.toString(),
        channel.tokenContract
      )
    )

    /**
     * Ethereum requires RLP encoding, not supported by bitcoin-ts:
     *  - https://ethereum.stackexchange.com/questions/64380/understanding-ethereum-signatures
     *  - https://docs.ethers.io/ethers.js/html/api-utils.html#signatures
     */
    const v = recoveryId === 1 ? '1c' : '1b'
    const flatSignature = '0x' + Buffer.from(signature).toString('hex') + v

    return {
      ...channel,
      signature: flatSignature
    }
  }

  async sendClaim({
    channelId,
    signature,
    spent,
    contractAddress,
    tokenContract
  }: PaymentChannel) {
    const claim = {
      channelId,
      signature,
      value: spent.toString(),
      contractAddress,
      tokenContract
    }

    return this.sendMessage({
      type: TYPE_MESSAGE,
      requestId: await generateBtpRequestId(),
      data: {
        protocolData: [
          {
            protocolName: 'machinomy',
            contentType: MIME_APPLICATION_JSON,
            data: Buffer.from(JSON.stringify(claim))
          }
        ]
      }
    })
  }

  async handleData(message: BtpPacket): Promise<BtpSubProtocol[]> {
    // Link the given Ethereum address & inform counterparty what address this wants to be paid at
    const info = getBtpSubprotocol(message, 'info')
    if (info) {
      this.linkEthereumAddress(info)

      return [
        {
          protocolName: 'info',
          contentType: MIME_APPLICATION_JSON,
          data: Buffer.from(
            JSON.stringify({
              ethereumAddress: this.master._wallet.address
            })
          )
        }
      ]
    }

    // If the peer says they may have deposited, check for a deposit
    const channelDeposit = getBtpSubprotocol(message, 'channelDeposit')
    if (channelDeposit) {
      const cachedChannel = this.account.incoming.state
      if (!cachedChannel) {
        return []
      }

      // Don't block the queue while fetching channel state, since that slows down claim processing
      this.master._log.debug('Checking if peer has deposited to channel')
      const checkForDeposit = async (attempts = 0): Promise<void> => {
        if (attempts > 20) {
          return this.master._log.debug(
            `Failed to confirm incoming deposit after several attempts`
          )
        }

        const updatedChannel = await updateChannel(
          await this.master._contract,
          cachedChannel
        )

        if (!updatedChannel) {
          return
        }

        const wasDeposit = updatedChannel.value.isGreaterThan(
          cachedChannel.value
        )
        if (!wasDeposit) {
          await delay(250)
          return checkForDeposit(attempts + 1)
        }

        // Rectify the two forked states
        await this.account.incoming.add(async newCachedChannel => {
          // Ensure it's the same channel, except for the value. Otherwise, don't update.
          const isSameChannel =
            newCachedChannel &&
            newCachedChannel.channelId === cachedChannel.channelId &&
            newCachedChannel.disputePeriod.isEqualTo(
              cachedChannel.disputePeriod
            ) &&
            newCachedChannel.sender === cachedChannel.sender &&
            newCachedChannel.receiver === cachedChannel.receiver
          if (!newCachedChannel || !isSameChannel) {
            this.master._log.debug(
              `Incoming channel was closed while confirming deposit: reverting to old state`
            )

            // Revert to old state
            return newCachedChannel
          }

          // Only update the state with the new value of the channel
          this.master._log.debug('Confirmed deposit to incoming channel')
          return {
            ...newCachedChannel,
            value: BigNumber.max(updatedChannel.value, newCachedChannel.value)
          }
        })
      }

      await checkForDeposit().catch(err => {
        this.master._log.error('Error confirming incoming deposit:', err)
      })

      return []
    }

    // If the peer requests to close a channel, try to close it, if it's profitable
    const requestClose = getBtpSubprotocol(message, 'requestClose')
    if (requestClose) {
      this.master._log.info(
        `Channel close requested for account ${this.account.accountName}`
      )

      await this.claimIfProfitable(false, () => Promise.resolve()).catch(err =>
        this.master._log.error(
          `Error attempting to claim channel: ${err.message}`
        )
      )

      return []
    }

    const machinomy = getBtpSubprotocol(message, 'machinomy')
    if (machinomy) {
      this.master._log.debug(
        `Handling Machinomy claim for account ${this.account.accountName}`
      )

      // If JSON is semantically invalid, this will throw
      const claim = JSON.parse(machinomy.data.toString())

      const hasValidSchema = (o: any): o is SerializedClaim =>
        typeof o.value === 'string' &&
        typeof o.channelId === 'string' &&
        typeof o.signature === 'string' &&
        typeof o.contractAddress === 'string' &&
        ['string', 'undefined'].includes(typeof o.tokenContract)
      if (!hasValidSchema(claim)) {
        this.master._log.debug('Invalid claim: schema is malformed')
        return []
      }

      await this.account.incoming.add(this.validateClaim(claim)).catch(err =>
        // Don't expose internal errors, since it may not have been intentionally thrown
        this.master._log.error('Failed to validate claim: ', err)
      )

      /**
       * Attempt to fund an outgoing channel, if the incoming claim is accepted,
       * the incoming channel has sufficient value, and no existing outgoing
       * channel already exists
       */
      this.autoFundOutgoingChannel().catch(err =>
        this.master._log.error(
          'Error attempting to auto fund outgoing channel: ',
          err
        )
      )

      return []
    }

    // Handle incoming ILP PREPARE packets from peer
    // plugin-btp handles correlating the response packets for the dataHandler
    const ilp = getBtpSubprotocol(message, 'ilp')
    if (ilp) {
      try {
        const { amount } = deserializeIlpPrepare(ilp.data)
        const amountBN = new BigNumber(amount)

        if (amountBN.gt(this.master._maxPacketAmount)) {
          throw new Errors.AmountTooLargeError('Packet size is too large.', {
            receivedAmount: amount,
            maximumAmount: this.master._maxPacketAmount.toString()
          })
        }

        const newBalance = this.account.receivableBalance.plus(amount)
        if (newBalance.isGreaterThan(this.master._maxBalance)) {
          this.master._log.debug(
            `Cannot forward PREPARE: cannot debit ${this.master._format(
              amount,
              'account'
            )}: proposed balance of ${this.master._format(
              newBalance,
              'account'
            )} exceeds maximum of ${this.master._format(
              this.master._maxBalance,
              'account'
            )}`
          )
          throw new Errors.InsufficientLiquidityError(
            'Exceeded maximum balance'
          )
        }

        this.master._log.debug(
          `Forwarding PREPARE: Debited ${this.master._format(
            amount,
            'account'
          )}, new balance is ${this.master._format(newBalance, 'account')}`
        )
        this.account.receivableBalance = newBalance

        const response = await this.dataHandler(ilp.data)
        const reply = deserializeIlpReply(response)

        if (isReject(reply)) {
          this.master._log.debug(
            `Credited ${this.master._format(
              amount,
              'account'
            )} in response to REJECT`
          )
          this.account.receivableBalance = this.account.receivableBalance.minus(
            amount
          )
        } else if (isFulfill(reply)) {
          this.master._log.debug(
            `Received FULFILL in response to forwarded PREPARE`
          )
        }

        return [
          {
            protocolName: 'ilp',
            contentType: MIME_APPLICATION_OCTET_STREAM,
            data: response
          }
        ]
      } catch (err) {
        return [
          {
            protocolName: 'ilp',
            contentType: MIME_APPLICATION_OCTET_STREAM,
            data: errorToReject('', err)
          }
        ]
      }
    }

    return []
  }

  /**
   * Given an unvalidated claim and the current channel state, return either:
   * (1) the previous state, or
   * (2) new state updated with the valid claim
   *
   * TODO: Add test cases for sending claims with varying lengths of hex strings, with and without 0x prefix
   * (current approach of checking string equality likely circumvents those issues)
   */
  validateClaim = (claim: SerializedClaim) => async (
    cachedChannel: ClaimablePaymentChannel | undefined,
    attempts = 0
  ): Promise<ClaimablePaymentChannel | undefined> => {
    // To reduce latency, only fetch channel state if no channel was linked, or there was a possible on-chain deposit
    const shouldFetchChannel =
      !cachedChannel ||
      new BigNumber(claim.value).isGreaterThan(cachedChannel.value)
    const updatedChannel = shouldFetchChannel
      ? await fetchChannelById(await this.master._contract, claim.channelId)
      : cachedChannel

    // Perform checks to link a new channel
    if (!cachedChannel) {
      if (!updatedChannel) {
        if (attempts > 20) {
          this.master._log.debug(
            `Invalid claim: channel ${
              claim.channelId
            } doesn't exist, despite several attempts to refresh channel state`
          )
          return cachedChannel
        }

        await delay(250)
        return this.validateClaim(claim)(cachedChannel, attempts + 1)
      }

      // Ensure the channel is to this address
      // (only check for new channels, not per claim, in case the server restarts and changes config)
      const amReceiver =
        updatedChannel.receiver.toLowerCase() ===
        this.master._wallet.address.toLowerCase()
      if (!amReceiver) {
        this.master._log.debug(
          `Invalid claim: the recipient for new channel ${
            claim.channelId
          } is not ${this.master._wallet.address}`
        )
        return cachedChannel
      }

      // Confirm the settling period for the channel is above the minimum
      const isAboveMinDisputePeriod = updatedChannel.disputePeriod.isGreaterThanOrEqualTo(
        this.master._minIncomingDisputePeriod
      )
      if (!isAboveMinDisputePeriod) {
        this.master._log.debug(
          `Invalid claim: new channel ${
            claim.channelId
          } has dispute period of ${
            updatedChannel.disputePeriod
          } blocks, below floor of ${
            this.master._minIncomingDisputePeriod
          } blocks`
        )
        return cachedChannel
      }
    }
    // An existing claim is linked, so validate this against the previous claim
    else {
      if (!updatedChannel) {
        this.master._log.error(`Invalid claim: channel is unexpectedly closed`)
        return cachedChannel
      }

      // `updatedChannel` is fetched using the ID in the claim, so compare against previously linked channelId
      const wrongChannel =
        claim.channelId.toLowerCase() !== cachedChannel.channelId.toLowerCase()
      if (wrongChannel) {
        this.master._log.debug(
          'Invalid claim: channel is not the previously linked channel'
        )
        return cachedChannel
      }
    }

    /**
     * Ensure the claim is positive or zero
     * - Allow claims of 0 (essentially a proof of channel ownership without sending any money)
     */
    const hasNegativeValue = new BigNumber(claim.value).isNegative()
    if (hasNegativeValue) {
      this.master._log.error(`Invalid claim: value is negative`)
      return cachedChannel
    }

    const wrongContract =
      claim.contractAddress.toLowerCase() !==
      (await this.master._contract).address.toLowerCase()
    if (wrongContract) {
      this.master._log.debug(
        'Invalid claim: sender is using a different contract or network (e.g. testnet instead of mainnet)'
      )
      return cachedChannel
    }

    // If using ERC-20 tokens, ensure the claim and channel are for the correct token
    if (this.master._tokenContract) {
      // Since channels are fetched from TokenUnidirectional, tokenContract is defined
      const channelUsesWrongToken =
        updatedChannel.tokenContract!.toLowerCase() !==
        this.master._tokenContract.address.toLowerCase()
      if (channelUsesWrongToken) {
        this.master._log.debug(
          'Invalid claim: channel is for the wrong ERC-20 token'
        )
        return cachedChannel
      }

      const claimUsesWrongToken =
        !claim.tokenContract ||
        claim.tokenContract.toLowerCase() !==
          this.master._tokenContract.address.toLowerCase()
      if (claimUsesWrongToken) {
        this.master._log.debug('Invalid claim: claim is for wrong ERC-20 token')
        return cachedChannel
      }
    }
    // If using ETH, ensure the claim is not for a token
    else {
      if (claim.tokenContract) {
        this.master._log.debug(
          'Invalid claim: claim is for ERC-20 token, not ETH'
        )
        return cachedChannel
      }
    }

    const isSigned = isValidClaimSignature(
      this.master._secp256k1!,
      claim,
      updatedChannel.sender
    )
    if (!isSigned) {
      this.master._log.debug('Invalid claim: signature is invalid')
      return cachedChannel
    }

    const sufficientChannelValue = updatedChannel.value.isGreaterThanOrEqualTo(
      claim.value
    )
    if (!sufficientChannelValue) {
      if (attempts > 20) {
        this.master._log.debug(
          `Invalid claim: value of ${this.master._format(
            claim.value,
            'account'
          )} is above value of channel, despite several attempts to refresh channel state`
        )
        return cachedChannel
      }

      await delay(250)
      return this.validateClaim(claim)(cachedChannel, attempts + 1)
    }

    // Finally, if the claim is new, ensure it isn't already linked to another account
    // (do this last to prevent race conditions)
    if (!cachedChannel) {
      /**
       * Ensure no channel can be linked to multiple accounts
       * - Each channel key is a mapping of channelId -> accountName
       */
      const channelKey = `${claim.channelId}:incoming-channel`
      await this.master._store.load(channelKey)
      const linkedAccount = this.master._store.get(channelKey)
      if (typeof linkedAccount === 'string') {
        this.master._log.debug(
          `Invalid claim: channel ${
            claim.channelId
          } is already linked to a different account`
        )
        return cachedChannel
      }

      this.master._store.set(channelKey, this.account.accountName)
      this.master._log.debug(
        `Incoming channel ${claim.channelId} is now linked to account ${
          this.account.accountName
        }`
      )
    }

    // Cap the value of the credited claim by the total value of the channel
    const claimIncrement = BigNumber.min(
      claim.value,
      updatedChannel.value
    ).minus(cachedChannel ? cachedChannel.spent : 0)

    // Claims for zero are okay, so long as it's new channel (essentially a "proof of channel")
    const isBestClaim = claimIncrement.gt(0)
    if (!isBestClaim && cachedChannel) {
      this.master._log.debug(
        `Invalid claim: value of ${this.master._format(
          claim.value,
          'base'
        )} is less than previous claim for ${this.master._format(
          updatedChannel.spent,
          'base'
        )}`
      )
      return cachedChannel
    }

    // Only perform balance operations if the claim increment is positive
    if (isBestClaim) {
      const amount = this.master._convertFromBaseUnit(claimIncrement)

      this.account.receivableBalance = this.account.receivableBalance.minus(
        amount
      )

      await this.moneyHandler(amount.toString())
    }

    this.master._log.debug(
      `Accepted incoming claim from account ${
        this.account.accountName
      } for ${this.master._format(claimIncrement, 'base')}`
    )

    // Start the channel watcher if it wasn't already running
    if (!this.watcher) {
      this.watcher = this.startChannelWatcher()
    }

    return {
      ...updatedChannel,
      tokenContract: claim.tokenContract,
      channelId: claim.channelId,
      contractAddress: claim.contractAddress,
      signature: claim.signature,
      spent: new BigNumber(claim.value)
    }
  }

  // Handle the response from a forwarded ILP PREPARE
  handlePrepareResponse(prepare: IlpPrepare, reply: IlpReply) {
    if (isFulfill(reply)) {
      // Update balance to reflect that we owe them the amount of the FULFILL
      const amount = new BigNumber(prepare.amount)

      this.master._log.debug(
        `Received a FULFILL in response to forwarded PREPARE: credited ${this.master._format(
          amount,
          'account'
        )}`
      )
      this.account.payableBalance = this.account.payableBalance.plus(amount)

      this.sendMoney().catch((err: Error) =>
        this.master._log.debug('Error queueing outgoing settlement: ', err)
      )
    } else if (isReject(reply)) {
      this.master._log.debug(
        `Received a ${reply.code} REJECT in response to the forwarded PREPARE`
      )

      // On T04s, send the most recent claim to the peer in case they didn't get it
      const outgoingChannel = this.account.outgoing.state
      if (reply.code === 'T04' && hasClaim(outgoingChannel)) {
        this.sendClaim(outgoingChannel).catch((err: Error) =>
          this.master._log.debug(
            'Failed to send latest claim to peer on T04 error:',
            err
          )
        )
      }
    }
  }

  private startChannelWatcher() {
    const timer: NodeJS.Timeout = setInterval(async () => {
      const cachedChannel = this.account.incoming.state
      // No channel & claim are linked: stop the channel watcher
      if (!cachedChannel) {
        this.watcher = null
        clearInterval(timer)
        return
      }

      const updatedChannel = await updateChannel(
        await this.master._contract,
        cachedChannel
      )

      // If the channel is closed or closing, then add a task to the queue
      // that will update the channel state (for real) and claim if it's closing
      if (!updatedChannel || isDisputed(updatedChannel)) {
        this.claimIfProfitable(true).catch((err: Error) => {
          this.master._log.debug(
            `Error attempting to claim channel or confirm channel was closed: ${
              err.message
            }`
          )
        })
      }
    }, this.master._channelWatcherInterval.toNumber())

    return timer
  }

  claimIfProfitable(
    requireDisputed = false,
    authorize?: (channel: PaymentChannel, fee: BigNumber) => Promise<void>
  ) {
    return this.account.incoming.add(async cachedChannel => {
      if (!cachedChannel) {
        return cachedChannel
      }

      const updatedChannel = await updateChannel(
        await this.master._contract,
        cachedChannel
      )
      if (!updatedChannel) {
        this.master._log.error(
          `Cannot claim channel ${cachedChannel.channelId} with ${
            this.account.accountName
          }: linked channel is unexpectedly closed`
        )
        return updatedChannel
      }

      const { channelId, spent, signature } = updatedChannel

      if (requireDisputed && !isDisputed(updatedChannel)) {
        this.master._log.debug(
          `Won't claim channel ${updatedChannel.channelId} with ${
            this.account.accountName
          }: channel is not disputed`
        )
        return updatedChannel
      }

      this.master._log.debug(
        `Attempting to claim channel ${channelId} for ${this.master._format(
          updatedChannel.spent,
          'base'
        )}`
      )

      const { sendTransaction, txFee } = await prepareTransaction({
        methodName: 'claim',
        params: [channelId, spent.toString(), signature],
        contract: await this.master._contract,
        gasPrice: await this.master._getGasPrice()
      })

      // Check to verify it's profitable first
      if (authorize) {
        const isAuthorized = await authorize(updatedChannel, txFee)
          .then(() => true)
          .catch(() => false)

        if (!isAuthorized) {
          return updatedChannel
        }
      } else if (txFee.isGreaterThanOrEqualTo(spent)) {
        this.master._log.debug(
          `Not profitable to claim channel ${channelId} with ${
            this.account.accountName
          }: fee of ${this.master._format(
            txFee,
            'base'
          )} is greater than value of ${this.master._format(spent, 'base')}`
        )

        return updatedChannel
      }

      const receipt = await this.master
        ._queueTransaction(sendTransaction)
        .catch(err => {
          this.master._log.error(`Failed to claim channel:`, err)
          throw err
        })

      if (!hasEvent(receipt, 'DidClaim')) {
        throw new Error(`Failed to claim channel ${channelId}`)
      }

      this.master._log.debug(
        `Successfully claimed incoming channel ${channelId} for ${this.master._format(
          spent,
          'base'
        )}`
      )
    }, IncomingTaskPriority.ClaimChannel)
  }

  // Request the peer to claim the outgoing channel
  async requestClose() {
    return this.account.outgoing.add(async cachedChannel => {
      if (!cachedChannel) {
        return
      }

      try {
        await this.sendMessage({
          requestId: await generateBtpRequestId(),
          type: TYPE_MESSAGE,
          data: {
            protocolData: [
              {
                protocolName: 'requestClose',
                contentType: MIME_TEXT_PLAIN_UTF8,
                data: Buffer.alloc(0)
              }
            ]
          }
        })

        const checkForChannelClose = async () =>
          fetchChannelById(await this.master._contract, cachedChannel.channelId)
            .then(channel => !channel)
            .catch(() => false)

        const confirmChannelDidClose = (attempts = 0): Promise<boolean> =>
          checkForChannelClose().then(async isClosed => {
            if (isClosed) {
              return true
            } else if (attempts > 20) {
              return false
            } else {
              await delay(250)
              return confirmChannelDidClose(attempts + 1)
            }
          })

        if (!(await confirmChannelDidClose())) {
          this.master._log.error(
            'Unable to confirm if the peer closed our outgoing channel'
          )
          return cachedChannel
        }

        this.master._log.debug(
          `Peer successfully closed our outgoing channel ${
            cachedChannel.channelId
          }, returning at least ${this.master._format(
            remainingInChannel(cachedChannel),
            'base'
          )} of collateral`
        )
      } catch (err) {
        this.master._log.debug(
          'Error while requesting peer to claim channel:',
          err
        )

        return cachedChannel
      }
    })
  }

  // From mini-accounts: invoked on a websocket close or error event
  // From plugin-btp: invoked *only* when `disconnect` is called on plugin
  async disconnect(): Promise<void> {
    // Only stop the channel watcher if the channels were attempted to be closed
    if (this.watcher) {
      clearInterval(this.watcher)
    }
  }

  unload(): void {
    // Stop the channel watcher
    if (this.watcher) {
      clearInterval(this.watcher)
    }

    // Remove event listeners that persisted updated channels/claims
    this.account.outgoing.removeAllListeners()
    this.account.incoming.removeAllListeners()

    // Remove account from store cache
    this.master._store.unload(`${this.account.accountName}:account`)

    // Garbage collect the account at the top-level
    this.master._accounts.delete(this.account.accountName)
  }
}
