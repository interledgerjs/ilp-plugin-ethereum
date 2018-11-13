import {
  createConnection,
  createServer,
  DataAndMoneyStream
} from 'ilp-protocol-stream'
import getPort from 'get-port'
import EthereumPlugin from '..'
import { convert, Unit } from '../account'
import BigNumber from 'bignumber.js'
import test from 'ava'
import Web3 from 'web3'

test('client streams data and money to server', async t => {
  const AMOUNT_TO_SEND = convert('0.0023', Unit.Eth, Unit.Gwei)
  const SENDER_MAX_PREFUND = convert('0.001', Unit.Eth, Unit.Gwei)
  const INCOMING_FEE = convert('0.00018', Unit.Eth, Unit.Gwei)
  const RECEIVER_MAX_BALANCE = 0

  const ethereumProvider = new Web3.providers.HttpProvider(process.env.ETHEREUM_PROVIDER!)

  const port = await (getPort() as Promise<number>)

  const clientPlugin = new EthereumPlugin({
    role: 'client',
    ethereumPrivateKey: process.env.PRIVATE_KEY_A!,
    ethereumProvider,
    server: `btp+ws://userA:secretA@localhost:${port}`,
    outgoingChannelAmount: convert('0.002', Unit.Eth, Unit.Gwei),
    balance: {
      maximum: SENDER_MAX_PREFUND,
      settleTo: SENDER_MAX_PREFUND,
      settleThreshold: SENDER_MAX_PREFUND
    }
  })

  const serverPlugin = new EthereumPlugin({
    role: 'server',
    ethereumPrivateKey: process.env.PRIVATE_KEY_B!,
    ethereumProvider,
    debugHostIldcpInfo: {
      assetCode: 'ETH',
      assetScale: 9,
      clientAddress: 'private.ethereum'
    },
    port,
    maxPacketAmount: convert('0.0001', Unit.Eth, Unit.Gwei),
    incomingChannelFee: INCOMING_FEE,
    balance: {
      maximum: RECEIVER_MAX_BALANCE
    }
  })

  let actualReceived = new BigNumber(0)

  clientPlugin.registerMoneyHandler(Promise.resolve)
  serverPlugin.registerMoneyHandler(async (amount: string) => {
    actualReceived = actualReceived.plus(amount)
  })

  await serverPlugin.connect()
  await clientPlugin.connect()

  // Setup the receiver (Ethereum server, Stream server)
  const streamServer = await createServer({
    plugin: serverPlugin,
    receiveOnly: true
  })

  const connProm = streamServer.acceptConnection()

  // Setup the sender (Ethereum client, Stream client)
  const clientConn = await createConnection({
    plugin: clientPlugin,
    ...(streamServer.generateAddressAndSecret())
  })

  const clientStream = clientConn.createStream()
  clientStream.setSendMax(AMOUNT_TO_SEND)

  const serverConn = await connProm
  const serverStream = await new Promise<DataAndMoneyStream>(resolve => {
    serverConn.once('stream', resolve)
  })

  serverStream.on('money', () => {
    const amountPrefunded = actualReceived.minus(serverConn.totalReceived)

    t.true(amountPrefunded.gte(RECEIVER_MAX_BALANCE), 'amount prefunded to server is always at least the max balance')
    t.true(amountPrefunded.lte(SENDER_MAX_PREFUND), 'amount prefunded to server is never greater than settleTo amount')
  })

  await t.notThrowsAsync(serverStream.receiveTotal(AMOUNT_TO_SEND, {
    timeout: 360000
  }), 'client streamed the total amount of packets to the server')

  // Wait 10 seconds for sender to finish sending the remaining payment channel claims
  await new Promise(resolve => {
    setTimeout(resolve, 10000)
  })

  t.true(actualReceived.gte(AMOUNT_TO_SEND.minus(INCOMING_FEE)), 'server received at least as much money as the client sent')

  await clientConn.end()
})
