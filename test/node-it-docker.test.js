'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createNodeItDocker } = require('../node-it-docker');

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
  };
}

function createMysqlStub({ failConnect = false } = {}) {
  const connections = [];
  return {
    connections,
    createConnection: config => {
      connections.push(config);
      return {
        connect: cb => cb(failConnect ? new Error('connect failed') : null),
        query: (sql, cb) => cb(null, [{ id: 1 }]),
        destroy: () => {},
      };
    },
  };
}

function createDockerStub() {
  const calls = [];
  const containers = new Map();
  const networks = new Map();
  let containerSeq = 0;
  let hostPortSeq = 49152;

  function makeNetwork(name, id = name) {
    return {
      id,
      name,
      removed: false,
      connected: [],
      disconnected: [],
      async connect(opts) {
        this.connected.push(opts);
      },
      async disconnect(opts) {
        this.disconnected.push(opts);
      },
      async remove(opts) {
        calls.push(['network.remove', name, opts]);
        this.removed = true;
        networks.delete(name);
        networks.delete(id);
      },
    };
  }

  function makeContainer(createOptions) {
    const id = createOptions.id || `container-${++containerSeq}`;
    const name = createOptions.name || id;
    const binding = createOptions.HostConfig
      && createOptions.HostConfig.PortBindings
      && createOptions.HostConfig.PortBindings['3306/tcp']
      && createOptions.HostConfig.PortBindings['3306/tcp'][0];
    const requestedPort = binding && binding.HostPort;
    const hostPort = requestedPort || `${hostPortSeq++}`;

    return {
      id,
      name,
      createOptions,
      started: false,
      stopped: false,
      removed: false,
      stopError: null,
      restartError: null,
      async inspect() {
        calls.push(['container.inspect', name]);
        if (this.removed) {
          throw new Error('not found');
        }
        return {
          Id: id,
          State: {
            Running: this.started,
          },
          NetworkSettings: {
            Ports: {
              '3306/tcp': [{
                HostPort: hostPort,
              }],
            },
          },
        };
      },
      async start() {
        calls.push(['container.start', name]);
        this.started = true;
      },
      async stop() {
        calls.push(['container.stop', name]);
        if (this.stopError) {
          throw this.stopError;
        }
        this.stopped = true;
        this.started = false;
      },
      async remove(opts) {
        calls.push(['container.remove', name, opts]);
        this.removed = true;
        containers.delete(name);
        containers.delete(id);
      },
      async restart() {
        calls.push(['container.restart', name]);
        if (this.restartError) {
          throw this.restartError;
        }
        this.started = true;
      },
    };
  }

  const docker = {
    calls,
    containers,
    networks,
    createContainerError: null,
    async listNetworks() {
      calls.push(['listNetworks']);
      return Array.from(networks.values()).map(network => ({ Id: network.id, Name: network.name }));
    },
    async createNetwork(options) {
      calls.push(['createNetwork', options]);
      const network = makeNetwork(options.Name, `network-${options.Name}`);
      networks.set(options.Name, network);
      networks.set(network.id, network);
      return { id: network.id };
    },
    getNetwork(nameOrId) {
      calls.push(['getNetwork', nameOrId]);
      const network = networks.get(nameOrId);
      if (network) return network;

      return makeNetwork(nameOrId, nameOrId);
    },
    async createContainer(options) {
      calls.push(['createContainer', options]);
      if (this.createContainerError) {
        throw this.createContainerError;
      }
      const container = makeContainer(options);
      containers.set(options.name, container);
      containers.set(container.id, container);
      return { id: container.id };
    },
    getContainer(nameOrId) {
      calls.push(['getContainer', nameOrId]);
      const existing = containers.get(nameOrId);
      if (existing) return existing;

      return {
        async inspect() {
          calls.push(['container.inspect', nameOrId]);
          throw new Error('not found');
        },
        async start() {
          calls.push(['container.start', nameOrId]);
          throw new Error('not found');
        },
        async stop() {
          calls.push(['container.stop', nameOrId]);
          throw new Error('not found');
        },
        async remove(opts) {
          calls.push(['container.remove', nameOrId, opts]);
          throw new Error('not found');
        },
        async restart() {
          calls.push(['container.restart', nameOrId]);
          throw new Error('not found');
        },
      };
    },
  };

  return docker;
}

function createSubject(options = {}, stubs = {}) {
  const docker = stubs.docker || createDockerStub();
  const mysql = stubs.mysql || createMysqlStub();
  const sleep = stubs.sleep || (async () => {});
  const NodeItDocker = createNodeItDocker(docker, mysql, createLogger(), sleep);
  return {
    docker,
    mysql,
    nodeItDocker: NodeItDocker(options),
  };
}

