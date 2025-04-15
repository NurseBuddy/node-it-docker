'use strict';

const Docker = require('dockerode');
const pino = require('pino');
const mysql = require('mysql');

const log = pino({
  timestamp: pino.stdTimeFunctions.isoTime,
});

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const LOCALHOST = '127.0.0.1';
const MYSQL_DEFAULT_PORT = '3306';

async function sleep(timeMs) {
  return new Promise(resolve => setTimeout(resolve, timeMs));
}

async function connectRunningContainerToNetwork(currentContainerId, network) {
  if (currentContainerId) {
    log.info(`Connecting the current container ('${currentContainerId}') to the IT DB network.`);
    await network.connect({ Container: currentContainerId });
  }
}

async function disconnectRunningContainerFromNetwork(currentContainerId, network) {
  if (currentContainerId) {
    log.info(`Disconnecting the current container ('${currentContainerId}') from the IT DB network.`);
    await network.disconnect({ Container: currentContainerId, Force: true });
  }
}

async function getOrCreateNetwork(containerNetworkName) {
  let network;
  try {
    const existingNetworks = await docker.listNetworks();
    const found = existingNetworks.find(n => n.Name === containerNetworkName);
    if (found) {
      network = docker.getNetwork(found.Id);
    }
  } catch (err) {
    log.debug('Failed to list docker networks.', err);
  }

  if (!network) {
    log.info('No existing network, creating it.');
    network = await docker.createNetwork({
      Name: containerNetworkName,
      CheckDuplicate: true,
      Attachable: true,
    });
    network = docker.getNetwork(network.id);
    log.info(`Network '${containerNetworkName}' created`);
  }

  return network;
}

async function connect(externalPort, currentContainerId, itContainerName, dbUsername, dbPassword, dbName) {
  return new Promise((resolve, reject) => {
    const connection = mysql.createConnection({
      host: currentContainerId ? itContainerName : LOCALHOST,
      port: currentContainerId ? MYSQL_DEFAULT_PORT : externalPort,
      user: dbUsername,
      password: dbPassword,
      database: dbName,
    });

    connection.connect(err => {
      if (err) return reject(err);

      connection.query('SELECT id AS id FROM integration_test_flag LIMIT 1', (err, res) => {
        connection.destroy();
        if (err || res.length !== 1) {
          return reject(err || { msg: 'Invalid length' });
        }
        return resolve(true);
      });
    });
  });
}

async function verifyDatabaseConnection(verifyDbConnection, externalPort, currentContainerId, itContainerName, dbUsername, dbPassword, dbName, stopFn) {
  let lastError;
  let waitPeriod = 500;
  const start = Date.now();

  if (verifyDbConnection) {
    for (let i = 0; i < 10; i++) {
      try {
        if (await connect(externalPort, currentContainerId, itContainerName, dbUsername, dbPassword, dbName)) {
          log.info(`DB Connection verified in : ${Date.now() - start} ms.`);
          return true;
        }
      } catch (err) {
        lastError = err;
      }
      await sleep(waitPeriod);
      waitPeriod += Math.round(waitPeriod / 2);
    }

    log.warn({ msg: 'DB connection failed:', error: lastError });
    await stopFn();
    return false;
  }
}

const NodeItDocker = ({
  itImageName = '989173062527.dkr.ecr.eu-west-1.amazonaws.com/it-mysql-v2',
  itContainerName = 'node-it-container-qwerty12345',
  externalPort = 3806,
  containerNetworkName = 'node-it-test-net',
  dataDir = '/var/lib/mysql',
  currentContainerId = null,
  verifyDbConnection = true,
  dbUsername = 'ituser',
  dbPassword = 'ituser',
  dbName = 'nursebuddy',
}) => {
  currentContainerId = process.env.IT_CONTAINER || currentContainerId || null;
  itImageName = process.env.IT_IMAGE_NAME || itImageName;

  return {
    stop: async () => {
      try {
        const container = docker.getContainer(itContainerName);
        await container.stop();
        await container.remove({ force: true });

        const network = docker.getNetwork(containerNetworkName);
        if (currentContainerId) {
          await disconnectRunningContainerFromNetwork(currentContainerId, network);
        }
        await network.remove({ force: true });
        log.info('Container stopped.');
      } catch (err) {
        log.warn('Failed to stop container or network:', err);
      }
    },

    start: async () => {
      let container;
      let network = await getOrCreateNetwork(containerNetworkName);

      try {
        container = docker.getContainer(itContainerName);
        await container.inspect();
      } catch {
        log.info('Creating container');
        container = await docker.createContainer({
          Image: itImageName,
          name: itContainerName,
          HostConfig: {
            PortBindings: {
              [`${MYSQL_DEFAULT_PORT}/tcp`]: [{
                HostIP: '0.0.0.0',
                HostPort: `${externalPort}`,
              }],
            },
            Tmpfs: {
              [dataDir]: 'rw,noexec,nosuid,size=600m',
              '/tmp': 'rw,noexec,nosuid,size=50m'
            },
          },
          NetworkingConfig: {
            EndpointsConfig: {
              [containerNetworkName]: {
                Aliases: [itContainerName],
              },
            },
          },
        });
        container = docker.getContainer(container.id);
        log.info(`Container '${container.id}' created.`);
      }

      await container.start();
      await connectRunningContainerToNetwork(currentContainerId, network);

      if (await verifyDatabaseConnection(verifyDbConnection, externalPort, currentContainerId, itContainerName, dbUsername, dbPassword, dbName, this.stop)) {
        return {
          host: currentContainerId ? itContainerName : LOCALHOST,
          port: currentContainerId ? MYSQL_DEFAULT_PORT : externalPort,
          user: dbUsername,
          password: dbPassword,
          database: dbName,
        };
      }
      return null;
    },

    restart: async () => {
      try {
        const container = docker.getContainer(itContainerName);
        await container.restart();
        if (await verifyDatabaseConnection(verifyDbConnection, externalPort, currentContainerId, itContainerName, dbUsername, dbPassword, dbName, this.stop)) {
          return {
            host: currentContainerId ? itContainerName : LOCALHOST,
            port: currentContainerId ? MYSQL_DEFAULT_PORT : externalPort,
            user: dbUsername,
            password: dbPassword,
            database: dbName,
          };
        }
        return null;
      } catch (err) {
        log.warn('Restart failed, starting new container.', err);
        return this.start();
      }
    },

    getDbConnectionParameters: async () => {
      return {
        host: currentContainerId ? itContainerName : LOCALHOST,
        port: currentContainerId ? MYSQL_DEFAULT_PORT : externalPort,
        user: dbUsername,
        password: dbPassword,
        database: dbName,
      };
    },
  };
};

exports.NodeItDocker = NodeItDocker;