const Plugin = require('.')
const IlpPacket = require('ilp-packet')
const Store = require('ilp-store-memory')
const plugin = new Plugin({
  account: '0x1dd0684d785785d8bd4797450d3487dae5c8d406',
  port: 6666,
  _store: new Store(),
  debugHostIldcpInfo: {
    clientAddress: 'test.example',
    assetCode: 'ETH',
    assetScale: 18
  }
})

const fulfillment = Buffer.from(
  'Qc4XjnucqgbulbDxZsZrJc3ddA8PsLEaILMSSMVSfJM', 'base64')
const condition = require('crypto')
  .createHash('sha256')
  .update(fulfillment)
  .digest()

async function run () {
  await plugin.connect()
  await new Promise(resolve => setTimeout(resolve, 10000))
  console.log('GOT A PAYMENT FOR THIS AMOUNT')
  await plugin.sendData(IlpPacket.serializeIlpPrepare({
    destination: 'test.example.K7gNU3sdo-OL0wNhqoVWhr3g6s1xYv72ol_pe_Unols',
    amount: '50',
    executionCondition: condition,
    expiresAt: new Date(Date.now() + 10000),
    data: Buffer.alloc(0)
  }))
}

run()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
