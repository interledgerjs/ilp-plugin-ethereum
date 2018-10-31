import Web3 = require('web3')
import * as getPort from 'get-port'
import EthereumPlugin from '..'
import { convert, Unit } from '../account'
import { getContract, generateTx } from '../utils/contract'
import { MemoryStore } from '../utils/store'
import test from 'ava'

test(`channel watcher claims settling channel if it's profitable`, async t => {
  t.plan(1)

  const web3 = new Web3(process.env.ETHEREUM_PROVIDER!)

  const port = await (getPort() as Promise<number>)

  const clientStore = new MemoryStore()
  const clientPlugin = new EthereumPlugin({
    role: 'client',
    ethereumPrivateKey: process.env.PRIVATE_KEY_A!,
    ethereumProvider: process.env.ETHEREUM_PROVIDER!,
    balance: {
      settleTo: convert('0.01', Unit.Eth, Unit.Gwei),
      settleThreshold: convert('0.000000001', Unit.Eth, Unit.Gwei)
    },
    // @ts-ignore
    server: `btp+ws://userA:secretA@localhost:${port}`
  }, {
    store: clientStore
  })

  const serverPlugin = new EthereumPlugin({
    role: 'server',
    ethereumPrivateKey: process.env.PRIVATE_KEY_B!,
    ethereumProvider: process.env.ETHEREUM_PROVIDER!,
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
    const interval = setInterval(async () => {
      const wasClaimed = await contract.methods.isAbsent(channelId).call()

      if (wasClaimed) {
        clearInterval(interval)
        t.pass()
        resolve()
      }
    }, 5000)
  })
})