test('keeps legacy defaults without opt-in dynamic mode', async () => {
  const { docker, nodeItDocker } = createSubject({ verifyDbConnection: false });

  const params = await nodeItDocker.start();
  const createContainerCall = docker.calls.find(([name]) => name === 'createContainer');

  assert.equal(createContainerCall[1].Image, '989173062527.dkr.ecr.eu-west-1.amazonaws.com/it-mysql-v2');
  assert.equal(createContainerCall[1].name, 'node-it-container-qwerty12345');
  assert.equal(createContainerCall[1].HostConfig.PortBindings['3306/tcp'][0].HostPort, '3806');
  assert.deepEqual(params, {
    host: '127.0.0.1',
    port: 3806,
    user: 'ituser',
    password: 'ituser',
    database: 'nursebuddy',
  });
});

test('supports explicit legacy container, network, port, and db options', async () => {
  const { docker, nodeItDocker } = createSubject({
    itImageName: 'custom-image',
    itContainerName: 'custom-container',
    containerNetworkName: 'custom-network',
    externalPort: 3810,
    verifyDbConnection: false,
    dbUsername: 'user',
    dbPassword: 'pass',
    dbName: 'db',
  });

  const params = await nodeItDocker.start();
  const createContainerCall = docker.calls.find(([name]) => name === 'createContainer');
  const createNetworkCall = docker.calls.find(([name]) => name === 'createNetwork');

  assert.equal(createContainerCall[1].Image, 'custom-image');
  assert.equal(createContainerCall[1].name, 'custom-container');
  assert.equal(createNetworkCall[1].Name, 'custom-network');
  assert.equal(createContainerCall[1].HostConfig.PortBindings['3306/tcp'][0].HostPort, '3810');
  assert.deepEqual(params, {
    host: '127.0.0.1',
    port: 3810,
    user: 'user',
    password: 'pass',
    database: 'db',
  });
});

test('uses dynamic port and unique names when dynamic mode is enabled', async () => {
  const { docker, nodeItDocker } = createSubject({
    dynamicPort: true,
    verifyDbConnection: false,
  });

  const params = await nodeItDocker.start();
  const createContainerCall = docker.calls.find(([name]) => name === 'createContainer');
  const createNetworkCall = docker.calls.find(([name]) => name === 'createNetwork');

  assert.match(createContainerCall[1].name, /^node-it-container-/);
  assert.match(createNetworkCall[1].Name, /^node-it-test-net-/);
  assert.equal(createContainerCall[1].HostConfig.PortBindings['3306/tcp'][0].HostPort, '');
  assert.equal(params.host, '127.0.0.1');
  assert.equal(params.port, '49152');
  assert.equal(createContainerCall[1].Labels['com.nursebuddy.integration-test'], 'node-it-docker');
});

test('returns docker-network connection parameters when running inside a container', async () => {
  const { docker, nodeItDocker } = createSubject({
    currentContainerId: 'current-test-container',
    itContainerName: 'mysql-service',
    verifyDbConnection: false,
  });

  const params = await nodeItDocker.start();
  const network = Array.from(docker.networks.values()).find(item => item.name === 'node-it-test-net');

  assert.deepEqual(params, {
    host: 'mysql-service',
    port: '3306',
    user: 'ituser',
    password: 'ituser',
    database: 'nursebuddy',
  });
  assert.deepEqual(network.connected, [{ Container: 'current-test-container' }]);
});

test('uses IT_IMAGE_NAME before IT_MYSQL_IMAGE and constructor image', async () => {
  const originalImageName = process.env.IT_IMAGE_NAME;
  const originalMysqlImage = process.env.IT_MYSQL_IMAGE;
  process.env.IT_IMAGE_NAME = 'env-image-name';
  process.env.IT_MYSQL_IMAGE = 'env-mysql-image';

  try {
    const { docker, nodeItDocker } = createSubject({
      itImageName: 'constructor-image',
      verifyDbConnection: false,
    });

    await nodeItDocker.start();
    const createContainerCall = docker.calls.find(([name]) => name === 'createContainer');

    assert.equal(createContainerCall[1].Image, 'env-image-name');
  } finally {
    if (originalImageName === undefined) {
      delete process.env.IT_IMAGE_NAME;
    } else {
      process.env.IT_IMAGE_NAME = originalImageName;
    }

    if (originalMysqlImage === undefined) {
      delete process.env.IT_MYSQL_IMAGE;
    } else {
      process.env.IT_MYSQL_IMAGE = originalMysqlImage;
    }
  }
});

