import EthereumAccount from '../account'
import { PluginInstance, PluginServices } from '../types/plugin'
import MiniAccountsPlugin from 'ilp-plugin-mini-accounts'
import { ServerOptions } from 'ws'
import { IldcpResponse } from 'ilp-protocol-ildcp'
import { BtpPacket, BtpSubProtocol } from 'ilp-plugin-btp'
import { IlpPacket, IlpPrepare, Type, isPrepare } from 'ilp-packet'

export interface MiniAccountsOpts {
  port?: number
  wsOpts?: ServerOptions
  debugHostIldcpInfo?: IldcpResponse
  allowedOrigins?: string[]
}

export interface EthereumServerOpts extends MiniAccountsOpts {
  getAccount: (accountName: string) => EthereumAccount
  loadAccount: (accountName: string) => Promise<EthereumAccount>
}

export class EthereumServerPlugin extends MiniAccountsPlugin
  implements PluginInstance {
  private getAccount: (address: string) => EthereumAccount
  private loadAccount: (address: string) => Promise<EthereumAccount>

  constructor(
    { getAccount, loadAccount, ...opts }: EthereumServerOpts,
    api: PluginServices
  ) {
    super(opts, api)

    this.getAccount = (address: string) =>
      getAccount(this.ilpAddressToAccount(address))
    this.loadAccount = (address: string) =>
      loadAccount(this.ilpAddressToAccount(address))
  }

  _sendMessage(accountName: string, message: BtpPacket) {
    return this._call(this._prefix + accountName, message)
  }

  async _connect(address: string, message: BtpPacket): Promise<void> {
    await this.loadAccount(address)
  }

  _handleCustomData = async (
    from: string,
    message: BtpPacket
  ): Promise<BtpSubProtocol[]> => {
    return this.getAccount(from).handleData(message)
  }

  _handlePrepareResponse = async (
    destination: string,
    responsePacket: IlpPacket,
    preparePacket: {
      type: Type.TYPE_ILP_PREPARE
      typeString?: 'ilp_prepare'
      data: IlpPrepare
    }
  ) => {
    if (isPrepare(responsePacket.data)) {
      throw new Error('Received PREPARE in response to PREPARE')
    }

    return this.getAccount(destination).handlePrepareResponse(
      preparePacket.data,
      responsePacket.data
    )
  }

  async _close(from: string): Promise<void> {
    return this.getAccount(from).disconnect()
  }
}
