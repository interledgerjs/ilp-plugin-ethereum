'use strict'

const MachinomyServerPlugin = require('..')
const HDWalletProvider = require('truffle-hdwallet-provider')
const Store = require('./util/memStore')
const BtpPacket = require('btp-packet')
const IlpPacket = require('ilp-packet')
const BigNumber = require('bignumber.js')
const getPort = require('get-port')
const formatAmount = require('../build/index.js').formatAmount
const crypto = require('crypto')

const secret = 'lazy glass net matter square melt fun diary network bean play deer'
const providerUrl = 'https://ropsten.infura.io/T1S8a0bkyrGD7jxJBgeH'
const provider = () => new HDWalletProvider(secret, providerUrl, 0)
function sha256 (preimage) { return crypto.createHash('sha256').update(preimage).digest() }

async function createPlugin () {
  /* Silence console log output from provider creation. */
  const _pre = console.log
  console.log = () => {}

  let plugin = new MachinomyServerPlugin({
    address: provider().getAddress(),
    provider: provider(),
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
  this.plugin = await createPlugin()
  await this.plugin.connect()

  this.mockChannel = {
    sender: this.plugin._address,
    receiver: this.plugin._address,
    channelId: '0x42',
    value: new BigNumber(1000),
    spent: new BigNumber(0),
    state: 0 // open
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
  this.mockBtpPacketIlp = (ilpData) => {
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
  this.plugin._provider.engine.stop()
  await this.plugin.disconnect()
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
      await Promise.all(feeTypes.map(async (feeType) => {
        const fee = await this.plugin._estimateFee(feeType)
        expect(fee.toNumber()).toBeLessThan(1200000)
      }))
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
      await this.plugin._store.close()
      await this.plugin._store.load(this.mockAccountName)
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
      expect(await this.plugin._preConnect()).toBeUndefined()
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
      await this.plugin._store.close()
      this.plugin._connect(this.mockAccountAddress, {}).catch(() => {})
      expect(this.plugin._accounts.get(this.mockAccountName)).toEqual(this.mockAccount)
    })

    test('throw on blocked account', async () => {
      this.mockAccount.isBlocked = true
      await expect(this.plugin._connect(this.mockAccountAddress, {}))
        .rejects
        .toThrow(`Cannot connect to blocked account ${this.mockAccountName}`)
    })

    test('ethereum address retrieved from client through \'info\' protocol', async () => {
      this.plugin._call = jest.fn()
      this.plugin._call.mockResolvedValue(this.mockBtpPacketInfo.data)
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
      expect(await this.plugin._handleCustomData(this.mockAccountAddress, this.mockBtpPacketInfo)).toEqual(this.mockBtpPacketInfo.data.protocolData)
    })

    test('throw if prepare from blocked account received', async () => {
      this.mockAccount.isBlocked = true
      await expect(this.plugin._handleCustomData(this.mockAccountAddress, this.mockBtpPacketIlp(this.mockIlpPrepare)))
        .rejects
        .toThrow('Account has been closed.')
    })

    test('throw if amount in prepare > maxPacket amount', async () => {
      this.mockIlpPrepare.amount = '101'
      await expect(this.plugin._handleCustomData(this.mockAccountAddress, this.mockBtpPacketIlp(this.mockIlpPrepare)))
        .rejects
        .toThrow('Packet size is too large.')
    })

    test('throw if amount in prepare puts account over maximum balance', async () => {
      const newBalance = this.mockAccount.balance.plus(100)
      await expect(this.plugin._handleCustomData(this.mockAccountAddress, this.mockBtpPacketIlp(this.mockIlpPrepare)))
        .rejects
        .toThrow(`Insufficient funds, prepared balance is ${formatAmount(newBalance, 'eth')}, above max of ${formatAmount(this.plugin.balance.maximum, 'eth')}`)
    })

    test('throw if no data handler', async () => {
      this.plugin.balance.maximum = 200
      await expect(this.plugin._handleCustomData(this.mockAccountAddress, this.mockBtpPacketIlp(this.mockIlpPrepare)))
        .rejects
        .toThrow('no request handler registered')
    })

    describe('on reject response from data handler (from expiry):', () => {
      beforeEach(async () => {
        jest.useFakeTimers()
        this.oldBalance = this.mockAccount.balance
        this.plugin.balance.maximum = 200
        this.plugin.registerDataHandler(() => new Promise(resolve => setTimeout(() => resolve(), 100000)))
        this.protocolDataResponse = this.plugin._handleCustomData(this.mockAccountAddress, this.mockBtpPacketIlp(this.mockIlpPrepare))
        jest.runOnlyPendingTimers()
        await this.protocolDataResponse
      })

      test('account balance rolled back', async () => {
        expect(this.oldBalance).toEqual(this.mockAccount.balance)
      })

      test('return packet of type reject', async () => {
        const protocolDataResponse = await this.protocolDataResponse
        expect(protocolDataResponse[0].data[0]).toBe(IlpPacket.Type.TYPE_ILP_REJECT)
      })
    })

    describe('on fulfill response from data handler:', () => {
      beforeEach(() => {
        jest.useFakeTimers()
        this.plugin.registerDataHandler(() => new Promise(resolve => setTimeout(() => resolve(IlpPacket.serializeIlpFulfill(this.mockIlpFulfill)), 1000)))
        this.plugin.balance.maximum = 200
      })

      test('account balance updated', async () => {
        const oldBalance = this.mockAccount.balance
        const protocolDataResponse = this.plugin._handleCustomData(this.mockAccountAddress, this.mockBtpPacketIlp(this.mockIlpPrepare))
        jest.runOnlyPendingTimers()
        protocolDataResponse.catch(() => {})
        expect(parseInt(oldBalance)).toEqual(this.mockAccount.balance - this.mockIlpPrepare.amount)
      })

      test('throw on no money handler', async () => {
        const protocolDataResponse = this.plugin._handleCustomData(this.mockAccountAddress, this.mockBtpPacketIlp(this.mockIlpPrepare))
        jest.runOnlyPendingTimers()
        await expect(protocolDataResponse)
          .rejects
          .toThrow('no money handler registered')
      })

      test('throw on negative amount', async () => {
        const protocolDataResponse = this.plugin._handleCustomData(this.mockAccountAddress, this.mockBtpPacketIlp(this.mockIlpPrepare))
        jest.runOnlyPendingTimers()
        await expect(protocolDataResponse)
          .rejects
          .toThrow('no money handler registered')
      })

      test('call money handler and return fulfill in btp subprotocol', async () => {
        const mockMoneyHandler = jest.fn()
        this.plugin.registerMoneyHandler(mockMoneyHandler)
        let protocolDataResponse = this.plugin._handleCustomData(this.mockAccountAddress, this.mockBtpPacketIlp(this.mockIlpPrepare))
        jest.runOnlyPendingTimers()
        protocolDataResponse = await protocolDataResponse
        expect(protocolDataResponse[0].data[0]).toBe(IlpPacket.Type.TYPE_ILP_FULFILL)
        expect(mockMoneyHandler).toHaveBeenCalledTimes(1)
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
   * before funding:
   *   needs new channel:
   *     if no channel, throw if balance + channel open fees > max balance
   *     if channel is settling/settled, throw if balance + channel open fees > max balance
   *   needs deposit:
   *     throw trace if balance + deposit fee > max balance AND assert balance the same
   *     newBalance = (balance + deposit fee), if newBalance <= max balance
   *     throw trace if balance below settle threshold
   * during funding:
   *   if requires new channel, throw if no eth  address linked to acct
   *   if requires deposit, update balance to include difference between estimated and real transaction
   * after funding:
   *   throw if machinomy selected wrong payment channel for claim
   *   if settleThreshold is 0, and full amount could be settled, final balance = 0
   */
  describe('_handlePrepareResponse', () => {
    beforeEach(() => {
      this.preError = `Failed to pay account ${this.mockAccountName}: `
      this.mockIlpPacketFulfill = {
        type: IlpPacket.Type.TYPE_ILP_FULFILL,
        data: this.mockIlpFulfill
      }
      this.mockIlpPacketPrepare = {
        type: IlpPacket.Type.TYPE_ILP_PREPARE,
        data: this.mockIlpPrepare
      }
      this.mockTx = {
        gasPrice: new BigNumber('1000000000')
      }
      this.mockTxHash = '0x94adbd6f426bddf630d07474794a4b604a221bd2720aeb6e6172585920e0f50f'
      this.mockTxReceipt = {
        gasUsed: 40000
      }
      this.mockDepositResult = {
        tx: this.mockTxHash,
        receipt: this.mockTxReceipt
      }
      this.mockNextPaymentResult = {
        payment: { channelId: '0x42' }
      }

      this.plugin._log.trace = jest.fn()
      this.plugin._log.error = jest.fn()
      this.plugin._estimateFee = jest.fn().mockResolvedValue(new BigNumber('20000'))
      this.plugin._call = jest.fn()
      this.plugin._machinomy.channelById = jest.fn().mockResolvedValue(this.mockChannel)
      this.plugin._machinomy.open = jest.fn().mockResolvedValue(this.mockChannel)
      this.plugin._machinomy.deposit = jest.fn().mockResolvedValue(this.mockDepositResult)
      this.plugin._machinomy.payment = jest.fn().mockResolvedValue(this.mockNextPaymentResult)

      // TODO this mock represents how get transaction SHOULD work according to
      // the api reference, but it does not! Need to diagnose error -- this mock
      // allows test to run. Refer to TODO in index.ts.
      this.plugin._web3.eth.getTransaction = jest.fn().mockImplementation((tx, cb) => cb(null, this.mockTx))
    })

    test('response type is ilp fulfill', async () => {
      this.mockAccount.isFunding = true
      await this.plugin._handlePrepareResponse(this.mockAccountAddress, this.mockIlpPacketFulfill, this.mockIlpPacketPrepare)
      expect(this.plugin._log.trace.mock.calls[0][0]).toEqual(`Handling a ILP_FULFILL in response to the forwarded ILP_PREPARE`)
    })

    test('account balance decreased by amount in fulfill', async () => {
      const oldBalance = this.mockAccount.balance
      this.mockAccount.isFunding = true
      await this.plugin._handlePrepareResponse(this.mockAccountAddress, this.mockIlpPacketFulfill, this.mockIlpPacketPrepare)
      expect(parseInt(this.mockAccount.balance)).toBe(oldBalance - this.mockIlpPrepare.amount)
    })

    test('throw on outgoing channel with the wrong ethereum address as the receiver', async () => {
      this.mockAccount.outgoingChannelId = '0x42'
      this.mockAccount.ethereumAddress = this.plugin._address
      this.mockChannel.receiver = '0x13'

      await this.plugin._handlePrepareResponse(this.mockAccountAddress, this.mockIlpPacketFulfill, this.mockIlpPacketPrepare)
      expect(this.plugin._log.error.mock.calls[0][0])
        .toEqual(this.preError + `Error: recipient of the outgoing channel is not the linked Ethereum address. ` +
          `This should never occur and be investigated further. ` +
          `channelId=${this.mockAccount.outgoingChannelId} channelAddress=${this.mockChannel.receiver} ` +
          `accountAddress=${this.mockAccount.ethereumAddress}`)
    })

    test('throw trace if account is funding', async () => {
      this.mockAccount.isFunding = true
      await this.plugin._handlePrepareResponse(this.mockAccountAddress, this.mockIlpPacketFulfill, this.mockIlpPacketPrepare)
      expect(this.plugin._log.trace.mock.calls[2][0]).toEqual(this.preError + 'Trace: another funding event was occuring simultaneously.')
    })

    describe('before funding:', () => {
      beforeEach(() => {
        this.plugin.balance.settleThreshold = new BigNumber('-200')
        this.mockAccount.outgoingChannelId = '0x42'
        this.mockAccount.ethereumAddress = this.plugin._address
        this.mockChannel.receiver = this.plugin._address
        this.mockChannel.spent = new BigNumber(1000) // 1000 - 1000 = 0 gwei left in channel
      })

      describe('needs new channel:', () => {
        test('if no channel, throw if balance + channel open fees > max balance', async () => {
          this.mockAccount.outgoingChannelId = null
          await this.plugin._handlePrepareResponse(this.mockAccountAddress, this.mockIlpPacketFulfill, this.mockIlpPacketPrepare)
          expect(this.plugin._log.trace.mock.calls[2][0])
            .toEqual(this.preError + 'Trace: insufficient funds to open a new channel; funds will continue to accumulate.')
        })

        test('if channel is settling/settled, throw if balance + channel open fees > max balance', async () => {
          this.mockChannel.state = 1
          await this.plugin._handlePrepareResponse(this.mockAccountAddress, this.mockIlpPacketFulfill, this.mockIlpPacketPrepare)
          expect(this.plugin._log.trace.mock.calls[2][0])
            .toEqual(this.preError + 'Trace: insufficient funds to open a new channel; funds will continue to accumulate.')
        })
      })

      describe('needs deposit:', () => {
        test('throw trace if balance + deposit fee > max balance AND assert balance the same', async () => {
          const oldBalance = parseInt(this.mockIlpPrepare.amount) * -1 // negated because we pay out this amount to receiver
          await this.plugin._handlePrepareResponse(this.mockAccountAddress, this.mockIlpPacketFulfill, this.mockIlpPacketPrepare)
          expect(this.plugin._log.trace.mock.calls[2][0])
            .toEqual(`Account ${this.mockAccountName} has insufficient funds to cover an on-chain deposit to ` +
              `send full payment; sending partial payment.`)
          expect(oldBalance).toEqual(parseInt(this.mockAccount.balance))
        })

        test('newBalance = (balance + deposit fee), if newBalance <= max balance', async () => {
          this.mockIlpPrepare.amount = '20000'// balance = -20000
          const oldBalance = parseInt(this.mockIlpPrepare.amount) * -1
          const newBalance = (await this.plugin._estimateFee('deposit')).plus(oldBalance)
          await this.plugin._handlePrepareResponse(this.mockAccountAddress, this.mockIlpPacketFulfill, this.mockIlpPacketPrepare)
          expect(newBalance).toEqual(this.mockAccount.balance)
        })

        test('throw trace if balance below settle threshold', async () => {
          await this.plugin._handlePrepareResponse(this.mockAccountAddress, this.mockIlpPacketFulfill, this.mockIlpPacketPrepare)
          expect(this.plugin._log.trace.mock.calls[3][0])
            .toEqual(this.preError + 'Trace: below settle threshold; funds will continue to accumulate.')
        })
      })
    })

    describe('during funding:', () => {
      beforeEach(() => {
        this.mockIlpPrepare.amount = '25000'
        this.mockAccount.outgoingChannelId = '0x42'
        this.mockAccount.ethereumAddress = this.plugin._address
        this.mockChannel.receiver = this.plugin._address
        this.mockChannel.spent = new BigNumber(1000) // 1000 - 1000 = 0 gwei left in channel
      })

      test('if requires new channel, throw if no eth address linked to acct', async () => {
        this.mockAccount.outgoingChannelId = null
        this.mockAccount.ethereumAddress = null
        await this.plugin._handlePrepareResponse(this.mockAccountAddress, this.mockIlpPacketFulfill, this.mockIlpPacketPrepare)
        expect(this.plugin._log.error.mock.calls[0][0])
          .toEqual(this.preError + 'Error: no Ethereum address was linked.')
      })

      test('if requires deposit, update balance to include difference between estimated and real transaction', async () => {
        const feeEstimate = (await this.plugin._estimateFee('deposit')).toNumber()
        const actualFee = this.plugin._web3.fromWei(this.mockTx.gasPrice, 'gwei') * this.mockTxReceipt.gasUsed
        const balanceAfterPrepare = parseInt(this.mockIlpPrepare.amount) * -1
        const balanceAfterDepositFee = balanceAfterPrepare + feeEstimate
        const balanceAfterRefund = balanceAfterDepositFee + (actualFee - feeEstimate)
        await this.plugin._handlePrepareResponse(this.mockAccountAddress, this.mockIlpPacketFulfill, this.mockIlpPacketPrepare)
        expect(this.plugin._log.trace.mock.calls[2][0])
          .toEqual(`Updated balance for account ${this.mockAccountName} to reflect difference of ${actualFee - feeEstimate} gwei between actual and estimated transaction fees`)
        expect(parseInt(this.mockAccount.balance)).toEqual(balanceAfterRefund)
        expect(this.plugin._log.trace.mock.calls[3][0])
          .toEqual(this.preError + 'Trace: insufficient balance to trigger settlement.')
      })
    })

    describe('after funding:', () => {
      test('throw if machinomy selected wrong payment channel for claim', async () => {
        this.mockNextPaymentResult.payment.channelId = '0x00'
        this.mockIlpPrepare.amount = '40000'
        this.mockAccount.ethereumAddress = this.plugin._address
        await this.plugin._handlePrepareResponse(this.mockAccountAddress, this.mockIlpPacketFulfill, this.mockIlpPacketPrepare)
        expect(this.plugin._log.error.mock.calls[0][0])
          .toEqual(this.preError + 'Error: Machinomy selected the wrong payment channel for claim; database may need to be cleared.')
      })

      test('if settleThreshold is 0, and full amount could be settled, final balance = 0', async () => {
        this.mockIlpPrepare.amount = '40000'
        this.mockAccount.ethereumAddress = this.plugin._address
        await this.plugin._handlePrepareResponse(this.mockAccountAddress, this.mockIlpPacketFulfill, this.mockIlpPacketPrepare)
        expect(parseInt(this.mockAccount.balance)).toEqual(0)
        expect(this.plugin._call.mock.calls.length).toEqual(1)
      })
    })
  })

  /**
   * _handleMoney
   *
   * throw error if no machinomy protocol is present
   * throw if acct has different incoming channel than the one in payment
   * throw if the channel in the payment could not be fetched
   * use new channel for acct, and update balance to reflect amount to credit ourselves
   */
  describe('_handleMoney', () => {
    beforeEach(() => {
      this.paymentValue = new BigNumber(100000000)
      this.mockBtpPacketMachinomy = {
        requestId: 0,
        type: BtpPacket.TYPE_TRANSFER,
        data: {
          protocolData: [{
            protocolName: 'machinomy',
            contentType: BtpPacket.MIME_APPLICATION_JSON,
            data: Buffer.from(JSON.stringify({
              channelId: '0x42',
              value: this.paymentValue
            }))
          }]
        }
      }

      this.plugin._log.trace = jest.fn()
      this.plugin._machinomy.acceptPayment = jest.fn().mockResolvedValue({})
      this.plugin._machinomy.channelById = jest.fn().mockResolvedValue(this.mockChannel)
    })

    test('throw if no machinomy protocol is present', async () => {
      await expect(this.plugin._handleMoney(this.mockAccountAddress, this.mockBtpPacketInfo))
        .rejects
        .toThrow('BTP TRANSFER packet did not include any Machinomy subprotocol data')
    })

    test('throw if acct has different incoming channel than the one in payment', async () => {
      this.mockAccount.incomingChannelId = '0x43'
      await expect(this.plugin._handleMoney(this.mockAccountAddress, this.mockBtpPacketMachinomy))
        .rejects
        .toThrow(`Account ${this.mockAccountName} must use channel ${this.mockAccount.incomingChannelId}`)
    })

    test('throw if the channel in the payment could not be fetched', async () => {
      this.plugin._machinomy.channelById = jest.fn().mockResolvedValue(null)
      await expect(this.plugin._handleMoney(this.mockAccountAddress, this.mockBtpPacketMachinomy))
        .rejects
        .toThrow('Channel from payment could not be fetched')
    })

    test('use new channel for acct, and update balance to reflect amount to credit ourselves', async () => {
      const oldBalance = this.mockAccount.balance
      await this.plugin._handleMoney(this.mockAccountAddress, this.mockBtpPacketMachinomy)
      expect(this.mockAccount.balance).toEqual(oldBalance.minus(this.paymentValue.shift(-9))) // convert to gwei
      expect(this.mockAccount.incomingChannelId).toEqual('0x42')
    })
  })

  /**
   * _startWatcher
   *
   * default polling period calculation ~50min
   * account that begins to settle is successfully blocked
   * claim occurs only if channel in settling state is profitable
   */
  describe('_startWatcher', () => {
    beforeEach(() => {
      jest.useFakeTimers()
      this.mockChannel.spent = new BigNumber(100000)
      this.plugin._machinomy.settlingChannels = jest.fn().mockResolvedValue([this.mockChannel])
      this.plugin._machinomy.close = jest.fn().mockResolvedValue({})
      this.plugin._estimateFee = jest.fn().mockResolvedValue(new BigNumber(20000))
    })

    test('default polling period calculation ~50min', () => {
      this.plugin._startWatcher()
      const fiftyMinutes = setInterval.mock.calls[0][1] / 1000 / 60
      expect(fiftyMinutes).toBeCloseTo(50.4)
    })

    test('account that begins to settle is successfully blocked', async () => {
      this.mockAccount.incomingChannelId = '0x42'
      expect(this.mockAccount.isBlocked).toBeFalsy()
      this.plugin._startWatcher()
      jest.runOnlyPendingTimers()
      await new Promise(resolve => setImmediate(resolve))
      expect(this.mockAccount.isBlocked).toBeTruthy()
    })

    test('claim occurs only if channel in settling state is profitable', async () => {
      this.plugin._startWatcher()
      jest.runOnlyPendingTimers()
      await new Promise(resolve => setImmediate(resolve))
      expect(this.plugin._machinomy.close).toHaveBeenCalled()
      this.plugin._machinomy.close.mockReset()

      this.plugin._estimateFee.mockResolvedValue(new BigNumber(200000))
      this.plugin._startWatcher()
      jest.runOnlyPendingTimers()
      await new Promise(resolve => setImmediate(resolve))
      expect(this.plugin._machinomy.close).not.toHaveBeenCalled()
    })
  })

  /**
   * _disconnect
   *
   * store cache is clear on disconnect and all accounts moved to store
   */
  describe('_disconnect', () => {
    test('store cache is clear on disconnect and all accounts moved to store', async () => {
      this.mockAccount.balance = 10
      expect(this.plugin._store._cache.get(this.mockAccountName)).toBe(JSON.stringify(this.mockAccount))
      await this.plugin._disconnect()
      expect(this.plugin._store._cache.get(this.mockAccountName)).toBeUndefined()
      expect(await this.plugin._store._store.get(this.mockAccountName))
        .toBe(JSON.stringify(this.mockAccount))
    })
  })
})
