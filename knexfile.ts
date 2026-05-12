import * as dotenv from 'dotenv';
dotenv.config();

const connection = {
  host: process.env.MYSQL_HOST,
  port: process.env.MYSQL_PORT ? Number(process.env.MYSQL_PORT) : 3306,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE_NAME
};

const shared = {
  client: 'mysql2',
  connection: connection,
  migrations: {
    tableName: 'migrations',
    directory: './database/migrations'
  },
  seeds: {
    directory: './database/seeds'
  }
};

const knexConfig = {
  development: shared,
  production: { ...shared, pool: { min: 0, max: 10 } }
};

export default knexConfig;
