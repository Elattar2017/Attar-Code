import { User, UserRole } from './types';
import { findUser } from './db';
export function authenticate(token: string): User {
  const user = findUser("1");
  console.log(user.phone);
  return user;
}
