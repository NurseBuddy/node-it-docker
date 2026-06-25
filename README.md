# node-it-docker

Node Docker IT DB Launcher for NurseBuddy integration tests.

This helper starts and manages the MySQL integration-test database container
used by Node services. It supports the legacy fixed-port mode and an opt-in
dynamic mode for parallel and CI-safe test runs.

## Install

```bash
npm install https://github.com/NurseBuddy/node-it-docker/archive/v1.2.0.tar.gz
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
//
// DB-heavy suites can restore the baseline database without restarting the
// Docker container when the IT DB image supports it:
// await nodeItDocker.resetDatabase();

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

`resetDatabase()` is an opt-in faster reset for suites that need a full
database baseline between groups of tests. It calls the reset script baked into
newer IT DB images and falls back to the legacy container `restart()` path when
running against an older image.

## Testing

```bash
npm test
```

The test suite uses mocked Docker and MySQL clients. It does not start a real
Docker container.

Run the optional Docker smoke before rolling a new helper version into service
pilot branches:

```bash
npm run smoke:docker
```

The smoke starts `it-mysql-v2` with `dynamicPort: true`, verifies MySQL
connectivity, exercises `resetDatabase()` and `restart()`, and then stops the
container. It requires Docker access and access to the configured
integration-test DB image. Use `IT_IMAGE_NAME` or `IT_MYSQL_IMAGE` to point at a
locally available image if needed.
