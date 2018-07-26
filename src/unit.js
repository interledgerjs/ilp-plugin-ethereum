const BigNumber = require('bignumber.js')

class EthUnit extends BigNumber {
  constructor (amount, unit) {
    super(amount)
    if (!unit) {
      throw new Error('Must specify a unit of ether')
    }
    this.unit = unit
  }

  _transform (unit) {
    const orders = {
      wei: 0,
      gwei: 9,
      ether: 18
    }
    return new EthUnit(
      this.shift(orders[this.unit] - orders[unit]),
      unit
    )
  }

  wei () {
    return this._transform('wei')
  }

  gwei () {
    return this._transform('gwei')
  }

  ether () {
    return this._transform('ether')
  }

  ethStr () {
    return this.ether().toString() + ' ETH'
  }
}

module.exports = EthUnit
