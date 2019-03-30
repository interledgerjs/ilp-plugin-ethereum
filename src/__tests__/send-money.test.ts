import getPort from 'get-port'
import EthereumPlugin from '..'
import BigNumber from 'bignumber.js'
import test from 'ava'
import createLogger from 'ilp-logger'
import { convert, eth, gwei, wei } from '@kava-labs/crypto-rate-utils'

test('money can be sent between two peers', async t => {
  const port = await getPort()

  const clientPlugin = new EthereumPlugin(
    {
      role: 'client',
      server: `btp+ws://:secret@localhost:${port}`,
      ethereumPrivateKey: process.env.PRIVATE_KEY_A!,
      ethereumProvider: process.env.ETHEREUM_PROVIDER as any
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
      ethereumPrivateKey: process.env.PRIVATE_KEY_B!,
      ethereumProvider: process.env.ETHEREUM_PROVIDER as any
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
