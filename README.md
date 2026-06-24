# node-it-docker

Node Docker IT DB Launcher for NurseBuddy integration tests.

This helper starts and manages the MySQL integration-test database container
used by Node services. It supports the legacy fixed-port mode and an opt-in
dynamic mode for parallel and CI-safe test runs.

## Install

```bash
yarn install
```

## Usage

```js
const { NodeItDocker } = require('node-it-docker');

const nodeItDocker = NodeItDocker({
  dynamicPort: true,
});

const db = await nodeItDocker.start();

// Configure the service under test with db.host, db.port, db.user,
// db.password, and db.database.

await nodeItDocker.stop();
```

## Options

| Option | Default | Notes |
|---|---|---|
| `itImageName` | `989173062527.dkr.ecr.eu-west-1.amazonaws.com/it-mysql-v2` | Docker image to run. |
| `itContainerName` | `node-it-container-qwerty12345` | Legacy default unless `dynamicPort` or `useDynamicDefaults` is enabled. |
| `externalPort` | `3806` | Legacy host port. Use `0` for a dynamic Docker-assigned host port. |
| `dynamicPort` | `false` | Enables Docker-assigned host port and unique default container/network names. |
| `useDynamicDefaults` | `false` | Enables unique default container/network names without forcing `externalPort` when explicitly provided. |
| `containerNetworkName` | `node-it-test-net` | Legacy default unless dynamic defaults are enabled. |
| `dataDir` | `/var/lib/mysql` | MySQL data tmpfs mount path. |
| `currentContainerId` | `null` | Connects the current container to the DB network; also reads `IT_CONTAINER`. |
| `verifyDbConnection` | `true` | Verifies the `integration_test_flag` table before returning DB params. |
| `dbUsername` | `ituser` | MySQL username. |
| `dbPassword` | `ituser` | MySQL password. |
| `dbName` | `nursebuddy` | MySQL database name. |

## Environment Overrides

Image override precedence:

1. `IT_IMAGE_NAME`
2. `IT_MYSQL_IMAGE`
3. `itImageName` option
4. built-in `it-mysql-v2` image

`IT_CONTAINER` overrides `currentContainerId`.

`IT_IMAGE_NAME` is the legacy env var and keeps precedence for compatibility.
`IT_MYSQL_IMAGE` exists so GitHub workflows can pass the resolved/pulled test DB
image name without changing existing service code that still uses
`IT_IMAGE_NAME`.

## Compatibility Notes

Version `1.2.0` keeps the legacy no-option defaults:

- container name: `node-it-container-qwerty12345`
- network name: `node-it-test-net`
- host port: `3806`
- returned DB fields: `host`, `port`, `user`, `password`, `database`

Services updated under NB-9161 should opt in to dynamic behavior with
`dynamicPort: true`. A future major version can make dynamic behavior the
default after all consumers have moved away from the legacy fixed port.

## Testing

```bash
npm test
```

The test suite uses mocked Docker and MySQL clients. It does not start a real
Docker container.
