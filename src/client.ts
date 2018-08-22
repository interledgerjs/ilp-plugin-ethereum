import EthereumAccount, { requestId } from './account'
import { PluginInstance } from './types'
import BtpPlugin, { BtpPacket, BtpSubProtocol } from 'ilp-plugin-btp'
const BtpPacket = require('btp-packet')
import * as IlpPacket from 'ilp-packet'
import EthereumPlugin = require('.')

export default class EthereumClientPlugin extends BtpPlugin implements PluginInstance {
  private _account: EthereumAccount
  private _master: EthereumPlugin

  // TODO Add type info for opts
  constructor (opts: any) {
    super({
      responseTimeout: 3500000, // TODO what is reasonable?
      ...opts
    })

    this._master = opts.master

    this._account = new EthereumAccount({
      master: opts.master,
      accountName: '', // TODO what should be here?
      sendMessage: (message: BtpPacket) =>
        this._call('', message)
    })
  }

  // TODO depending upon receiveOnly, open a paychan on connect
  async _connect (): Promise<void> {
    await this._account.connect()
    if (!this._master._receiveOnly) {
      return this._account.fundOutgoingChannel()
    }
  }

  _handleData (from: string, message: BtpPacket): Promise<BtpSubProtocol[]> {
    return this._account.handleData(message)
  }

  _handleMoney (from: string, message: BtpPacket): Promise<BtpSubProtocol[]> {
    return this._account.handleMoney(message)
  }

  // TODO Add error handling to catch ILP error packets in the response
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
