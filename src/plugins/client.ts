import EthereumAccount, { generateBtpRequestId } from '../account'
import BtpPlugin, {
  BtpPacket,
  BtpSubProtocol,
  IlpPluginBtpConstructorOptions
} from 'ilp-plugin-btp'
import { TYPE_MESSAGE, MIME_APPLICATION_OCTET_STREAM } from 'btp-packet'
import { PluginInstance, PluginServices } from '../types/plugin'
import {
  isPrepare,
  deserializeIlpPrepare,
  deserializeIlpReply
} from 'ilp-packet'

export interface EthereumClientOpts extends IlpPluginBtpConstructorOptions {
  getAccount: (accountName: string) => EthereumAccount
  loadAccount: (accountName: string) => Promise<EthereumAccount>
}

export class EthereumClientPlugin extends BtpPlugin implements PluginInstance {
  private getAccount: () => EthereumAccount
  private loadAccount: () => Promise<EthereumAccount>

  constructor(
    { getAccount, loadAccount, ...opts }: EthereumClientOpts,
    { log }: PluginServices
  ) {
    super(opts, { log })

    this.getAccount = () => getAccount('peer')
    this.loadAccount = () => loadAccount('peer')
  }

  _sendMessage(accountName: string, message: BtpPacket) {
    return this._call('', message)
  }

  async _connect(): Promise<void> {
    await this.loadAccount()
  }

  _handleData(from: string, message: BtpPacket): Promise<BtpSubProtocol[]> {
    return this.getAccount().handleData(message)
  }

  // Add hooks into sendData before and after sending a packet for
  // balance updates and settlement, akin to mini-accounts
  async sendData(buffer: Buffer): Promise<Buffer> {
    const prepare = deserializeIlpPrepare(buffer)
    if (!isPrepare(prepare)) {
      throw new Error('Packet must be a PREPARE')
    }

    const response = await this._call('', {
      type: TYPE_MESSAGE,
      requestId: await generateBtpRequestId(),
      data: {
        protocolData: [
          {
            protocolName: 'ilp',
            contentType: MIME_APPLICATION_OCTET_STREAM,
            data: buffer
          }
        ]
      }
    })

    const ilpResponse = response.protocolData.find(
      p => p.protocolName === 'ilp'
    )
    if (ilpResponse) {
      const reply = deserializeIlpReply(ilpResponse.data)
      this.getAccount().handlePrepareResponse(prepare, reply)
      return ilpResponse.data
    }

    return Buffer.alloc(0)
  }

  _disconnect(): Promise<void> {
    return this.getAccount().disconnect()
  }
}
