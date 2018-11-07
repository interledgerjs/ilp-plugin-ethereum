import EthereumPlugin from '.'
import EthereumAccount, { requestId } from './account'
import BtpPlugin, { BtpPacket, BtpSubProtocol } from 'ilp-plugin-btp'
import MiniAccountsPlugin from 'ilp-plugin-mini-accounts'
import { PluginInstance, PluginServices } from './utils/types'
import * as IlpPacket from 'ilp-packet'
const BtpPacket = require('btp-packet')

export class EthereumClientPlugin extends BtpPlugin implements PluginInstance {
  private _account: EthereumAccount

  constructor (opts: any, api: PluginServices) {
    super(opts, api)

    this._account = new EthereumAccount({
      master: opts.master,
      accountName: 'server',
      sendMessage: (message: BtpPacket) =>
        this._call('', message),
      dataHandler: (data: Buffer) => {
        if (typeof this._dataHandler !== 'function') {
          throw new Error('no request handler registered')
        }

        return this._dataHandler(data)
      },
      moneyHandler: (amount: string) => {
        if (typeof this._moneyHandler !== 'function') {
          throw new Error('no money handler registered')
        }

        return this._moneyHandler(amount)
      }
    })
  }

  async _connect (): Promise<void> {
    return this._account.connect()
  }

  _handleData (from: string, message: BtpPacket): Promise<BtpSubProtocol[]> {
    return this._account.handleData(message)
  }

  _handleMoney (from: string, message: BtpPacket): Promise<BtpSubProtocol[]> {
    return this._account.handleMoney(message)
  }

  // Add hooks into sendData before and after sending a packet for balance updates and settlement, akin to mini-accounts
  async sendData (buffer: Buffer): Promise<Buffer> {
    const preparePacket = IlpPacket.deserializeIlpPacket(buffer)

    const response = await this._call('', {
      type: BtpPacket.TYPE_MESSAGE,
      requestId: await requestId(),
      data: {
        protocolData: [{
          protocolName: 'ilp',
          contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
          data: buffer
        }]
      }
    })

    const ilpResponse = response.protocolData.find(p => p.protocolName === 'ilp')
    if (ilpResponse) {
      const responsePacket = IlpPacket.deserializeIlpPacket(ilpResponse.data)
      this._account.handlePrepareResponse(preparePacket, responsePacket)
      return ilpResponse.data
    }

    return Buffer.alloc(0)
  }

  _disconnect (): Promise<void> {
    return this._account.disconnect()
  }
}

export class EthereumServerPlugin extends MiniAccountsPlugin implements PluginInstance {
  private _accounts: Map<string, EthereumAccount> // accountName -> account
  private _master: EthereumPlugin

  constructor (opts: any, api: PluginServices) {
    super(opts, api)

    this._master = opts.master
    this._accounts = new Map()
  }

  _getAccount (address: string) {
    const accountName = this.ilpAddressToAccount(address)
    let account = this._accounts.get(accountName)

    if (!account) {
      account = new EthereumAccount({
        accountName,
        master: this._master,
        sendMessage: (message: BtpPacket) =>
          this._call(address, message),
        dataHandler: (data: Buffer) => {
          if (typeof this._dataHandler !== 'function') {
            throw new Error('no request handler registered')
          }

          return this._dataHandler(data)
        },
        moneyHandler: (amount: string) => {
          if (typeof this._moneyHandler !== 'function') {
            throw new Error('no money handler registered')
          }

          return this._moneyHandler(amount)
        }
      })

      this._accounts.set(accountName, account)
    }

    return account
  }

  _connect (address: string, message: BtpPacket): Promise<void> {
    return this._getAccount(address).connect()
  }

  _handleCustomData = async (from: string, message: BtpPacket): Promise<BtpSubProtocol[]> =>
    this._getAccount(from).handleData(message)

  _handleMoney (from: string, message: BtpPacket): Promise<BtpSubProtocol[]> {
    return this._getAccount(from).handleMoney(message)
  }

  // @ts-ignore Different versions of ilp-packet between this and mini-accounts
  _handlePrepareResponse = (
    destination: string,
    responsePacket: IlpPacket.IlpPacket,
    preparePacket: IlpPacket.IlpPacket
  ): void =>
    this._getAccount(destination).handlePrepareResponse(preparePacket, responsePacket)

  _close (from: string): Promise<void> {
    return this._getAccount(from).disconnect()
  }
}
