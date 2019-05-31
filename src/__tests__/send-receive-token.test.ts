import { convert, eth, gwei, wei } from '@kava-labs/crypto-rate-utils'
import test from 'ava'
import BigNumber from 'bignumber.js'
import debug from 'debug'
import { ethers } from 'ethers'
import ganache from 'ganache-core'
import getPort from 'get-port'
import createLogger from 'ilp-logger'
import EthereumPlugin from '..'
import TOKEN_UNIDIRECTIONAL from '../abi/TokenUnidirectional.json'
import MINTABLE_TOKEN from 'openzeppelin-solidity/build/contracts/ERC20Mintable.json'

test('tokens can be sent between two peers', async t => {
  const port = await getPort()
  const mnemonic =
    'donate post silk true upset company tourist salt puppy rough base jealous salad caution female'

  const provider = new ethers.providers.Web3Provider(
    ganache.provider({
      mnemonic,
      logger: {
        log: debug('ganache-core')
      }
    })
  )

  const generateWallet = (index = 0) =>
    ethers.Wallet.fromMnemonic(mnemonic, `m/44'/60'/0'/0/${index}`).connect(
      provider
    )

  const clientWallet = generateWallet()
  const serverWallet = generateWallet(1)

  // Deploy TokenUnidirectional
  const machinomyFactory = new ethers.ContractFactory(
    TOKEN_UNIDIRECTIONAL.abi,
    TOKEN_UNIDIRECTIONAL.bytecode,
    clientWallet
  )
  const contractAddress = (await machinomyFactory.deploy()).address

  // Deploy test ERC-20 token contract
  const tokenFactory = new ethers.ContractFactory(
    MINTABLE_TOKEN.abi,
    MINTABLE_TOKEN.bytecode,
    clientWallet
  )
  const tokenContract = await tokenFactory.deploy()

  // Mint test tokens for both accounts (100 units of the token, assuming -18 base)
  await tokenContract.functions.mint(
    await clientWallet.getAddress(),
    new BigNumber(10).exponentiatedBy(20).toString()
  )
  await tokenContract.functions.mint(
    await serverWallet.getAddress(),
    new BigNumber(10).exponentiatedBy(20).toString()
  )

  const clientPlugin = new EthereumPlugin(
    {
      role: 'client',
      server: `btp+ws://:secret@localhost:${port}`,
      ethereumWallet: clientWallet,
      contractAddress,
      tokenAddress: tokenContract.address
    },
    {
      log: createLogger('ilp-plugin-ethereum:client')
    }
  )

  const serverPlugin = new EthereumPlugin(
    {
      role: 'client',
      listener: {
        port,
        secret: 'secret'
      },
      ethereumWallet: serverWallet,
      contractAddress,
      tokenAddress: tokenContract.address
    },
    {
      log: createLogger('ilp-plugin-ethereum:server')
    }
  )

  await Promise.all([serverPlugin.connect(), clientPlugin.connect()])

  const AMOUNT_TO_FUND = convert(eth('0.002'), wei())
  const AMOUNT_TO_DEPOSIT = convert(eth('0.001'), wei())

  const SEND_AMOUNT_1 = convert(eth('0.0023'), gwei())
  const SEND_AMOUNT_2 = convert(eth('0.0005'), gwei())

  const pluginAccount = await clientPlugin._loadAccount('peer')

  // Open a channel
  await t.notThrowsAsync(
    pluginAccount.fundOutgoingChannel(AMOUNT_TO_FUND, () => Promise.resolve()),
    'successfully opens an outgoing chanenl'
  )

  // Deposit to the channel
  await t.notThrowsAsync(
    pluginAccount.fundOutgoingChannel(AMOUNT_TO_DEPOSIT, () =>
      Promise.resolve()
    ),
    'successfully deposits to the outgoing channel'
  )

  // Ensure the initial claim can be accepted
  serverPlugin.deregisterMoneyHandler()
  await new Promise(async resolve => {
    serverPlugin.registerMoneyHandler(async amount => {
      t.true(
        new BigNumber(amount).isEqualTo(SEND_AMOUNT_1),
        'initial claim is sent and validated successfully between two peers'
      )
      resolve()
    })

    await t.notThrowsAsync(clientPlugin.sendMoney(SEND_AMOUNT_1.toString()))
  })

  // Ensure a greater claim can be accepted
  serverPlugin.deregisterMoneyHandler()
  await new Promise(async resolve => {
    serverPlugin.registerMoneyHandler(async amount => {
      t.true(
        new BigNumber(amount).isEqualTo(SEND_AMOUNT_2),
        'better claim is sent and validated successfully between two peers'
      )
      resolve()
    })

    await t.notThrowsAsync(clientPlugin.sendMoney(SEND_AMOUNT_2.toString()))
  })
})
