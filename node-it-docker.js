'use strict';

const { Docker } = require('node-docker-api');
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

    await network.connect({
      Container: currentContainerId,
      EndpointConfig: {
        Aliases: [currentContainerId],
      },
    });
  }
}
async function disconnectRunningContainerFromNetwork(currentContainerId, network) {
  if (currentContainerId) {
    log.info(`Connecting the current container ('${currentContainerId}') to the IT DB network.`);

    await network.disconnect({
      Container: currentContainerId,
      Force: true,
    });
  }
}

async function getOrCreateNetwork(containerNetworkName) {
  let network;

  try {
    const existingNetworks = await docker.network.list();
    const existingNetwork = existingNetworks.filter(network => network.data.Name === containerNetworkName);
    network = existingNetwork && existingNetwork[0];
  } catch (err) {
    log.debug('Failed to list docker networks.');
  }

  if (!network || !network.data.Id) {
    log.info('No existing network, creating it.');

    network = await docker.network.create({
      name: containerNetworkName,
      CheckDuplicate: true,
      Attachable: true,
    });

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
      if (err) {
        log.debug({ msg: 'Failed to connect to database', error: err });
        return reject(err);
      }

      connection.query('SELECT id AS id FROM integration_test_flag LIMIT 1', (err, res) => {
        if (err) {
          log.debug({ msg: 'Failed to execute query', error: err });

          try {
            connection.destroy();
          }
          catch(ex) {
            // noop
          }

          return reject(err);
        }

        if (res.length !== 1) {
          log.debug(`Invalid result length: ${res.length}. Expected 1.`);

          try {
            connection.destroy();
          }
          catch(ex) {
            // noop
          }

          return reject({msg: 'Invalid length'});
        }

        try {
          connection.destroy();
        }
        catch(ex) {
          // noop
        }

        log.debug('Connection success');
        return resolve(true);
      });
    });
  });
}

async function verifyDatabaseConnection(verifyDbConnection, externalPort, currentContainerId, itContainerName, dbUsername, dbPassword, dbName, stopFn) {
  let lastError;
  let waitPeriod = 500;
  const start = (new Date()).getTime();

  if(verifyDbConnection) {
    for (let i = 0; i < 10; i++) {
      try {
        if (await connect(externalPort, currentContainerId, itContainerName, dbUsername, dbPassword, dbName)) {
          log.info(`DB Connection verified in : ${(new Date()).getTime() - start} ms.`);
          return true;
        }
      }
      catch (err) {
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
      const container = docker.container.get(itContainerName);

      if (!container || !container.id) {
        return;
      }

      log.info('Stopping container.');
      const stopped = await container.stop();
      await stopped.delete({ force: true });
      const network = docker.network.get(containerNetworkName);

      if (currentContainerId) {
        log.info('Disconnecting IT container from the Docker DB container network.')
        await disconnectRunningContainerFromNetwork(currentContainerId, network);
      }

      await network.remove({ force: true });
      log.info('Container stopped.');
    },
    start: async () => {
      let container = docker.container.get(itContainerName);
      let network;

      if (!container || !container.id || !container.data || !container.data.Id) {
        network = await getOrCreateNetwork(containerNetworkName);
        log.info('Creating container');

        container = await docker.container.create({
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
      const container = docker.container.get(itContainerName);

      if (container && container.id) {
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
      }

      return this.start();
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
