# Interledger Ethereum Payment Channel Plugin

[![NPM Package](https://img.shields.io/npm/v/ilp-plugin-ethereum.svg?style=flat-square&logo=npm)](https://npmjs.org/package/ilp-plugin-ethereum)
[![CircleCI](https://img.shields.io/circleci/project/github/interledgerjs/ilp-plugin-ethereum/master.svg?style=flat-square&logo=circleci)](https://circleci.com/gh/interledgerjs/ilp-plugin-ethereum/master)
[![Codecov](https://img.shields.io/codecov/c/github/interledgerjs/ilp-plugin-ethereum/master.svg?style=flat-square&logo=codecov)](https://codecov.io/gh/interledgerjs/ilp-plugin-ethereum)
[![Prettier](https://img.shields.io/badge/code_style-prettier-brightgreen.svg?style=flat-square)](https://prettier.io/)
[![Apache 2.0 License](https://img.shields.io/github/license/interledgerjs/ilp-plugin-ethereum.svg?style=flat-square)](https://github.com/interledgerjs/ilp-plugin-ethereum/blob/master/LICENSE)

🚨 **Expect breaking changes while this plugin is in beta.**

## Overview

Settle Interledger packets with streaming micropayments of ETH or an ERC-20 token.

Two plugins peer with one another over WebSockets and exchange Interledger packets denominated in ETH or a particular ERC-20 token. One or both peers may collateralize a unidirectional, or one-way payment channel from themselves to the other peer. Then, they may send settlements as payment channel claims at configurable frequency. Two peers may extend nearly no credit to one another and require settlements before or after every ILP packet, or extend greater credit to one another and settle less frequently.

[Machinomy smart contracts](https://github.com/machinomy/machinomy/tree/master/packages/contracts/contracts) are used for the unidirectional ETH and ERC-20 payment channels.

## Install

```bash
npm install ilp-plugin-ethereum
```

Node.js 10+ is required.

## Roadmap

- [x] ETH payment channel client
- [x] Optimizations for streaming payments
- [x] ERC-20 payment channel client
- [ ] More robust testing
- [ ] Refactor plugin architecture to use HTTP-based interface
- [ ] Eliminate internal boilerplate code
- [ ] Update Machinomy contract to support MetaMask and hardware wallets
- [ ] Smart liquidity management and negotiation for incoming capacity
- [ ] Audit codebase

## API

Here are the available options to pass to the plugin. Additional configuration options are also inherited from [ilp-plugin-btp](https://github.com/interledgerjs/ilp-plugin-btp) if the plugin is a client, and [ilp-plugin-mini-accounts](https://github.com/interledgerjs/ilp-plugin-mini-accounts) if the plugin is a server.

All ILP packet amounts and accounting must use units of _gwei_, or units to 9 decimal places (wei was such a small unit that it introduced issues calculating an exchange rate). For payment channel claims, the plugin converts the amount into wei, or if using an ERC-20 token, converts to the number of decimal places of the token.

#### `ethereumPrivateKey`

- **Required**
- Type: `string`
- Private key of the Ethereum account used to sign transactions, corresponding to the address which peers must open channels to

#### `ethereumProvider`

- Type:
  - `"homestead"` to use Infura & Etherscan on mainnet
  - `"ropsten"` to use Infura & Etherscan on the Ropsten proof of work testnet
  - `"kovan"` to use Infura & Etherscan on the Kovan proof of authority testnet (Parity)
  - `"rinkeby"` to use Infura & Etherscan on the Rinkeby proof of authority testnet (Geth)
  - [`ethers.providers.Provider`](https://docs.ethers.io/ethers.js/html/api-providers.html) to supply a custom provider
- Default: `"homestead"`
- Provider used to connect to an Ethereum node for a particular chain/testnet

#### `ethereumWallet`

- Type: [`ethers.Wallet`](https://docs.ethers.io/ethers.js/html/api-wallet.html)
- [Ethers wallet](https://docs.ethers.io/ethers.js/html/api-wallet.html) used to sign transactions
- Must be connected to a provider to query the network
- Supercedes and may be provided in lieu of `ethereumPrivateKey` and `ethereumProvider`

#### `role`

- Type:
  - `"client"` to connect to a single peer or server that is explicity specified
  - `"server"` to enable multiple clients to openly connect to the plugin
- Default: `"client"`

> ### Settlement
>
> Clients do not automatically open channels, nor settle automatically. Channels must be funded or closed through the internal API of the plugin. Sending payment channel claims can be triggered by invoking `sendMoney` on the plugin, and the money handler is called upon receipt of incoming payment channel claims (set using `registerMoneyHandler`).
>
> Servers _do_ automatically open channels. If a client has opened a channel with a value above the configurable `minIncomingChannelAmount`, the server will automatically open a channel back to the client with a value of `outgoingChannelAmount`. When the channel is half empty, the server will also automatically top up the value of the channel by the `outgoingChannelAmount`.
>
> The balance configuration has been simplified for servers. Clients must prefund before sending any packets through a server, and if a client fulfills packets sent to them through a server, the server will automatically settle such that they owe 0 to the client. This configuration was chosen because it assumes the server would extend no credit to an anonymous client, and clients extend little credit to servers, necessitating frequent settlements.
>
> ### Closing Channels
>
> Both clients and servers operate a channel watcher to automatically close a disputed channel if it's profitable to do so, and both will automatically claim channels if the other peer requests one to be closed.
>
> ### Transaction Fees
>
> In the current version of this plugin, there is no accounting for transaction fees on servers. In previous versions, transaction fees where added to the client's balance, which forced them to prefund the fee, but this made accounting nearly impossible from the client's perspective: it was opaque, and there was no negotiation. The balances of the two peers would quickly get out of sync.
>
> Since clients must manually open & close channels, they do have the ability to authorize transaction fees before sending them to the chain.
>
> ### Future Work
>
> The current model introduces problems with locking up excessive liquidity for servers, and doesn't provide sufficient denial of service protections against transaction fees. Ultimately, clients will likely have to purchase incoming capacity (possibly by amount and/or time) through prefunding the server, and pay for the server's transaction fees to open and close a channel back to them. However, this may require a more complex negotiation and fee logic that is nontrivial to implement.

#### `tokenAddress`

- Type: `string`
- Ethereum address of the ERC-20 token contract
- Used to send and receive a particular ERC-20 token asset, instead of ether
- Each payment channel can be used with only ETH, or only a predefined ERC-20 token

#### `contractAddress`

- Type: `string`
- Custom Ethereum address for the Machinomy payment channel contact
- Useful for private blockchains or testing with Ganache

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

While the channel is open, the sender may begin the dispute period. If the receiver does not claim the channel before the specified number of blocks elapses and the dispute period ends, all the funds can go back to the sender. Disputing a channel can be useful if the receiver is unresponsive or excessive collateral is locked up.

#### `minIncomingDisputePeriod`

- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `17280` blocks, or approximately 3 days, assuming 15 second blocks
- Minimum number of blocks for the dispute period in order to accept an incoming channel

In case the sender starts a dispute period, the receiver may want to allot themselves enough time to claim the channel. Incoming claims from channels with dispute periods below this floor will be rejected outright.
