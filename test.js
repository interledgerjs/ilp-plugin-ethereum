const Plugin = require('.')
const Store = require('ilp-store-memory')
const plugin = new Plugin({
  account: '0x1dd0684d785785d8bd4797450d3487dae5c8d406',
  port: 6666,
  _store: new Store(),
  debugHostIldcpInfo: {
    clientAddress: 'test.example'
  }
})

async function run () {
  await plugin.connect() 
}

run()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
