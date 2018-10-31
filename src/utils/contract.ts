import Web3 = require('web3')
import { TransactionObject } from 'web3/eth/types'
import BigNumber from 'bignumber.js'
import { randomBytes } from 'crypto'
import { promisify } from 'util'

import * as UNIDIRECTIONAL_MAINNET from '../abi/Unidirectional-mainnet.json'
import * as UNIDIRECTIONAL_TESTNET from '../abi/Unidirectional-testnet.json'

const NETWORKS: {
  [index: number]: Network
} = {
  // Mainnet
  1: {
    unidirectional: {
      abi: UNIDIRECTIONAL_MAINNET,
      address: '0x08e4f70109ccc5135f50cc359d24cb7686247df4'
    }
  },
  // Ropsten (cross-client PoW)
  3: {
    unidirectional: {
      abi: UNIDIRECTIONAL_TESTNET,
      address: '0x8ffdea290f4dcdc553841a432e56aa26c91ab777'
    }
  },
  // Rinkeby (Geth PoA)
  4: {
    unidirectional: {
      abi: UNIDIRECTIONAL_TESTNET,
      address: '0x71ed284ea8e26e14b8f2d9b98ce4eff5a1f25120'
    }
  },
  // Kovan (Parity PoA)
  42: {
    unidirectional: {
      abi: UNIDIRECTIONAL_TESTNET,
      address: '0x481029bf134710832f5b9debdd10275fb7816f59'
    }
  }
}

export interface Network {
  unidirectional: {
    address: string
    abi: typeof UNIDIRECTIONAL_MAINNET | typeof UNIDIRECTIONAL_TESTNET
  }
}

export interface Channel {
  channelId: string
  receiver: string
  sender: string
  settlingPeriod: BigNumber
  // settlingUntil is defined if channel is settling; otherwise, the channel is open
  settlingUntil?: BigNumber
  value: BigNumber
}

export interface Claim {
  channelId: string,
  value: string,
  signature: string
}

export interface Tx {
  nonce?: string | number
  chainId?: string | number
  to?: string
  from: string
  data: string
  value: string | number
  gas: string | number
  gasPrice: string | number
}

export const generateChannelId = async () =>
  '0x' + (await promisify(randomBytes)(32)).toString('hex')

export const getNetwork = async (web3: Web3): Promise<Network> => {
  const chainId = await web3.eth.net.getId()
  const network = NETWORKS[chainId]

  if (!network) {
    throw new Error('Machinomy is not supported on the current network')
  }

  return network
}

export const getContract = async (web3: Web3) => {
  const network = await getNetwork(web3)
  return new web3.eth.Contract(
    network.unidirectional.abi,
    network.unidirectional.address
  )
}

export const fetchChannel = async (web3: Web3, channelId: string): Promise<Channel | null> => {
  try {
    const contract = await getContract(web3)
    let {
      sender, receiver, settlingUntil, settlingPeriod, value
    } = await contract.methods.channels(channelId).call()

    // Minimic the check done at the contract level (check for empty address 0x00000...)
    if (web3.utils.toBN(sender).isZero()) {
      return null
    }

    // In contract, `settlingUntil` should be positive if settling, 0 if open (contract checks if settlingUntil != 0)
    settlingUntil = settlingUntil !== '0'
      ? new BigNumber(settlingUntil)
      : undefined

    return {
      channelId,
      receiver,
      sender,
      settlingUntil,
      settlingPeriod: new BigNumber(settlingPeriod),
      value: new BigNumber(value)
    }
  } catch (err) {
    throw new Error(`Failed to fetch channel details: ${err.message}`)
  }
}

export const generateTx = async ({ web3, txObj, from, value = 0 }: {
  web3: Web3
  txObj: TransactionObject<any>
  from: string
  value?: BigNumber.Value
}): Promise<Tx> => {
  const tx = {
    from,
    data: txObj.encodeABI(),
    value: '0x' + new BigNumber(value).toString(16)
  }

  const gasPrice = await web3.eth.getGasPrice()
  const gas = await txObj.estimateGas(tx)

  return { ...tx, gas, gasPrice }
}

export const isSettling = (channel: Channel): boolean =>
  !!channel.settlingUntil
