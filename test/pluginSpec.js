'use strict'

const PluginEthAsymServer = require('..')
const Store = require('./util/memStore')
const HDWalletProvider = require('truffle-hdwallet-provider')

const SECRET = "lazy glass net matter square melt fun diary network bean play deer"
const PROVIDER_URL = "https://ropsten.infura.io/T1S8a0bkyrGD7jxJBgeH"
    console.log(new HDWalletProvider(SECRET, PROVIDER_URL, 0).getAddress())

function createPlugin(opts = {}) {
  return new PluginEthAsymServer(Object.assign({
    provider: () => new HDWalletProvider(SECRET, PROVIDER_URL)
  }, opts))
}

console.log(createPlugin())
