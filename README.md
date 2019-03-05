# Interledger Ethereum Plugin

[![NPM Package](https://img.shields.io/npm/v/ilp-plugin-ethereum/next.svg?style=flat)](https://npmjs.org/package/ilp-plugin-ethereum)
[![CircleCI](https://img.shields.io/circleci/project/github/interledgerjs/ilp-plugin-ethereum.svg)](https://circleci.com/gh/interledgerjs/ilp-plugin-ethereum)
[![Codecov](https://img.shields.io/codecov/c/github/interledgerjs/ilp-plugin-ethereum.svg)](https://codecov.io/gh/interledgerjs/ilp-plugin-ethereum)
[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)
[![Apache 2.0 License](https://img.shields.io/github/license/interledgerjs/ilp-plugin-ethereum.svg)](https://github.com/interledgerjs/ilp-plugin-ethereum/blob/master/LICENSE)

🚨 **Expect breaking changes while this plugin is in beta.**

## Overview

Settle Interledger payments with ether and (soon!) ERC-20 tokens. Powered by [Machinomy smart contracts](https://github.com/machinomy/machinomy) for unidirectional payment channels.

## Install

```bash
npm install ilp-plugin-ethereum@next
```

## API

Here are the available options to pass to the plugin. Additional configuration options are also inherited from [ilp-plugin-btp](https://github.com/interledgerjs/ilp-plugin-btp) if the plugin is a client, and [ilp-plugin-mini-accounts](https://github.com/interledgerjs/ilp-plugin-mini-accounts) if the plugin is a server.

This plugin uses an asset scale of 9 and units of _gwei_, and **not** 18, or wei, as wei is such a small unit that it introduced issues calculating the exchange rate.

#### `ethereumPrivateKey`

- **Required**
- Type: `string`
- Private key of the Ethereum account used to sign transactions, corresponding to the address which peers must open channels to

#### `ethereumProvider`

- Type: `string` or [`Web3.Provider`](https://web3js.readthedocs.io/en/1.0/web3.html#providers)
- Default: `"wss://mainnet.infura.io/ws"`
- [Web3 1.0 provider](https://web3js.readthedocs.io/en/1.0/web3.html#providers) used to connect to an Ethereum node

#### `role`

- Type:
  - `"client"` to connect to a single peer or server that is explicity specified
  - `"server"` to enable multiple clients to openly connect to the plugin
- Default: `"client"`

### Settlement

Clients do not automatically open channels, nor settle automatically. Channels must be funded or closed through the internal API of the plugin. Sending payment channel claims can be triggered by invoking `sendMoney` on the plugin, and the money handler is called upon receipt of incoming payment channel claims (set using `registerMoneyHandler`).

Servers _do_ automatically open channels. If a client has opened a channel with a value above the configurable `minIncomingChannelAmount`, the server will automatically open a channel back to the client with a value of `outgoingChannelAmount`. When the channel is half empty, the server will also automatically top up the value of the channel to the `outgoingChannelAmount`.

The balance configuration has been simplified for servers. Clients must prefund before sending any packets through a server, and if a client fulfills packets sent to them through a server, the server will automatically settle such that they owe 0 to the client. This configuration was chosen as a default due to it's security and protection against deadlocks.

### Closing Channels

Both clients and servers operate a channel watcher to automatically close a disputed channel if it's profitable to do so, and both will automatically claim channels if the other peer requests one to be closed.

### Transaction Fees

In the current version of this plugin, there is no accounting for transaction fees on servers. In previous versions, transaction fees where added to the client's balance, which forced them to prefund the fee, but this made accounting nearly impossible from the client's perspective: it was opaque, and there was no negotiation. The balances of the two peers would quickly get out of sync.

Since clients must manually open & close channels, they do have the ability to authorize transaction fees before sending them to the chain.

### Future Work

The current model introduces problems with locking up excessive liquidity for servers, and doesn't provide sufficient denial of service protections against transaction fees. Ultimately, clients will likely have to purchase incoming capacity (possibly by amount and/or time) through prefunding the server, and pay for the server's transaction fees to open and close a channel back to them. However, this may require a more complex negotiation and fee logic that is nontrivial to implement.

The ILP connector/plugin architecture is likely going to be refactored in the near future, which should simplify the external interface, enable multi-process plugins, and eliminate some of the internal boilerplate code.

#### `maxPacketAmount`

- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `Infinity`
- Maximum amount in _gwei_ above which an incoming packet should be rejected

#### `outgoingChannelAmount`

- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `50000000` gwei, or 0.05 ether
- Amount in _gwei_ to use as a default to fund an outgoing channel up to
- Note: this is primarily relevant to servers, since clients that don't automatically open channels may manually specify the amount

#### `minIncomingChannelAmount`

- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `Infinity` gwei (channels will never automatically be opened)
- Value in _gwei_ that a peer's incoming channel must exceed if an outgoing channel to the peer should be automatically opened

#### `channelWatcherInterval`

- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default `60000` ms, or 1 minute
- Number of milliseconds between each run of the channel watcher, which checks if the peer started a dispute and if so, claims the channel if it's profitable

#### `outgoingDisputePeriod`

- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `34560` blocks, or approximately 6 days, assuming 15 second blocks
- Number of blocks for dispute period when opening new outgoing channels

While the channel is open, the sender may begin the dispute period. If the receiver does not claim the channel before the specified number of blocks elapses and the settling period ends, all the funds can go back to the sender. Settling a channel can be useful if the receiver is unresponsive or excessive collateral is locked up.

#### `minIncomingDisputePeriod`

- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `17280` blocks, or approximately 3 days, assuming 15 second blocks
- Minimum number of blocks for the dispute period in order to accept an incoming channel

In case the sender starts settling, the receiver may want to allot themselves enough time to claim the channel. Incoming claims from channels with dispute periods below this floor will be rejected outright.
