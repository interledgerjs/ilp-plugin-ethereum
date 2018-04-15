const Plugin = require('..')
const IlDcp = require('ilp-protocol-ildcp')
const HDWalletProvider = require('truffle-hdwallet-provider')
if (typeof process.env.RINKEBY_PROVIDER_URL == 'undefined' || typeof process.env.SECRET == 'undefined') {
  console.error('Please set the RINKEBY_PROVIDER_URL and SECRET env vars!')
  process.exit(1)
}
// class ObjStore {
//   constructor (init) {
//     this.s = init || {}
//   }
//   // this simple store just uses an javascript object to store things in memory.
// 
//   get (k) {
//     return Promise.resolve(this.s[k])
//   }
// 
//   put (k, v) {
//     this.s[k] = v
//     return Promise.resolve(null)
//   }
// 
//   del (k) {
//     delete this.s[k]
//     return Promise.resolve(null)
//   }
// }

console.log('creating provider')
const provider = new HDWalletProvider(process.env.SECRET, process.env.RINKEBY_PROVIDER_URL)
console.log(provider)
// const account = '0x' + provider.address.substring(2).toUpperCase()
const account = '0x' + provider.address.substring(2).toLowerCase()
console.log('Starting server, account:', account)

const plugin = new Plugin({
  account,
  provider,
  port: 6666, // port to listen for incoming connections on
//  _store: new ObjStore(), // store for ILP balance and account info
  minimumChannelAmount: '10000', // amount with which to fund the channel
  debugHostIldcpInfo: {
    clientAddress: 'g.testing',
    assetCode: 'ETH',
    assetScale: 10
  }
})
console.log('connecting')
plugin.connect().then(async () => {
  console.log('connected')
  // const request = IlDcp.serializeIldcpRequest()
  // const response = await plugin.sendData(request)
  // const info = IlDcp.deserializeIldcpResponse(response)
  // plugin.registerDataHandler(packet => {
  //   const prepare = IlpPacket.deserializeIlpPrepare(packet)
  //   console.log(prepare)
  //   return IlpPacket.serializeIlpFulfill({ fulfillment: fulfillment, data: Buffer.from([]) })
  // })
  plugin.registerMoneyHandler(packet => {
    console.log('got money!', packet)
    plugin.disconnect()
  })
}, err => console.log(err))
