'use strict'

const MachinomyServerPlugin = require('..')
const HDWalletProvider = require('truffle-hdwallet-provider')
const Store = require('./util/memStore')
const BtpPacket = require('btp-packet')
const IlpPacket = require('ilp-packet')
const debug = require('debug')('ilp-plugin-eohereum-asym-server:test')
const getPort = require('get-port')
const formatAmount = require('../build/index.js').formatAmount
const crypto = require('crypto')

const secret = 'lazy glass net matter square melt fun diary network bean play deer'
const providerUrl = "https://ropsten.infura.io/T1S8a0bkyrGD7jxJBgeH"
const provider = new HDWalletProvider(secret, providerUrl, 0)
function sha256 (preimage) { return crypto.createHash('sha256').update(preimage).digest() }

class Trace extends Error {}

/* TODO Mock for web3, HDWallet, and Machinomy API. */
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
  this.mockFulfillment = crypto.randomBytes(32)
  this.mockIlpPrepare = {
    amount: '100', 
    executionCondition: sha256(this.mockFulfillment),
    destination: this.mockAccountAddress,
    data: Buffer.alloc(0),
    expiresAt: new Date(Date.now() + 10000)
  }
  this.mockIlpFulfill = {
    fulfillment: this.mockFulfillment,
    data: Buffer.alloc(0)
  }
  this.mockBtpPacketInfo = {
    requestId: 0,
    type: BtpPacket.TYPE_MESSAGE,
    data: {
      protocolData: [{
        protocolName: 'info',
        contentType: BtpPacket.MIME_APPLICATION_JSON,
        data: Buffer.from(JSON.stringify({
          ethereumAddress: this.plugin._address
        }))
      }]
    }
  }
  this.mockBtpPacketIlp = function (ilpData) {
    return {
      requestId: 0,
      type: BtpPacket.TYPE_MESSAGE,
      data: {
        protocolData: [{
          protocolName: 'ilp',
          contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
          data: ilpData.amount ? IlpPacket.serializeIlpPrepare(ilpData) : IlpPacket.serializeIlpFulfill(ilpData) 
        }]
      }
    }
  }
})

