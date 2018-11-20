import Web3 from 'web3'
import { TransactionObject } from 'web3/eth/types'
import BigNumber from 'bignumber.js'
import { randomBytes } from 'crypto'
import { promisify } from 'util'
import IContract from 'web3/eth/contract'

import UNIDIRECTIONAL_MAINNET from '../abi/Unidirectional-mainnet.json'
import UNIDIRECTIONAL_TESTNET from '../abi/Unidirectional-testnet.json'

const NETWORKS: {
  [index: number]: INetwork
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

export interface INetwork {
  unidirectional: {
    address: string
    abi: typeof UNIDIRECTIONAL_MAINNET | typeof UNIDIRECTIONAL_TESTNET
  }
}

export interface IChannel {
  channelId: string
  receiver: string
  sender: string
  value: BigNumber
  settlingPeriod: BigNumber
  // settlingUntil is defined if channel is settling; otherwise, the channel is open
  settlingUntil?: BigNumber
}

export interface IClaim {
  channelId: string,
  value: string,
  signature: string
}

export interface ITx {
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

export const getNetwork = async (web3: Web3): Promise<INetwork> => {
  const chainId = await web3.eth.net.getId()
  const network = NETWORKS[chainId]

  if (!network) {
    throw new Error('Machinomy is not supported on the current network')
  }

  return network
}

export const getContract = (web3: Web3, network: INetwork) => {
  return new web3.eth.Contract(
    network.unidirectional.abi,
    network.unidirectional.address
  )
}

export const fetchChannel = async (contract: IContract, channelId: string): Promise<IChannel | undefined> => {
  try {
    let {
      sender, receiver, settlingUntil, settlingPeriod, value
    } = await contract.methods.channels(channelId).call()

    // Minimic the check done at the contract level (check for empty address 0x00000...)
    if (new BigNumber(sender).isZero()) {
      return
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
}): Promise<ITx> => {
  const tx = {
    from,
    data: txObj.encodeABI(),
    value: '0x' + new BigNumber(value).toString(16)
  }

  const gasPrice = await web3.eth.getGasPrice()
  const gas = await txObj.estimateGas(tx)

  return { ...tx, gas, gasPrice }
}

export const isSettling = (channel: IChannel): boolean =>
  !!channel.settlingUntil
