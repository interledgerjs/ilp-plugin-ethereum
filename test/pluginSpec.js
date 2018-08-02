'use strict'

const PluginEthAsymServer = require('..')
const Store = require('./util/memStore')
const HDWalletProvider = require('truffle-hdwallet-provider')

const SECRET = "lazy glass net matter square melt fun diary network bean play deer"
const PROVIDER_URL = "https://ropsten.infura.io/T1S8a0bkyrGD7jxJBgeH"

function createPlugin(opts = {}) {
  return new PluginEthAsymServer(Object.assign({
    prefix: 'test.example',
    provider: () => new HDWalletProvider(SECRET, PROVIDER_URL, 0),
    account: '0xad217fb704030c8465682c3b1a6ac3ed56bff8ab',
    minimumChannelAmount: 1000000,
    maxPacketAmount: 1000000, 
    _store: new Store(null, 'test.example'),
    debugHostIldcpInfo: {
      clientAddress: 'test.example',
      assetScale: 9,
      assetCode: 'ETH'
    }
  }, opts))
}

describe('pluginSpec', () => {

  describe('constructor', function () {
    it('should throw if currencyScale is neither undefined nor a number', function () {
      assert.throws(() => createPlugin({ currencyScale: 'oaimwdaiowdoamwdaoiw' }),
        /currency scale must be a number if specified/)
    })
  })

  beforeEach(async function () {
  })

  afterEach(async function () {
  })

  describe('validate channel details', () => {
    beforeEach(function () {
    })

    it('should not accept a channel with a short settle delay', function () {
    })

    it('should not accept a channel with a cancelAfter', function () {
    })

    it('should not accept a channel with an expiration', function () {
    })

    it('should not accept a channel for someone else', function () {
    })

    it('should accept a channel which does not have any flaws', function () {
    })
  })

  describe('channel close', () => {
    beforeEach(async function () {
    })

    it('should call channelClose when close event is emitted', async function () {
    })

    it('should submit the correct claim tx on channel close', async function () {
    })
  })

  describe('handle custom data', () => {
    describe('channel protocol', () => {
      beforeEach(async function () {
      })

      it('does not race when assigning a channel to an account', async function () {
      })

      it('don\'t throw if an account associates the same paychan again', async function () {
      })
    })
  })

  describe('connect account', () => {
    beforeEach(function () {
    })

    it('should check for existing paychan', async function () {
    })

    it('should reject and give block reason if account blocked', async function () {
    })

    it('should load details for existing paychan', async function () {
    })

    it('should load lastClaimedAmount successfully', async function () {
    })

    it('should delete persisted paychan if it does not exist on the ledger', async function () {
    })
  })

  describe('get extra info', () => {
    beforeEach(async function () {
    })

    it('should return channel if it exists', function () {
    })

    it('should return client channel if it exists', function () {
    })

    it('should return full address', function () {
    })
  })

  describe('channel claim', () => {
    beforeEach(async function () {
    })

    it('should create a fund transaction with proper parameters', async function () {
    })

    it('should scale the claim amount appropriately', async function () {
    })

    it('should give an error if submit fails', async function () {
    })

    it('should not auto claim when more has been claimed than the plugin thought', async function () {
    })
  })

  describe('handle money', () => {
    beforeEach(async function () {
    })

    it('should throw error if no claim protocol is present', function () {
    })

    it('should throw error if claim protocol is empty', function () {
    })

    it('should pass claim to _handleClaim if present', function () {
    })

    describe('_handleClaim', () => {
      beforeEach(function () {
      })

      it('should throw if the signature is not valid', function () {
      })

      it('should throw if the signature is for a higher amount than the channel max', function () {
      })

      it('should not save the claim if it is lower than the previous', function () {
      })

      it('should save the claim if it is higher than the previous', function () {
      })
    })
  })

  describe('send money', () => {
    beforeEach(async function () {
    })

    describe('_sendMoneyToAccount', () => {
      it('should return a claim for a higher balance', function () {
      })

      describe('with high scale', function () {
        beforeEach(function () {
        })

        it('should round high-scale amount up to next drop', async function () {
        })

        it('should scale up low-scale amount', async function () {
        })

        it('should keep error under a drop even on repeated roundings', async function () {
        })

        it('should handle a claim', async function () {
        })
      })

      it('should not issue a fund if the amount is below the threshold', function () {
      })

      it('should issue a fund if the amount is above the threshold', function () {
      })

      it('reloads client\'s paychan details after funding', async function () {
      })
    })
  })

  describe('handle custom data', () => {
    beforeEach(async function () {
    })

    it('should return a reject if the packet is too big', async function () {
    })

    it('should return a reject if insufficient bandwidth', async function () {
    })

    it('should return a reject if there is no channel to peer', async function () {
    })
  })

  describe('auto claim logic', () => {
    beforeEach(async function () {
    })

    it('should auto claim when amount is more than 100 * fee + last claim', async function () {
    })

    it('should not auto claim when amount is less than 100 * fee + last claim', async function () {
    })

    describe('with high scale', () => {
      beforeEach(function () {
      })

      it('should auto claim when amount is more than 100 * fee + last claim', async function () {
      })

      it('should not auto claim when amount is less than 100 * fee + last claim', async function () {
      })
    })
  })

  describe('handle prepare response', () => {
    beforeEach(async function () {
    })

    it('should handle a prepare response (fulfill)', async function () {
    })

    it('should ignore fulfillments for zero-amount packets', async function () {
    })

    it('should handle a prepare response on which transfer fails', async function () {
    })

    it('should handle a prepare response (non-fulfill)', async function () {
    })

    it('should handle a prepare response (invalid fulfill)', async function () {
    })

    it('should handle a prepare response (no channel to client)', async function () {
    })
  })

  describe('Account', function () {
    beforeEach(function () {
    })

    it('should block the account if the store says so', async function () {
    })

    it('should set to ESTABLISHING_CHANNEL if no channel exists', async function () {
    })

    it('should load channel from ledger if it exists', async function () {
    })

    it('should retry call to ledger if channel gives timeout', async function () {
    })

    it('should retry call to ledger if client channel gives timeout', async function () {
    })
  })
})