test('uses IT_MYSQL_IMAGE when legacy IT_IMAGE_NAME is not set', async () => {
  const originalImageName = process.env.IT_IMAGE_NAME;
  const originalMysqlImage = process.env.IT_MYSQL_IMAGE;
  delete process.env.IT_IMAGE_NAME;
  process.env.IT_MYSQL_IMAGE = 'env-mysql-image';

  try {
    const { docker, nodeItDocker } = createSubject({
      itImageName: 'constructor-image',
      verifyDbConnection: false,
    });

    await nodeItDocker.start();
    const createContainerCall = docker.calls.find(([name]) => name === 'createContainer');

    assert.equal(createContainerCall[1].Image, 'env-mysql-image');
  } finally {
    if (originalImageName === undefined) {
      delete process.env.IT_IMAGE_NAME;
    } else {
      process.env.IT_IMAGE_NAME = originalImageName;
    }

    if (originalMysqlImage === undefined) {
      delete process.env.IT_MYSQL_IMAGE;
    } else {
      process.env.IT_MYSQL_IMAGE = originalMysqlImage;
    }
  }
});

test('falls back to start when restart fails without using method this binding', async () => {
  const { docker, nodeItDocker } = createSubject({ verifyDbConnection: false });

  await nodeItDocker.start();
  const container = docker.containers.get('node-it-container-qwerty12345');
  container.restartError = new Error('restart failed');

  const params = await nodeItDocker.restart();

  assert.equal(params.port, 3806);
  assert.deepEqual(
    docker.calls.filter(([name]) => ['container.restart', 'container.start'].includes(name)).map(([name]) => name),
    ['container.start', 'container.restart', 'container.start'],
  );
});

test('successful restart returns stable connection parameters', async () => {
  const { docker, nodeItDocker } = createSubject({ verifyDbConnection: false });

  const startParams = await nodeItDocker.start();
  const firstRestartParams = await nodeItDocker.restart();
  const secondRestartParams = await nodeItDocker.restart();

  assert.deepEqual(firstRestartParams, startParams);
  assert.deepEqual(secondRestartParams, startParams);
  assert.equal(docker.calls.filter(([name]) => name === 'container.restart').length, 2);
});

test('start is idempotent when the container is already running', async () => {
  const { docker, nodeItDocker } = createSubject({ verifyDbConnection: false });

  const first = await nodeItDocker.start();
  const second = await nodeItDocker.start();

  assert.deepEqual(second, first);
  assert.equal(docker.calls.filter(([name]) => name === 'createContainer').length, 1);
  assert.equal(docker.calls.filter(([name]) => name === 'container.start').length, 1);
});

test('stop removes the container even when stop fails and can be repeated', async () => {
  const { docker, nodeItDocker } = createSubject({ verifyDbConnection: false });

  await nodeItDocker.start();
  const container = docker.containers.get('node-it-container-qwerty12345');
  container.stopError = new Error('already stopped');

  await nodeItDocker.stop();
  await nodeItDocker.stop();

  assert.ok(docker.calls.some(([name]) => name === 'container.remove'));
  assert.ok(docker.calls.some(([name]) => name === 'network.remove'));
});

test('two dynamic helpers use distinct container, network, and host port values', async () => {
  const docker = createDockerStub();
  const mysql = createMysqlStub();
  const NodeItDocker = createNodeItDocker(docker, mysql, createLogger(), async () => {});

  const first = NodeItDocker({ dynamicPort: true, verifyDbConnection: false });
  const second = NodeItDocker({ dynamicPort: true, verifyDbConnection: false });

  const firstParams = await first.start();
  const secondParams = await second.start();

  const createContainerCalls = docker.calls.filter(([name]) => name === 'createContainer');
  const createNetworkCalls = docker.calls.filter(([name]) => name === 'createNetwork');

  assert.notEqual(createContainerCalls[0][1].name, createContainerCalls[1][1].name);
  assert.notEqual(createNetworkCalls[0][1].Name, createNetworkCalls[1][1].Name);
  assert.notEqual(firstParams.port, secondParams.port);
});

test('cleans up and returns null when database verification fails', async () => {
  const docker = createDockerStub();
  const mysql = createMysqlStub({ failConnect: true });
  const NodeItDocker = createNodeItDocker(docker, mysql, createLogger(), async () => {});
  const nodeItDocker = NodeItDocker({});

  const params = await nodeItDocker.start();

  assert.equal(params, null);
  assert.ok(docker.calls.some(([name]) => name === 'container.remove'));
  assert.ok(docker.calls.some(([name]) => name === 'network.remove'));
});

test('cleans up network when container creation fails', async () => {
  const docker = createDockerStub();
  docker.createContainerError = new Error('create failed');
  const mysql = createMysqlStub();
  const NodeItDocker = createNodeItDocker(docker, mysql, createLogger(), async () => {});
  const nodeItDocker = NodeItDocker({ dynamicPort: true, verifyDbConnection: false });

  await assert.rejects(() => nodeItDocker.start(), /create failed/);

  assert.ok(docker.calls.some(([name]) => name === 'network.remove'));
});
