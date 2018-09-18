import Web3 = require('web3')
import * as getPort from 'get-port'
import EthereumPlugin = require('..')
import { convert, Unit } from '../account'
import { getContract, generateTx } from '../utils/contract'
import { Store } from '../utils/store-wrapper'
import test from 'ava'
const MemoryStore = require('ilp-store-memory')

test(`channel watcher claims settling channel if it's profitable`, async t => {
  t.plan(1)

  const web3 = new Web3('wss://ropsten.infura.io/ws')

  const port = await getPort()

  const clientStore = new MemoryStore() as Store
  const clientPlugin = new EthereumPlugin({
    role: 'client',
    ethereumPrivateKey: process.env.PRIVATE_KEY_A!,
    ethereumProvider: 'wss://ropsten.infura.io/ws',
    balance: {
      settleTo: convert('0.01', Unit.Eth, Unit.Gwei),
      settleThreshold: convert('0.000000001', Unit.Eth, Unit.Gwei)
    },
    _store: clientStore,
    // @ts-ignore
    server: `btp+ws://userA:secretA@localhost:${port}`
  })

  const serverPlugin = new EthereumPlugin({
    role: 'server',
    ethereumPrivateKey: process.env.PRIVATE_KEY_B!,
    ethereumProvider: 'wss://ropsten.infura.io/ws',
    channelWatcherInterval: 5000, // Every 5 sec
    // @ts-ignore
    debugHostIldcpInfo: {
      assetCode: 'ETH',
      assetScale: 9,
      clientAddress: 'private.ethereum'
    },
    port
  })

  serverPlugin.registerMoneyHandler(() => Promise.resolve())
  clientPlugin.registerMoneyHandler(() => Promise.resolve())

  await serverPlugin.connect()
  await clientPlugin.connect()

  const channelId = JSON.parse(await clientStore.get('server:account') as string)
    .bestOutgoingClaim.channelId as string

  const contract = await getContract(web3)

  // TODO web3.js beta 36 event bugs: https://github.com/ethereum/web3.js/issues/1916
  // contract.events.DidClaim({
  //   fromBlock: 'latest',
  //   filter: { channelId }
  // }).on('data', () => {
  //   t.pass('successfully claimed settling channel')
  // })

  const address = web3.eth.accounts.wallet.add(process.env.PRIVATE_KEY_A!).address

  const txObj = contract.methods.startSettling(channelId)
  const tx = await generateTx({ web3, txObj, from: address })

  await web3.eth.sendTransaction(tx)

  await new Promise(resolve => {
    setInterval(async () => {
      const wasClaimed = await contract.methods.isAbsent(channelId).call()

      if (wasClaimed) {
        t.pass()
        resolve()
      }
    }, 5000)
  })
})
