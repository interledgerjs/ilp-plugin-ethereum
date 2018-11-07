# Interledger Ethereum Plugin

[![NPM Package](https://img.shields.io/npm/v/ilp-plugin-ethereum/next.svg?style=flat)](https://npmjs.org/package/ilp-plugin-ethereum)
[![CircleCI](https://img.shields.io/circleci/project/github/interledgerjs/ilp-plugin-ethereum.svg)](https://circleci.com/gh/interledgerjs/ilp-plugin-ethereum)
[![Codecov](https://img.shields.io/codecov/c/github/interledgerjs/ilp-plugin-ethereum.svg)](https://codecov.io/gh/interledgerjs/ilp-plugin-ethereum)
[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)
[![Apache 2.0 License](https://img.shields.io/github/license/interledgerjs/ilp-plugin-ethereum.svg)](https://github.com/interledgerjs/ilp-plugin-ethereum/blob/master/LICENSE)

Settle Interledger payments with ether and (soon!) ERC-20 tokens. Powered by [Machinomy smart contracts](https://github.com/machinomy/machinomy) for unidirectional payment channels.

## Install

```bash
npm install ilp-plugin-ethereum@next
```

## API

Here are the available options to pass to the plugin. Additional configuration options are also inherited from [ilp-plugin-btp](https://github.com/interledgerjs/ilp-plugin-btp) if the plugin is a client, and [ilp-plugin-mini-accounts](https://github.com/interledgerjs/ilp-plugin-mini-accounts) if the plugin is a server.

This plugin uses an asset scale of 9 and units of *gwei*, and **not** 18, or wei, as wei is such a small unit that it introduced issues calculating the exchange rate.

### `ethereumPrivateKey`
- **Required**
- Type: `string`
- Private key of the Ethereum account used to sign transactions, corresponding to the address which peers must open channels to

### `ethereumProvider`
- Type: `string` or [`Web3.Provider`](https://web3js.readthedocs.io/en/1.0/web3.html#providers)
- Default: `"wss://mainnet.infura.io/ws"`
- [Web3 1.0 provider](https://web3js.readthedocs.io/en/1.0/web3.html#providers) used to connect to an Ethereum node

### `role`
- Type:
  - `"client"` to connect to a single peer or server that is explicity specified
  - `"server"` to enable multiple clients to openly connect to the plugin
- Default: `"client"`

### `outgoingChannelAmount`
- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `40000000` gwei, or 0.04 ether
- Amount in *gwei* to to use as a default to fund or deposit to an outgoing channel

### `incomingChannelFee`
- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `0` gwei
- Fee collected when a new channel is first linked to an account, added to the balance of the peer prior to accepting the claim

A connector may charge such a fee to cover the cost of their transaction fee to later claim the channel. For example, if they received a claim for 1 gwei, they'd never be able to claim the channel, since the transaction fee would likely be far greater than the value of the claim, and therefore it wouldn't be worth their while to forward 1 gwei worth of payments.

### `outgoingSettlementPeriod`
- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `34560` blocks, or approximately 6 days, assuming 15 second blocks
- Number of blocks for settlement period when opening new outgoing channels

While the channel is open, the sender may begin the settlement period. If the receiver does not claim the channel before the specified number of blocks elapses and the settling period ends, all the funds can go back to the sender. Settling a channel can be useful if the receiver is unresponsive or excessive collateral is locked up.

### `minIncomingSettlementPeriod`
- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `17280` blocks, or approximately 3 days, assuming 15 second blocks
- Minimum number of blocks for the settlement period in order to accept an incoming channel

In case the sender starts settling, the receiver may want to allot themselves enough time to claim the channel. Incoming claims from channels with settlement periods below this floor will be rejected outright.

### `maxPacketAmount`
- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `Infinity`
- Maximum amount in *gwei* above which an incoming packet should be rejected

### `balance`

The balance (positive) is the net amount the counterparty/peer owes an instance of the plugin. A negative balance implies the plugin owes money to the counterparty.

Contrary to other plugins that require the balance middleware in [ilp-connector](https://github.com/interledgerjs/ilp-connector/) to trigger settlement, here, all the balance configuration is internal to the plugin. `sendMoney` is a no-operation on both the client and the server.

Thus, pre-funding—sending money to the peer *before* forwarding packets through them—requires a positive `settleTo` amount, and post-funding—settling *after* forwarding packets through them—requires a 0 or negative `settleTo` amount.

In this model, it is the sender's responsibility to fund above the fee its peer charges to accept a new incoming channel (up to `settleTo`), and it is the receiver's responsibility to fulfill packets above what its peer charges to open a new channel (up to `maximum`). Furthermore, even when using the plugin as a client, the fees to fund outgoing channels are debited (added) to the peer's balance, and must be accounted for in the `settleTo` amount.

All the following balance options are in units of *gwei*.

#### `maximum`
- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `Infinity`
- Maximum balance the counterparty owes this instance before further balance additions are rejected (e.g. settlements and forwarding of PREPARE packets with debits that increase balance above maximum the would be rejected)
- Must be greater than or equal to settleTo amount

#### `settleTo`
- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `0`
- Settlement attempts will increase the balance to this amount
- Must be greater than or equal to settleThreshold

#### `settleThreshold`
- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Automatically attempts to settle when the balance drops below this threshold (exclusive)
- By default, auto settlement is disabled, and the plugin is in receive-only mode
- Must be greater than or equal to the minimum balance

#### `minimum`
- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `-Infinity`
- Maximum this instance owes the counterparty before further balance subtractions are rejected (e.g. incoming money/claims and forwarding of FULFILL packets with credits that reduce balance below minimum would be rejected)
