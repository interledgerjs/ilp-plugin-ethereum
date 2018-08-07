'use strict'

const MachinomyServerPlugin = require('..')
const HDWalletProvider = require('truffle-hdwallet-provider')
const Store = require('./util/memStore')
const BtpPacket = require('btp-packet')
const IlpPacket = require('ilp-packet')
const debug = require('debug')('ilp-plugin-ethereum-asym-server:test')
const getPort = require('get-port')
const formatAmount = require('../build/index.js').formatAmount
const crypto = require('crypto')

const secret = 'lazy glass net matter square melt fun diary network bean play deer'
const providerUrl = "https://ropsten.infura.io/T1S8a0bkyrGD7jxJBgeH"
const provider = new HDWalletProvider(secret, providerUrl, 0)

/* TODO Mock for web3, HDWallet, and Machinomy API. */
/* NOTE HDWalletProvider hangs on create. */
async function createPlugin() {
  /* Silence console log output from provider creation. */
  const _pre = console.log
  console.log = () => {}

  let plugin = new MachinomyServerPlugin({
    address: await provider.getAddress(),
    provider: provider,
    minimumChannelAmount: 100,
    maxPacketAmount: 100,
    _store: new Store(),
    port: await getPort(),
    debugHostIldcpInfo: {
      clientAddress: 'test.prefix',
      assetScale: 9,
      assetCode: 'ETH'
    }
  })

  console.log = _pre

  return plugin
}

function sha256 (preimage) { return crypto.createHash('sha256').update(preimage).digest() }

function createBtpSubprotocolArrayJSON(protocolName, dataObj) {
    return [{
      protocolName: protocolName,
      contentType: BtpPacket.MIME_APPLICATION_JSON,
      data: Buffer.from(JSON.stringify(dataObj))
    }]
} 


function createBtpSubprotocolArrayOctet(protocolName, data) {
    return [{
      protocolName: protocolName,
      contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
      data: data 
    }]
} 

function createBtpPacket(type, data) {
  return {
    requestId: 0,
    type: type,
    data: { protocolData: data } 
  }
} 

function createIlpPrepare(destination, amount) {
  return IlpPacket.serializeIlpPrepare({
    amount: amount.toString(),
    executionCondition: sha256('ASDWSDG3425ASD235'),
    destination: destination,
    data: Buffer.alloc(0),
    expiresAt: new Date(Date.now() + 10000)
  })
}

beforeEach(async () => {
  try {
    this.plugin = await createPlugin() 
    await this.plugin.connect()
  } catch (e) {
    throw e
  }
    this.mockAccountName = 'ADSBG124AS62ASF45GHJB' 
    this.mockAccountAddress = this.plugin._debugHostIldcpInfo.clientAddress + '.' + this.mockAccountName
    this.mockAccount = this.plugin._getAccount(this.mockAccountAddress)
})

afterEach(async () => {
  try {
    await this.plugin._provider.engine.stop()
    await this.plugin.disconnect()
  } catch (e) {
    throw e
  }
})

