import EthereumAccount from './account'
import { PluginInstance } from './types'
import { BtpPacket, BtpPacketData, BtpSubProtocol } from 'ilp-plugin-btp'
import MiniAccountsPlugin from 'ilp-plugin-mini-accounts'
import * as IlpPacket from 'ilp-packet'
import EthereumPlugin = require('.')

export default class EthereumServerPlugin extends MiniAccountsPlugin implements PluginInstance {
  private _accounts: Map<string, EthereumAccount> // accountName -> account
  private _master: EthereumPlugin

  // FIXME add type info for options
  constructor (opts: any) {
    super(opts)

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
        callMessage: (message: BtpPacket) =>
          this._call('', message),
        sendMessage: (message: BtpPacket) =>
          this._handleOutgoingBtpPacket('', message)
      })

      this._accounts.set(accountName, account)
    }

    return account
  }

  _connect (address: string, message: BtpPacket): Promise<void> {
    return this._getAccount(address).connect()
  }

  _handleCustomData = async (from: string, message: BtpPacket): Promise<BtpSubProtocol[]> =>
    this._getAccount(from).handleData(message, this._dataHandler)

  _handleMoney (from: string, message: BtpPacket): Promise<BtpSubProtocol[]> {
    return this._getAccount(from).handleMoney(message, this._moneyHandler)
  }

  _sendPrepare (destination: string, preparePacket: IlpPacket.IlpPacket) {
    return this._getAccount(destination).beforeForward(preparePacket)
  }

  _handlePrepareResponse = async (
    destination: string,
    responsePacket: IlpPacket.IlpPacket,
    preparePacket: IlpPacket.IlpPacket
  ): Promise<void> =>
    this._getAccount(destination).afterForwardResponse(preparePacket, responsePacket)

  _close (from: string): Promise<void> {
    return this._getAccount(from).disconnect()
  }

  // FIXME Add _disconnect (handler for when the plugin disconnects)
}
