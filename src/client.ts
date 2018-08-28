import EthereumAccount, { requestId } from './account'
import { PluginInstance } from './types'
import BtpPlugin, { BtpPacket, BtpSubProtocol } from 'ilp-plugin-btp'
const BtpPacket = require('btp-packet')
import * as IlpPacket from 'ilp-packet'
import EthereumPlugin = require('.')

export default class EthereumClientPlugin extends BtpPlugin implements PluginInstance {
  private _account: EthereumAccount
  private _master: EthereumPlugin // FIXME remove?

  // FIXME Add type info for opts
  constructor (opts: any) {
    super({
      responseTimeout: 3500000, // FIXME what is reasonable?
      ...opts
    })

    this._master = opts.master

    this._account = new EthereumAccount({
      master: opts.master,
      accountName: 'server', // FIXME what is the name of the server?
      sendMessage: (message: BtpPacket) =>
        this._call('', message)
    })
  }

  async _connect (): Promise<void> {
    await this._account.connect()
    await this._account.shareEthereumAddress()
    return this._account.attemptSettle()
  }

  _handleData (from: string, message: BtpPacket): Promise<BtpSubProtocol[]> {
    return this._account.handleData(message, this._dataHandler)
  }

  _handleMoney (from: string, message: BtpPacket): Promise<BtpSubProtocol[]> {
    return this._account.handleMoney(message, this._moneyHandler)
  }

  // FIXME Add error handling to catch ILP error packets in the response
  // Add hooks into sendData before and after sending a packet for balance updates and settlement, akin to mini-accounts
  async sendData (buffer: Buffer): Promise<Buffer> {
    const preparePacket = IlpPacket.deserializeIlpPacket(buffer)
    this._account.beforeForward(preparePacket)

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

    // FIXME What if there isn't an ILP response?
    const ilpResponse = response.protocolData
      .filter(p => p.protocolName === 'ilp')[0]
    const responsePacket = IlpPacket.deserializeIlpPacket(ilpResponse.data)

    await this._account.afterForwardResponse(preparePacket, responsePacket)

    return ilpResponse
      ? ilpResponse.data
      : Buffer.alloc(0)
  }

  _disconnect (): Promise<void> {
    return this._account.disconnect()
  }
}
