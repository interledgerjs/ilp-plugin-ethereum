# ILP Plugin Ethereum Asym Server
> Server to Ethereum Asym Client

- [Description](#description)
- [Usage](#usage)

## Description

**This plugin is still under development. Don't use it for large amounts of money.**

This is an implementation of an ILP integration with Ethereum. It uses simple
unidirectional payment channels on Ethereum, by making use of the
[Machinomy](https://github.com/machinomy/machinomy) library.

One party must run this Asym Server, and then any number of clients can connect
by using [Ethereum Asym
Client](https://github.com/sharafian/ilp-plugin-ethereum-asym-client). Each
client opens a payment channel to this server, and will immediately send a
claim. This claim is to cover the transaction fee of the server opening a
channel to the client. The end result is that the server and client have two
payment channels, allowing either one to send and receive.

Interleger packets are passed over the websocket connection that the client and
server share, and then are periodically settled by passing claims over the
websocket connection. The [ILP
Connector](https://github.com/interledgerjs/ilp-connector) will manage this
logic for you.

## Usage

```sh
export RINKEBY_PROVIDER_URL=https://rinkeby.infura.io/2LQpDUsVeDqOZ8hvLzti
export SECRET=eepauZo4UTh2Iejuo9Aichahph0ooy5boojohtoh
npm install
DEBUG=* node scripts/server-infura.js
```

## For testing purposes 

```sh
export PROVIDER_URL=https://ropsten.infura.io/T1S8a0bkyrGD7jxJBgeH
export SECRET="lazy glass net matter square melt fun diary network bean play deer"
npm install
DEBUG=* node test-infura-sell.js
```
