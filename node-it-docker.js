'use strict';

const { Writable } = require('stream');
const Docker = require('dockerode');
const pino = require('pino');
const mysql = require('mysql');

const log = pino({
  timestamp: pino.stdTimeFunctions.isoTime,
});

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const LOCALHOST = '127.0.0.1';
const MYSQL_DEFAULT_PORT = '3306';
const DEFAULT_IT_IMAGE_NAME = '989173062527.dkr.ecr.eu-west-1.amazonaws.com/it-mysql-v2';
const DEFAULT_IT_CONTAINER_NAME = 'node-it-container-qwerty12345';
const DEFAULT_CONTAINER_NETWORK_NAME = 'node-it-test-net';
const DEFAULT_EXTERNAL_PORT = 3806;
const RESET_SCRIPT_PATH = '/usr/local/bin/reset-nursebuddy-db';
const VERIFY_DB_CONNECTION_MAX_ATTEMPTS = 120;

async function sleep(timeMs) {
  return new Promise(resolve => setTimeout(resolve, timeMs));
}

function createRunId() {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function hasOption(options, key) {
  return Object.prototype.hasOwnProperty.call(options, key);
}

function isDynamicHostPort(externalPort) {
  return externalPort === 0 || externalPort === '0' || externalPort === null;
}

function createLabels(runId) {
  return {
    'com.nursebuddy.integration-test': 'node-it-docker',
    'com.nursebuddy.integration-test.runner': 'node-it-docker',
    'com.nursebuddy.integration-test.run-id': runId,
  };
}

function isAlreadyConnectedNetworkError(err) {
  const message = err && err.message ? err.message : `${err}`;
  return /already connected|endpoint .*already exists|endpoint with name .* already exists/i.test(message);
}

async function connectRunningContainerToNetwork(currentContainerId, network, logger) {
  if (currentContainerId) {
    logger.info(`Connecting the current container ('${currentContainerId}') to the IT DB network.`);
    try {
      await network.connect({ Container: currentContainerId });
    } catch (err) {
      if (isAlreadyConnectedNetworkError(err)) {
        logger.info(`Current container ('${currentContainerId}') is already connected to the IT DB network.`);
        return;
      }
      throw err;
    }
  }
}

async function disconnectRunningContainerFromNetwork(currentContainerId, network, logger) {
  if (currentContainerId) {
    logger.info(`Disconnecting the current container ('${currentContainerId}') from the IT DB network.`);
    await network.disconnect({ Container: currentContainerId, Force: true });
  }
}

async function getOrCreateNetwork(dockerClient, containerNetworkName, labels, logger) {
  let network;
  try {
    const existingNetworks = await dockerClient.listNetworks();
    const found = existingNetworks.find(n => n.Name === containerNetworkName);
    if (found) {
      network = dockerClient.getNetwork(found.Id);
    }
  } catch (err) {
    logger.debug('Failed to list docker networks.', err);
  }

  if (!network) {
    logger.info('No existing network, creating it.');
    network = await dockerClient.createNetwork({
      Name: containerNetworkName,
      CheckDuplicate: true,
      Attachable: true,
      Labels: labels,
    });
    network = dockerClient.getNetwork(network.id);
    logger.info(`Network '${containerNetworkName}' created`);
  }

  return network;
}

async function connect(mysqlClient, externalPort, currentContainerId, itContainerName, dbUsername, dbPassword, dbName) {
  return new Promise((resolve, reject) => {
    const connection = mysqlClient.createConnection({
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
        if (err || !res || res.length !== 1) {
          return reject(err || { msg: 'Invalid length' });
        }
        return resolve(true);
      });
    });
  });
}

function getVerifySleepMs(attempt) {
  if (attempt < 10) {
    return 100;
  }
  if (attempt < 30) {
    return 250;
  }
  return 500;
}

async function verifyDatabaseConnection(verifyDbConnection, mysqlClient, externalPort, currentContainerId, itContainerName, dbUsername, dbPassword, dbName, stopFn, logger, sleepFn) {
  let lastError;
  const start = Date.now();

  if (!verifyDbConnection) {
    return true;
  }

  for (let attempt = 0; attempt < VERIFY_DB_CONNECTION_MAX_ATTEMPTS; attempt++) {
    try {
      if (await connect(mysqlClient, externalPort, currentContainerId, itContainerName, dbUsername, dbPassword, dbName)) {
        logger.info(`DB Connection verified in : ${Date.now() - start} ms.`);
        return true;
      }
    } catch (err) {
      lastError = err;
    }
    if (attempt < VERIFY_DB_CONNECTION_MAX_ATTEMPTS - 1) {
      await sleepFn(getVerifySleepMs(attempt));
    }
  }

  logger.warn({ msg: 'DB connection failed:', error: lastError });
  await stopFn();
  return false;
}

