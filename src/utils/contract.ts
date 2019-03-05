import BigNumber from 'bignumber.js'
import { randomBytes } from 'crypto'
import { promisify } from 'util'
import Web3 from 'web3'
import Contract from 'web3/eth/contract'
import { TransactionObject } from 'web3/eth/types'
import UNIDIRECTIONAL_MAINNET from '../abi/Unidirectional-mainnet.json'
import UNIDIRECTIONAL_TESTNET from '../abi/Unidirectional-testnet.json'
import { TransactionReceipt } from 'web3/types'
import { keccak256 } from 'js-sha3'
import { recover } from 'eth-crypto'

const CONTRACT_METADATA: {
  [index: number]: {
    unidirectional: {
      address: string
      abi: typeof UNIDIRECTIONAL_MAINNET | typeof UNIDIRECTIONAL_TESTNET
    }
  }
} = {
  /** Mainnet */
  1: {
    unidirectional: {
      abi: UNIDIRECTIONAL_MAINNET,
      address: '0x08e4f70109ccc5135f50cc359d24cb7686247df4'
    }
  },
  /** Ropsten (cross-client PoW) */
  3: {
    unidirectional: {
      abi: UNIDIRECTIONAL_TESTNET,
      address: '0x8ffdea290f4dcdc553841a432e56aa26c91ab777'
    }
  },
  /** Rinkeby (Geth PoA) */
  4: {
    unidirectional: {
      abi: UNIDIRECTIONAL_TESTNET,
      address: '0x71ed284ea8e26e14b8f2d9b98ce4eff5a1f25120'
    }
  },
  /** Kovan (Parity PoA) */
  42: {
    unidirectional: {
      abi: UNIDIRECTIONAL_TESTNET,
      address: '0x481029bf134710832f5b9debdd10275fb7816f59'
    }
  }
}

export interface PaymentChannel {
  /** UNIX timestamp in milliseconds when channel state was last fetched */
  lastUpdated: number
  /** Unique identifier on contract for this specific channel */
  channelId: string
  /** Ethereum address of the receiver in the channel */
  receiver: string
  /** Ethereum address of the sender in the channel */
  sender: string
  /** Total collateral the sender added to the channel */
  value: BigNumber
  /**
   * Number of blocks between the beginning of the dispute period and when
   * the sender could sweep the channel, if the receiver did not claim it
   */
  disputePeriod: BigNumber
  /**
   * Block number when the sender can end the dispute to get all their money back
   * - Only defined if a dispute period is active
   */
  disputedUntil?: BigNumber
  /** Ethereum address of the contract the channel is created on */
  contractAddress: string
  /**
   * Value of the claim/amount that can be claimed
   * - If no claim signature is included, the value defaults to 0
   */
  spent: BigNumber
  /** Valid signature to claim the channel */
  signature?: string
}

export interface ClaimablePaymentChannel extends PaymentChannel {
  /** Valid signature to claim the channel */
  signature: string
}

export interface SerializedClaim {
  contractAddress: string
  channelId: string
  signature: string
  value: string
}

// TODO The param isn't really a PaymentChannel; it's serialized so all the bignumbers are strings
export const deserializePaymentChannel = <
  TPaymentChannel extends PaymentChannel
>(
  channel: TPaymentChannel
): TPaymentChannel => ({
  ...channel,
  value: new BigNumber(channel.value),
  disputePeriod: new BigNumber(channel.disputePeriod),
  disputedUntil: channel.disputedUntil
    ? new BigNumber(channel.disputedUntil)
    : channel.disputedUntil,
  spent: new BigNumber(channel.spent)
})

export const generateChannelId = async () =>
  '0x' + (await promisify(randomBytes)(32)).toString('hex')

export const getContract = async (web3: Web3) => {
  const chainId = await web3.eth.net.getId()
  const contractMetadata = CONTRACT_METADATA[chainId]

  if (!contractMetadata) {
    throw new Error('Machinomy is not supported on the current chain')
  }

  return new web3.eth.Contract(
    contractMetadata.unidirectional.abi,
    contractMetadata.unidirectional.address
  )
}

