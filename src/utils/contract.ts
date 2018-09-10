import Web3 = require('web3')
import { TransactionObject } from 'web3/eth/types'
const Unidirectional = require('@machinomy/contracts/build/contracts/Unidirectional.json')
import BigNumber from 'bignumber.js'
import { randomBytes } from 'crypto'
import { promisify } from 'util'

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

export const generateChannelId = async () =>
  '0x' + (await promisify(randomBytes)(32)).toString('hex')

export const getContractAddress = async (web3: Web3): Promise<string> => {
  const chainId = await web3.eth.net.getId()
  const network = Unidirectional.networks[chainId]

  if (!network || !network.address) {
    throw new Error('Machinomy is not supported on the current network')
  }

  return network.address
}

export const getContract = async (web3: Web3) => {
  return new web3.eth.Contract(Unidirectional.abi, await getContractAddress(web3))
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