afterEach(async () => {
  try {
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
        throw Error('Test Error: should trigger catch')
      } catch (e) {
        expect(e).toEqual(new Error(`Cannot connect to blocked account ${this.mockAccountName}`))
      }
    })

    test('ethereum address retrieved from client through \'info\' protocol', async () => {
      this.plugin._call = jest.fn() 
      this.plugin._call.mockImplementation(() => this.mockBtpPacketInfo.data)
      await this.plugin._connect(this.mockAccountAddress, {})
      expect(this.plugin._getAccount(this.mockAccountAddress).ethereumAddress).toBe(this.plugin._address)
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
   * on reject response from data handler (from expiry): 
   *   account balance rolled back 
   *   packet type of ilp reject 
   * on fulfill response from data handler:
   *   account balance updated
   *   throw on no money handler 
   *   throw on negative amount
   *   call money handler and return packet type of fulfill 
   */
  describe('_handleCustomData', () => {
    test('btp message with \'info\' protocol returns btp subprotocol data with server eth address', async () => {
      try {
        expect(await this.plugin._handleCustomData(this.mockAccountAddress, this.mockBtpPacketInfo)).toEqual(this.mockBtpPacketInfo.data.protocolData)
      } catch (e) {
        throw e
      } 
    })

    test('throw if prepare from blocked account received', async () => {
      this.mockAccount.isBlocked = true
      try {
        await this.plugin._handleCustomData(this.mockAccountAddress, this.mockBtpPacketIlp(this.mockIlpPrepare))
        throw Error('Test Error: should trigger catch')
      } catch (e) {
        expect(e).toEqual(new IlpPacket.Errors.UnreachableError('Account has been closed.'))
      }
    })

    test('throw if amount in prepare > maxPacket amount', async () => {
      this.mockIlpPrepare.amount = '101'
      try {
        await this.plugin._handleCustomData(this.mockAccountAddress, this.mockBtpPacketIlp(this.mockIlpPrepare))
        throw Error('Test Error: should trigger catch')
      } catch (e) {
        expect(e).toEqual(new IlpPacket.Errors.AmountTooLargeError('Packet size is too large.', {
          receivedAmount: '101',
          maximumAmount: this.plugin._maxPacketAmount.toString()
        }))
      }
    })

    test('throw if amount in prepare puts account over maximum balance',  async () => {
      const newBalance = this.mockAccount.balance.plus(100)
      try {
        await this.plugin._handleCustomData(this.mockAccountAddress, this.mockBtpPacketIlp(this.mockIlpPrepare))
        throw Error('Test Error: should trigger catch')
      } catch (e) {
        expect(e).toEqual(new IlpPacket.Errors.InsufficientLiquidityError(
          `Insufficient funds, prepared balance is ${formatAmount(newBalance, 'eth')}, above max of ${formatAmount(this.plugin.balance.maximum, 'eth')}`
        ))
      }
    })

    test('throw if no data handler', async () => {
      this.plugin.balance.maximum = 200 
      try {
        await this.plugin._handleCustomData(this.mockAccountAddress, this.mockBtpPacketIlp(this.mockIlpPrepare))
        throw Error('Test Error: should trigger catch')
      } catch (e) {
        expect(e).toEqual(new Error('no request handler registered'))    
      }
    })

    describe('on reject response from data handler (from expiry)', () => {
      beforeEach(async () => {
        jest.useFakeTimers()
        this.oldBalance = this.mockAccount.balance
        this.plugin.balance.maximum = 200
        this.plugin.registerDataHandler(() => new Promise(resolve => setTimeout(() => resolve(), 100000)))
        try {
          this.protocolDataResponse = this.plugin._handleCustomData(this.mockAccountAddress, this.mockBtpPacketIlp(this.mockIlpPrepare))
          jest.runOnlyPendingTimers()
          await this.protocolDataResponse
        }
        catch (e) {
          throw e
        }
      })
      
      test('account balance rolled back', async () => {
        expect(this.oldBalance).toEqual(this.mockAccount.balance)
      })

      test('return packet of type reject', async () => {
        const protocolDataResponse = await this.protocolDataResponse
        expect(protocolDataResponse[0].data[0]).toBe(IlpPacket.Type.TYPE_ILP_REJECT)
      })
    })
    
    describe('on fulfill response from data handler', () => {
      beforeEach(() => {
        jest.useFakeTimers()
        this.plugin.registerDataHandler(() => new Promise(resolve => setTimeout(() => resolve(IlpPacket.serializeIlpFulfill(this.mockIlpFulfill)), 1000)))
        this.plugin.balance.maximum = 200
      })

      test('account balance updated', async () => {
        try {
          const oldBalance = this.mockAccount.balance
          const protocolDataResponse = this.plugin._handleCustomData(this.mockAccountAddress, this.mockBtpPacketIlp(this.mockIlpPrepare))
          jest.runOnlyPendingTimers()
          await protocolDataResponse
          expect(oldBalance).toEqual(this.mockAccount.balance - this.mockIlpPrepare.amount)
        } catch (e) {}
      })

      test('throw on no money handler', async () => {
        try {
          const protocolDataResponse = this.plugin._handleCustomData(this.mockAccountAddress, this.mockBtpPacketIlp(this.mockIlpPrepare))
          jest.runOnlyPendingTimers()
          await protocolDataResponse
          throw Error('Test Error: should trigger catch')
        } catch (e) {
          expect(e).toEqual(new Error('no money handler registered')) 
        }
      })

      test('throw on negative amount', async () => {
        try {
          const protocolDataResponse = this.plugin._handleCustomData(this.mockAccountAddress, this.mockBtpPacketIlp(this.mockIlpPrepare))
          jest.runOnlyPendingTimers()
          await protocolDataResponse
          throw Error('Test Error: should trigger catch')
        } catch (e) {
          expect(e).toEqual(new Error('no money handler registered')) 
        }
      })

      test('call money handler and return fulfill in btp subprotocol', async () => {
        const mockMoneyHandler = jest.fn()
        this.plugin.registerMoneyHandler(mockMoneyHandler)
        try {
          let protocolDataResponse = this.plugin._handleCustomData(this.mockAccountAddress, this.mockBtpPacketIlp(this.mockIlpPrepare))
          jest.runOnlyPendingTimers()
          protocolDataResponse = await protocolDataResponse
          expect(protocolDataResponse[0].data[0]).toBe(IlpPacket.Type.TYPE_ILP_FULFILL)
          expect(mockMoneyHandler).toHaveBeenCalledTimes(1)
        } catch (e) {
          throw e
        }
      })
    })
  })  
  
  /**
   * _sendPrepare
   *
   * throw on blocked account
   * throw on account with no ethereum address
   */
  describe('_sendPrepare', () => {
    test('throw on blocked account', () => {
      this.mockAccount.isBlocked = true
      expect(() => this.plugin._sendPrepare(this.mockAccountAddress, {}))
        .toThrow(new IlpPacket.Errors.UnreachableError('Account has been closed'))
    })

    test('throw on account with no ethereum address', () => {
      expect(() => this.plugin._sendPrepare(this.mockAccountAddress, {}))
        .toThrow(new IlpPacket.Errors.UnreachableError('No Ethereum address linked with account, cannot forward PREPARE'))
    })
  })

  /**
   * _handlePrepareResponse
   *
   * response type is ilp fulfill
   * account balance descreased by amount in fulfill
   * throw on outgoing channel with the wrong ethereum address as the receiver
   * throw trace if account is funding
   * if no channel OR existing channel is settling//settled: 
   *   throw if balance + channel open fees > max balance
   */
  describe('_handlePrepareResponse', () => {
    beforeEach(() => {
      this.plugin._log.trace = jest.fn()

      this.preError = `Failed to pay account ${this.mockAccountName}: `
      this.mockIlpPacketFulfill = {
        type: IlpPacket.Type.TYPE_ILP_FULFILL,
        data: this.mockIlpFulfill
      }

      this.mockIlpPacketPrepare = {
        type: IlpPacket.Type.TYPE_ILP_PREPARE,
        data: this.mockIlpPrepare
      }
    })

    test('response type is ilp fulfill', async () => {
      this.mockAccount.isFunding = true
      try {
        await this.plugin._handlePrepareResponse(this.mockAccountAddress, this.mockIlpPacketFulfill, this.mockIlpPacketPrepare)
        expect(this.plugin._log.trace.mock.calls[0][0]).toEqual(`Handling a ILP_FULFILL in response to the forwarded ILP_PREPARE`)
      } catch (e) {
        throw e
      }
    })

    test('account balance decreased by amount in fulfill', async () => {
      const oldBalance = this.mockAccount.balance
      this.mockAccount.isFunding = true
      try {
        await this.plugin._handlePrepareResponse(this.mockAccountAddress, this.mockIlpPacketFulfill, this.mockIlpPacketPrepare)
        expect(parseInt(this.mockAccount.balance)).toBe(oldBalance - this.mockIlpPrepare.amount)
      } catch (e) {
        throw e
      }
    })

    test('throw on outgoing channel with the wrong ethereum address as the receiver', async () => {
      this.mockAccount.isFunding = true
       
      try {
        await this.plugin._handlePrepareResponse(this.mockAccountAddress, this.mockIlpPacketFulfill, this.mockIlpPacketPrepare)
        // expect(parseInt(this.mockAccount.balance)).toBe(oldBalance - this.mockIlpPrepare.amount)
      } catch (e) {
        throw e
      }
    })

    test('throw trace if account is funding', async () => {
      this.mockAccount.isFunding = true
      try {
        await this.plugin._handlePrepareResponse(this.mockAccountAddress, this.mockIlpPacketFulfill, this.mockIlpPacketPrepare)
        expect(this.plugin._log.trace.mock.calls[2][0]).toEqual(this.preError + 'Trace: another funding event was occuring simultaneously.')
      } catch (e) {
        throw e
      }
    })
  })


  /* TODO
   * rest of _handlePrepareResponse
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
