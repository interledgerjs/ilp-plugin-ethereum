import BigNumber from 'bignumber.js'
import { Secp256k1 } from 'bitcoin-ts'
import { randomBytes } from 'crypto'
import { Contract, ethers } from 'ethers'
import { promisify } from 'util'
import UNIDIRECTIONAL_MAINNET from '../abi/Unidirectional-mainnet.json'
import UNIDIRECTIONAL_TESTNET from '../abi/Unidirectional-testnet.json'
import TOKEN_UNIDIRECTIONAL from '../abi/TokenUnidirectional.json'
import { ContractReceipt } from 'ethers/contract'

const UNIDIRECTIONAL_METADATA: {
  [index: number]: {
    address: string
    metadata: typeof UNIDIRECTIONAL_MAINNET | typeof UNIDIRECTIONAL_TESTNET
  }
} = {
  /** Mainnet */
  1: {
    metadata: UNIDIRECTIONAL_MAINNET,
    address: '0x08e4f70109ccc5135f50cc359d24cb7686247df4'
  },
  /** Ropsten (cross-client PoW) */
  3: {
    metadata: UNIDIRECTIONAL_TESTNET,
    address: '0x8ffdea290f4dcdc553841a432e56aa26c91ab777'
  },
  /** Rinkeby (Geth PoA) */
  4: {
    metadata: UNIDIRECTIONAL_TESTNET,
    address: '0x71ed284ea8e26e14b8f2d9b98ce4eff5a1f25120'
  },
  /** Kovan (Parity PoA) */
  42: {
    metadata: UNIDIRECTIONAL_TESTNET,
    address: '0x481029bf134710832f5b9debdd10275fb7816f59'
  }
}