describe('ilp-plugin-ethereum-asym-server tests', () => {
  /** 
   * _estimateFee
   * 
   * fee estimate is less than 1.2M gwei
   *   the 1.2M estimate comes from an upper bound estimate:
   *
   *   cost of opening a paychan which is the most expensive tx according to
   *   estimates on machinomy: 120000 gas
   *
   *   cost of gas: 10 gwei
   */
  describe('_estimateFee', () => {
    test('fee estimate is less than 1.2M gwei', async () => {
      const feeTypes = ['open', 'deposit', 'claim']
      try {
        const fees = await Promise.all(feeTypes.map(async (feeType) => {
          const fee = await this.plugin._estimateFee(feeType)
          expect(fee.toNumber()).toBeLessThan(1200000) 
        }))
      } catch (e) {
        throw e
      }
    })
  })

  /**
   * _getAccount
   *
   * new account is created in account map 
   * proxy persists to store on set 
   */
  describe('_getAccount', () => {
    test('new account is created in account map', () => {
      expect(this.plugin._accounts.get(this.mockAccountName)).toBe(this.mockAccount)
    })

    test('proxy persists to store on set', async () => {
      this.mockAccount.isBlocked = true
      this.plugin._store.unload(this.mockAccountName)
      expect(this.plugin._store.get(this.mockAccountName)).toBeUndefined()
      try {
        await this.plugin._store.close()
        await this.plugin._store.load(this.mockAccountName)
      } catch (e) {
        throw e
      }
      expect(this.plugin._store.get(this.mockAccountName)).toBe(JSON.stringify(this.mockAccount))
    })
  })

  /**
   * _preConnect
   *
   * does not hang on starting watcher 
   */   
  describe('_preConnect', () => {
    test('does not hang on starting watcher', async () => {
      try {
        expect(await this.plugin._preConnect()).toBeUndefined()
      } catch (e) {
        throw e
      }
    }) 
  })

  /* _connect
   * 
   * account correctly loaded from store
   * throw on blocked account
   * ethereum address retrieved from client through 'info' protocol
   * ethereum address is valid
   */
  describe('_connect', () => {
    test('account correctly loaded from store', async () => {
      this.mockAccount.isBlocked = true
      this.plugin._store.unload(this.mockAccountName)
      expect(this.plugin._store.get(this.mockAccountName)).toBeUndefined()
      try {
        await this.plugin._store.close()
        await this.plugin._connect(this.mockAccountAddress, {})
      } catch (e) {
      }
      expect(this.plugin._accounts.get(this.mockAccountName)).toEqual(this.mockAccount)
    })

    test('throw on blocked account', async () => {
      this.mockAccount.isBlocked = true
      try {
        await this.plugin._connect(this.mockAccountAddress, {})
      } catch (e) {
        expect(e).toEqual(new Error(`Cannot connect to blocked account ${this.mockAccountName}`))
      }
    })

    test('ethereum address retrieved from client through \'info\' protocol', () => {
      const btpPacketData = {protocolData: createBtpSubprotocolArrayJSON('info', {
        ethereumAddress: this.plugin._address
      })}
      const info = JSON.parse(btpPacketData.protocolData[0].data.toString()) 
      expect(info.ethereumAddress).toBe(this.plugin._address)
    })
  })

  /*   
   * _handleCustomData
   * 
   * btp message with 'info' protocol returns btp packet with server eth address 
   * throw if prepare from blocked account received
   * throw if amount in prepare > maxPacket amount
   * throw if amount in prepare puts account over maximum balance
   * throw if no data handler
   */
  describe('_handleCustomData', () => {
    test('btp message with \'info\' protocol returns btp subprotocol data with server eth address', async () => {
      const btpSubprotocolArray = createBtpSubprotocolArrayJSON('info', {
        ethereumAddress: this.plugin._address
      })
      const btpPacket = createBtpPacket(BtpPacket.TYPE_MESSAGE, btpSubprotocolArray)
      try {
        expect(await this.plugin._handleCustomData(this.mockAccountAddress, btpPacket)).toEqual(btpSubprotocolArray)
      } catch (e) {
        throw e
      } 
    })

    test('throw if prepare from blocked account received', async () => {
      this.mockAccount.isBlocked = true
      const btpSubprotocolArray = createBtpSubprotocolArrayOctet('ilp', createIlpPrepare(this.mockAccountAddress, 100))
      const btpPacket = createBtpPacket(BtpPacket.TYPE_MESSAGE, btpSubprotocolArray)
      try {
        await this.plugin._handleCustomData(this.mockAccountAddress, btpPacket)
      } catch (e) {
        expect(e).toEqual(new IlpPacket.Errors.UnreachableError('Account has been closed.'))
      }
    })

    test('throw if amount in prepare > maxPacket amount', async () => {
      const btpSubprotocolArray = createBtpSubprotocolArrayOctet('ilp', createIlpPrepare(this.mockAccountAddress, 101))
      const btpPacket = createBtpPacket(BtpPacket.TYPE_MESSAGE, btpSubprotocolArray)
      try {
        await this.plugin._handleCustomData(this.mockAccountAddress, btpPacket)
      } catch (e) {
        expect(e).toEqual(new IlpPacket.Errors.AmountTooLargeError('Packet size is too large.', {
          receivedAmount: '101',
          maximumAmount: this.plugin._maxPacketAmount.toString()
        }))
      }
    })

    test('throw if amount in prepare puts account over maximum balance',  async () => {
      const btpSubprotocolArray = createBtpSubprotocolArrayOctet('ilp', createIlpPrepare(this.mockAccountAddress, 100))
      const btpPacket = createBtpPacket(BtpPacket.TYPE_MESSAGE, btpSubprotocolArray)
      const newBalance = this.mockAccount.balance.plus(100)
      try {
        await this.plugin._handleCustomData(this.mockAccountAddress, btpPacket)
      } catch (e) {
        expect(e).toEqual(new IlpPacket.Errors.InsufficientLiquidityError(
          `Insufficient funds, prepared balance is ${formatAmount(newBalance, 'eth')}, above max of ${formatAmount(this.plugin.balance.maximum, 'eth')}`
        ))
      }
    })
  })  

  /* TODO
   *
   * _sendPrepare
   *
   * _handlePrepareResponse 
   *
   * _handleMoney
   *
   * _disconnect
   *   store cache is clear on disconnect
   *   all accounts still in store
   * 
   * _startWatcher
   *   default polling period calculation ~50min
   *   account that begins to settle is successfully blocked
   *   claim occurs only if channel in settling state is profitable 
   */
})
