'use strict';

const mysql = require('mysql');
const { NodeItDocker } = require('../node-it-docker');

function queryFlag(connectionParams) {
  return new Promise((resolve, reject) => {
    const connection = mysql.createConnection(connectionParams);

    connection.connect(err => {
      if (err) {
        connection.destroy();
        return reject(err);
      }

      connection.query('SELECT id AS id FROM integration_test_flag LIMIT 1', (err, rows) => {
        connection.destroy();
        if (err) return reject(err);
        if (!rows || rows.length !== 1) {
          return reject(new Error('integration_test_flag smoke query returned no row'));
        }
        return resolve();
      });
    });
  });
}

(async function main() {
  const nodeItDocker = NodeItDocker({
    dynamicPort: true,
  });

  try {
    const db = await nodeItDocker.start();
    if (!db || !db.host || !db.port) {
      throw new Error('start() did not return usable DB parameters');
    }

    await queryFlag(db);

    const restarted = await nodeItDocker.restart();
    if (!restarted || !restarted.host || !restarted.port) {
      throw new Error('restart() did not return usable DB parameters');
    }

    await queryFlag(restarted);
  } finally {
    await nodeItDocker.stop();
  }
})();
