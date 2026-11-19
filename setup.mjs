import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const password = () => randomBytes(24).toString('base64url');
try {
  writeFileSync('.env', `WALEED_PASSWORD=${password()}\nROHA_PASSWORD=${password()}\n`, {
    flag: 'wx', mode: 0o600
  });
  console.log('Created .env with separate passwords for Waleed and Roha.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Existing .env kept.');
}
