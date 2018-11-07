import Web3 = require('web3')
import * as IlpStream from 'ilp-protocol-stream'
import * as getPort from 'get-port'
import axios from 'axios'
import EthereumPlugin from '..'
import { convert, Unit } from '../account'
import BigNumber from 'bignumber.js'
import test from 'ava'

test('client streams data and money to server', async t => {
  const web3 = new Web3(process.env.ETHEREUM_PROVIDER!)

  const privateKeys = [
    process.env.PRIVATE_KEY_A!,
    process.env.PRIVATE_KEY_B!
  ] as string[]

  const addresses = privateKeys.map(key => web3.eth.accounts.wallet.add(key).address)

  for (let address of addresses) {
    // If the balance of the account goes below 5 ETH, top up from faucet
    const balance = await web3.eth.getBalance(address)
    if (convert(5, Unit.Eth, Unit.Wei).gt(balance.toString())) {
      const { data } = await axios.post(`https://faucet.metamask.io/`, address, {
        headers: {
          'Content-Type': 'application/rawdata'
        }
      })

      // MetaMask faucet returns the tx hash
      if (typeof data === 'string') {
        await new Promise(resolve => {
          // Check for the tx to be mined
          const interval = setInterval(async () => {
            const receipt = await web3.eth.getTransactionReceipt(data)

            if (receipt && receipt.status) {
              clearInterval(interval)
              resolve()
            }
          }, 1000)
        })
      }
    }
  }

  const AMOUNT_TO_SEND = convert('0.0023', Unit.Eth, Unit.Gwei)
  const SENDER_MAX_PREFUND = convert('0.001', Unit.Eth, Unit.Gwei)
  const INCOMING_FEE = convert('0.00018', Unit.Eth, Unit.Gwei)
  const RECEIVER_MAX_BALANCE = 0

  const port = await (getPort() as Promise<number>)

  const clientPlugin = new EthereumPlugin({
    role: 'client',
    ethereumPrivateKey: process.env.PRIVATE_KEY_A!,
    ethereumProvider: process.env.ETHEREUM_PROVIDER!,
    // @ts-ignore
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
    ethereumProvider: process.env.ETHEREUM_PROVIDER!,
    // @ts-ignore
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
  serverPlugin.registerMoneyHandler((amount: string) => {
    actualReceived = actualReceived.plus(amount)
  })

  await serverPlugin.connect()
  await clientPlugin.connect()

  // Setup the receiver (Ethereum server, Stream server)
  const streamServer = await IlpStream.createServer({
    plugin: serverPlugin,
    receiveOnly: true
  })

  let serverStream: IlpStream.DataAndMoneyStream
  let serverConn: IlpStream.Connection
  let clientConn: IlpStream.Connection

  await new Promise(async resolve => {
    streamServer.once('connection', (conn: IlpStream.Connection) => {
      serverConn = conn

      serverConn.once('stream', (stream: IlpStream.DataAndMoneyStream) => {
        stream.setReceiveMax(Infinity)
        serverStream = stream

        resolve()
      })
    })

    // Setup the sender (Ethereum client, Stream client)
    clientConn = await IlpStream.createConnection({
      plugin: clientPlugin,
      ...(streamServer.generateAddressAndSecret())
    })

    const clientStream = clientConn.createStream()
    clientStream.setSendMax(AMOUNT_TO_SEND)
  })

  serverStream!.on('money', () => {
    const amountPrefunded = actualReceived.minus(serverConn.totalReceived)

    t.true(amountPrefunded.gte(RECEIVER_MAX_BALANCE), 'amount prefunded to server is always at least the max balance')
    t.true(amountPrefunded.lte(SENDER_MAX_PREFUND), 'amount prefunded to server is never greater than settleTo amount')
  })

  await t.notThrowsAsync(serverStream!.receiveTotal(AMOUNT_TO_SEND, {
    timeout: 360000
  }), 'client streamed the total amount of packets to the server')

  // Wait 10 seconds for sender to finish sending the remaining payment channel claims
  await new Promise(resolve => {
    setTimeout(resolve, 10000)
  })

  t.true(actualReceived.gte(AMOUNT_TO_SEND.minus(INCOMING_FEE)), 'server received at least as much money as the client sent')

  await clientConn!.end()
})
