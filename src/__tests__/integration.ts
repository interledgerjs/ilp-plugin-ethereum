import Web3 = require('web3')
import * as IlpStream from 'ilp-protocol-stream'
import * as getPort from 'get-port'
import axios from 'axios'
import EthereumPlugin = require('..')
import { convert, Unit } from '../account'
import BigNumber from 'bignumber.js'

const web3 = new Web3('wss://ropsten.infura.io/ws')

const privateKeys = [
  process.env.PRIVATE_KEY_A,
  process.env.PRIVATE_KEY_B
] as string[]

const addresses = privateKeys.map(key => web3.eth.accounts.wallet.add(key).address)

const DEFAULT_TIMEOUT = 360000
jest.setTimeout(DEFAULT_TIMEOUT)

beforeAll(async () => {
  for (let address of addresses) {
    // If the balance of the account goes below 5 ETH, top up from faucet
    const balance = await web3.eth.getBalance(address)
    if (convert(5, Unit.Eth, Unit.Wei).gt(balance)) {
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
})

describe('the thingggg', () => {
  let client: EthereumPlugin
  let serverPort: number
  let server: EthereumPlugin

  beforeEach(async () => {
    serverPort = await getPort()

    client = new EthereumPlugin({
      role: 'client',
      ethereumPrivateKey: process.env.PRIVATE_KEY_A!,
      ethereumProvider: 'wss://ropsten.infura.io/ws',
      // @ts-ignore
      server: `btp+ws://userA:secretA@localhost:${serverPort}`,
      outgoingChannelAmount: convert('0.01', Unit.Eth, Unit.Gwei),
      balance: {
        settleTo: convert('0.002', Unit.Eth, Unit.Gwei), // This must be higher than the fee
        settleThreshold: convert('0.0019', Unit.Eth, Unit.Gwei)
      }
    })

    server = new EthereumPlugin({
      role: 'server',
      ethereumPrivateKey: process.env.PRIVATE_KEY_B!,
      ethereumProvider: 'wss://ropsten.infura.io/ws',
      // @ts-ignore
      debugHostIldcpInfo: {
        assetCode: 'ETH',
        assetScale: 9,
        clientAddress: 'private.ethereum'
      },
      port: serverPort,
      maxPacketAmount: convert('0.0001', Unit.Eth, Unit.Gwei),
      outgoingChannelAmount: convert('0.01', Unit.Eth, Unit.Gwei),
      incomingChannelFee: convert('0.00045', Unit.Eth, Unit.Gwei),
      balance: {
        maximum: '0',
        settleTo: convert('-0.00005', Unit.Eth, Unit.Gwei),
        settleThreshold: convert('-0.0001', Unit.Eth, Unit.Gwei)
      }
    })

    client.registerMoneyHandler(() => Promise.resolve())

    await server.connect()
    await client.connect()
  })

  test('client settles and streams money to server', async done => {
    const amount = convert(0.0023, Unit.Eth, Unit.Gwei)

    const SENDER_SETTLE_TO = convert('0.002', Unit.Eth, Unit.Gwei).toNumber()
    const RECEIVER_MAX_BALANCE = 0

    // Setup the receiver
    const streamServer = await IlpStream.createServer({
      plugin: server,
      receiveOnly: true
    })

    let actualReceived = new BigNumber(0)
    server.registerMoneyHandler(async (amount: string) => {
      actualReceived = actualReceived.plus(amount)
    })

    streamServer.on('connection', (conn: IlpStream.Connection) => {
      const checkBalance = () => {
        // Amount of money prefunded to the server at a moment in time:
        // Total amount sent to server from client (after incoming fees),
        // minus the total amount fulfilled by server
        const amountPrefunded = actualReceived.minus(conn.totalReceived).toNumber()

        expect(amountPrefunded).toBeGreaterThanOrEqual(RECEIVER_MAX_BALANCE)
        expect(amountPrefunded).toBeLessThanOrEqual(SENDER_SETTLE_TO)
      }

      conn.on('stream', async (stream: IlpStream.DataAndMoneyStream) => {
        stream.on('money', checkBalance)
        // Verify the entirety of the packets got through
        await expect(stream.receiveTotal(amount)).resolves.toBeUndefined()
        await client.disconnect()

        // Make sure the sender received at least as much money as the sender sent
        // `checkBalance` will verify the sender didn't prefund/send more than thee settleTo amount
        expect(
          actualReceived.toNumber()
        ).toBeGreaterThanOrEqual(
          amount.minus(convert('0.00045', Unit.Eth, Unit.Gwei)).toNumber()
        )

        done()
      })
    })

    // Sender
    const streamClient = await IlpStream.createConnection({
      plugin: client,
      ...(streamServer.generateAddressAndSecret())
    })

    const stream = streamClient.createStream()
    stream.setSendMax(amount)
  })
})