async function resolveExternalPort(container, externalPort, currentContainerId) {
  if (currentContainerId) {
    return MYSQL_DEFAULT_PORT;
  }

  if (!isDynamicHostPort(externalPort)) {
    return externalPort;
  }

  const inspected = await container.inspect();
  const bindings = inspected
    && inspected.NetworkSettings
    && inspected.NetworkSettings.Ports
    && inspected.NetworkSettings.Ports[`${MYSQL_DEFAULT_PORT}/tcp`];

  if (!bindings || !bindings[0] || !bindings[0].HostPort) {
    throw new Error(`Failed to resolve dynamic Docker host port for MySQL port ${MYSQL_DEFAULT_PORT}.`);
  }

  return bindings[0].HostPort;
}

function collectExecOutput(dockerClient, stream) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const stdoutStream = new Writable({
      write(chunk, encoding, callback) {
        stdout += chunk.toString();
        callback();
      },
    });
    const stderrStream = new Writable({
      write(chunk, encoding, callback) {
        stderr += chunk.toString();
        callback();
      },
    });

    stream.on('end', () => resolve({ stdout, stderr }));
    stream.on('error', reject);

    if (dockerClient.modem && typeof dockerClient.modem.demuxStream === 'function') {
      dockerClient.modem.demuxStream(stream, stdoutStream, stderrStream);
      return;
    }

    stream.on('data', chunk => {
      stdout += chunk.toString();
    });
  });
}

async function execInContainer(dockerClient, container, cmd) {
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({ hijack: true, stdin: false });
  const output = await collectExecOutput(dockerClient, stream);
  const inspected = await exec.inspect();

  if (inspected.ExitCode !== 0) {
    const err = new Error(`Container command failed with exit code ${inspected.ExitCode}: ${cmd.join(' ')}`);
    err.exitCode = inspected.ExitCode;
    err.stdout = output.stdout;
    err.stderr = output.stderr;
    throw err;
  }

  return output;
}

function isResetScriptUnavailable(err) {
  const output = `${err.stdout || ''}\n${err.stderr || ''}\n${err.message || ''}`;

  return err.exitCode === 66
    || err.exitCode === 126
    || err.exitCode === 127
    || /Missing \/baseline\.sql|No such file|not found|executable file not found/i.test(output);
}

