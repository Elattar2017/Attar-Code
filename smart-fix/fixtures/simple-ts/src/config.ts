import { Config } from './types';

export const DEFAULT_PORT = 3000;

export function getConfig(): Config {
  return {
    port: parseInt(process.env.PORT || String(DEFAULT_PORT)),
    dbUrl: process.env.DATABASE_URL || 'sqlite:memory',
  };
}
