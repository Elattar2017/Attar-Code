import { User } from './types';
export function findUser(id: string): User {
  return { id, name: "Test", email: "test@test.com" };
}
export function createUser(name: string, email: string, phone: string): User {
  return { id: "1", name, email, phone };
}
