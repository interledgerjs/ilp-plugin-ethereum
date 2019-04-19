import getPort from 'get-port'
import EthereumPlugin from '..'
import { prepareTransaction } from '../utils/channel'
import { MemoryStore } from '../utils/store'
import test from 'ava'
import { convert, eth, gwei, wei } from '@kava-labs/crypto-rate-utils'

test(`channel watcher claims settling channel if it's profitable`, async t => {
  t.plan(1)

  const port = await getPort()

  const clientStore = new MemoryStore()
  const clientPlugin = new EthereumPlugin(
    {
      role: 'client',
      ethereumPrivateKey: process.env.PRIVATE_KEY_A!,
      ethereumProvider: process.env.ETHEREUM_PROVIDER as any,
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
        ethereumProvider: process.env.ETHEREUM_PROVIDER as any,
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

  const { sendTransaction } = await prepareTransaction({
    methodName: 'startSettling',
    params: [channelId],
    contract: await clientPlugin._contract,
    gasPrice: await clientPlugin._getGasPrice()
  })

  await sendTransaction()

  // Start the server back up to make sure the channel watcher claims the channel
  await createServer()

  await new Promise(resolve => {
    const interval = setInterval(async () => {
      const contract = await serverPlugin._contract
      const wasClaimed = await contract.functions.isAbsent(channelId)

      if (wasClaimed) {
        clearInterval(interval)
        t.pass()
        resolve()
      }
    }, 5000)
  })
})
