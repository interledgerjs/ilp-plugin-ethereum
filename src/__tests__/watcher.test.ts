import Web3 from 'web3'
import getPort from 'get-port'
import EthereumPlugin from '..'
import { convert, Unit } from '../account'
import { getContract, generateTx, getNetwork } from '../utils/contract'
import { MemoryStore } from '../utils/store'
import test from 'ava'

test(`channel watcher claims settling channel if it's profitable`, async t => {
  t.plan(1)

  const ethereumProvider = new Web3.providers.HttpProvider(process.env.ETHEREUM_PROVIDER!)
  const web3 = new Web3(ethereumProvider)

  const port = await (getPort() as Promise<number>)

  const clientStore = new MemoryStore()
  const clientPlugin = new EthereumPlugin({
    role: 'client',
    ethereumPrivateKey: process.env.PRIVATE_KEY_A!,
    ethereumProvider,
    balance: {
      settleTo: convert('0.01', Unit.Eth, Unit.Gwei),
      settleThreshold: convert('0.000000001', Unit.Eth, Unit.Gwei)
    },
    server: `btp+ws://userA:secretA@localhost:${port}`,
    // Don't ask the server to claim on disconnect
    closeOnDisconnect: false
  }, {
    store: clientStore
  })

  const serverStore = new MemoryStore()
  const createServer = async (): Promise<EthereumPlugin> => {
    const serverPlugin = new EthereumPlugin({
      role: 'server',
      ethereumPrivateKey: process.env.PRIVATE_KEY_B!,
      ethereumProvider,
      channelWatcherInterval: 5000, // Every 5 sec
      debugHostIldcpInfo: {
        assetCode: 'ETH',
        assetScale: 9,
        clientAddress: 'private.ethereum'
      },
      port
    }, {
      store: serverStore
    })

    serverPlugin.registerMoneyHandler(() => Promise.resolve())
    await serverPlugin.connect()

    return serverPlugin
  }

  const serverPlugin = await createServer()

  // Create channel & send claim to server
  clientPlugin.registerMoneyHandler(() => Promise.resolve())
  await clientPlugin.connect()

  // Wait for claims to finish processing
  await new Promise(r => setTimeout(r, 5000))

  // Disconnect the client & server, then start settling the channel
  await clientPlugin.disconnect()
  await serverPlugin.disconnect()

  const channelId = JSON.parse(await clientStore.get('peer:account') as string)
    .bestOutgoingClaim.channelId as string

  const network = await getNetwork(web3)
  const contract = getContract(web3, network)

  contract.events.DidClaim({
    fromBlock: 'latest',
    filter: { channelId }
  }).on('data', () =>
    t.pass('successfully claimed settling channel')
  )

  const address = web3.eth.accounts.wallet.add(process.env.PRIVATE_KEY_A!).address

  const txObj = contract.methods.startSettling(channelId)
  const gasPrice = await web3.eth.getGasPrice()
  const tx = await generateTx({ gasPrice, txObj, from: address })

  await web3.eth.sendTransaction(tx)

  // Start the server back up to make sure the channel watcher claims the channel
  await createServer()

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
