import { EventEmitter2 } from 'eventemitter2'
import { Store } from '../utils/store'

export interface Logger {
  info(...msg: any[]): void
  warn(...msg: any[]): void
  error(...msg: any[]): void
  debug(...msg: any[]): void
  trace(...msg: any[]): void
}

export interface DataHandler {
  (data: Buffer): Promise<Buffer>
}

export interface MoneyHandler {
  (amount: string): Promise<void>
}

export interface PluginInstance extends EventEmitter2 {
  connect(options: {}): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean
  sendData(data: Buffer): Promise<Buffer>
  sendMoney(amount: string): Promise<void>
  registerDataHandler(dataHandler: DataHandler): void
  deregisterDataHandler(): void
  registerMoneyHandler(moneyHandler: MoneyHandler): void
  deregisterMoneyHandler(): void
  getAdminInfo?(): Promise<object>
  sendAdminInfo?(info: object): Promise<object>
}

export interface PluginServices {
  log?: Logger
  store?: Store
}