function createNodeItDocker(dockerClient = docker, mysqlClient = mysql, logger = log, sleepFn = sleep) {
  return function NodeItDocker(options = {}) {
    const runId = createRunId();
    const useDynamicDefaults = options.useDynamicDefaults === true || options.dynamicPort === true;
    const configuredExternalPort = hasOption(options, 'externalPort')
      ? options.externalPort
      : (options.dynamicPort === true ? 0 : DEFAULT_EXTERNAL_PORT);

    const itContainerName = options.itContainerName
      || (useDynamicDefaults ? `node-it-container-${runId}` : DEFAULT_IT_CONTAINER_NAME);
    const containerNetworkName = options.containerNetworkName
      || (useDynamicDefaults ? `node-it-test-net-${runId}` : DEFAULT_CONTAINER_NETWORK_NAME);
    const dataDir = options.dataDir || '/var/lib/mysql';
    const verifyDbConnection = hasOption(options, 'verifyDbConnection') ? options.verifyDbConnection : true;
    const dbUsername = options.dbUsername || 'ituser';
    const dbPassword = options.dbPassword || 'ituser';
    const dbName = options.dbName || 'nursebuddy';
    const labels = createLabels(runId);
    let currentContainerId = process.env.IT_CONTAINER || options.currentContainerId || null;
    let itImageName = process.env.IT_IMAGE_NAME || process.env.IT_MYSQL_IMAGE || options.itImageName || DEFAULT_IT_IMAGE_NAME;
    let resolvedExternalPort = configuredExternalPort;

    function getDbConnectionParameters() {
      return {
        host: currentContainerId ? itContainerName : LOCALHOST,
        port: currentContainerId ? MYSQL_DEFAULT_PORT : resolvedExternalPort,
        user: dbUsername,
        password: dbPassword,
        database: dbName,
      };
    }

    async function stop() {
      const container = dockerClient.getContainer(itContainerName);

      try {
        await container.stop();
      } catch (err) {
        logger.warn('Failed to stop container:', err);
      }

      try {
        await container.remove({ force: true });
      } catch (err) {
        logger.warn('Failed to remove container:', err);
      }

      try {
        const network = dockerClient.getNetwork(containerNetworkName);
        if (currentContainerId) {
          try {
            await disconnectRunningContainerFromNetwork(currentContainerId, network, logger);
          } catch (err) {
            logger.warn('Failed to disconnect current container from network:', err);
          }
        }
        await network.remove({ force: true });
        logger.info('Container stopped.');
      } catch (err) {
        logger.warn('Failed to remove network:', err);
      }
    }

    async function start() {
      let container;
      let inspected;

      try {
        const network = await getOrCreateNetwork(dockerClient, containerNetworkName, labels, logger);
        container = dockerClient.getContainer(itContainerName);

        try {
          inspected = await container.inspect();
        } catch {
          logger.info('Creating container');
          container = await dockerClient.createContainer({
            Image: itImageName,
            name: itContainerName,
            Labels: labels,
            ExposedPorts: {
              [`${MYSQL_DEFAULT_PORT}/tcp`]: {},
            },
            HostConfig: {
              PortBindings: {
                [`${MYSQL_DEFAULT_PORT}/tcp`]: [{
                  HostIP: '0.0.0.0',
                  HostPort: isDynamicHostPort(configuredExternalPort) ? '' : `${configuredExternalPort}`,
                }],
              },
              Tmpfs: {
                [dataDir]: 'rw,noexec,nosuid,size=600m',
                '/tmp': 'rw,noexec,nosuid,size=50m',
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
          container = dockerClient.getContainer(container.id);
          logger.info(`Container '${container.id}' created.`);
        }

        if (!inspected || !inspected.State || !inspected.State.Running) {
          await container.start();
        }

        await connectRunningContainerToNetwork(currentContainerId, network, logger);
        resolvedExternalPort = await resolveExternalPort(container, configuredExternalPort, currentContainerId);

        if (await verifyDatabaseConnection(verifyDbConnection, mysqlClient, resolvedExternalPort, currentContainerId, itContainerName, dbUsername, dbPassword, dbName, stop, logger, sleepFn)) {
          return getDbConnectionParameters();
        }
        return null;
      } catch (err) {
        logger.warn('Failed to start container:', err);
        await stop();
        throw err;
      }
    }

    async function restart() {
      try {
        const container = dockerClient.getContainer(itContainerName);
        await container.restart();
        resolvedExternalPort = await resolveExternalPort(container, configuredExternalPort, currentContainerId);
        if (await verifyDatabaseConnection(verifyDbConnection, mysqlClient, resolvedExternalPort, currentContainerId, itContainerName, dbUsername, dbPassword, dbName, stop, logger, sleepFn)) {
          return getDbConnectionParameters();
        }
        logger.warn('Restart verification failed, starting new container.');
        return start();
      } catch (err) {
        logger.warn('Restart failed, starting new container.', err);
        await stop();
        return start();
      }
    }

    async function resetDatabase() {
      if (dbName !== 'nursebuddy') {
        logger.warn(`SQL reset only supports the nursebuddy database, falling back to container restart for '${dbName}'.`);
        return restart();
      }

      try {
        const container = dockerClient.getContainer(itContainerName);
        await execInContainer(dockerClient, container, [RESET_SCRIPT_PATH, dbName]);
        resolvedExternalPort = await resolveExternalPort(container, configuredExternalPort, currentContainerId);
        if (await verifyDatabaseConnection(verifyDbConnection, mysqlClient, resolvedExternalPort, currentContainerId, itContainerName, dbUsername, dbPassword, dbName, stop, logger, sleepFn)) {
          return getDbConnectionParameters();
        }
        logger.warn('SQL reset verification failed, falling back to container restart.');
        return restart();
      } catch (err) {
        if (isResetScriptUnavailable(err)) {
          logger.warn('SQL reset script is unavailable in the IT DB image, falling back to container restart.', err);
        } else {
          logger.warn('SQL reset failed, falling back to container restart.', err);
        }
        return restart();
      }
    }

    return {
      stop,
      start,
      restart,
      resetDatabase,
      getDbConnectionParameters: async () => getDbConnectionParameters(),
    };
  };
}

exports.createNodeItDocker = createNodeItDocker;
exports.NodeItDocker = createNodeItDocker();
