import pg from 'pg';
import { logger } from '../utils/logger.js';
import { validateEnvironment } from './envValidator.js';

validateEnvironment();

const { Pool } = pg;

const dbPool = new Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : 5432,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  max: 5,
  ssl: {
    rejectUnauthorized: false
  }
});

logger.info('[Admin Service] Azure PostgreSQL 커넥션 풀을 수립했습니다.');

export { dbPool };
