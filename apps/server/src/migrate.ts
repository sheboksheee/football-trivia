import pg from 'pg';
import { migrate } from './persistence.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url });
migrate(pool)
  .then((applied) => {
    console.warn(applied.length ? `Applied: ${applied.join(', ')}` : 'Database up to date');
    return pool.end();
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
