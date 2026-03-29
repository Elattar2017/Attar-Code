import { User, UserRole } from './types';
import { getConfig, DEFAULT_PORT } from './config';

export function createUser(name: string, email: string): User {
  return { id: crypto.randomUUID(), name, email, role: UserRole.USER };
}

export function startApp() {
  const config = getConfig();
  console.log(`Starting on port ${config.port}`);
}
