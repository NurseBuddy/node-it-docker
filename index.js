const { NodeItDocker } = require('./node-it-docker');

(async function main() {
  const nodeItDocker = NodeItDocker({});
  await nodeItDocker.start();
  await nodeItDocker.stop();
})();
