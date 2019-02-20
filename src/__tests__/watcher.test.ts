import Web3 from 'web3'
import getPort from 'get-port'
import EthereumPlugin from '..'
import { getContract, prepareTransaction } from '../utils/contract'
import { MemoryStore } from '../utils/store'
import test from 'ava'
import { convert, eth, gwei, wei } from '@kava-labs/crypto-rate-utils'

test(`channel watcher claims settling channel if it's profitable`, async t => {
  t.plan(1)

  const ethereumProvider = new Web3.providers.HttpProvider(
    process.env.ETHEREUM_PROVIDER!
  )
  const web3 = new Web3(ethereumProvider)

  const port = await getPort()

  const clientStore = new MemoryStore()
  const clientPlugin = new EthereumPlugin(
    {
      role: 'client',
      ethereumPrivateKey: process.env.PRIVATE_KEY_A!,
      ethereumProvider,
      server: `btp+ws://userA:secretA@localhost:${port}`
    },
    {
      store: clientStore
    }
  )

  const serverStore = new MemoryStore()
  const createServer = async (): Promise<EthereumPlugin> => {
    const serverPlugin = new EthereumPlugin(
      {
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
      },
      {
        store: serverStore
      }
    )

    serverPlugin.registerMoneyHandler(() => Promise.resolve())
    await serverPlugin.connect()

    return serverPlugin
  }

  const serverPlugin = await createServer()
  await clientPlugin.connect()

  // Create channel & send claim to server
  const pluginAccount = await clientPlugin._loadAccount('peer')
  await pluginAccount.fundOutgoingChannel(convert(eth('0.0015'), wei()))
  await clientPlugin.sendMoney(convert(eth('0.0015'), gwei()).toString())

  // Wait for claims to finish processing
  await new Promise(r => setTimeout(r, 2000))

  // Disconnect the client & server, then start settling the channel
  await clientPlugin.disconnect()
  await serverPlugin.disconnect()

  const channelId = JSON.parse((await clientStore.get(
    'peer:account'
  )) as string).outgoing.channelId as string

  const contract = await getContract(web3)

  contract.events
    .DidClaim({
      fromBlock: 'latest',
      filter: { channelId }
    })
    .on('data', () => t.pass('successfully claimed settling channel'))

  const address = web3.eth.accounts.wallet.add(process.env.PRIVATE_KEY_A!)
    .address

  const txObj = contract.methods.startSettling(channelId)
  const gasPrice = await web3.eth.getGasPrice()
  const { sendTransaction } = await prepareTransaction({
    gasPrice,
    txObj,
    from: address
  })

  await sendTransaction()

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