// TODO Add sanity checks to ensure it's *actually* the same channel?
// TODO Is this essentially, update paychan *with* claim, whereas fetch channel is update paychan *without* claim?
export const updateChannel = async <TPaymentChannel extends PaymentChannel>(
  contract: Contract,
  cachedChannel: TPaymentChannel
): Promise<TPaymentChannel | undefined> =>
  fetchChannel(contract, cachedChannel.channelId)
    .then(
      updatedChannel =>
        updatedChannel && {
          ...cachedChannel,
          ...updatedChannel,
          spent: cachedChannel.spent,
          signature: cachedChannel.signature
        }
    )
    .catch(() => cachedChannel)

export const fetchChannel = async (
  contract: Contract,
  channelId: string
): Promise<PaymentChannel | undefined> => {
  let {
    sender,
    receiver,
    settlingUntil,
    settlingPeriod,
    value
  } = await contract.methods.channels(channelId).call()

  // Minimic the check done at the contract level (check for empty address 0x00000...)
  if (new BigNumber(sender).isZero()) {
    return
  }

  // In contract, `settlingUntil` should be positive if settling, 0 if open (contract checks if settlingUntil != 0)
  const disputedUntil =
    settlingUntil !== '0' ? new BigNumber(settlingUntil) : undefined

  return {
    lastUpdated: Date.now(),
    contractAddress: contract.options.address,
    channelId,
    receiver,
    sender,
    disputedUntil,
    disputePeriod: new BigNumber(settlingPeriod),
    value: new BigNumber(value),
    spent: new BigNumber(0)
  }
}

export const prepareTransaction = async ({
  txObj,
  from,
  gasPrice,
  value = 0
}: {
  txObj: TransactionObject<any>
  from: string
  gasPrice: number
  value?: BigNumber.Value
}): Promise<{
  txFee: BigNumber
  sendTransaction: () => Promise<void>
}> => {
  const tx = {
    from,
    data: txObj.encodeABI(),
    value: '0x' + new BigNumber(value).toString(16)
  }
  const gas = await txObj.estimateGas(tx)
  const txFee = new BigNumber(gas).times(gasPrice)

  return {
    txFee,
    sendTransaction: () => {
      const emitter = txObj.send({
        ...tx,
        gasPrice,
        gas
      })

      return new Promise<void>((resolve, reject) => {
        emitter.on(
          'confirmation',
          (confNumber: number, receipt: TransactionReceipt) => {
            if (!receipt.status) {
              reject(new Error('Ethereum transaction reverted by the EVM'))
            } else if (confNumber >= 1) {
              resolve()
            }
          }
        )

        emitter.on('error', (err: Error) => {
          reject(err)
        })
      }).finally(() => {
        // @ts-ignore
        emitter.removeAllListeners()
      })
    }
  }
}

export const spentFromChannel = (channel?: PaymentChannel): BigNumber =>
  channel ? channel.spent : new BigNumber(0)

export const remainingInChannel = (channel?: PaymentChannel): BigNumber =>
  channel ? channel.value.minus(channel.spent) : new BigNumber(0)

export const isDisputed = (channel: PaymentChannel): boolean =>
  !!channel.disputedUntil

export const isValidClaimSignature = (
  claim: SerializedClaim,
  channel: PaymentChannel
): boolean => {
  const senderAddress = recover(
    claim.signature,
    createPaymentDigest(claim.contractAddress, claim.channelId, claim.value)
  )

  return senderAddress.toLowerCase() === channel.sender.toLowerCase()
}

export const createPaymentDigest = (
  contractAddress: string,
  channelId: string,
  value: string
) => {
  const paymentDigest = Web3.utils.soliditySha3(
    contractAddress,
    channelId,
    value
  )

  const paymentDigestBuffer = Buffer.from(Web3.utils.hexToBytes(paymentDigest))

  const prefixedPaymentDigest = Buffer.concat([
    Buffer.from(SIGNED_MESSAGE_PREFIX),
    paymentDigestBuffer
  ])

  return keccak256(prefixedPaymentDigest)
}

export const SIGNED_MESSAGE_PREFIX = '\x19Ethereum Signed Message:\n32'
