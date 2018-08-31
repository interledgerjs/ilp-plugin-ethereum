# Interledger Ethereum Plugin

Settle Interledger payments with ether and ERC-20 tokens using [Machinomy smart contracts](https://github.com/machinomy/machinomy) for unidirectional payment channels

## Get Started

TODO

## Advanced

### Install

```bash
npm install ilp-plugin-ethereum
```

### Direct Peering

TODO

### Client

TODO

### Server

TODO -- I should probably explain the config, rather than example code...

```javascript
const EthereumPlugin = require('ilp-plugin-ethereum')
const Web3 = require('web3')

const web3 = new Web3('wss://mainnet.infura.io/ws')

const server = new EthereumPlugin({
  role: 'server',

})


```

## API

Here are the available options to pass to the plugin. Additional configuration options are also inherited from [ilp-plugin-btp](https://github.com/interledgerjs/ilp-plugin-btp) if the plugin is a client, and [ilp-plugin-mini-accounts](https://github.com/interledgerjs/ilp-plugin-mini-accounts) if the plugin is a server.

### ethereumAddress
- **Required**
- Type: `string`
- Ethereum address for sender of outgoing chanenls and receiver of incoming channels

### web3
- **Required**
- Type: [`Web3`](https://web3js.readthedocs.io/en/1.0/getting-started.html)
- Instance of [Web3 1.0](https://web3js.readthedocs.io/en/1.0/getting-started.html) with a provider and an unlocked account corresponding to the `ethereumAddress` option

Using [Infura](https://infura.io/) as a provider with private key:
```javascript
const Web3 = require('web3')
const web3 = new Web3('wss://mainnet.infura.io/ws')
web3.eth.accounts.wallet.add('0x3a0ef25c9e37b0bcb27deea570708b12b2939f7f703fe0caea03433b55806384')
```

Using a local Ethereum node with an unlocked account:
```javascript
const Web3 = require('web3')
const web3 = new Web3('ws://localhost:8546')
```

### role
- Type:
  - `'client'` to allow only a single peer that is explicity specified
  - `'server'` to enable multiple clients to openly connect to the plugin
- Default: `'client'`

### outgoingChannelAmount
- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `40000000` gwei, or 0.04 ether
- Amount in *gwei* to to use as a default to fund or deposit to an outgoing channel

### outgoingSettlementPeriod
- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `50400` blocks, or approximately 9 days, assuming 15 second blocks
- Number of blocks for settlement period when opening new outgoing channels

While the channel is open, the sender may begin the settlement period. If the receiver does not claim the channel before the specified number of blocks elapses and the settling period ends, all the funds can go back to the sender. Settling a channel can be useful if the receiver is unresponsive or excessive collateral is locked up.

### minIncomingSettlementPeriod
- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `40320` blocks, or approximately 1 week, assuming 15 second blocks
- Minimum number of blocks for the settlement period in order to accept an incoming channel

In case the sender starts settling, the receiver may want to allot themselves enough time to claim the channel. Incoming claims from channels with settlement periods below this floor will be rejected outright.

### maxPacketAmount
- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `Infinity`
- Maximum amount in *gwei* above which an incoming packet should be rejected

### balance

The balance (positive) is the net amount the counterparty/peer owes an instance of the plugin. A negative balance implies the plugin owes money to the counterparty.

All balance options are in *gwei*.

TODO explain max > settleTo, etc

#### maximum
- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `Infinity`
- TODO

#### settleTo
- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `0`
- Settlement attempts will increase the balance to the settleTo amount

#### settleThreshold
- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Automatically attempts to settle when the balance drops below this threshold
- By default, auto settlement is disabled, and the plugin is in receive-only mode

#### minimum
- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `-Infinity`
- TODO

TODO: add _store / _log