const TOKEN_UNIDIRECTIONAL_METADATA: {
  [index: number]: {
    address: string
    metadata: typeof TOKEN_UNIDIRECTIONAL
  }
} = {
  /** Ropsten (cross-client PoW) */
  3: {
    metadata: TOKEN_UNIDIRECTIONAL,
    address: '0xf55cf03626dc6d6fdd9e97f88aace0b2ecae34c1'
  },
  /** Rinkeby (Geth PoA) */
  4: {
    metadata: TOKEN_UNIDIRECTIONAL,
    address: '0x7660f4fb856c0dcf07439d93ec3fe3f438960b89'
  },
  /** Kovan (Parity PoA) */
  42: {
    metadata: TOKEN_UNIDIRECTIONAL,
    address: '0x396317f2ea46a1cea58a58d44d2d902f1a257588'
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
   * Address of the ERC-20 token contract to use for the token in the payment channel
   * - Only defined if this uses the TokenUnidirectional contract for ERC-20s
   */
  tokenContract?: string

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
  tokenContract?: string
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

/** TODO Should you be able to specify custom ABIs, addresses or contract instances? */
export const getContract = async (
  signer: ethers.Signer,
  useTokenContract = false,
  contractAddress?: string
) => {
  let contractMetadata

  if (signer.provider) {
    const { chainId } = await signer.provider.getNetwork()

    contractMetadata = useTokenContract
      ? TOKEN_UNIDIRECTIONAL_METADATA[chainId]
      : UNIDIRECTIONAL_METADATA[chainId]
  }

  if (!contractMetadata) {
    if (contractAddress) {
      // Default to using the testnet ABI
      contractMetadata = useTokenContract
        ? {
            metadata: TOKEN_UNIDIRECTIONAL,
            address: contractAddress
          }
        : {
            metadata: UNIDIRECTIONAL_TESTNET,
            address: contractAddress
          }
    } else {
      throw new Error(
        `Machinomy is not supported on the current Ethereum chain`
      )
    }
  }

  return new ethers.Contract(
    contractMetadata.address,
    contractMetadata.metadata.abi,
    signer
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

// TODO Rename to "fetchChannelById" ??
export const fetchChannel = async (
  contract: Contract,
  channelId: string
): Promise<PaymentChannel | undefined> => {
  let {
    sender,
    receiver,
    settlingUntil,
    settlingPeriod,
    value,
    tokenContract
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
    spent: new BigNumber(0),
    tokenContract
  }
}

export const prepareTransaction = async ({
  methodName,
  params,
  contract,
  gasPrice,
  gasLimit,
  value = 0
}: {
  methodName: string
  params: any[]
  contract: ethers.Contract
  gasPrice: BigNumber.Value
  gasLimit?: BigNumber.Value
  value?: BigNumber.Value
}): Promise<{
  txFee: BigNumber
  sendTransaction: () => Promise<ContractReceipt>
}> => {
  const overrides = {
    value: ethers.utils.bigNumberify(value.toString()),
    gasPrice: ethers.utils.bigNumberify(gasPrice.toString())
  }

  const estimatedGasLimit: ethers.utils.BigNumber = gasLimit
    ? ethers.utils.bigNumberify(gasLimit.toString())
    : await contract.estimate[methodName](...params, overrides)

  const txFee = new BigNumber(gasPrice).times(estimatedGasLimit.toString())

  return {
    txFee,
    sendTransaction: async () => {
      const tx: ethers.ContractTransaction = await contract.functions[
        methodName
      ](...params, {
        ...overrides,
        gasLimit: estimatedGasLimit
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

      return receipt
    }
  }
}

/**
 * Does the transaction receipt include an event with the given name?
 * @param receipt Receipt from a transaction on a contract
 * @param eventName Name of the contract event to check
 */
export const hasEvent = (
  receipt: ContractReceipt,
  eventName: string
): boolean =>
  !receipt.events || receipt.events.map(o => o.event).includes(eventName)

/**
 * Does the given payemnt channel include a claim to withdraw funds on the blockchain?
 * @param channel Payment channel state
 */
export const hasClaim = (
  channel?: PaymentChannel
): channel is ClaimablePaymentChannel => !!channel && !!channel.signature

/**
 * What amount in the payment channel as been sent to the receiver?
 * @param channel Payment channel state
 */
export const spentFromChannel = (channel?: PaymentChannel): BigNumber =>
  channel ? channel.spent : new BigNumber(0)

/**
 * What amount in the payment channel is still escrowed in our custody, available to send?
 * @param channel Payment channel state
 */
export const remainingInChannel = (channel?: PaymentChannel): BigNumber =>
  channel ? channel.value.minus(channel.spent) : new BigNumber(0)

/**
 * Has the sender of the payment channel initiated a dispute period?
 * @param channel Payment channel state
 */
export const isDisputed = (channel: PaymentChannel): boolean =>
  !!channel.disputedUntil

/**
 * TODO asdklfjasf
 * @param secp256k1 TODO adsfadsf
 */
export const isValidClaimSignature = (secp256k1: Secp256k1) => (
  claim: SerializedClaim,
  expectedSenderAddress: string
): boolean => {
  const signature = claim.signature.slice(0, -2) // Remove recovery param from end
  const signatureBuffer = hexToBuffer(signature)

  const v = claim.signature.slice(-2)
  const recoveryId = v === '1c' ? 1 : 0

  let publicKey: Uint8Array
  try {
    publicKey = secp256k1.recoverPublicKeyUncompressed(
      signatureBuffer,
      recoveryId,
      createPaymentDigest(
        claim.contractAddress,
        claim.channelId,
        claim.value,
        claim.tokenContract
      )
    )
  } catch (err) {
    return false
  }

  const senderAddress = ethers.utils.computeAddress(publicKey)
  return senderAddress.toLowerCase() === expectedSenderAddress.toLowerCase()
}

/**
 * TODO
 * @param contractAddress TODO
 * @param channelId TODO
 * @param value TODO
 * @param tokenContract TODO
 */
export const createPaymentDigest = (
  contractAddress: string,
  channelId: string,
  value: string,
  tokenContract?: string
): Buffer => {
  const paramTypes = ['address', 'bytes32', 'uint256']
  const paramValues = [contractAddress, channelId, value]

  // ERC-20 claims must also encode the token contract address at the end
  if (tokenContract) {
    paramTypes.push('address')
    paramValues.push(tokenContract)
  }

  const paymentDigest = ethers.utils.solidityKeccak256(paramTypes, paramValues)
  const paymentDigestBuffer = hexToBuffer(paymentDigest)

  // Prefix with `\x19Ethereum Signed Message\n`, encode packed, and hash using keccak256 again
  const prefixedPaymentDigest = ethers.utils.hashMessage(paymentDigestBuffer)
  return hexToBuffer(prefixedPaymentDigest)
}

/**
 * Convert the given hexadecimal string to a Buffer
 * @param hexString Hexadecimal string, which may optionally begin with "0x"
 */
export const hexToBuffer = (hexString: string) =>
  Buffer.from(stripHexPrefix(hexString), 'hex')

/**
 * If the given string begins with "0x", remove it
 * @param hexString Hexadecimal string, which may optionally begin with "0x"
 */
const stripHexPrefix = (hexString: string) =>
  hexString.startsWith('0x') ? hexString.slice(2) : hexString
