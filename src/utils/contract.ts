import BigNumber from 'bignumber.js'
import { Secp256k1 } from 'bitcoin-ts'
import { randomBytes } from 'crypto'
import { Contract, ethers } from 'ethers'
import { promisify } from 'util'
import UNIDIRECTIONAL_MAINNET from '../abi/Unidirectional-mainnet.json'
import UNIDIRECTIONAL_TESTNET from '../abi/Unidirectional-testnet.json'

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

export const getContract = async (wallet: ethers.Wallet) => {
  const { chainId, name } = await wallet.provider.getNetwork()

  const contractMetadata = CONTRACT_METADATA[chainId]

  if (!contractMetadata) {
    throw new Error(`Machinomy is not supported on ${name}`)
  }

  return new ethers.Contract(
    contractMetadata.unidirectional.address,
    contractMetadata.unidirectional.abi,
    wallet
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
  } = await contract.functions.channels(channelId)

  if (sender === ethers.constants.AddressZero) {
    return
  }

  // In contract, `settlingUntil` should be positive if settling, 0 if open (contract checks if settlingUntil != 0)
  const disputedUntil = settlingUntil.gt(0)
    ? new BigNumber(settlingUntil.toString())
    : undefined

  return {
    lastUpdated: Date.now(),
    contractAddress: contract.address,
    channelId,
    receiver,
    sender,
    disputedUntil,
    disputePeriod: new BigNumber(settlingPeriod.toString()),
    value: new BigNumber(value.toString()),
    spent: new BigNumber(0)
  }
}

export const prepareTransaction = async ({
  methodName,
  params,
  contract,
  gasPrice,
  value = 0
}: {
  methodName: string
  params: any[]
  contract: ethers.Contract
  gasPrice: BigNumber.Value
  value?: BigNumber.Value
}): Promise<{
  txFee: BigNumber
  sendTransaction: () => Promise<void>
}> => {
  const overrides = {
    value: ethers.utils.bigNumberify(value.toString()),
    gasPrice: ethers.utils.bigNumberify(gasPrice.toString())
  }

  const gasLimit = await contract.estimate[methodName](...params, overrides)

  const txFee = new BigNumber(gasPrice).times(gasLimit.toString())

  return {
    txFee,
    sendTransaction: async () => {
      const tx: ethers.ContractTransaction = await contract.functions[
        methodName
      ](...params, {
        ...overrides,
        gasLimit
      })

      // Wait 1 confirmation
      const receipt = await tx.wait(1)

      /**
       * Per EIP 658, a receipt of 1 indicates the tx was successful:
       * https://github.com/Arachnid/EIPs/blob/d1ae915d079293480bd6abb0187976c230d57903/EIPS/eip-658.md
       */
      if (receipt.status !== 1) {
        throw new Error('Ethereum transaction reverted by the EVM')
      }
    }
  }
}

export const hasClaim = (
  channel?: PaymentChannel
): channel is ClaimablePaymentChannel => !!channel && !!channel.signature

export const spentFromChannel = (channel?: PaymentChannel): BigNumber =>
  channel ? channel.spent : new BigNumber(0)

export const remainingInChannel = (channel?: PaymentChannel): BigNumber =>
  channel ? channel.value.minus(channel.spent) : new BigNumber(0)

export const isDisputed = (channel: PaymentChannel): boolean =>
  !!channel.disputedUntil

export const isValidClaimSignature = (secp256k1: Secp256k1) => (
  claim: SerializedClaim,
  channel: PaymentChannel
): boolean => {
  const signature = claim.signature.slice(0, -2) // Remove recovery param from end
  const signatureBuffer = hexToBuffer(signature)

  const v = claim.signature.slice(-2)
  const recoveryId = v === '1c' ? 1 : 0

  const publicKey = secp256k1.recoverPublicKeyUncompressed(
    signatureBuffer,
    recoveryId,
    createPaymentDigest(claim.contractAddress, claim.channelId, claim.value)
  )

  const senderAddress = ethers.utils.computeAddress(publicKey)
  return senderAddress.toLowerCase() === channel.sender.toLowerCase()
}

export const createPaymentDigest = (
  contractAddress: string,
  channelId: string,
  value: string
): Buffer => {
  const paymentDigest = ethers.utils.solidityKeccak256(
    ['address', 'bytes32', 'uint256'],
    [contractAddress, channelId, value]
  )
  const paymentDigestBuffer = hexToBuffer(paymentDigest)

  // Prefix with `\x19Ethereum Signed Message\n`, encode packed, and hash using keccak256 again
  const prefixedPaymentDigest = ethers.utils.hashMessage(paymentDigestBuffer)
  return hexToBuffer(prefixedPaymentDigest)
}

export const hexToBuffer = (hexString: string) =>
  Buffer.from(stripHexPrefix(hexString), 'hex')

const stripHexPrefix = (hexString: string) =>
  hexString.startsWith('0x') ? hexString.slice(2) : hexString
